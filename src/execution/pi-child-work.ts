import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { validateRoleContext, type RoleTaskContext } from "./role-context";
import { validateMemorySlice, type MemorySlice } from "./memory-slice";
import { digestValue } from "./security-boundary";
import { Check } from "typebox/value";
import { workerTools, validateWorkerAction, hostToolSchemas, type WorkerProfile, type WorkerAction } from "./pi-child-protocol";
import type { WorkerBinding } from "./pi-child-tools";

type Host = Pick<ExtensionAPI, "events" | "registerProvider" | "unregisterProvider">;
export interface PiWorkerRequest {
  nodeId: string; roleName: string; profile: WorkerProfile; cwd: string; stateDir: string; task: string;
  roleContext: RoleTaskContext; memorySlice: MemorySlice;
  model: {alias: string; id: string; config: ProviderConfig};
  nativePlugin?: string; remainingToolTurns?: number; resumeRunId?: string; signal?: AbortSignal; timeoutMs?: number; tools?: readonly string[];
  execute?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  onStarted?: (nativeRunId: string) => void | Promise<void>;
}
async function json(path: string) { return JSON.parse(await readFile(path, "utf8")); }

export async function runPiWorker(_pi: Host, input: PiWorkerRequest): Promise<{nativeRunId: string; action: WorkerAction; toolTurns: number; remainingToolTurns: number}> {
  const memory = validateMemorySlice(input.memorySlice);
  const context = validateRoleContext(input.roleContext);
  if (context.audit.targetAgentId !== memory.targetAgentId || context.audit.runId !== memory.runId ||
      context.audit.memoryDigest !== memory.digest || context.audit.taskId !== memory.taskId || context.audit.missionId !== memory.missionId) {
    throw Error("worker memory and context bindings do not match");
  }
  const {alias, id, config} = input.model;
  const base = new URL(config.baseUrl ?? "");
  if (!/^evok-meter-[a-z0-9-]+$/.test(alias) || !/^[\w.-]+$/.test(id) || base.protocol !== "http:" || base.hostname !== "127.0.0.1" ||
      base.username || base.password || config.models?.length !== 1 || config.models[0].id !== id || !config.apiKey) throw Error("expected scoped loopback worker model");
  if (!isAbsolute(input.cwd) || !isAbsolute(input.stateDir)) throw Error("worker paths must be absolute");
  await mkdir(input.stateDir, {recursive: true, mode: 0o700});
  const cwd = await realpath(input.cwd), stateDir = await realpath(input.stateDir);
  const inside = relative(cwd, stateDir);
  if (inside !== ".." && !inside.startsWith("../")) throw Error("worker control directory must be outside its workspace");
  const tools = workerTools(input.profile, input.tools);
  const identity = digestValue({nodeId: input.nodeId, missionId: memory.missionId, targetAgentId: memory.targetAgentId,
    cwd, role: context.role, profile: input.profile, tools, model: alias + "/" + id, allowedPaths: context.allowedPaths,
    policyDigest: context.audit.policyDigest, contractDigest: context.audit.contractDigest});
  const history = join(stateDir, "native-history.json");
  const previous = await json(history).catch(error => {if(error.code !== "ENOENT") throw error; return undefined;});
  if (input.resumeRunId !== previous?.nativeRunId || (previous && previous.identity !== identity)) throw Error("native history belongs to another node, scope or run");
  const requestedTurns = input.remainingToolTurns ?? 8;
  if (!Number.isInteger(requestedTurns) || requestedTurns < 0 || requestedTurns > 8) throw Error("invalid tool-turn budget");
  const remainingToolTurns = Math.min(requestedTurns, previous?.remainingToolTurns ?? 8);
  if (remainingToolTurns === 0) throw Error("node tool-turn budget exhausted");
  input.signal?.throwIfAborted();
  const round = randomUUID(), actionFile = join(stateDir, round + ".action.json"), activeFile = join(stateDir, "active.json");
  const binding: WorkerBinding = {nodeId: input.nodeId, roleRunId: round, remainingToolTurns, profile: input.profile, tools, provider: {alias, config}};
  let server: Server | undefined, bindingOwned = false;
  let owner: ChildProcessWithoutNullStreams | undefined;
  let ownerEnded: Promise<unknown> | undefined;
  let nativeRunId: string | undefined;
  const name = "evok-work-" + identity.slice(-20);
  const model = alias + "/" + id;
  const command = (cmd: string) => owner!.stdin.write(JSON.stringify({type: "prompt", message: "/" + cmd}) + "\n");
  try {
    if (tools.some(tool => Object.hasOwn(hostToolSchemas, tool))) {
      if (!input.execute) throw Error("scoped tool host is required");
      const key = randomUUID();
      server = createServer(async (req, res) => {
        if (req.method !== "POST" || req.url !== "/tool" || req.headers.authorization !== "Bearer " + key) {res.writeHead(403).end(); return;}
        try {
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of req) {size += chunk.length; if(size > 1024*1024) throw Error("oversized tool call"); chunks.push(chunk);}
          const {name, args} = JSON.parse(Buffer.concat(chunks).toString());
          if (!tools.includes(name) || !Object.hasOwn(hostToolSchemas, name) || !Check(hostToolSchemas[name], args)) throw Error("invalid tool call");
          res.end(JSON.stringify(await input.execute!(name, args as Record<string, unknown>)) ?? "null");
        } catch { res.writeHead(400).end(); }
      });
      server.listen(0, "127.0.0.1"); await once(server, "listening");
      const address = server.address(); if (!address || typeof address === "string") throw Error("no local tool port");
      binding.toolServer = {url: `http://127.0.0.1:${address.port}/tool`, key};
    }
    await writeFile(activeFile, JSON.stringify(binding), {mode: 0o600, flag: "wx"}); bindingOwned = true;

    const childExtension = join(stateDir, "worker-extension.mjs");
    const installer = fileURLToPath(new URL("./pi-child-tools.ts", import.meta.url));
    // The retained native contract pins this file. Its binding rotates on each admission.
    if (!previous) await writeFile(childExtension, `import { installPiWorkerTools } from ${JSON.stringify(installer)};\nexport default pi => installPiWorkerTools(pi, ${JSON.stringify(stateDir)});\n`, {mode: 0o600});
    const reg = {version: 1, name, definition: {description: "EvoK " + input.roleName,
      systemPromptMode: "replace", systemPrompt: `You are ${input.roleName}. Use only your assigned evidence and capabilities. End this turn with one EvoK control tool call on its own.`,
      model, thinking: "max", defaultContext: "fresh", inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
      tools, extensions: [], subagentOnlyExtensions: [childExtension], skills: [], mcpDirectTools: [], allowNestedSubagents: false},
      result: undefined as {ok: boolean; registration?: {dispose(): void}} | undefined};
    const task = JSON.stringify({task: input.task, roleContext: context, memorySlice: memory});
    const method = input.resumeRunId ? "resume" : "spawn";
    const params = input.resumeRunId ? {id: input.resumeRunId, message: task} : {
      agent: name, task, cwd, model, thinking: "max", context: "fresh", skill: false, artifacts: false};
    await writeFile(join(stateDir, round + ".launch.json"), JSON.stringify({method, params, registration: reg}), {mode: 0o600});
    const agentDir = join(stateDir,"pi"); await mkdir(agentDir,{recursive:true,mode:0o700});
    const plugin = input.nativePlugin ?? join(process.env.PI_CODING_AGENT_DIR || join(homedir(),".pi/agent"),"npm/node_modules/pi-subagents/bundle/index.js");
    owner = spawn("pi", ["--offline","--no-extensions","--no-skills","--no-tools","--no-mcp","--no-context-files", "--session",join(stateDir,"owner.jsonl"),
      "-e",plugin,"-e",fileURLToPath(new URL("./pi-child-owner.ts",import.meta.url)),"--model","evok-internal/owner","--mode","rpc"], {
      cwd, env: {HOME: stateDir, PATH:process.env.PATH, PI_CODING_AGENT_DIR:agentDir, PI_SUBAGENTS_TEMP_ROOT:join(stateDir,"native"),
        PI_OFFLINE:"1",EVOK_WORKER_STATE:stateDir,TERM:"dumb",NO_COLOR:"1"},stdio:["pipe","pipe","pipe"]});
    owner.stdout.resume(); owner.stderr.resume(); owner.stdin.on("error", () => {});
    ownerEnded=once(owner,"exit"); void ownerEnded.catch(()=>{});
    command("evok-start");
    let asyncDir: string | undefined;
    const startupDeadline = Date.now()+35_000;
    while (!asyncDir) {
      const started = await json(join(stateDir, round + ".started.json")).catch(e=>{if(e.code!=="ENOENT")throw e;});
      if (started) {nativeRunId=started.nativeRunId; asyncDir=started.asyncDir; break;}
      const failed = await json(join(stateDir,round+".error.json")).catch(e=>{if(e.code!=="ENOENT")throw e;});
      if (failed || owner.exitCode!==null || Date.now()>=startupDeadline) throw Error(failed?.error ?? "native control owner failed to launch");
      await delay(75);
    }
    if (!asyncDir || !nativeRunId) throw Error("missing native async launch receipt");
    await input.onStarted?.(nativeRunId);
    const deadline = Date.now() + (input.timeoutMs ?? 15 * 60_000);
    let stopTime: number | undefined;
    for (;;) {
      if (stopTime === undefined && (input.signal?.aborted || Date.now() >= deadline)) {stopTime = Date.now(); command("evok-cancel");}
      const state = await json(join(asyncDir, "status.json"));
      if (state.runId !== nativeRunId) throw Error("native status identity mismatch");
      if (["complete", "failed", "stopped", "rejected", "partial"].includes(state.state) &&
          ["observed", "not-started"].includes(state.processTerminal?.state)) {
        if (stopTime !== undefined || state.state !== "complete") throw Error("worker " + state.state + ": " + (state.error ?? state.steps?.[0]?.error ?? "no result"));
        const raw = await json(actionFile);
        const action = validateWorkerAction(raw.name, raw.args, input.profile);
        const toolTurns = await json(join(stateDir, round + ".turns.json"));
        if (!Number.isInteger(toolTurns) || toolTurns < 1 || toolTurns > remainingToolTurns) throw Error("invalid worker tool-turn receipt");
        const remaining = remainingToolTurns - toolTurns;
        const tmp = history + "." + round;
        await writeFile(tmp, JSON.stringify({identity, nativeRunId, remainingToolTurns:remaining}), {mode: 0o600}); await rename(tmp, history);
        return {nativeRunId, action, toolTurns, remainingToolTurns:remaining};
      }
      if (state.processTerminal?.state === "unknown" || (stopTime !== undefined && Date.now() - stopTime > 15_000)) throw Error("worker termination is unconfirmed: " + nativeRunId);
      await delay(150);
    }
  } finally {
    if (owner && owner.exitCode===null) owner.kill("SIGTERM");
    await ownerEnded?.catch(()=>{});
    if (bindingOwned) await rm(activeFile, {force: true});
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  }
}
