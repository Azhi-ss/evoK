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
const children = [
  { sentinel: "researcher", role: "researcher", capability: "research", tools: [] as string[] },
  { sentinel: "reviewer", role: "reviewer", capability: "review", tools: [] as string[] },
  { sentinel: "granted", role: "researcher", capability: "research", tools: ["evok_read_evidence"] },
];
const roles = children.map((child) => child.sentinel);
const calls: {
  role?: string;
  tools: number;
  toolNames: string[];
  /** The granted child actually read its evidence: the tool result came back in the prompt. */
  read: boolean;
  key: boolean;
  max: boolean;
  clean: boolean;
}[] = [];

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
  const results = (body.messages ?? []).filter((message: { role?: string }) => message.role === "tool");
  calls.push({
    role,
    tools: body.tools?.length ?? 0,
    toolNames: (body.tools ?? []).map((tool: { function?: { name?: string } }) => tool.function?.name),
    read: results.some((message: { content?: unknown }) =>
      JSON.stringify(message.content ?? "").includes("slice-sentinel-granted"),
    ),
    key: req.headers.authorization === "Bearer local-test-only",
    max: body.reasoning_effort === "max",
    clean: !/parent-transcript-marker|unrelated-(project|global|skill)-marker/.test(messages),
  });
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const completion = { id: "offline", object: "chat.completion.chunk", model: body.model, created: 0 };
  const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 };
  // The granted child's first turn calls its one tool; the second turn answers.
  if (role === "granted" && results.length === 0) {
    res.write(
      "data: " +
        JSON.stringify({
          ...completion,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "evok_read_evidence", arguments: '{"ref":"fact"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }) +
        "\n\n",
    );
    res.end(
      "data: " +
        JSON.stringify({
          ...completion,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage,
        }) +
        "\n\ndata: [DONE]\n\n",
    );
    return;
  }
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
import { buildResearcherContext } from ${entry("researcher-context")};
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
      for (const child of ${JSON.stringify(children)}) {
        const id={missionId:"mission",taskId:"task-"+child.sentinel,runId:"run-"+child.sentinel,targetAgentId:"agent-"+child.sentinel};
        const memorySlice=createMemorySlice({...id,sliceId:"slice-"+child.sentinel,findings:[{findingId:"fact",summary:"slice-sentinel-"+child.sentinel}]});
        const roleContext=assembleRoleContext({...id,role:child.role,contract,policy,objective:"Improve.",source:"test",
          tools:child.tools,memoryDigest:memorySlice.digest});
        const delegation={agent:child.sentinel+"-child",capability:child.capability,task:"Return your role.",
          context:buildResearcherContext({objective:"Improve."}),roleContext,memorySlice,runId:id.runId,targetAgentId:id.targetAgentId};
        results.push(await dispatchPiChild(pi,delegation,{model:alias+"/"+model,cwd:ctx.cwd+"/"+child.sentinel,
          remainingToolTurns:child.tools.length?2:8,protocolProbe:()=>${JSON.stringify(protocolVersion)},timeoutMs:15_000}));
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
      results.map((row) => row.value.text),
      roles,
    );
    assert.ok(results.every((row) => typeof row.value.runId === "string"));
    assert.deepEqual(results.map((row) => row.value.usage?.toolCalls), [0, 0, 1]);
    assert.notEqual(results[0].value.runId, results[1].value.runId);
    const plain = children.filter((child) => child.tools.length === 0);
    assert.deepEqual(
      calls.filter((call) => plain.some((child) => child.sentinel === call.role)),
      plain.map((child) => ({
        role: child.sentinel,
        tools: 0,
        toolNames: [],
        read: false,
        key: true,
        max: true,
        clean: true,
      })),
    );
    // Both of the granted child's turns carry its one tool, and the read came back.
    const granted = calls.filter((call) => call.role === "granted");
    assert.deepEqual(
      granted.map((call) => ({ tools: call.tools, toolNames: call.toolNames, key: call.key, max: call.max })),
      [1, 1].map(() => ({ tools: 1, toolNames: ["evok_read_evidence"], key: true, max: true })),
    );
    assert.deepEqual(granted.map((call) => call.read), [false, true]);
    console.log(JSON.stringify({ children: results.map((row) => row.value.runId), calls }));
  } finally {
    if (proc.exitCode === null) proc.kill("SIGTERM");
    await ended;
  }
} finally {
  server.close();
  await rm(scratch, { recursive: true, force: true });
}
