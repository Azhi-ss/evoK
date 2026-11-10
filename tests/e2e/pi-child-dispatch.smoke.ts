/**
 * Offline protocol smoke, using the actual installed Pi and pi-subagents.
 * bun tests/e2e/pi-child-dispatch.smoke.ts /path/to/pi-subagents/bundle/index.js
 * A disposable Pi home and a loopback-only provider keep the test unbilled.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const plugin = process.argv[2];
if (!plugin) throw Error("pass the installed pi-subagents extension entry");
const engine = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/execution");
// The smoke launches the plugin it was handed, so it declares that install's protocol.
const { probePiSubagentsEntryProtocol } = await import(join(engine, "pi-subagents-protocol.ts"));
const protocolVersion = probePiSubagentsEntryProtocol(resolve(plugin)).version;
const scratch = await mkdtemp(join(tmpdir(), "evok-child-smoke-"));
const home = join(scratch, "pi"),
  cwd = join(scratch, "workspace");
const output = join(scratch, "proof.json"),
  extension = join(scratch, "driver.ts");
const roles = ["researcher", "reviewer"];
const calls: { role?: string; tools: number; key: boolean; max: boolean; clean: boolean }[] = [];

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const messages = JSON.stringify(body.messages);
  const evidence = roles.filter((role) => messages.includes("slice-sentinel-" + role));
  const role = evidence.length === 1 ? evidence[0] : undefined;
  calls.push({
    role,
    tools: body.tools?.length ?? 0,
    key: req.headers.authorization === "Bearer local-test-only",
    max: body.reasoning_effort === "max",
    clean: !/parent-transcript-marker|unrelated-(project|global|skill)-marker/.test(messages),
  });
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const completion = { id: "offline", object: "chat.completion.chunk", model: body.model, created: 0 };
  res.write(
    "data: " +
      JSON.stringify({
        ...completion,
        choices: [{ index: 0, delta: { role: "assistant", content: role }, finish_reason: null }],
      }) +
      "\n\n",
  );
  res.end(
    "data: " +
      JSON.stringify({
        ...completion,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }) +
      "\n\ndata: [DONE]\n\n",
  );
});

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("no loopback port");
  await Promise.all([mkdir(home), mkdir(cwd)]);
  await Promise.all(roles.map((role) => mkdir(join(cwd, role))));
  await writeFile(join(home, "AGENTS.md"), "unrelated-global-marker");
  await writeFile(join(cwd, "AGENTS.md"), "unrelated-project-marker");
  const skill = join(home, "skills/smoke");
  await mkdir(skill, { recursive: true });
  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: smoke\ndescription: unrelated-skill-marker\n---\nAmbient skill.",
  );
  const entry = (path: string) => JSON.stringify(join(engine, path + ".ts"));
  await writeFile(
    extension,
    `
import { writeFileSync } from "node:fs";
import { dispatchPiChild } from ${entry("pi-child-dispatch")};
import { assembleRoleContext } from ${entry("role-context")};
import { createMemorySlice } from ${entry("memory-slice")};
import { createCompetitionContract } from ${entry("../competition/competition-contract")};
import { createRuleVisibilityPolicy } from ${entry("../competition/rule-visibility")};
export default function smoke(pi) {
  const alias="evok-meter-smoke", model="kimi-k3-1-pro-261024";
  pi.registerProvider(alias,{baseUrl:"http://127.0.0.1:${address.port}/v1",api:"openai-completions",apiKey:"local-test-only",authHeader:true,
    models:[{id:model,name:"Offline Kimi",reasoning:true,thinkingLevelMap:{off:null,low:"low",medium:null,high:"high",xhigh:null,max:"max"},
    input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:1048576,maxTokens:32768,compat:{supportsDeveloperRole:false,supportsStrictMode:true}}]});
  pi.registerCommand("test-child",{description:"Test fresh children",handler:async (_args,ctx)=>{
    try {
      pi.sendMessage({customType:"test-history",content:"parent-transcript-marker",display:false});
      const results=[];
      const contract=createCompetitionContract({version:"1",competitionId:"offline",objective:"Improve.",scoring:{metric:"reward",direction:"maximize"},
        dataSplit:{kind:"group",holdout:"protected"},submission:{format:"json"},limits:{network:"restricted"}});
      const policy=createRuleVisibilityPolicy({competitionId:"offline",contractDigest:contract.digest,allow:{researcher:["scoring.metric"],reviewer:["scoring.metric"]}});
      for (const role of ["researcher","reviewer"]) {
        const id={missionId:"mission",taskId:"task-"+role,runId:"run-"+role,targetAgentId:"agent-"+role};
        const memorySlice=createMemorySlice({...id,sliceId:"slice-"+role,findings:[{findingId:"fact",summary:"slice-sentinel-"+role}]});
        const roleContext=assembleRoleContext({...id,role,contract,policy,objective:"Improve.",source:"test",memoryDigest:memorySlice.digest});
        results.push(await dispatchPiChild(pi,{role,task:"Return your role.",model:alias+"/"+model,cwd:ctx.cwd+"/"+role,memorySlice,roleContext,protocolProbe:()=>${JSON.stringify(protocolVersion)},timeoutMs:15_000}));
      }
      writeFileSync(${JSON.stringify(output)},JSON.stringify(results));
    } catch (error) { writeFileSync(${JSON.stringify(output)},JSON.stringify({error:String(error)})); }
  }});
}`,
  );
  const proc = spawn(
    "pi",
    [
      "--offline",
      "--no-session",
      "--no-extensions",
      "--no-mcp",
      "--extension",
      resolve(plugin),
      "--extension",
      extension,
      "--model",
      "evok-meter-smoke/kimi-k3-1-pro-261024",
      "--mode",
      "rpc",
    ],
    {
      cwd,
      env: {
        HOME: scratch,
        PATH: process.env.PATH,
        PI_CODING_AGENT_DIR: home,
        PI_OFFLINE: "1",
        NO_COLOR: "1",
        TERM: "dumb",
      },
      stdio: ["pipe", "ignore", "ignore"],
    },
  );
  const ended = once(proc, "exit");
  try {
    proc.stdin!.write('{"id":"test","type":"prompt","message":"/test-child"}\n');
    let results;
    for (let retry = 0; retry < 450 && proc.exitCode === null; retry++) {
      const data = await readFile(output, "utf8").catch(() => "");
      if (data) {
        results = JSON.parse(data);
        break;
      }
      await delay(100);
    }
    assert.ok(Array.isArray(results), JSON.stringify(results ?? "no Pi child receipt"));
    assert.deepEqual(
      results.map((row) => row.text),
      roles,
    );
    assert.ok(results.every((row) => typeof row.runId === "string" && row.usage?.toolCalls === 0));
    assert.notEqual(results[0].runId, results[1].runId);
    assert.deepEqual(
      calls,
      roles.map((role) => ({ role, tools: 0, key: true, max: true, clean: true })),
    );
    console.log(JSON.stringify({ children: results.map((row) => row.runId), calls }));
  } finally {
    if (proc.exitCode === null) proc.kill("SIGTERM");
    await ended;
  }
} finally {
  server.close();
  await rm(scratch, { recursive: true, force: true });
}
