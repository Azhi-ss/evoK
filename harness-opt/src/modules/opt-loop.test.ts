import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../cli";
import { writeHostAttestation } from "./attestation";
import {
  claimNonce,
  CONTROL_CONFIG_SHA,
  CONTROL_CONFIG_TEXT,
  OPT_MODEL,
  realRunCommand,
  reconcilePrereg,
  assertLiveRoleCall,
  runLiveRoleSmoke,
  stageGapTrace,
  roleFailureIsTransient,
  RoleFailed,
  resolveOfficialTask,
  runOptLoop,
  runOptOnce,
  runRecordArgv,
  relayPlantRead,
  relayPlantRole,
  relayRecord,
  stubOptRoles,
  type OptLoopOptions,
  type OptRoles,
} from "./opt-loop";
import { assertRoleSpawn, hostWriteSession, roleWrite, type RoleSpawnConfig } from "./role-spawn";
import { EFFECTIVE_KNOBS, formatKnobLine, knobCatalog } from "./effective-knobs";
import { renderExecutorCommand, tokenCap, writeRunArtifacts, type OptExecutor, type OptRunRequest, type OptTask, type RunArtifactTiming } from "./opt-executor";

/** Caller-supplied loop target. The loop itself has no built-in task. */
const LOOP_TASK: OptTask = {
  id: "hb003",
  path: "tasks3/hb003",
  split: "dev",
  network: "devii-004-int",
  tokenW: 9_024_166,
};
/** Chief's current box identity. The `...` segment is supplied by the operator; this string is the input, not a default in the loop. */
const ROUND0_TRACE = "heldout/hb003/seed0/.../trace.jsonl";
const ROUND0_SHA = "3e4f857cfbaae07c3901c379bcdcdd681c15f2438881ad943a6ab6cc957b1a76";

/** sha256 of the two-line gate manifest. Same composition as loop_mode.gate_rule_sha. */
function gateRuleManifestSha(): string {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const files = ["docs/reviewer-gate-rules.md", "src/modules/reviewer-gates.ts"];
  const manifest = files.map((rel) => {
    const digest = createHash("sha256").update(readFileSync(join(root, rel))).digest("hex");
    return `${rel} ${digest}\n`;
  }).join("");
  return createHash("sha256").update(manifest).digest("hex");
}

function taskFlags(root: string): string[] {
  return ["--task", LOOP_TASK.id, "--task-path", join(root, "task"), "--network", LOOP_TASK.network, "--token-w", String(LOOP_TASK.tokenW)];
}

function round0Flags(): string[] {
  return ["--round0-trace", ROUND0_TRACE, "--round0-sha", ROUND0_SHA];
}

interface Fixture {
  readonly root: string;
  readonly out: string;
  readonly attestRoot: string;
  readonly keyFile: string;
  readonly harnessPath: string;
  readonly key: Buffer;
  readonly controlConfig: string;
  readonly controlAttest: string;
  readonly controlTrace: string;
}

function fixture(harnessSource?: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), "opt-loop-"));
  const keyFile = join(root, "attest.key");
  const key = Buffer.alloc(32, 9);
  writeFileSync(keyFile, key);
  chmodSync(keyFile, 0o600);
  const harnessPath = join(root, "harness.mjs");
  writeFileSync(harnessPath, harnessSource ?? `${EFFECTIVE_KNOBS.map((key) => `effective["${key}"]`).join("\n")}\n`);
  const taskDir = join(root, "task");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "task.toml"), "[agent]\ntimeout_sec = 3600\n\n[verifier]\ntimeout_sec = 60\n");
  const out = join(root, "out");
  const attestRoot = join(root, "attest");
  mkdirSync(attestRoot, { recursive: true });
  const controlConfig = join(root, "control.json");
  writeFileSync(controlConfig, CONTROL_CONFIG_TEXT);
  const control = attestControl(root, key, harnessPath, controlConfig);
  return {
    root,
    out,
    attestRoot,
    keyFile,
    harnessPath,
    key,
    controlConfig,
    controlAttest: control.attestDir,
    controlTrace: control.tracePath,
  };
}

function hostOpts(fx: Fixture): Pick<OptLoopOptions, "out" | "attestRoot" | "attestKeyFile" | "harnessPath" | "controlAttests" | "controlConfigPath" | "env" | "task" | "round0TracePath" | "round0TraceSha"> {
  return {
    out: fx.out,
    attestRoot: fx.attestRoot,
    attestKeyFile: fx.keyFile,
    harnessPath: fx.harnessPath,
    controlAttests: [fx.controlAttest],
    controlConfigPath: fx.controlConfig,
    env: { HARNESS_RELAY_BIND: "127.0.0.1" },
    task: { ...LOOP_TASK, path: join(fx.root, "task") },
    round0TracePath: ROUND0_TRACE,
    round0TraceSha: ROUND0_SHA,
  };
}

function attestControl(root: string, key: Buffer, harnessPath: string, controlConfig: string): { readonly attestDir: string; readonly tracePath: string } {
  const runDir = join(root, "control-run");
  const attestDir = join(root, "control-attest");
  const request: OptRunRequest = {
    task: LOOP_TASK,
    seed: 0,
    arm: "control",
    configPath: controlConfig,
    runDir,
    attestDir,
    harnessPath,
    model: OPT_MODEL,
    tokenCap: tokenCap(LOOP_TASK),
    relayLogRoot: join(root, "control-relay"),
  };
  const base = 1_700_000_000;
  writeRunArtifacts(request, {
    reward: 1,
    tokens: 10,
    wallS: 1,
    timedOut: false,
    tWrite: base,
    tEnd: base + 1,
    assistantTs: [],
  }, { key, harnessPath });
  return { attestDir, tracePath: join(runDir, "trace.jsonl") };
}

function flattenParts(value: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      Object.assign(out, flattenParts(child as Record<string, unknown>, path));
    } else {
      out[path] = child;
    }
  }
  return out;
}

function timing(request: OptRunRequest, reward: number, tokens = 100): RunArtifactTiming {
  const base = 1_700_000_000;
  const ewi = request.task.id === LOOP_TASK.id && request.arm === "candidate" && request.seed === 1 && request.runDir.includes("/round1/");
  return {
    reward,
    tokens,
    wallS: ewi ? 5409 : 30,
    timedOut: ewi,
    tWrite: base,
    tEnd: base + (ewi ? 5386.8 : 0.5),
    assistantTs: ewi ? [base + 178.1] : [],
  };
}

function observation(request: OptRunRequest, fields: { readonly reward: number; readonly tokens: number; readonly wallS: number; readonly timedOut: boolean }) {
  return {
    reward: fields.reward,
    scoreStatus: "scored" as const,
    tokens: fields.tokens,
    wallS: fields.wallS,
    timedOut: fields.timedOut,
    tracePath: join(request.runDir, "trace.jsonl"),
    outputsDir: join(request.runDir, "outputs"),
    batchLogPath: join(request.runDir, "batch.log"),
  };
}

function fakeExecutor(fx: Fixture): { readonly calls: OptRunRequest[]; readonly executor: OptExecutor } {
  const calls: OptRunRequest[] = [];
  return {
    calls,
    executor: {
      name: "fake",
      async run(request) {
        calls.push(request);
        const reward = request.seed === 2 && request.runDir.includes("/round1/") ? 0 : 1;
        const script = timing(request, reward);
        writeRunArtifacts(request, script, { key: fx.key, harnessPath: fx.harnessPath });
        return observation(request, { reward, tokens: script.tokens, wallS: script.wallS, timedOut: script.timedOut });
      },
    },
  };
}

function rejectingRoles(fx: Fixture): OptRoles & { readonly reviews: number } {
  const roles = stubOptRoles(fx.key);
  let reviews = 0;
  return {
    gap: (input) => roles.gap(input),
    innovate: (input) => roles.innovate(input),
    critic: (input) => roles.critic(input),
    ranker: (input) => roles.ranker(input),
    review: async (input) => {
      reviews += 1;
      const reason = "still idle";
      await plantRole(fx, input, "reviewer", { reason });
      hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "reviewer-gate" })}\n${JSON.stringify({ type: "message", text: reason })}\n`, fx.key);
      return { session: { jsonl: "ignored\n" }, reason };
    },
    get reviews() { return reviews; },
  };
}

function runIdOf(baseUrl: string): string {
  const match = /\/r\/([0-9a-f]{32})\/v1$/.exec(baseUrl);
  if (!match?.[1]) throw new Error("base url has no run id");
  return match[1];
}

function roleLog(root: string, baseUrl: string): string {
  return join(root, runIdOf(baseUrl), "relay.jsonl");
}

function equalKeyRoles(fx: Fixture, winnerId: string, options?: { readonly excluded?: readonly string[]; readonly reviewPlant?: boolean; readonly third?: boolean }): OptRoles {
  const session = (spawn: RoleSpawnConfig, role: string) => {
    hostWriteSession(spawn, `${JSON.stringify({ type: "session", role })}\n`, fx.key);
  };
  return {
    gap: (input) => stubOptRoles(fx.key).gap(input),
    async innovate(input) {
      const slot = input.sessionPath.match(/innovator-(\d+)\.jsonl$/)?.[1] ?? "0";
      const specs: Record<string, { summary: string; maxSteps: number }> = {
        "0": { summary: "agent-loop.maxSteps=20", maxSteps: 20 },
        "1": { summary: "agent-loop.maxSteps=21", maxSteps: 21 },
        ...(options?.third ? { "2": { summary: "agent-loop.maxSteps=22", maxSteps: 22 } } : {}),
      };
      const spec = specs[slot] ?? specs["0"];
      if (!spec) throw new Error("innovator slot");
      await relayPlantRole(input.baseUrl, "innovator", input.round, { summary: spec.summary });
      session(input.spawn, "innovator");
      return { session: { jsonl: "ignored\n" }, summary: spec.summary, parts: { "agent-loop": { maxSteps: spec.maxSteps } } };
    },
    async critic(input) {
      const excluded = [...(options?.excluded ?? [])];
      await relayPlantRole(input.baseUrl, "critic", input.round, { excluded });
      session(input.spawn, "critic");
      return { session: { jsonl: "ignored\n" }, excluded };
    },
    async ranker(input) {
      await relayPlantRole(input.baseUrl, "ranker", input.round, { winnerId });
      session(input.spawn, "ranker");
      return { session: { jsonl: "ignored\n" }, winnerId };
    },
    async review(input) {
      const reason = "hold";
      if (options?.reviewPlant !== false) await relayPlantRole(input.baseUrl, "reviewer", input.round, { reason });
      session(input.spawn, "reviewer-gate");
      return { session: { jsonl: "ignored\n" }, reason };
    },
  };
}

function secondProposal(key: Buffer, input: { readonly baseUrl: string; readonly round: number; readonly spawn: RoleSpawnConfig }): Promise<{ session: { jsonl: string }; summary: string; parts: { "agent-loop": { maxNudges: number } } }> {
  const summary = "agent-loop.maxNudges=1";
  return relayPlantRole(input.baseUrl, "innovator", input.round, { summary }).then(() => {
    hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "innovator" })}\n`, key);
    return { session: { jsonl: "ignored\n" }, summary, parts: { "agent-loop": { maxNudges: 1 } } };
  });
}

function plantRole(
  _fx: Fixture,
  input: { readonly baseUrl: string; readonly round: number },
  role: string,
  body: unknown,
): Promise<void> {
  return relayPlantRole(input.baseUrl, role, input.round, body);
}

const UPSTREAM_USAGE = { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 1 } };

function listenUpstream(usage: typeof UPSTREAM_USAGE = UPSTREAM_USAGE): Promise<{ readonly url: string; readonly hits: Buffer[]; close(): Promise<void> }> {
  const hits: Buffer[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      hits.push(Buffer.concat(chunks));
      const body = JSON.stringify({ usage });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("upstream port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}/v1/chat/completions`,
        hits,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function listenStatusUpstream(failCount: number): Promise<{ readonly url: string; readonly hits: () => number; close(): Promise<void> }> {
  let hits = 0;
  const server = createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      hits += 1;
      if (hits <= failCount) {
        const body = "{\"error\":\"bad gateway\"}";
        res.writeHead(502, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      const payload = JSON.stringify({
        choices: [{ message: { role: "assistant", content: "{}" } }],
        usage: UPSTREAM_USAGE,
      });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
      res.end(payload);
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("upstream port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}/v1/chat/completions`,
        hits: () => hits,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function postForStatus(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "role-call" }] }),
  });
  if (!response.ok) throw new RoleFailed("role", 1, `HTTP ${response.status}`, false);
  await response.arrayBuffer();
}

async function postRole(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "role-call" }] }),
  });
  if (!response.ok) throw new Error(`relay ${response.status}`);
  await response.arrayBuffer();
}

const ECHO_UPSTREAM_PY = `
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length") or "0")
        raw = self.rfile.read(length)
        content = "{}"
        try:
            body = json.loads(raw.decode())
            messages = body.get("messages") or []
            if messages and isinstance(messages[-1], dict):
                content = messages[-1].get("content") or content
        except Exception:
            content = "{}"
        payload = json.dumps({
            "choices": [{"message": {"role": "assistant", "content": content}}],
            "usage": {"prompt_tokens": 11, "completion_tokens": 7, "prompt_tokens_details": {"cached_tokens": 1}},
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        return

server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(server.server_address[1], flush=True)
server.serve_forever()
`;

/** Separate process. A server inside this test deadlocks under spawnSync. */
function startEchoUpstream(): Promise<{ readonly url: string; close(): Promise<void> }> {
  const child = spawn("python3", ["-c", ECHO_UPSTREAM_PY], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("echo upstream did not listen")), 5_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      const line = buf.split("\n")[0]?.trim() ?? "";
      if (!/^\d+$/.test(line)) return;
      clearTimeout(timer);
      resolve({
        url: `http://127.0.0.1:${line}/v1/chat/completions`,
        close: () => {
          child.kill();
          return Promise.resolve();
        },
      });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function listenEchoUpstream(): Promise<{ readonly url: string; readonly hits: number; close(): Promise<void> }> {
  let hits = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      hits += 1;
      let content = "{}";
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: { content?: string }[] };
        content = body.messages?.[body.messages.length - 1]?.content ?? content;
      } catch {
        content = "{}";
      }
      const payload = JSON.stringify({
        choices: [{ message: { role: "assistant", content } }],
        usage: UPSTREAM_USAGE,
      });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
      res.end(payload);
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("upstream port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}/v1/chat/completions`,
        get hits() { return hits; },
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function postRelayReads(baseUrl: string, files: readonly string[]): Promise<void> {
  const messages: object[] = [];
  for (const [index, file] of files.entries()) {
    const id = `c${index}`;
    messages.push({
      role: "assistant",
      tool_calls: [{ id, type: "function", function: { name: "read", arguments: JSON.stringify({ path: file }) } }],
    });
    messages.push({ role: "tool", tool_call_id: id, content: readFileSync(file, "utf8") });
  }
  messages.push({ role: "user", content: "{}" });
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!response.ok) throw new Error(`relay ${response.status}`);
  await response.arrayBuffer();
}

async function postConclusion(baseUrl: string, conclusion: unknown): Promise<void> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: JSON.stringify(conclusion) }] }),
  });
  if (!response.ok) throw new Error(`relay ${response.status}`);
  await response.arrayBuffer();
}

function chatRoles(
  fx: Fixture,
  review: { readonly reported: { readonly reason: string }; readonly recorded: { readonly reason: string } },
): OptRoles {
  const session = (input: { spawn: RoleSpawnConfig }, role: string) => {
    hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role })}\n`, fx.key);
  };
  return {
    async gap(input) {
      const turn = await stubOptRoles(fx.key).gap(input);
      const files = input.traces.map((hint) => hint.file);
      if (files.length > 0) await postRelayReads(input.baseUrl, files);
      return turn;
    },
    async innovate(input) {
      const slot = input.sessionPath.match(/innovator-(\d+)\.jsonl$/)?.[1] ?? "0";
      const maxSteps = slot === "1" ? 20 : 24;
      const summary = `agent-loop.maxSteps=${maxSteps}`;
      await postConclusion(input.baseUrl, { summary });
      session(input, "innovator");
      return { session: { jsonl: "ignored\n" }, summary, parts: { "agent-loop": { maxSteps } } };
    },
    async critic(input) {
      const body = { excluded: [] as string[] };
      await postConclusion(input.baseUrl, body);
      session(input, "critic");
      return { session: { jsonl: "ignored\n" }, excluded: body.excluded };
    },
    async ranker(input) {
      const winnerId = input.candidates[0]?.id ?? "";
      await postConclusion(input.baseUrl, { winnerId });
      session(input, "ranker");
      return { session: { jsonl: "ignored\n" }, winnerId };
    },
    async review(input) {
      await postConclusion(input.baseUrl, review.recorded);
      session(input, "reviewer-gate");
      return { session: { jsonl: "ignored\n" }, reason: review.reported.reason };
    },
  };
}

function lastDone(log: string): { assistant?: string; usage?: unknown } | undefined {
  return readFileSync(log, "utf8").split("\n").map((line) => line.trim()).filter((line) => line !== "").map((line) => JSON.parse(line) as { type?: string; assistant?: string; usage?: unknown }).filter((row) => row.type === "done").at(-1);
}

function plantRelayRead(baseUrl: string, files: readonly string[]): Promise<void> {
  return relayPlantRead(baseUrl, files);
}

/** Test-only wrapper. The production stub does not plant relay reads. */
function citingRoles(key: Buffer, attestRoot: string): OptRoles {
  const stub = stubOptRoles(key);
  const root = join(attestRoot, "relay-logs");
  return {
    async gap(input) {
      const turn = await stub.gap(input);
      const files = [
        ...input.traces.map((hint) => hint.file),
        ...(input.previousReviewSession ? [input.previousReviewSession] : []),
      ];
      if (files.length > 0) {
        await plantRelayRead(input.baseUrl, files);
      }
      return turn;
    },
    innovate: (input) => stub.innovate(input),
    critic: (input) => stub.critic(input),
    ranker: (input) => stub.ranker(input),
    review: (input) => stub.review(input),
  };
}

function perfectRead(file: string, text: string): string {
  const call = {
    type: "message",
    message: { role: "assistant", content: [{ type: "toolCall", id: "c0", name: "read", arguments: { path: file } }], timestamp: 0 },
  };
  const result = {
    type: "message",
    message: { role: "toolResult", toolCallId: "c0", toolName: "read", isError: false, content: [{ type: "text", text }], timestamp: 0 },
  };
  return `${JSON.stringify(call)}\n${JSON.stringify(result)}\n`;
}

describe("optimization loop", () => {
  test("the box control file is the compact config", () => {
    expect(createHash("sha256").update(CONTROL_CONFIG_TEXT).digest("hex")).toBe(CONTROL_CONFIG_SHA);
    expect(createHash("sha256").update(`${JSON.stringify(JSON.parse(CONTROL_CONFIG_TEXT), null, 2)}\n`).digest("hex")).not.toBe(CONTROL_CONFIG_SHA);
  });

  test("one round persists sessions, the patch, and the Pi session that loaded the candidate", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const roles = rejectingRoles(fx);
    const result = await runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 1, roles, executor: fake.executor });
    expect(result.model).toBe(OPT_MODEL);
    expect(result.ewiThresholdSec).toBe(600);
    expect(result.skippedFinal).toBe(true);
    expect(fake.calls.map((call) => `${call.task.id}:${call.seed}:${call.model}`)).toEqual([
      "hb003:0:deepseek-v4-1-flash-261017",
    ]);
    expect(roles.reviews).toBe(1);
    expect(result.stopReport).toEqual({ reason: null, faultRounds: 0, reviewerRejectRounds: 1 });
    const notes = readFileSync(join(fx.out, "round1/run-notes.md"), "utf8");
    expect(notes).toContain("screenshot: round1/screenshot.svg");
    expect(notes).toContain("sessions: round1/sessions");
    expect(readFileSync(join(fx.out, "round1/screenshot.svg"), "utf8")).toContain("data-round=\"1\"");
    const pre = JSON.parse(readFileSync(join(fx.out, "pre-round1.json"), "utf8")) as {
      maxRounds: number;
      readOnlyTokenCap: number;
      readOnlyWallCapS: number;
      realRunWallCapS: number;
      seed: number;
      seedSha: string;
      innovatorCap: number;
      gateRuleSha: string;
      round0Record: { srcPath: string; srcSha256: string; hostCopyPath: string };
    };
    expect(pre.maxRounds).toBe(10);
    expect(pre.readOnlyTokenCap).toBe(30_000_000);
    expect(pre.readOnlyWallCapS).toBe(48 * 3600);
    expect(pre.realRunWallCapS).toBe(103 * 3600);
    expect(pre.seed).toBe(0);
    expect(pre.innovatorCap).toBe(200_000);
    expect(pre.gateRuleSha).toBe(gateRuleManifestSha());
    expect(pre.seedSha).toMatch(/^[0-9a-f]{64}$/);
    expect(pre.round0Record).toEqual({
      srcPath: ROUND0_TRACE,
      srcSha256: ROUND0_SHA,
      hostCopyPath: "",
    });
    expect(notes).toContain("reward:");

    const manifest = JSON.parse(readFileSync(join(fx.out, "round1/sessions/manifest.json"), "utf8")) as {
      sessions: { role: string; file: string; sha256: string }[];
    };
    expect(manifest.sessions.map((item) => item.role)).toEqual([
      "gap-finder",
      "innovator",
      "innovator",
      "innovator",
      "innovator",
      "innovator",
      "innovator",
      "critic",
      "reviewer-gate",
    ]);
    for (const item of manifest.sessions) {
      const bytes = readFileSync(join(fx.out, item.file));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(item.sha256);
    }
    const gapSession = readFileSync(join(fx.out, "round1/sessions/gap-finder.jsonl"), "utf8");
    expect(gapSession).toContain("\"role\":\"gap-finder\"");
    expect(gapSession).toContain("gap");
    expect(gapSession).not.toContain("ignored-return");
    expect(existsSync(join(fx.out, "baseline/hb003/seed0/trace.jsonl"))).toBe(false);

    const diff = readFileSync(join(fx.out, "round1/patch.diff"), "utf8");
    expect(diff).toContain('"maxSteps":25');
    expect(diff).toContain('"maxSteps": 24');
    const patchHash = createHash("sha256").update(readFileSync(join(fx.out, "round1/patch.diff"))).digest("hex");
    const activation = JSON.parse(readFileSync(join(fx.out, "round1/activation.json"), "utf8")) as {
      patchHash: string;
      differsFromControl: boolean;
      patchActive: boolean;
      candidateConfigSha: string;
      runs: { seed: number; tracePath: string; hashInSystemMessage: boolean; active: boolean; attestOk: boolean }[];
    };
    expect(activation.patchHash).toBe(patchHash);
    expect(activation).not.toHaveProperty("marker");
    expect(activation.differsFromControl).toBe(true);
    expect(activation.patchActive).toBe(true);
    for (const run of activation.runs) {
      expect(run.attestOk).toBe(true);
      const line = readFileSync(run.tracePath, "utf8").split("\n")[0] ?? "";
      const start = JSON.parse(line) as { systemPrompt?: string; candidateConfigHash?: string };
      expect(start.systemPrompt).toBeUndefined();
      expect(start.candidateConfigHash).toBe(activation.candidateConfigSha);
      const session = readFileSync(join(run.tracePath, "../.pi-sessions/session.jsonl"), "utf8");
      expect(session).toContain(`candidateConfigHash: ${activation.candidateConfigSha}`);
      expect(run.hashInSystemMessage).toBe(true);
      expect(run.active).toBe(true);
    }

    const metrics = JSON.parse(readFileSync(join(fx.out, "round1/metrics.json"), "utf8")) as {
      ewiThresholdSec: number;
      ewiThresholdLabel: string;
      runs: { seed: number; reward: number | null; ewi: boolean | null; ewiVerdict: string }[];
      ewiRuns: { seed: number; reward: number | null }[];
      rewardMean: number;
      withoutEwi: { count: number; rewardMean: number | null; timedOut: number };
    };
    expect(metrics.ewiThresholdSec).toBe(600);
    expect(metrics.ewiThresholdLabel).toBe("新口径下未校准");
    expect(result.ewiThresholdLabel).toBe("新口径下未校准");
    expect(metrics.ewiRuns).toEqual([]);
    expect(metrics.runs.map((run) => run.ewi)).toEqual([null]);
    expect(metrics.runs.map((run) => run.ewiVerdict)).toEqual(["EWI不可判"]);
    expect(metrics.runs.map((run) => run.reward)).toEqual([1]);
    expect(metrics.rewardMean).toBe(1);
    expect(metrics.withoutEwi).toEqual({ count: 0, rewardMean: null, timedOut: 0 });
    expect(readFileSync(join(fx.out, "round1/run-notes.md"), "utf8")).toContain(`patchSha: ${patchHash}`);
    const reviewInput = readFileSync(join(fx.out, "round1/review-input.json"), "utf8");
    expect(reviewInput).not.toContain("i030");
    expect(reviewInput).not.toContain("hb003");
    expect(reviewInput).not.toContain("held-out");
  });

  test("a forged trace or outputs mtime does not change the scored relay EWI", async () => {
    const fx = fixture();
    let armed = "";
    const executor: OptExecutor = {
      name: "forged",
      async run(request) {
        writeRunArtifacts(request, {
          reward: 1,
          tokens: 10,
          wallS: 1,
          timedOut: false,
          tWrite: 0,
          tEnd: 700,
          assistantTs: [],
        }, { key: fx.key, harnessPath: fx.harnessPath });
        writeFileSync(join(request.runDir, "trace.jsonl"), `${JSON.stringify({ type: "assistant_message", ts: 699_000 })}\n`);
        utimesSync(join(request.runDir, "outputs", "answer.txt"), 699, 699);
        const log = join(request.relayLogRoot ?? "", request.runId ?? "", "relay.jsonl");
        const rows = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type?: string; ts_resp_end?: number });
        for (const row of rows) if (row.type === "done") row.ts_resp_end = 1010;
        writeFileSync(log, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
        return observation(request, { reward: 1, tokens: 10, wallS: 1, timedOut: false });
      },
    };
    await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      roles: rejectingRoles(fx),
      executor,
      now: () => new Date(1050 * 1000),
      resultWatcher: {
        arm(file) { armed = file; },
        snapshot() { return { tFirst: 1000, tLastWrite: 1000 }; },
      },
    });
    expect(armed.endsWith(`${join("outputs", "answer.txt")}`)).toBe(true);
    const metrics = JSON.parse(readFileSync(join(fx.out, "round1/metrics.json"), "utf8")) as {
      runs: { ewi: boolean | null; idleS: number; gapMaxS: number; ewi_trace_ref: { idleS: number; ewi: boolean } | null }[];
    };
    const runDir = join(fx.out, "round1/runs/hb003/seed0/candidate");
    expect(existsSync(join(runDir, "summary.csv"))).toBe(false);
    expect(metrics.runs[0]?.ewi).toBe(false);
    expect(metrics.runs[0]?.idleS).toBe(40);
    expect(metrics.runs[0]?.gapMaxS).toBe(40);
    expect(metrics.runs[0]?.ewi_trace_ref?.idleS).toBe(1);
    expect(metrics.runs[0]?.ewi_trace_ref?.ewi).toBe(false);
  });

  test("a missing host write observation is EWI不可判", async () => {
    const fx = fixture();
    const executor: OptExecutor = {
      name: "clear-trace",
      async run(request) {
        writeRunArtifacts(request, {
          reward: 1,
          tokens: 10,
          wallS: 1,
          timedOut: false,
          tWrite: 1_700_000_000,
          tEnd: 1_700_000_001,
          assistantTs: [1_700_000_000.2],
        }, { key: fx.key, harnessPath: fx.harnessPath });
        return observation(request, { reward: 1, tokens: 10, wallS: 1, timedOut: false });
      },
    };
    await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      roles: rejectingRoles(fx),
      executor,
    });
    const metrics = JSON.parse(readFileSync(join(fx.out, "round1/metrics.json"), "utf8")) as {
      runs: { ewi: boolean | null; ewiVerdict: string }[];
    };
    expect(metrics.runs[0]?.ewi).toBeNull();
    expect(metrics.runs[0]?.ewiVerdict).toBe("EWI不可判");
  });

  test("EWI_IDLE_SCRIPT override is rejected on the scored path", async () => {
    const fx = fixture();
    const previous = process.env.EWI_IDLE_SCRIPT;
    process.env.EWI_IDLE_SCRIPT = "/tmp/not-the-approved-ewi.py";
    try {
      const result = await runOptLoop({
        ...hostOpts(fx),
        mode: "dry-run",
        rounds: 1,
        roles: rejectingRoles(fx),
        executor: fakeExecutor(fx).executor,
      });
      expect(result.stopReport.reason).toBe("internal_error");
      expect(result.stopReport.stderrTail).toContain("EWI_IDLE_SCRIPT");
      const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { reason?: string; roleFailure?: { stderrTail?: string } };
      expect(closure.reason).toBe("internal_error");
      expect(closure.roleFailure?.stderrTail).toContain("EWI_IDLE_SCRIPT");
      expect(existsSync(join(fx.out, "loop-result.json"))).toBe(true);
      expect(result.accepted).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.EWI_IDLE_SCRIPT;
      else process.env.EWI_IDLE_SCRIPT = previous;
    }
  });

  test("the next gap input receives the reviewer reason, and a repeated summary is not run", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    let innovateCalls = 0;
    const roles: OptRoles = {
      gap: (input) => stubOptRoles(fx.key).gap(input),
      critic: (input) => stubOptRoles(fx.key).critic(input),
      ranker: (input) => stubOptRoles(fx.key).ranker(input),
      async innovate(input) {
        innovateCalls += 1;
        writeFileSync(input.sessionPath, `${JSON.stringify({ type: "session", role: "innovator" })}\n`);
        if (input.round > 1) {
          await plantRole(fx, input, "innovator", { summary: "agent-loop.maxSteps=24" });
          return { session: { jsonl: "ignored\n" }, summary: "agent-loop.maxSteps=24", parts: { "agent-loop": { maxSteps: 24 } } };
        }
        return stubOptRoles(fx.key).innovate(input);
      },
      review: async (input) => {
        const reason = "still idle";
        await plantRole(fx, input, "reviewer", { reason });
        hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "reviewer-gate" })}\n${JSON.stringify({ type: "message", text: reason })}\n`, fx.key);
        return { session: { jsonl: "ignored\n" }, reason };
      },
    };
    const result = await runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 2, roles, executor: fake.executor });
    const gapInput = JSON.parse(readFileSync(join(fx.out, "round2/gap-input.json"), "utf8")) as { previousReview: { reason: string } };
    expect(gapInput.previousReview.reason).toBe("still idle");
    const gapSession = readFileSync(join(fx.out, "round2/sessions/gap-finder.jsonl"), "utf8");
    expect(gapSession).toContain("gap");
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { reviewFedForward: boolean; closed: boolean };
    expect(closure.reviewFedForward).toBe(false);
    expect(closure.closed).toBe(false);
    expect(innovateCalls).toBe(12);
    expect(fake.calls).toHaveLength(1);
    expect(existsSync(join(fx.out, "round2/sessions/reviewer-gate.jsonl"))).toBe(true);
    expect(readFileSync(join(fx.out, "round2/sessions/reviewer-gate.jsonl"), "utf8")).toContain("duplicate summary");
    const skipped = JSON.parse(readFileSync(join(fx.out, "round2/closure.json"), "utf8")) as { noWinner?: string };
    expect(skipped.noWinner).toBe("duplicate summary");
    expect(result.rounds[1]?.noWinner).toBe("duplicate summary");
    expect(result.stopReport.noWinner).toEqual([{ round: 2, reason: "duplicate summary" }]);
    expect(existsSync(join(fx.out, "final/order.json"))).toBe(false);
  });

  test("three rejected rounds skip the final block and held-out", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 3,
      roles: rejectingRoles(fx),
      executor: fake.executor,
    });
    expect(result.skippedFinal).toBe(true);
    expect(result.finalBlock).toBeNull();
    expect(result.heldOut).toBeNull();
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls.every((call) => call.task.id === "hb003" && call.task.network === "devii-004-int")).toBe(true);
  });

  test("a run past 6×W is unscored and stays out of the reward mean", async () => {
    const fx = fixture();
    const calls: OptRunRequest[] = [];
    const executor: OptExecutor = {
      name: "fake",
      async run(request) {
        calls.push(request);
        const over = request.seed === 0;
        const script = timing(request, 1, over ? tokenCap(LOOP_TASK) + 1 : 10);
        writeRunArtifacts(request, { ...script, timedOut: false, tEnd: script.tWrite + 0.5, assistantTs: [] }, { key: fx.key, harnessPath: fx.harnessPath });
        return observation(request, { reward: 1, tokens: over ? tokenCap(LOOP_TASK) + 1 : 10, wallS: 10, timedOut: false });
      },
    };
    await runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 1, roles: rejectingRoles(fx), executor });
    const metrics = JSON.parse(readFileSync(join(fx.out, "round1/metrics.json"), "utf8")) as {
      runs: { seed: number; scoreStatus: string; unscoredReason?: string; reward: number | null }[];
      rewardMean: number | null;
    };
    expect(metrics.runs).toHaveLength(1);
    expect(metrics.runs[0]).toMatchObject({ seed: 0, scoreStatus: "unscored", unscoredReason: "token_cap", reward: null });
    expect(metrics.rewardMean).toBeNull();
  });

  test("a null evaluator score stays unscored and keeps the evaluator reason", async () => {
    const fx = fixture();
    const reason = "gold labels missing for the hidden split";
    const executor: OptExecutor = {
      name: "fake",
      async run(request) {
        const script = timing(request, 0);
        writeRunArtifacts(request, { ...script, timedOut: false, tEnd: script.tWrite + 0.5, assistantTs: [] }, { key: fx.key, harnessPath: fx.harnessPath });
        const verifier = join(request.runDir, "verifier");
        const checker = join(request.relayLogRoot ?? "", request.runId ?? "", "checker");
        writeFileSync(join(verifier, ".scorer-result.json"), `${JSON.stringify({ total_score: null, reward: null, reason })}\n`);
        writeFileSync(join(verifier, "breakdown.json"), `${JSON.stringify({
          total_score: 0,
          reward: 0,
          issues: ["checker_exception: ValueError: private evaluator returned non-finite score"],
        })}\n`);
        const relayDir = fileURLToPath(new URL("../../relay", import.meta.url));
        const kept = spawnSync("python3", ["-c", [
          "import sys",
          "sys.path.insert(0, sys.argv[1])",
          "import hooks",
          "hooks.preserve_scorer_result(sys.argv[2], sys.argv[3])",
        ].join("\n"), relayDir, verifier, checker], { encoding: "utf8" });
        if (kept.status !== 0) throw new Error(kept.stderr || kept.stdout || "preserve failed");
        unlinkSync(join(verifier, ".scorer-result.json"));
        return observation(request, { reward: 0, tokens: script.tokens, wallS: script.wallS, timedOut: false });
      },
    };
    await runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 1, roles: rejectingRoles(fx), executor });
    const metrics = JSON.parse(readFileSync(join(fx.out, "round1/metrics.json"), "utf8")) as {
      runs: { seed: number; scoreStatus: string; unscoredReason?: string; reward: number | null }[];
      rewardMean: number | null;
    };
    expect(metrics.runs).toHaveLength(1);
    expect(metrics.runs[0]).toMatchObject({ seed: 0, scoreStatus: "unscored", unscoredReason: reason, reward: null });
    expect(metrics.rewardMean).toBeNull();
    const review = readFileSync(join(fx.out, "round1/review-input.json"), "utf8");
    expect(review).toContain(reason);
    const logs = join(fx.attestRoot, "relay-logs");
    const copied = readdirSync(logs)
      .map((id) => join(logs, id, "checker", ".scorer-result.json"))
      .find((file) => existsSync(file));
    expect(copied).toBeTruthy();
    expect(JSON.parse(readFileSync(copied ?? "", "utf8")).reason).toBe(reason);
    expect(existsSync(join(copied ?? "", "..", "..", "run-record.json"))).toBe(false);
  });

  test("execute mode refuses to start without BASE_URL", async () => {
    const fx = fixture();
    await expect(runOptLoop({
      ...hostOpts(fx),
      mode: "execute",
      rounds: 1,
      env: {},
      roles: stubOptRoles(fx.key),
      executorCommand: ["python3", "{driver}", "--task", "{task}", "--run-dir", "{runDir}", "--attest-dir", "{attestDir}"],
      driver: join(fx.root, "driver.py"),
    })).rejects.toThrow(/BASE_URL/);
  });

  test("execute mode's real run is the once entry", () => {
    const fx = fixture();
    const command = realRunCommand();
    const text = command.join("\n");
    expect(text).toContain("once");
    expect(text).toContain("--relay-external");
    expect(text).toContain("{taskPath}");
    expect(text).toContain("{runDir}");
    expect(text).toContain("{attestDir}");
    expect(text).toContain("{harness}");
    expect(text).toContain("{runId}");
    expect(text).toContain("{relayLog}");
    expect(text).not.toContain("API_KEY");
    const request: OptRunRequest = {
      task: LOOP_TASK,
      seed: 9,
      arm: "control",
      configPath: join(fx.root, "control.json"),
      runDir: join(fx.root, "run"),
      attestDir: join(fx.root, "attest"),
      harnessPath: fx.harnessPath,
      runId: "ab".repeat(16),
      nonce: "cd".repeat(16),
      relayLogRoot: join(fx.root, "relay"),
      model: OPT_MODEL,
      tokenCap: tokenCap(LOOP_TASK),
    };
    const rendered = renderExecutorCommand(command, request);
    const joined = rendered.join("\n");
    expect(joined).not.toContain("API_KEY");
    expect(rendered).toContain("once");
    expect(rendered).toContain("--relay-external");
    expect(rendered).toContain("tasks3/hb003");
    expect(rendered).toContain(request.runDir);
    expect(rendered).toContain(request.attestDir);
    expect(rendered).toContain(fx.harnessPath);
    expect(rendered).toContain(request.runId);
    expect(rendered).toContain(join(fx.root, "relay", request.runId ?? "", "relay.jsonl"));
  });

  test("the seed-9 prereg uses the configured task", () => {
    const fx = fixture();
    const config = join(fx.root, "control.json");
    writeFileSync(config, CONTROL_CONFIG_TEXT);
    expect(() => reconcilePrereg("tasks3/hb003", "", config, 9, "control")).toThrow(/reconcile task/);
    const accepted = reconcilePrereg("tasks3/hb003", "hb003", config, 9, "control");
    expect(accepted).toEqual({ accepted: true, purpose: "reconcile", exclude: true });
    const other = reconcilePrereg("tasks2/i014", "hb003", config, 9, "control");
    expect(other.accepted).toBe(false);
    expect(other.exclude).toBe(false);
    const later = reconcilePrereg("hb003", "hb003", config, 8, "control");
    expect(later.accepted).toBe(false);
  });

  test("round 1 refuses a missing, forged, or mis-bound control attestation", async () => {
    const fx = fixture();
    const roles = stubOptRoles(fx.key);
    const executor = fakeExecutor(fx).executor;
    await expect(runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 1, controlAttests: [], roles, executor })).rejects.toThrow(/control attestation/);
    await expect(runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      controlAttests: [join(fx.root, "missing-attest")],
      roles,
      executor,
    })).rejects.toThrow(/control attestation/);
    const raw = readFileSync(join(fx.controlAttest, "attestation.json"), "utf8");
    writeFileSync(join(fx.controlAttest, "attestation.json"), raw.replace("\"hmacSha256\": \"", "\"hmacSha256\": \"00"));
    await expect(runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 1, roles, executor })).rejects.toThrow(/hmac/);
    expect(existsSync(join(fx.out, "round1/sessions/gap-finder.jsonl"))).toBe(false);
    expect(existsSync(join(fx.out, "baseline/hb003/seed0/trace.jsonl"))).toBe(false);

    const pretty = join(fx.root, "pretty-control.json");
    writeFileSync(pretty, `${JSON.stringify(JSON.parse(CONTROL_CONFIG_TEXT), null, 2)}\n`);
    const prettyRun = join(fx.root, "pretty-run");
    const prettyAttest = join(fx.root, "pretty-attest");
    writeRunArtifacts({
      task: LOOP_TASK,
      seed: 0,
      arm: "control",
      configPath: pretty,
      runDir: prettyRun,
      attestDir: prettyAttest,
      harnessPath: fx.harnessPath,
      model: OPT_MODEL,
      tokenCap: tokenCap(LOOP_TASK),
      relayLogRoot: join(fx.root, "pretty-relay"),
    }, { reward: 1, tokens: 10, wallS: 1, timedOut: false, tWrite: 1_700_000_000, tEnd: 1_700_000_001, assistantTs: [] }, { key: fx.key, harnessPath: fx.harnessPath });
    await expect(runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      controlAttests: [prettyAttest],
      roles,
      executor,
    })).rejects.toThrow(/config/);
  });

  test("a path mentioned in the gap text is not a read of the trace", async () => {
    const fx = fixture();
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fakeExecutor(fx).executor,
      roles: {
        ...stubOptRoles(fx.key),
        async gap(input) {
          const file = input.traces[0]?.file ?? "";
          const text = readFileSync(file, "utf8");
          writeFileSync(input.sessionPath, `${JSON.stringify({ type: "message", role: "assistant", text: `cited ${file}:1` })}\n`);
          return {
            session: { jsonl: perfectRead(file, text) },
            citations: [`${file}:1`],
            knob: "agent-loop.maxSteps",
            failureClass: "idle-loop",
            summary: "early write then idle",
          };
        },
        async review(input) {
          writeFileSync(input.sessionPath, "{\"type\":\"message\",\"text\":\"accept\"}\n");
          return { session: { jsonl: perfectRead(input.sessionPath, "nope") }, reason: "accept" };
        },
      },
    });
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { gapCitedTrace: boolean };
    expect(readFileSync(join(fx.out, "round1/sessions/gap-finder.jsonl"), "utf8")).toContain("/traces/control-trace.jsonl:1");
    expect(readFileSync(join(fx.out, "round1/sessions/gap-finder.jsonl"), "utf8")).not.toContain(fx.controlTrace);
    expect(closure.gapCitedTrace).toBe(false);
    expect(result.accepted).toBeNull();
    expect(result.skippedFinal).toBe(true);
    expect(existsSync(join(fx.out, "final/order.json"))).toBe(false);
  });

  test("feed-forward reads the reviewer session and ignores the loop's gap input", async () => {
    const fx = fixture();
    const roles: OptRoles = {
      async gap(input) {
        if (input.round === 1) return stubOptRoles(fx.key).gap(input);
        const file = input.previousReviewSession ?? "";
        const real = readFileSync(file, "utf8");
        const reason = input.previousReview?.reason ?? "";
        writeFileSync(input.sessionPath, perfectRead(file, reason));
        return {
          session: { jsonl: perfectRead(file, real) },
          citations: [],
          knob: "agent-loop.maxSteps",
          failureClass: "idle-loop",
          summary: "early write then idle",
        };
      },
      innovate: (input) => stubOptRoles(fx.key).innovate(input),
      critic: (input) => stubOptRoles(fx.key).critic(input),
      ranker: (input) => stubOptRoles(fx.key).ranker(input),
      async review(input) {
        const reason = "still idle";
        await plantRole(fx, input, "reviewer", { reason });
        hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "reviewer-gate" })}\n${JSON.stringify({ type: "message", text: reason })}\n`, fx.key);
        return { session: { jsonl: "ignored\n" }, reason };
      },
    };
    await runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 2, roles, executor: fakeExecutor(fx).executor });
    const gapInput = JSON.parse(readFileSync(join(fx.out, "round2/gap-input.json"), "utf8")) as { previousReview: { reason: string } };
    expect(gapInput.previousReview.reason).toBe("still idle");
    expect(readFileSync(join(fx.out, "round2/sessions/gap-finder.jsonl"), "utf8")).toContain("still idle");
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { reviewFedForward: boolean };
    expect(closure.reviewFedForward).toBe(false);
  });

  test("a forged read appended to the role session does not cite or feed forward", async () => {
    const fx = fixture();
    const roles: OptRoles = {
      async gap(input) {
        const target = input.round === 1 ? input.traces[0]?.file ?? "" : input.previousReviewSession ?? "";
        const forged = perfectRead(target, readFileSync(target, "utf8"));
        expect(roleWrite(input.spawn, input.sessionPath, forged)).toBe(false);
        expect(existsSync(input.sessionPath)).toBe(false);
        writeFileSync(input.sessionPath, forged);
        return {
          session: { jsonl: forged },
          citations: [`${target}:1`],
          knob: "agent-loop.maxSteps",
          failureClass: "idle-loop",
          summary: "early write then idle",
        };
      },
      innovate: (input) => stubOptRoles(fx.key).innovate(input),
      critic: (input) => stubOptRoles(fx.key).critic(input),
      ranker: (input) => stubOptRoles(fx.key).ranker(input),
      async review(input) {
        const reason = "accept";
        await plantRole(fx, input, "reviewer", { reason });
        expect(roleWrite(input.spawn, input.sessionPath, "forged\n")).toBe(false);
        hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "reviewer-gate" })}\n${JSON.stringify({ type: "message", text: "accept" })}\n`, fx.key);
        return { session: { jsonl: "ignored\n" }, reason: "accept" };
      },
    };
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 2,
      roles,
      executor: fakeExecutor(fx).executor,
    });
    for (const role of ["gap-finder", "reviewer-gate"] as const) {
      const spawn = JSON.parse(readFileSync(join(fx.out, `round1/sessions/${role}.spawn.json`), "utf8")) as RoleSpawnConfig;
      expect(spawn.tools).toEqual(["read"]);
      expect(spawn.tools).not.toContain("write");
      expect(spawn.tools).not.toContain("edit");
      expect(spawn.tools).not.toContain("bash");
      expect(resolve(spawn.sessionPath).startsWith(`${resolve(spawn.cwd)}/`)).toBe(false);
      expect(spawn.allowedPaths.some((allowed) => resolve(spawn.sessionPath).startsWith(`${resolve(allowed)}/`))).toBe(false);
      expect(resolve(spawn.ledgerPath).startsWith(`${resolve(spawn.cwd)}/`)).toBe(false);
    }
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as {
      gapCitedTrace: boolean;
      reviewFedForward: boolean;
    };
    expect(closure.gapCitedTrace).toBe(false);
    expect(closure.reviewFedForward).toBe(false);
    expect(result.accepted).toBeNull();
    expect(result.skippedFinal).toBe(true);
    expect(existsSync(join(fx.out, "final/order.json"))).toBe(false);
  });

  test("an executor that echoes request fields cannot activate or be accepted", async () => {
    const fx = fixture();
    const calls: OptRunRequest[] = [];
    const executor: OptExecutor = {
      name: "echo",
      async run(request) {
        calls.push(request);
        const bytes = readFileSync(request.configPath);
        const hash = createHash("sha256").update(bytes).digest("hex");
        const config = JSON.parse(bytes.toString()) as { parts?: Record<string, unknown> };
        const echoed = {
          config: request.configPath,
          model: request.model,
          arm: request.arm,
          seed: request.seed,
          task: request.task.id,
          tokenCap: request.tokenCap,
        };
        mkdirSync(join(request.runDir, "outputs"), { recursive: true });
        const answer = join(request.runDir, "outputs", "answer.txt");
        writeFileSync(answer, "echo\n");
        const base = 1_700_000_000;
        utimesSync(answer, base, base);
        writeFileSync(join(request.runDir, "trace.jsonl"), `${JSON.stringify({
          type: "run_start",
          systemPrompt: JSON.stringify(echoed),
          candidateConfigHash: hash,
          effective: flattenParts(config.parts ?? {}),
        })}\n`);
        writeFileSync(join(request.runDir, "batch.log"), `${new Date((base + 1) * 1000).toISOString()} run 1 done\n`);
        mkdirSync(join(request.runDir, "verifier"), { recursive: true });
        writeFileSync(join(request.runDir, "verifier", "reward.txt"), "1\n");
        mkdirSync(join(request.runDir, ".pi-sessions"), { recursive: true });
        writeFileSync(join(request.runDir, ".pi-sessions/session.jsonl"), `${JSON.stringify({
          type: "message",
          message: { role: "system", content: JSON.stringify(echoed), timestamp: 0 },
        })}\n`);
        writeFileSync(join(request.runDir, "result.json"), `${JSON.stringify({
          reward: 1, tokens: 10, wall_s: 1, timed_out: false, score_status: "scored",
        })}\n`);
        return observation(request, { reward: 1, tokens: 10, wallS: 1, timedOut: false });
      },
    };
    const result = await runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 1, roles: stubOptRoles(fx.key), executor });
    expect(calls[0]).not.toHaveProperty("marker");
    expect(calls[0]).not.toHaveProperty("patchHash");
    const activation = JSON.parse(readFileSync(join(fx.out, "round1/activation.json"), "utf8")) as {
      patchActive: boolean;
      runs: { hashInSystemMessage: boolean; attestOk: boolean; active: boolean }[];
    };
    expect(activation.runs.every((run) => run.attestOk === false && run.hashInSystemMessage === false && run.active === false)).toBe(true);
    expect(activation.patchActive).toBe(false);
    expect(result.accepted).toBeNull();
    expect(result.rounds[0]?.accepted).toBe(false);
    expect(result.skippedFinal).toBe(true);
    expect(result.finalBlock).toBeNull();
    expect(result.heldOut).toBeNull();
    expect(existsSync(join(fx.out, "final/order.json"))).toBe(false);
    expect(calls).toHaveLength(1);
    expect(result.stopReport.reason).toBe("anti_forgery");
    const metrics = JSON.parse(readFileSync(join(fx.out, "round1/metrics.json"), "utf8")) as {
      runs: { scoreStatus: string; unscoredReason?: string; reward: number | null }[];
    };
    expect(metrics.runs.every((run) => run.scoreStatus === "unscored" && run.unscoredReason === "attest_mismatch" && run.reward === null)).toBe(true);
  });

  test("a forged Pi session and a stdout attestation path cannot activate", async () => {
    const fx = fixture();
    const calls: OptRunRequest[] = [];
    const executor: OptExecutor = {
      name: "sessforge",
      async run(request) {
        calls.push(request);
        const script = timing(request, 1, 10);
        writeRunArtifacts(request, { ...script, timedOut: false, tEnd: script.tWrite + 0.5, assistantTs: [] });
        const side = join(fx.root, "side-attest", `${request.seed}`);
        const resultPath = join(request.runDir, "result.json");
        const result = JSON.parse(readFileSync(resultPath, "utf8")) as { attestation?: string };
        result.attestation = join(side, "attestation.json");
        writeFileSync(resultPath, `${JSON.stringify(result)}\n`);
        writeHostAttestation({
          attestDir: side,
          runDir: request.runDir,
          key: fx.key,
          harnessPath: fx.harnessPath,
          configPath: request.configPath,
          reward: 1,
          meta: {
            task: request.task.path,
            seed: request.seed,
            arm: request.arm,
            score_status: "scored",
            tokens: 10,
            exit: 0,
            runDir: request.runDir,
            runId: request.runId ?? "side-run",
            runPath: request.runDir,
            at: "2026-10-21T00:00:00+09:00",
          },
        });
        writeFileSync(join(request.runDir, "attestation.json"), readFileSync(join(side, "attestation.json")));
        return observation(request, { reward: 1, tokens: 10, wallS: 1, timedOut: false });
      },
    };
    const result = await runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 1, roles: stubOptRoles(fx.key), executor });
    const session = readFileSync(join(calls[0]?.runDir ?? "", ".pi-sessions/session.jsonl"), "utf8");
    const candidate = createHash("sha256").update(readFileSync(calls[0]?.configPath ?? "")).digest("hex");
    expect(session).toContain(`candidateConfigHash: ${candidate}`);
    const activation = JSON.parse(readFileSync(join(fx.out, "round1/activation.json"), "utf8")) as {
      patchActive: boolean;
      runs: { attestOk: boolean; active: boolean }[];
    };
    expect(activation.runs.every((run) => run.attestOk === false && run.active === false)).toBe(true);
    expect(activation.patchActive).toBe(false);
    expect(result.accepted).toBeNull();
    expect(result.skippedFinal).toBe(true);
    expect(existsSync(join(fx.out, "final/order.json"))).toBe(false);
    expect(existsSync(join(fx.attestRoot, "round1", "hb003", "seed0", "candidate", "attestation.json"))).toBe(false);
  });

  test("a second loop into the same out is rejected before the executor runs", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    await runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 1, roles: rejectingRoles(fx), executor: fake.executor });
    const calls = fake.calls.length;
    await expect(runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      roles: rejectingRoles(fx),
      executor: fake.executor,
    })).rejects.toThrow(/run dir already exists/);
    expect(fake.calls).toHaveLength(calls);
  });

  test("a used nonce is rejected", () => {
    const fx = fixture();
    const nonce = "ab".repeat(16);
    expect(claimNonce(fx.attestRoot, nonce)).toBe(nonce);
    expect(() => claimNonce(fx.attestRoot, nonce)).toThrow(/nonce already used/);
  });

  test("a control attestation with a mismatched run path is not scored", async () => {
    const fx = fixture();
    const runDir = join(fx.root, "control-run");
    writeHostAttestation({
      attestDir: fx.controlAttest,
      runDir,
      key: fx.key,
      harnessPath: fx.harnessPath,
      configPath: fx.controlConfig,
      reward: 1,
      meta: {
        task: LOOP_TASK.path,
        seed: 0,
        arm: "control",
        score_status: "scored",
        tokens: 10,
        exit: 0,
        runDir,
        runId: "cd".repeat(16),
        runPath: join(fx.root, "not-the-run"),
        at: "2026-10-21T00:00:00+09:00",
      },
    });
    const fake = fakeExecutor(fx);
    await expect(runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      roles: rejectingRoles(fx),
      executor: fake.executor,
    })).rejects.toThrow(/runPath/);
    expect(fake.calls).toHaveLength(0);
    expect(existsSync(join(fx.out, "round1/metrics.json"))).toBe(false);
  });

  test("a symlink in outputs before start does not launch the executor", async () => {
    const fx = fixture();
    const runDir = join(fx.out, "round1", "runs", "hb003", "seed0", "candidate");
    mkdirSync(runDir, { recursive: true });
    symlinkSync(fx.harnessPath, join(runDir, "outputs"));
    const fake = fakeExecutor(fx);
    await runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 1, roles: rejectingRoles(fx), executor: fake.executor });
    expect(fake.calls).toHaveLength(0);
    const metrics = JSON.parse(readFileSync(join(fx.out, "round1/metrics.json"), "utf8")) as {
      runs: { scoreStatus: string; unscoredReason?: string; reward: number | null }[];
    };
    expect(metrics.runs[0]).toMatchObject({ scoreStatus: "unscored", unscoredReason: "prerun_layout", reward: null });
  });

  test("a result.json run id that is not the host id is unscored", async () => {
    const fx = fixture();
    const executor: OptExecutor = {
      name: "swap-id",
      async run(request) {
        writeRunArtifacts(request, {
          reward: 1,
          tokens: 10,
          wallS: 1,
          timedOut: false,
          tWrite: 1_700_000_000,
          tEnd: 1_700_000_001,
          assistantTs: [],
        }, { key: fx.key, harnessPath: fx.harnessPath });
        const file = join(request.runDir, "result.json");
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { runId?: string };
        parsed.runId = "ff".repeat(16);
        writeFileSync(file, `${JSON.stringify(parsed)}\n`);
        return observation(request, { reward: 1, tokens: 10, wallS: 1, timedOut: false });
      },
    };
    await runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 1, roles: rejectingRoles(fx), executor });
    const metrics = JSON.parse(readFileSync(join(fx.out, "round1/metrics.json"), "utf8")) as {
      runs: { scoreStatus: string; unscoredReason?: string; reward: number | null }[];
    };
    expect(metrics.runs[0]).toMatchObject({ scoreStatus: "unscored", unscoredReason: "result_runid_mismatch", reward: null });
  });

  test("a signed round-0 host copy is the gap target", async () => {
    const fx = fixture();
    const trace = join(fx.root, "round0.jsonl");
    const body = "alpha\nbeta\ngamma\n";
    writeFileSync(trace, body);
    const fake = fakeExecutor(fx);
    const citing = citingRoles(fx.key, fx.attestRoot);
    const rejecting = rejectingRoles(fx);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      roles: { gap: citing.gap, innovate: citing.innovate, critic: citing.critic, ranker: citing.ranker, review: rejecting.review },
      executor: fake.executor,
      round0TracePath: trace,
      round0TraceSha: createHash("sha256").update(body).digest("hex"),
    });
    expect(fake.calls).toHaveLength(1);
    expect(result.stopReport.reason).toBeNull();
    expect(result.rounds).toHaveLength(1);
    const pre = JSON.parse(readFileSync(join(fx.out, "pre-round1.json"), "utf8")) as {
      round0Record: { srcSha256: string; hostCopyPath: string };
    };
    expect(pre.round0Record.srcSha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(pre.round0Record.hostCopyPath.startsWith(`${fx.attestRoot}/`)).toBe(true);
    expect(pre.round0Record.hostCopyPath.startsWith(`${fx.out}/`)).toBe(false);
    expect(readFileSync(pre.round0Record.hostCopyPath, "utf8")).toBe(body);
    const gap = JSON.parse(readFileSync(join(fx.out, "round1/gap-input.json"), "utf8")) as {
      traces: { file: string; sha256: string }[];
    };
    const record = JSON.parse(readFileSync(join(fx.out, "round1/gap-traces.json"), "utf8")) as {
      traces: { file: string; sha256: string }[];
    };
    expect(record.traces).toEqual(gap.traces);
    const round0Copy = gap.traces.find((hint) => hint.file.endsWith("/traces/round0-trace.jsonl"));
    const controlCopy = gap.traces.find((hint) => hint.file.endsWith("/traces/control-trace.jsonl"));
    expect(round0Copy?.sha256).toBe(pre.round0Record.srcSha256);
    expect(controlCopy?.sha256).toBe(createHash("sha256").update(readFileSync(fx.controlTrace)).digest("hex"));
    expect(round0Copy?.file.includes("private")).toBe(false);
    expect(controlCopy?.file.includes("private")).toBe(false);
    expect(round0Copy && readFileSync(round0Copy.file, "utf8")).toBe(body);
    expect(round0Copy && (statSync(round0Copy.file).mode & 0o777)).toBe(0o444);
    expect(controlCopy && (statSync(controlCopy.file).mode & 0o777)).toBe(0o444);
    const prompt = (JSON.parse(readFileSync(join(fx.out, "round1/sessions/gap-finder.argv.json"), "utf8")) as { argv: string[] }).argv.at(-1) ?? "";
    expect(prompt).toContain("/traces/round0-trace.jsonl");
    expect(prompt).toContain("/traces/control-trace.jsonl");
    expect(prompt).not.toContain("private");
    expect(prompt).not.toContain(pre.round0Record.hostCopyPath);
    expect(prompt).not.toContain(fx.controlTrace);
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { gapCitedTrace: boolean };
    expect(closure.gapCitedTrace).toBe(true);
  });

  test("a changed round-0 host copy stops before any call", async () => {
    const fx = fixture();
    const trace = join(fx.root, "round0.jsonl");
    writeFileSync(trace, "alpha\nbeta\ngamma\n");
    const fake = fakeExecutor(fx);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 2,
      roles: citingRoles(fx.key, fx.attestRoot),
      executor: fake.executor,
      round0TracePath: trace,
      round0TraceSha: createHash("sha256").update("alpha\nbeta\ngamma\n").digest("hex"),
      round0Tamper: true,
    });
    expect(fake.calls).toHaveLength(0);
    expect(result.rounds).toEqual([]);
    expect(result.stopReport.reason).toBe("anti_forgery");
    expect(existsSync(join(fx.out, "round1/gap-input.json"))).toBe(false);
    expect(existsSync(join(fx.out, "round2"))).toBe(false);
  });

  test("an unsigned round-0 target stops the loop before the executor", async () => {
    const fx = fixture();
    const trace = join(fx.root, "round0.jsonl");
    writeFileSync(trace, "alpha\nbeta\ngamma\n");
    const fake = fakeExecutor(fx);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 2,
      roles: stubOptRoles(fx.key),
      executor: fake.executor,
      round0TracePath: trace,
      round0TraceSha: createHash("sha256").update("alpha\nbeta\ngamma\n").digest("hex"),
    });
    expect(fake.calls).toHaveLength(0);
    expect(result.rounds).toEqual([{ round: 1, accepted: false, duplicate: false, patchHash: null, ewiSeeds: [], reason: "anti_forgery" }]);
    expect(result.stopReport.reason).toBe("anti_forgery");
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { reason?: string };
    expect(closure.reason).toBe("anti_forgery");
    expect(existsSync(join(fx.out, "round2"))).toBe(false);
  });

  test("a missing task or round-0 pin is refused before any call", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    await expect(runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      roles: rejectingRoles(fx),
      executor: fake.executor,
      task: { ...LOOP_TASK, id: " " },
    })).rejects.toThrow(/loop target task is required/);
    await expect(runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      roles: rejectingRoles(fx),
      executor: fake.executor,
      round0TracePath: " ",
    })).rejects.toThrow(/round-0 trace path is required/);
    await expect(runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      roles: rejectingRoles(fx),
      executor: fake.executor,
      round0TraceSha: "",
    })).rejects.toThrow(/round-0 trace sha is required/);
    const trace = join(fx.root, "round0.jsonl");
    writeFileSync(trace, "alpha\n");
    await expect(runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      roles: rejectingRoles(fx),
      executor: fake.executor,
      round0TracePath: trace,
      round0TraceSha: "ab".repeat(32),
    })).rejects.toThrow(/round0Record sha/);
    expect(fake.calls).toHaveLength(0);
  });

  test("a gap trace sha mismatch is rejected and the copy is not cited", () => {
    const dir = mkdtempSync(join(tmpdir(), "gap-trace-"));
    const src = join(dir, "src.jsonl");
    const body = "alpha\nbeta\ngamma\n";
    writeFileSync(src, body);
    const dest = join(dir, "roles", "gap-finder", "traces", "round0-trace.jsonl");
    expect(() => stageGapTrace(src, dest, "ab".repeat(32))).toThrow(/gap trace sha mismatch/);
    expect(existsSync(dest)).toBe(false);
    const sha = createHash("sha256").update(body).digest("hex");
    stageGapTrace(src, dest, sha);
    expect(readFileSync(dest, "utf8")).toBe(body);
    expect(createHash("sha256").update(readFileSync(dest)).digest("hex")).toBe(sha);
    expect(statSync(dest).mode & 0o777).toBe(0o444);
    expect(dest.endsWith(join("traces", "round0-trace.jsonl"))).toBe(true);
    expect(dest.includes("private")).toBe(false);
    expect(() => stageGapTrace(src, join(dir, "roles", "gap-finder", "traces", "private-trace.jsonl"), sha)).toThrow(/gap trace name/);
    const outside = join(dir, "secret.jsonl");
    writeFileSync(outside, "secret\n");
    const planted = join(dir, "roles", "gap-finder", "traces", "planted.jsonl");
    symlinkSync(outside, planted);
    expect(() => stageGapTrace(src, planted, sha)).toThrow(/gap trace path/);
    expect(readFileSync(outside, "utf8")).toBe("secret\n");
    expect(lstatSync(planted).isSymbolicLink()).toBe(true);
  });
});

function onceStyleAttest(fx: Fixture, candidateConfigHash: string): string {
  const run = join(fx.root, `once-run-${candidateConfigHash.slice(0, 8)}`);
  mkdirSync(join(run, "verifier"), { recursive: true });
  mkdirSync(join(run, "outputs"), { recursive: true });
  mkdirSync(join(run, ".pi-sessions"), { recursive: true });
  writeFileSync(join(run, "trace.jsonl"), `${JSON.stringify({ type: "run_start", candidateConfigHash })}\n`);
  writeFileSync(join(run, "verifier", "reward.txt"), "1\n");
  writeFileSync(join(run, "outputs", "answer.txt"), "ok\n");
  writeFileSync(join(run, ".pi-sessions", "session.jsonl"), "{}\n");
  writeFileSync(join(run, "result.json"), `${JSON.stringify({
    task: LOOP_TASK.path,
    seed: 9,
    arm: "control",
    score_status: "scored",
    reward: 1,
    tokens: 10,
    exit: 0,
    runId: "ab".repeat(16),
  })}\n`);
  const attest = join(fx.root, `once-attest-${candidateConfigHash.slice(0, 8)}`);
  const script = fileURLToPath(new URL("../../relay/devii_docker_v2.py", import.meta.url));
  const proc = spawnSync("python3", [
    script, "attest",
    "--run-dir", run,
    "--harness", fx.harnessPath,
    "--config", fx.controlConfig,
    "--attest-dir", attest,
  ], {
    encoding: "utf8",
    env: { ...process.env, HARNESS_ATTEST_KEY_FILE: fx.keyFile },
  });
  if (proc.status !== 0) throw new Error((proc.stderr || proc.stdout || "attest").trim());
  return attest;
}

function taskStyleAttest(fx: Fixture, candidateConfigHash: string): {
  readonly attest: string;
  readonly run: string;
  readonly trace: string;
  readonly session: string;
  readonly output: string;
  readonly traceBytes: Buffer;
  readonly traceMtime: number;
} {
  const run = join(fx.root, `task-run-${candidateConfigHash.slice(0, 8)}`);
  const task = join(run, "workspace", "runs", "task-1");
  mkdirSync(join(task, ".pi-sessions"), { recursive: true });
  mkdirSync(join(task, "outputs"), { recursive: true });
  mkdirSync(join(run, "verifier"), { recursive: true });
  const trace = join(task, "trace.jsonl");
  const session = join(task, ".pi-sessions", "session.jsonl");
  const output = join(task, "outputs", "answer.txt");
  writeFileSync(trace, `${JSON.stringify({ type: "run_start", candidateConfigHash })}\n`);
  writeFileSync(session, "{}\n");
  writeFileSync(output, "ok\n");
  writeFileSync(join(run, "verifier", "reward.txt"), "1\n");
  writeFileSync(join(run, "result.json"), `${JSON.stringify({
    task: LOOP_TASK.path,
    seed: 9,
    arm: "control",
    score_status: "scored",
    reward: 1,
    tokens: 10,
    exit: 0,
    runId: "ab".repeat(16),
  })}\n`);
  const traceBytes = readFileSync(trace);
  const traceMtime = statSync(trace).mtimeMs;
  const attest = join(fx.root, `task-attest-${candidateConfigHash.slice(0, 8)}`);
  const script = fileURLToPath(new URL("../../relay/devii_docker_v2.py", import.meta.url));
  const proc = spawnSync("python3", [
    script, "attest",
    "--run-dir", run,
    "--harness", fx.harnessPath,
    "--config", fx.controlConfig,
    "--attest-dir", attest,
  ], {
    encoding: "utf8",
    env: { ...process.env, HARNESS_ATTEST_KEY_FILE: fx.keyFile },
  });
  if (proc.status !== 0) throw new Error((proc.stderr || proc.stdout || "attest").trim());
  return { attest, run, trace, session, output, traceBytes, traceMtime };
}

function captureStderr(run: () => Promise<number>): Promise<{ readonly code: number; readonly stderr: string }> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return run().then((code) => ({ code, stderr: lines.join("") })).finally(() => {
    process.stderr.write = write;
  });
}

describe("optimization loop role caps", () => {
  test("role output caps are recorded on the argv and spawn files", async () => {
    const fx = fixture();
    await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fakeExecutor(fx).executor,
      roles: stubOptRoles(fx.key),
      roleMaxTokens: { "gap-finder": 2_000 },
    });
    const gapSpawn = JSON.parse(readFileSync(join(fx.out, "round1/sessions/gap-finder.spawn.json"), "utf8")) as { maxTokens: number };
    const gapArgv = JSON.parse(readFileSync(join(fx.out, "round1/sessions/gap-finder.argv.json"), "utf8")) as { argv: string[]; maxTokens: number };
    expect(gapSpawn.maxTokens).toBe(2_000);
    expect(gapArgv.maxTokens).toBe(2_000);
    expect(gapArgv.argv).not.toContain("--max-tokens");
    expect((gapArgv.argv.at(-1) ?? "").length).toBeGreaterThan(0);
    const innovator = JSON.parse(readFileSync(join(fx.out, "round1/sessions/innovator-0.spawn.json"), "utf8")) as { maxTokens: number };
    const critic = JSON.parse(readFileSync(join(fx.out, "round1/sessions/critic.spawn.json"), "utf8")) as { maxTokens: number };
    const review = JSON.parse(readFileSync(join(fx.out, "round1/sessions/reviewer-gate.spawn.json"), "utf8")) as { maxTokens: number };
    expect(innovator.maxTokens).toBe(16_384);
    expect(critic.maxTokens).toBe(32_768);
    expect(review.maxTokens).toBe(32_768);
    expect(existsSync(join(fx.out, "round1/sessions/ranker.spawn.json"))).toBe(false);
  });
});

function relayReadLog(dir: string, toolPath: string, body: string): { readonly log: string; readonly sha: string } {
  const sha = createHash("sha256").update(body).digest("hex");
  mkdirSync(join(dir, "tool"), { recursive: true });
  writeFileSync(join(dir, "tool", sha), body);
  const runId = "ab".repeat(16);
  const log = join(dir, "relay.jsonl");
  const rows = [
    { type: "relay_start", bootId: "b", pid: 1, relaySha: "x", ts: 1, ts_iso: "t" },
    { type: "open", runId, kind: "role:gap-finder" },
    { type: "req", seq: 1, runId, toolResults: [{ sha256: sha, tool_call_id: "c0", toolName: "read", args: { path: toolPath } }] },
  ];
  writeFileSync(log, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return { log, sha };
}

function captureStdout(run: () => Promise<number>): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return run().then((code) => ({ code, stdout: out.join(""), stderr: err.join("") })).finally(() => {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  });
}

describe("optimize command", () => {
  test("cite-check accepts a relative read inside the role cwd", async () => {
    const fx = fixture();
    const role = join(fx.root, "role");
    const body = "alpha\nbeta\ngamma\n";
    const file = join(role, "traces", "round0-trace.jsonl");
    mkdirSync(join(role, "traces"), { recursive: true });
    writeFileSync(file, body);
    const saved = relayReadLog(join(fx.root, "saved"), "traces/round0-trace.jsonl", body);
    const replay = await captureStdout(() => Promise.resolve(main([
      "cite-check", "--log", saved.log, "--cwd", role, "--file", file, "--sha", saved.sha,
    ])));
    expect(replay.code).toBe(0);
    expect(JSON.parse(replay.stdout).ok).toBe(true);
  });

  test("cite-check rejects a relative path that leaves the role cwd", async () => {
    const fx = fixture();
    const role = join(fx.root, "role");
    mkdirSync(role, { recursive: true });
    const body = "alpha\nbeta\ngamma\n";
    const outside = join(fx.root, "secret.jsonl");
    writeFileSync(outside, body);
    const saved = relayReadLog(join(fx.root, "saved"), "../secret.jsonl", body);
    const replay = await captureStdout(() => Promise.resolve(main([
      "cite-check", "--log", saved.log, "--cwd", role, "--file", outside, "--sha", saved.sha,
    ])));
    expect(replay.code).toBe(1);
    expect(JSON.parse(replay.stdout).ok).toBe(false);
  });

  test("cite-check rejects a symlink that leaves the role cwd", async () => {
    const fx = fixture();
    const role = join(fx.root, "role");
    mkdirSync(join(role, "traces"), { recursive: true });
    const body = "alpha\nbeta\ngamma\n";
    const outside = join(fx.root, "secret.jsonl");
    writeFileSync(outside, body);
    const link = join(role, "traces", "leak.jsonl");
    symlinkSync(outside, link);
    const saved = relayReadLog(join(fx.root, "saved"), "traces/leak.jsonl", body);
    const replay = await captureStdout(() => Promise.resolve(main([
      "cite-check", "--log", saved.log, "--cwd", role, "--file", outside, "--sha", saved.sha,
    ])));
    expect(replay.code).toBe(1);
    expect(JSON.parse(replay.stdout).ok).toBe(false);
  });

  test("cite-check still accepts an absolute read path", async () => {
    const fx = fixture();
    const role = join(fx.root, "role");
    const body = "alpha\nbeta\ngamma\n";
    const file = join(role, "traces", "round0-trace.jsonl");
    mkdirSync(join(role, "traces"), { recursive: true });
    writeFileSync(file, body);
    const saved = relayReadLog(join(fx.root, "saved"), file, body);
    const replay = await captureStdout(() => Promise.resolve(main([
      "cite-check", "--log", saved.log, "--cwd", role, "--file", file, "--sha", saved.sha,
    ])));
    expect(replay.code).toBe(0);
    expect(JSON.parse(replay.stdout).ok).toBe(true);
  });

  test("dry-run finishes a round without a model process", async () => {
    const fx = fixture();
    const previousBind = process.env.HARNESS_RELAY_BIND;
    process.env.HARNESS_RELAY_BIND = "127.0.0.1";
    try {
      const code = await main([
        "optimize", "--out", fx.out, "--dry-run", "--rounds", "1",
        "--attest-root", fx.attestRoot,
        "--attest-key-file", fx.keyFile,
        "--harness", fx.harnessPath,
        "--control-config", fx.controlConfig,
        "--control-attest", fx.controlAttest,
        ...taskFlags(fx.root),
        ...round0Flags(),
      ]);
      expect(code).toBe(0);
      expect(existsSync(join(fx.out, "round1/sessions/gap-finder.jsonl"))).toBe(true);
      expect(existsSync(join(fx.out, "round1/patch.diff"))).toBe(true);
      const activation = JSON.parse(readFileSync(join(fx.out, "round1/activation.json"), "utf8")) as { patchActive: boolean };
      expect(activation.patchActive).toBe(true);
      expect(existsSync(join(fx.out, "final/order.json"))).toBe(false);
      const loop = JSON.parse(readFileSync(join(fx.out, "loop-result.json"), "utf8")) as { skippedFinal: boolean };
      expect(loop.skippedFinal).toBe(true);
    } finally {
      if (previousBind === undefined) delete process.env.HARNESS_RELAY_BIND;
      else process.env.HARNESS_RELAY_BIND = previousBind;
    }
  });

  test("dry-run without a control attestation does not write a stub baseline", async () => {
    const fx = fixture();
    const code = await main([
      "optimize", "--out", fx.out, "--dry-run", "--rounds", "1",
      "--attest-root", fx.attestRoot,
      "--attest-key-file", fx.keyFile,
      "--harness", fx.harnessPath,
      ...taskFlags(fx.root),
      ...round0Flags(),
    ]);
    expect(code).toBe(1);
    expect(existsSync(join(fx.out, "baseline/hb003/seed0/trace.jsonl"))).toBe(false);
  });

  test("optimize names a missing task or round-0 flag", async () => {
    const fx = fixture();
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const bare = await main([
        "optimize", "--out", fx.out, "--dry-run",
        "--attest-root", fx.attestRoot,
        "--attest-key-file", fx.keyFile,
        "--harness", fx.harnessPath,
        ...round0Flags(),
      ]);
      expect(bare).toBe(1);
      expect(lines.join("")).toContain("--task");
      lines.length = 0;
      const noSha = await main([
        "optimize", "--out", fx.out, "--dry-run",
        "--attest-root", fx.attestRoot,
        "--attest-key-file", fx.keyFile,
        "--harness", fx.harnessPath,
        ...taskFlags(fx.root),
        "--round0-trace", ROUND0_TRACE,
      ]);
      expect(noSha).toBe(1);
      expect(lines.join("")).toContain("--round0-sha");
      expect(existsSync(join(fx.out, "pre-round1.json"))).toBe(false);
    } finally {
      process.stderr.write = write;
    }
  });

  test("execute with --pi-bin launches the pi role and stops before docker", async () => {
    const fx = fixture();
    const recorded = join(fx.root, "pi-argv.txt");
    const bin = join(fx.root, "pi");
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(recorded)}\n`);
    chmodSync(bin, 0o755);
    const previous = {
      base: process.env.BASE_URL,
      bind: process.env.HARNESS_RELAY_BIND,
      root: process.env.HARNESS_RELAY_LOG_ROOT,
    };
    process.env.BASE_URL = "http://127.0.0.1:9";
    process.env.HARNESS_RELAY_BIND = "127.0.0.1";
    process.env.HARNESS_RELAY_LOG_ROOT = join(fx.root, "relay-logs");
    try {
      const { code, stderr } = await captureStderr(() => main([
        "optimize", "--out", fx.out, "--execute", "--rounds", "1",
        "--pi-bin", bin,
        "--attest-root", fx.attestRoot,
        "--attest-key-file", fx.keyFile,
        "--harness", fx.harnessPath,
        "--control-config", fx.controlConfig,
        "--control-attest", fx.controlAttest,
        ...taskFlags(fx.root),
        ...round0Flags(),
      ]));
      expect(code).toBe(0);
      expect(stderr).toBe("");
      const loop = JSON.parse(readFileSync(join(fx.out, "loop-result.json"), "utf8")) as { stopReport: { reason: string | null; role?: string; exitCode?: number | null; stderrTail?: string } };
      expect(loop.stopReport.reason).toBe("no_conclusion");
      expect(loop.stopReport.role).toBe("gap-finder");
      expect(loop.stopReport.exitCode).toBe(0);
      expect(loop.stopReport.stderrTail).toBe("no conclusion");
      const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { reason?: string };
      expect(closure.reason).toBe("no_conclusion");
      const argv = readFileSync(recorded, "utf8");
      const lines = argv.split("\n");
      expect(lines[0]).toBe("--print");
      expect(lines[lines.indexOf("--tools") + 1]).toBe("read");
      expect(lines).toContain("--system-prompt");
      expect(lines[lines.indexOf("--system-prompt") + 1]?.endsWith("/agents/gap-finder.md")).toBe(true);
      expect(lines.slice(lines.indexOf("--system-prompt") + 2).join("\n").trim().length).toBeGreaterThan(0);
      const toolList = (lines[lines.indexOf("--tools") + 1] ?? "").split(",");
      expect(toolList).toEqual(["read"]);
      expect(toolList).not.toContain("write");
      expect(toolList).not.toContain("bash");
      const spawn = JSON.parse(readFileSync(join(fx.out, "round1/sessions/gap-finder.spawn.json"), "utf8")) as { relayLog?: string; baseUrl?: string };
      expect(spawn.relayLog).toBeUndefined();
      expect(spawn.baseUrl).toContain("127.0.0.1");
      const pre = JSON.parse(readFileSync(join(fx.out, "pre-round1.json"), "utf8")) as { type?: string; innovatorCap?: number; hmacSha256?: string };
      expect(pre.type).toBe("pre_round1");
      expect(pre.innovatorCap).toBe(200000);
      expect(typeof pre.hmacSha256).toBe("string");
      expect(existsSync(join(fx.out, "round1/runs"))).toBe(false);
    } finally {
      if (previous.base === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = previous.base;
      if (previous.bind === undefined) delete process.env.HARNESS_RELAY_BIND;
      else process.env.HARNESS_RELAY_BIND = previous.bind;
      if (previous.root === undefined) delete process.env.HARNESS_RELAY_LOG_ROOT;
      else process.env.HARNESS_RELAY_LOG_ROOT = previous.root;
    }
  });

  test("optimize --stop-before-run needs --execute", async () => {
    const fx = fixture();
    const { code, stderr } = await captureStderr(() => main([
      "optimize", "--out", fx.out, "--dry-run", "--stop-before-run",
      "--attest-root", fx.attestRoot,
      "--attest-key-file", fx.keyFile,
      "--harness", fx.harnessPath,
      ...taskFlags(fx.root),
      ...round0Flags(),
    ]));
    expect(code).toBe(1);
    expect(stderr).toContain("--stop-before-run needs --execute");
    const bad = await captureStderr(() => main([
      "optimize", "--out", fx.out, "--execute", "--role-max-tokens", "nope=10",
      "--attest-root", fx.attestRoot,
      "--attest-key-file", fx.keyFile,
      "--harness", fx.harnessPath,
      ...taskFlags(fx.root),
      ...round0Flags(),
    ]));
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("--role-max-tokens");
  });

  test("a length-limit exit with empty output is role_output_truncated", async () => {
    const fx = fixture();
    const bin = join(fx.root, "pi");
    writeFileSync(bin, "#!/bin/sh\necho 'Response was truncated: the model reached its output token limit.' >&2\nexit 1\n");
    chmodSync(bin, 0o755);
    const previous = {
      base: process.env.BASE_URL,
      bind: process.env.HARNESS_RELAY_BIND,
      root: process.env.HARNESS_RELAY_LOG_ROOT,
    };
    process.env.BASE_URL = "http://127.0.0.1:9";
    process.env.HARNESS_RELAY_BIND = "127.0.0.1";
    process.env.HARNESS_RELAY_LOG_ROOT = join(fx.root, "relay-logs");
    try {
      const code = await main([
        "optimize", "--out", fx.out, "--execute", "--rounds", "1",
        "--pi-bin", bin,
        "--attest-root", fx.attestRoot,
        "--attest-key-file", fx.keyFile,
        "--harness", fx.harnessPath,
        "--control-config", fx.controlConfig,
        "--control-attest", fx.controlAttest,
        ...taskFlags(fx.root),
        ...round0Flags(),
      ]);
      expect(code).toBe(0);
      const loop = JSON.parse(readFileSync(join(fx.out, "loop-result.json"), "utf8")) as { stopReport: { reason: string | null; faultRounds: number } };
      expect(loop.stopReport.reason).toBe("role_output_truncated");
      expect(loop.stopReport.faultRounds).toBe(1);
      const gapSpawn = JSON.parse(readFileSync(join(fx.out, "round1/sessions/gap-finder.spawn.json"), "utf8")) as { exitCode?: number };
      expect(gapSpawn.exitCode).toBe(1);
      expect(existsSync(join(fx.out, "round1/runs"))).toBe(false);
    } finally {
      if (previous.base === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = previous.base;
      if (previous.bind === undefined) delete process.env.HARNESS_RELAY_BIND;
      else process.env.HARNESS_RELAY_BIND = previous.bind;
      if (previous.root === undefined) delete process.env.HARNESS_RELAY_LOG_ROOT;
      else process.env.HARNESS_RELAY_LOG_ROOT = previous.root;
    }
  });

  test("a non-zero exit that is not a length limit stops as role_failed", async () => {
    const fx = fixture();
    const bin = join(fx.root, "pi");
    writeFileSync(bin, "#!/bin/sh\necho boom >&2\nexit 1\n");
    chmodSync(bin, 0o755);
    const previous = {
      base: process.env.BASE_URL,
      bind: process.env.HARNESS_RELAY_BIND,
      root: process.env.HARNESS_RELAY_LOG_ROOT,
    };
    process.env.BASE_URL = "http://127.0.0.1:9";
    process.env.HARNESS_RELAY_BIND = "127.0.0.1";
    process.env.HARNESS_RELAY_LOG_ROOT = join(fx.root, "relay-logs");
    try {
      const { code, stderr } = await captureStderr(() => main([
        "optimize", "--out", fx.out, "--execute", "--rounds", "1",
        "--pi-bin", bin,
        "--attest-root", fx.attestRoot,
        "--attest-key-file", fx.keyFile,
        "--harness", fx.harnessPath,
        "--control-config", fx.controlConfig,
        "--control-attest", fx.controlAttest,
        ...taskFlags(fx.root),
        ...round0Flags(),
      ]));
      expect(code).toBe(0);
      expect(stderr).toBe("");
      const loop = JSON.parse(readFileSync(join(fx.out, "loop-result.json"), "utf8")) as {
        stopReport: { reason: string | null; role?: string; exitCode?: number | null; stderrTail?: string; faultRounds: number };
        rounds: { reason?: string; roleFailure?: { role: string; exitCode: number | null; stderrTail: string } }[];
      };
      expect(loop.stopReport.reason).toBe("role_failed");
      expect(loop.stopReport.role).toBe("gap-finder");
      expect(loop.stopReport.exitCode).toBe(1);
      expect(loop.stopReport.stderrTail).toBe("boom");
      expect(loop.stopReport.faultRounds).toBe(0);
      expect(loop.rounds[0]?.reason).toBe("role_failed");
      expect(loop.rounds[0]?.roleFailure?.stderrTail).toBe("boom");
      const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { reason?: string; roleFailure?: { exitCode?: number | null } };
      expect(closure.reason).toBe("role_failed");
      expect(closure.roleFailure?.exitCode).toBe(1);
      const gapSpawn = JSON.parse(readFileSync(join(fx.out, "round1/sessions/gap-finder.spawn.json"), "utf8")) as { exitCode?: number; baseUrl?: string; attempts?: { n: number; transient: boolean }[] };
      expect(gapSpawn.exitCode).toBe(1);
      expect(gapSpawn.attempts?.map((item) => item.n)).toEqual([1]);
      expect(gapSpawn.attempts?.[0]?.transient).toBe(false);
      const log = readFileSync(roleLog(join(fx.root, "relay-logs"), gapSpawn.baseUrl ?? ""), "utf8");
      expect(log).toContain("\"type\":\"close\"");
    } finally {
      if (previous.base === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = previous.base;
      if (previous.bind === undefined) delete process.env.HARNESS_RELAY_BIND;
      else process.env.HARNESS_RELAY_BIND = previous.bind;
      if (previous.root === undefined) delete process.env.HARNESS_RELAY_LOG_ROOT;
      else process.env.HARNESS_RELAY_LOG_ROOT = previous.root;
    }
  });

  test("a 502 is retried and the next attempt can succeed", async () => {
    const fx = fixture();
    const upstream = await listenStatusUpstream(1);
    const stub = stubOptRoles(fx.key);
    const delays: number[] = [];
    try {
      const result = await runOptLoop({
        ...hostOpts(fx),
        mode: "dry-run",
        env: { HARNESS_RELAY_BIND: "127.0.0.1", HARNESS_RELAY_UPSTREAM: upstream.url },
        rounds: 1,
        roleRetrySleep: async (ms) => { delays.push(ms); },
        executor: fakeExecutor(fx).executor,
        roles: {
          gap: (input) => stub.gap(input),
          async innovate(input) {
            if (!input.sessionPath.endsWith("innovator-0.jsonl")) return stub.innovate(input);
            await postForStatus(input.baseUrl);
            return stub.innovate(input);
          },
          critic: (input) => stub.critic(input),
          ranker: (input) => stub.ranker(input),
          review: (input) => stub.review(input),
        },
      });
      expect(delays).toEqual([5_000]);
      expect(upstream.hits()).toBe(2);
      expect(result.stopReport.reason).toBeNull();
      expect(result.rounds[0]?.reason).toBeUndefined();
      expect(existsSync(join(fx.out, "round1/sessions/reviewer-gate.spawn.json"))).toBe(true);
      const spawn = JSON.parse(readFileSync(join(fx.out, "round1/sessions/innovator-0.spawn.json"), "utf8")) as { attempts?: { n: number; transient: boolean; exitCode: number | null }[] };
      expect(spawn.attempts?.map((item) => [item.n, item.transient, item.exitCode])).toEqual([[1, true, 1], [2, false, null]]);
    } finally {
      await upstream.close();
    }
  });

  test("an innovator that 502s on every attempt is skipped and the round continues", async () => {
    const fx = fixture();
    const upstream = await listenStatusUpstream(99);
    const stub = stubOptRoles(fx.key);
    const delays: number[] = [];
    try {
      const result = await runOptLoop({
        ...hostOpts(fx),
        mode: "dry-run",
        env: { HARNESS_RELAY_BIND: "127.0.0.1", HARNESS_RELAY_UPSTREAM: upstream.url },
        rounds: 1,
        roleRetrySleep: async (ms) => { delays.push(ms); },
        executor: fakeExecutor(fx).executor,
        roles: {
          gap: (input) => stub.gap(input),
          async innovate(input) {
            if (input.sessionPath.endsWith("innovator-5.jsonl")) {
              await postForStatus(input.baseUrl);
              return stub.innovate(input);
            }
            const turn = await stub.innovate(input);
            const slot = /innovator-(\d+)\.jsonl$/.exec(input.sessionPath)?.[1] ?? "0";
            return { ...turn, summary: `${turn.summary}#${slot}` };
          },
          critic: (input) => stub.critic(input),
          ranker: (input) => stub.ranker(input),
          review: (input) => stub.review(input),
        },
      });
      expect(delays).toEqual([5_000, 20_000]);
      expect(result.stopReport.reason).toBeNull();
      expect(result.rounds[0]?.reason).toBeUndefined();
      expect(existsSync(join(fx.out, "round1/sessions/reviewer-gate.spawn.json"))).toBe(true);
      expect(result.rounds[0]?.invalidCandidates).toEqual([
        { id: "c5", role: "innovator-5", reason: "no_output", exitCode: 1, stderrTail: "HTTP 502" },
      ]);
      const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { invalidCandidates?: { id: string; reason: string }[] };
      expect(closure.invalidCandidates?.map((item) => `${item.id}:${item.reason}`)).toEqual(["c5:no_output"]);
      const spawn = JSON.parse(readFileSync(join(fx.out, "round1/sessions/innovator-5.spawn.json"), "utf8")) as { attempts?: { n: number; runId: string }[] };
      expect(spawn.attempts?.map((item) => item.n)).toEqual([1, 2, 3]);
      for (const attempt of spawn.attempts ?? []) {
        const log = readFileSync(join(fx.attestRoot, "relay-logs", attempt.runId, "relay.jsonl"), "utf8");
        expect(log).toContain("\"status\":502");
        expect(log).toContain("\"type\":\"close\"");
      }
      expect(existsSync(join(fx.out, "round1/sessions/ranker.spawn.json"))).toBe(true);
    } finally {
      await upstream.close();
    }
  });

  test("a critic that 502s on every attempt stops as role_failed", async () => {
    const fx = fixture();
    const upstream = await listenStatusUpstream(99);
    const stub = stubOptRoles(fx.key);
    const delays: number[] = [];
    try {
      const result = await runOptLoop({
        ...hostOpts(fx),
        mode: "dry-run",
        env: { HARNESS_RELAY_BIND: "127.0.0.1", HARNESS_RELAY_UPSTREAM: upstream.url },
        rounds: 1,
        roleRetrySleep: async (ms) => { delays.push(ms); },
        executor: fakeExecutor(fx).executor,
        roles: {
          gap: (input) => stub.gap(input),
          innovate: (input) => stub.innovate(input),
          async critic(input) {
            await postForStatus(input.baseUrl);
            return stub.critic(input);
          },
          ranker: (input) => stub.ranker(input),
          review: (input) => stub.review(input),
        },
      });
      expect(delays).toEqual([5_000, 20_000]);
      expect(result.stopReport).toEqual({
        reason: "role_failed",
        faultRounds: 0,
        reviewerRejectRounds: 0,
        role: "critic",
        exitCode: 1,
        stderrTail: "HTTP 502",
      });
      expect(result.rounds[0]?.reason).toBe("role_failed");
      expect(result.rounds[0]?.roleFailure).toEqual({ role: "critic", exitCode: 1, stderrTail: "HTTP 502" });
      const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { reason?: string };
      expect(closure.reason).toBe("role_failed");
      expect(existsSync(join(fx.out, "loop-result.json"))).toBe(true);
      expect(existsSync(join(fx.out, "round1/sessions/ranker.spawn.json"))).toBe(false);
      const spawn = JSON.parse(readFileSync(join(fx.out, "round1/sessions/critic.spawn.json"), "utf8")) as { attempts?: { runId: string }[] };
      expect(spawn.attempts).toHaveLength(3);
      for (const attempt of spawn.attempts ?? []) {
        const log = readFileSync(join(fx.attestRoot, "relay-logs", attempt.runId, "relay.jsonl"), "utf8");
        expect(log).toContain("\"type\":\"close\"");
      }
    } finally {
      await upstream.close();
    }
  });

  test("a retry that would cross the read-only cap stops with that cap", async () => {
    const fx = fixture();
    const upstream = await listenStatusUpstream(99);
    const stub = stubOptRoles(fx.key);
    const delays: number[] = [];
    let calls = 0;
    let spent = false;
    try {
      const result = await runOptLoop({
        ...hostOpts(fx),
        mode: "dry-run",
        env: { HARNESS_RELAY_BIND: "127.0.0.1", HARNESS_RELAY_UPSTREAM: upstream.url },
        rounds: 1,
        readOnlyTokens: () => (spent ? 30_000_000 : 0),
        roleRetrySleep: async (ms) => { delays.push(ms); },
        executor: fakeExecutor(fx).executor,
        roles: {
          gap: (input) => stub.gap(input),
          async innovate(input) {
            if (!input.sessionPath.endsWith("innovator-0.jsonl")) return stub.innovate(input);
            calls += 1;
            spent = true;
            await postForStatus(input.baseUrl);
            return stub.innovate(input);
          },
          critic: (input) => stub.critic(input),
          ranker: (input) => stub.ranker(input),
          review: (input) => stub.review(input),
        },
      });
      expect(calls).toBe(1);
      expect(delays).toEqual([]);
      expect(result.stopReport.reason).toBe("readOnlyTokenCap");
      const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { reason?: string };
      expect(closure.reason).toBe("readOnlyTokenCap");
      expect(existsSync(join(fx.out, "loop-result.json"))).toBe(true);
      const spawn = JSON.parse(readFileSync(join(fx.out, "round1/sessions/innovator-0.spawn.json"), "utf8")) as { attempts?: unknown[] };
      expect(spawn.attempts).toHaveLength(1);
    } finally {
      await upstream.close();
    }
  });

  test("a patch.json without config.json is an invalid candidate and one remaining candidate is a walkover", async () => {
    const fx = fixture();
    const stub = stubOptRoles(fx.key);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fakeExecutor(fx).executor,
      roles: {
        gap: (input) => stub.gap(input),
        async innovate(input) {
          const slot = input.sessionPath.match(/innovator-(\d+)\.jsonl$/)?.[1];
          if (slot === "0") {
            writeFileSync(join(input.spawn.cwd, "patch.json"), "{\"summary\":\"only a patch\"}\n");
            return stub.innovate(input);
          }
          if (slot !== "1") throw new RoleFailed("innovator", 1, "boom", false);
          return stub.innovate(input);
        },
        critic: (input) => stub.critic(input),
        ranker: (input) => stub.ranker(input),
        review: (input) => stub.review(input),
      },
    });
    expect(result.stopReport.reason).toBeNull();
    expect(result.rounds[0]?.invalidCandidates?.map((item) => `${item.id}:${item.reason}`)).toEqual([
      "c0:patch_without_config",
      "c2:no_output",
      "c3:no_output",
      "c4:no_output",
      "c5:no_output",
    ]);
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { rank?: string; invalidCandidates?: { id: string }[] };
    expect(closure.rank).toBe("walkover");
    expect(closure.invalidCandidates?.map((item) => item.id)).toEqual(["c0", "c2", "c3", "c4", "c5"]);
    expect(existsSync(join(fx.out, "round1/sessions/ranker.spawn.json"))).toBe(false);
  });

  test("an innovator that exits 0 without a conclusion is invalid and the round continues", async () => {
    const fx = fixture();
    const stub = stubOptRoles(fx.key);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fakeExecutor(fx).executor,
      roles: {
        gap: (input) => stub.gap(input),
        async innovate(input) {
          if (!input.sessionPath.endsWith("innovator-2.jsonl")) return stub.innovate(input);
          writeFileSync(join(input.spawn.cwd, "patch.json"), "{\"summary\":\"prose only\"}\n");
          throw new RoleFailed("innovator", 0, "no conclusion", false);
        },
        critic: (input) => stub.critic(input),
        ranker: (input) => stub.ranker(input),
        review: (input) => stub.review(input),
      },
    });
    expect(result.stopReport.reason).toBeNull();
    expect(result.rounds[0]?.invalidCandidates).toEqual([
      { id: "c1", role: "innovator-1", reason: "duplicate" },
      { id: "c2", role: "innovator-2", reason: "no_conclusion", exitCode: 0, stderrTail: "no conclusion" },
      { id: "c3", role: "innovator-3", reason: "duplicate" },
      { id: "c4", role: "innovator-4", reason: "duplicate" },
      { id: "c5", role: "innovator-5", reason: "duplicate" },
    ]);
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { invalidCandidates?: { id: string; reason: string }[] };
    expect(closure.invalidCandidates?.map((item) => `${item.id}:${item.reason}`)).toEqual([
      "c1:duplicate",
      "c2:no_conclusion",
      "c3:duplicate",
      "c4:duplicate",
      "c5:duplicate",
    ]);
    expect(existsSync(join(fx.out, "loop-result.json"))).toBe(true);
    expect(existsSync(join(fx.out, "round1/sessions/reviewer-gate.spawn.json"))).toBe(true);
  });

  test("an arbitrary error inside the round still writes closure and loop-result", async () => {
    const fx = fixture();
    const stub = stubOptRoles(fx.key);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fakeExecutor(fx).executor,
      roles: {
        gap: () => { throw new Error("sensor exploded"); },
        innovate: (input) => stub.innovate(input),
        critic: (input) => stub.critic(input),
        ranker: (input) => stub.ranker(input),
        review: (input) => stub.review(input),
      },
    });
    expect(result.stopReport.reason).toBe("internal_error");
    expect(result.stopReport.role).toBe("gap-finder");
    expect(result.stopReport.stderrTail).toBe("sensor exploded");
    expect(result.rounds[0]?.reason).toBe("internal_error");
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { reason?: string; roleFailure?: { stderrTail?: string } };
    expect(closure.reason).toBe("internal_error");
    expect(closure.roleFailure?.stderrTail).toBe("sensor exploded");
    expect(existsSync(join(fx.out, "loop-result.json"))).toBe(true);
  });

  test("a stderr 429 is not transient when the relay log path is unknown", () => {
    expect(roleFailureIsTransient("", "HTTP 429").transient).toBe(false);
    expect(roleFailureIsTransient("/tmp/does-not-exist-relay.jsonl", "upstream returned 429").transient).toBe(false);
    expect(roleFailureIsTransient("", "HTTP 502").transient).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "relay-429-"));
    const log = join(dir, "relay.jsonl");
    writeFileSync(log, `${JSON.stringify({ type: "done", status: 429, errClass: "4xx" })}\n`);
    expect(roleFailureIsTransient(log, "HTTP 429").transient).toBe(true);
    writeFileSync(log, `${JSON.stringify({ type: "done", status: 429, errClass: "readOnlyTokenCap" })}\n`);
    expect(roleFailureIsTransient(log, "HTTP 429")).toEqual({ transient: false, cap: "readOnlyTokenCap" });
  });

  test("retry tokens from every attempt count toward the innovator cap and the ranking cap", async () => {
    const innovatorUsage = { prompt_tokens: 120_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } };
    const innovatorUpstream = await listenUpstream(innovatorUsage);
    const fx = fixture();
    const stub = stubOptRoles(fx.key);
    const delays: number[] = [];
    let innovatorTries = 0;
    let innovatorFinished = false;
    try {
      const result = await runOptLoop({
        ...hostOpts(fx),
        mode: "dry-run",
        env: { HARNESS_RELAY_BIND: "127.0.0.1", HARNESS_RELAY_UPSTREAM: innovatorUpstream.url },
        rounds: 1,
        roleRetrySleep: async (ms) => { delays.push(ms); },
        executor: fakeExecutor(fx).executor,
        roles: {
          gap: (input) => stub.gap(input),
          async innovate(input) {
            const slot = /innovator-(\d+)\.jsonl$/.exec(input.sessionPath)?.[1] ?? "0";
            if (slot !== "0") {
              const turn = await stub.innovate(input);
              return { ...turn, summary: `${turn.summary}#${slot}` };
            }
            const response = await fetch(`${input.baseUrl}/chat/completions`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ messages: [{ role: "user", content: "spend" }] }),
            });
            if (!response.ok) throw new Error(`relay ${response.status}`);
            await response.arrayBuffer();
            innovatorTries += 1;
            if (innovatorTries === 1) throw new RoleFailed("innovator", 1, "again", true);
            await new Promise((resolve) => setTimeout(resolve, 5_000));
            innovatorFinished = true;
            const turn = await stub.innovate(input);
            return { ...turn, summary: "spent-c0" };
          },
          critic: (input) => stub.critic(input),
          ranker: (input) => stub.ranker(input),
          review: (input) => stub.review(input),
        },
      });
      expect(innovatorTries).toBe(2);
      expect(innovatorFinished).toBe(false);
      expect(delays).toEqual([5_000]);
      expect(result.stopReport.reason).toBeNull();
      const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { invalidCandidates?: { id: string; reason: string }[] };
      expect(closure.invalidCandidates?.some((item) => item.id === "c0" && item.reason === "cap_hit")).toBe(true);
    } finally {
      await innovatorUpstream.close();
    }

    const rankingUsage = { prompt_tokens: 2_000_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } };
    const rankingUpstream = await listenUpstream(rankingUsage);
    const rankingFx = fixture();
    const rankingStub = stubOptRoles(rankingFx.key);
    const rankingDelays: number[] = [];
    let criticTries = 0;
    let criticFinished = false;
    try {
      const result = await runOptLoop({
        ...hostOpts(rankingFx),
        mode: "dry-run",
        env: { HARNESS_RELAY_BIND: "127.0.0.1", HARNESS_RELAY_UPSTREAM: rankingUpstream.url },
        rounds: 1,
        roleRetrySleep: async (ms) => { rankingDelays.push(ms); },
        executor: fakeExecutor(rankingFx).executor,
        roles: {
          gap: (input) => rankingStub.gap(input),
          innovate: (input) => rankingStub.innovate(input),
          async critic(input) {
            const response = await fetch(`${input.baseUrl}/chat/completions`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ messages: [{ role: "user", content: "rank-spend" }] }),
            });
            if (!response.ok) throw new Error(`relay ${response.status}`);
            await response.arrayBuffer();
            criticTries += 1;
            if (criticTries === 1) throw new RoleFailed("critic", 1, "again", true);
            await new Promise((resolve) => setTimeout(resolve, 5_000));
            criticFinished = true;
            return rankingStub.critic(input);
          },
          ranker: (input) => rankingStub.ranker(input),
          review: (input) => rankingStub.review(input),
        },
      });
      expect(criticTries).toBe(2);
      expect(criticFinished).toBe(false);
      expect(rankingDelays).toEqual([5_000]);
      expect(result.stopReport.reason).toBeNull();
      const closure = JSON.parse(readFileSync(join(rankingFx.out, "round1/closure.json"), "utf8")) as { reason?: string; noWinner?: string };
      expect(closure.reason).toBe("no_winner:cap_hit");
      expect(closure.noWinner).toBe("no_winner:cap_hit");
      expect(existsSync(join(rankingFx.out, "loop-result.json"))).toBe(true);
      expect(existsSync(join(rankingFx.out, "round1/sessions/ranker.spawn.json"))).toBe(false);
    } finally {
      await rankingUpstream.close();
    }
  });

  test("optimize --execute --stop-before-run writes the closure and does not start docker", async () => {
    const fx = fixture();
    const upstream = await startEchoUpstream();
    const script = join(fx.root, "answer.mjs");
    const bin = join(fx.root, "pi");
    writeFileSync(script, [
      "import { readFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const system = args[args.indexOf('--system-prompt') + 1] ?? '';",
      "const role = system.split('/').pop()?.replace(/\\.md$/, '') ?? '';",
      "const prompt = args.at(-1) ?? '';",
      "const base = process.env.BASE_URL ?? '';",
      "async function post(messages) {",
      "  const response = await fetch(base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages }) });",
      "  if (!response.ok) { process.stderr.write('relay ' + response.status + '\\n'); process.exit(2); }",
      "  await response.arrayBuffer();",
      "}",
      "const slot = process.cwd().match(/innovator-(\\d+)/)?.[1] ?? '0';",
      "const maxSteps = slot === '1' ? 20 : 24;",
      "const bodies = {",
      "  'gap-finder': { knob: 'agent-loop.maxSteps', failureClass: 'idle-loop', summary: 'early write then idle', citations: [] },",
      "  innovator: { summary: 'agent-loop.maxSteps=' + maxSteps, parts: { 'agent-loop': { maxSteps } } },",
      "  critic: { excluded: [] },",
      "  ranker: { winnerId: 'c1' },",
      "  'reviewer-gate': { reason: 'hold' },",
      "};",
      "const body = bodies[role];",
      "if (!body) { process.stderr.write('unknown role ' + role + '\\n'); process.exit(2); }",
      "if (role === 'gap-finder') {",
      "  const files = prompt.split('\\n').flatMap((line) => { const path = line.split(' ')[0] ?? ''; return path.includes('/traces/') ? [path] : []; });",
      "  const messages = [];",
      "  files.forEach((file, index) => {",
      "    const id = 'c' + index;",
      "    messages.push({ role: 'assistant', tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: file }) } }] });",
      "    messages.push({ role: 'tool', tool_call_id: id, content: readFileSync(file, 'utf8') });",
      "  });",
      "  messages.push({ role: 'user', content: '{}' });",
      "  await post(messages);",
      "}",
      "await post([{ role: 'user', content: JSON.stringify(body) }]);",
      "",
    ].join("\n"));
    writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(script)} "$@"\n`);
    chmodSync(bin, 0o755);
    const previous = {
      base: process.env.BASE_URL,
      bind: process.env.HARNESS_RELAY_BIND,
      root: process.env.HARNESS_RELAY_LOG_ROOT,
      upstream: process.env.HARNESS_RELAY_UPSTREAM,
    };
    process.env.BASE_URL = "http://127.0.0.1:9";
    process.env.HARNESS_RELAY_BIND = "127.0.0.1";
    process.env.HARNESS_RELAY_LOG_ROOT = join(fx.root, "relay-logs");
    process.env.HARNESS_RELAY_UPSTREAM = upstream.url;
    try {
      const { code, stderr } = await captureStderr(() => main([
        "optimize", "--out", fx.out, "--execute", "--stop-before-run", "--rounds", "1",
        "--pi-bin", bin,
        "--role-max-tokens", "ranker=4096",
        "--attest-root", fx.attestRoot,
        "--attest-key-file", fx.keyFile,
        "--harness", fx.harnessPath,
        "--control-config", fx.controlConfig,
        "--control-attest", fx.controlAttest,
        ...taskFlags(fx.root),
        ...round0Flags(),
      ]));
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(existsSync(join(fx.out, "round1/runs"))).toBe(false);
      expect(existsSync(join(fx.out, "round1/closure.json"))).toBe(true);
      const loop = JSON.parse(readFileSync(join(fx.out, "loop-result.json"), "utf8")) as { stopReport: { reason: string | null } };
      expect(loop.stopReport.reason).toBeNull();
      const ranker = JSON.parse(readFileSync(join(fx.out, "round1/sessions/ranker.spawn.json"), "utf8")) as { maxTokens: number; exitCode?: number };
      const rankerArgv = JSON.parse(readFileSync(join(fx.out, "round1/sessions/ranker.argv.json"), "utf8")) as { maxTokens: number; argv: string[] };
      expect(ranker.maxTokens).toBe(4096);
      expect(ranker.exitCode).toBe(0);
      expect(rankerArgv.maxTokens).toBe(4096);
      expect(rankerArgv.argv).not.toContain("--max-tokens");
      const gap = JSON.parse(readFileSync(join(fx.out, "round1/sessions/gap-finder.spawn.json"), "utf8")) as { maxTokens: number; exitCode?: number };
      expect(gap.maxTokens).toBe(16_384);
      expect(gap.exitCode).toBe(0);
      const reviewSpawn = JSON.parse(readFileSync(join(fx.out, "round1/sessions/reviewer-gate.spawn.json"), "utf8")) as { baseUrl?: string; exitCode?: number };
      expect(reviewSpawn.exitCode).toBe(0);
      const reviewLog = readFileSync(roleLog(join(fx.root, "relay-logs"), reviewSpawn.baseUrl ?? ""), "utf8");
      expect(reviewLog).toContain("hold");
      const config = JSON.parse(readFileSync(join(fx.out, "round1/candidate/config.json"), "utf8")) as { parts: { "agent-loop": { maxSteps: number } } };
      expect(config.parts["agent-loop"].maxSteps).toBe(20);
      const ranking = JSON.parse(readFileSync(join(fx.out, "round1/ranking.json"), "utf8")) as { codeWinner: string | null; rankerWinnerId: string };
      expect(ranking.codeWinner).toBe("c0");
      expect(ranking.rankerWinnerId).toBe("c1");
      const closureRank = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { codeRank?: { winner?: string }; noWinner?: string };
      expect(closureRank.codeRank?.winner).toBe("c0");
      expect(closureRank.noWinner).toBeUndefined();
      expect(existsSync(join(fx.out, "round1/sessions/reviewer-gate.argv.json"))).toBe(true);
      expect(existsSync(join(fx.out, "round1/sessions/critic.argv.json"))).toBe(true);
    } finally {
      await upstream.close();
      if (previous.base === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = previous.base;
      if (previous.bind === undefined) delete process.env.HARNESS_RELAY_BIND;
      else process.env.HARNESS_RELAY_BIND = previous.bind;
      if (previous.root === undefined) delete process.env.HARNESS_RELAY_LOG_ROOT;
      else process.env.HARNESS_RELAY_LOG_ROOT = previous.root;
      if (previous.upstream === undefined) delete process.env.HARNESS_RELAY_UPSTREAM;
      else process.env.HARNESS_RELAY_UPSTREAM = previous.upstream;
    }
  }, 60_000);

  test("execute without --pi-bin still needs roles", async () => {
    const fx = fixture();
    const marker = join(fx.root, "pi-launched");
    const bin = join(fx.root, "pi");
    writeFileSync(bin, `#!/bin/sh\nprintf launched > ${JSON.stringify(marker)}\n`);
    chmodSync(bin, 0o755);
    const previous = process.env.BASE_URL;
    process.env.BASE_URL = "http://127.0.0.1:9";
    try {
      const { code, stderr } = await captureStderr(() => main([
        "optimize", "--out", fx.out, "--execute", "--rounds", "1",
        "--attest-root", fx.attestRoot,
        "--attest-key-file", fx.keyFile,
        "--harness", fx.harnessPath,
        "--control-config", fx.controlConfig,
        "--control-attest", fx.controlAttest,
        ...taskFlags(fx.root),
        ...round0Flags(),
      ]));
      expect(code).toBe(1);
      expect(stderr).toContain("execute mode needs roles");
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(fx.out, "pre-round1.json"))).toBe(false);
      expect(existsSync(join(fx.out, "round1/runs"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = previous;
    }
  });

  test("control-attest accepts an once attestation and rejects a tampered or mismatched one", async () => {
    const fx = fixture();
    const hash = createHash("sha256").update(readFileSync(fx.controlConfig)).digest("hex");
    const attest = onceStyleAttest(fx, hash);
    const previousBind = process.env.HARNESS_RELAY_BIND;
    process.env.HARNESS_RELAY_BIND = "127.0.0.1";
    try {
      const code = await main([
        "optimize", "--out", fx.out, "--dry-run", "--rounds", "1",
        "--attest-root", fx.attestRoot,
        "--attest-key-file", fx.keyFile,
        "--harness", fx.harnessPath,
        "--control-config", fx.controlConfig,
        "--control-attest", attest,
        ...taskFlags(fx.root),
        ...round0Flags(),
      ]);
      expect(code).toBe(0);
      expect(existsSync(join(fx.out, "round1/patch.diff"))).toBe(true);
    } finally {
      if (previousBind === undefined) delete process.env.HARNESS_RELAY_BIND;
      else process.env.HARNESS_RELAY_BIND = previousBind;
    }

    const tamperedFx = fixture();
    const tampered = onceStyleAttest(tamperedFx, hash);
    const signed = JSON.parse(readFileSync(join(tampered, "attestation.json"), "utf8")) as { hmacSha256: string };
    signed.hmacSha256 = "0".repeat(64);
    writeFileSync(join(tampered, "attestation.json"), `${JSON.stringify(signed, null, 2)}\n`);
    const tamper = await captureStderr(() => main([
      "optimize", "--out", tamperedFx.out, "--dry-run", "--rounds", "1",
      "--attest-root", tamperedFx.attestRoot,
      "--attest-key-file", tamperedFx.keyFile,
      "--harness", tamperedFx.harnessPath,
      "--control-config", tamperedFx.controlConfig,
      "--control-attest", tampered,
      ...taskFlags(tamperedFx.root),
      ...round0Flags(),
    ]));
    expect(tamper.code).toBe(1);
    expect(tamper.stderr).toContain("control attestation rejected");
    expect(tamper.stderr).toContain("hmac");

    const mismatchedFx = fixture();
    const mismatched = onceStyleAttest(mismatchedFx, "ab".repeat(32));
    const mismatch = await captureStderr(() => main([
      "optimize", "--out", mismatchedFx.out, "--dry-run", "--rounds", "1",
      "--attest-root", mismatchedFx.attestRoot,
      "--attest-key-file", mismatchedFx.keyFile,
      "--harness", mismatchedFx.harnessPath,
      "--control-config", mismatchedFx.controlConfig,
      "--control-attest", mismatched,
      ...taskFlags(mismatchedFx.root),
      ...round0Flags(),
    ]));
    expect(mismatch.code).toBe(1);
    expect(mismatch.stderr).toContain("candidateConfigHash");
  });

  test("control-attest reads a task-* trace without rewriting the run", async () => {
    const fx = fixture();
    const hash = createHash("sha256").update(readFileSync(fx.controlConfig)).digest("hex");
    const laid = taskStyleAttest(fx, hash);
    const signed = JSON.parse(readFileSync(join(laid.attest, "attestation.json"), "utf8")) as {
      traceSha: string;
      piSessionShas: Record<string, string>;
      outputShas: Record<string, string>;
    };
    expect(signed.traceSha).toBe(createHash("sha256").update(readFileSync(laid.trace)).digest("hex"));
    expect(signed.piSessionShas["session.jsonl"]).toBe(createHash("sha256").update(readFileSync(laid.session)).digest("hex"));
    expect(signed.outputShas["answer.txt"]).toBe(createHash("sha256").update(readFileSync(laid.output)).digest("hex"));
    expect(existsSync(join(laid.run, "trace.jsonl"))).toBe(false);
    expect(readFileSync(laid.trace)).toEqual(laid.traceBytes);
    expect(statSync(laid.trace).mtimeMs).toBe(laid.traceMtime);
    const previousBind = process.env.HARNESS_RELAY_BIND;
    process.env.HARNESS_RELAY_BIND = "127.0.0.1";
    try {
      const code = await main([
        "optimize", "--out", fx.out, "--dry-run", "--rounds", "1",
        "--attest-root", fx.attestRoot,
        "--attest-key-file", fx.keyFile,
        "--harness", fx.harnessPath,
        "--control-config", fx.controlConfig,
        "--control-attest", laid.attest,
        ...taskFlags(fx.root),
        ...round0Flags(),
      ]);
      expect(code).toBe(0);
      expect(readFileSync(laid.trace)).toEqual(laid.traceBytes);
    } finally {
      if (previousBind === undefined) delete process.env.HARNESS_RELAY_BIND;
      else process.env.HARNESS_RELAY_BIND = previousBind;
    }

    const mismatchedFx = fixture();
    const mismatched = taskStyleAttest(mismatchedFx, "ab".repeat(32));
    const mismatch = await captureStderr(() => main([
      "optimize", "--out", mismatchedFx.out, "--dry-run", "--rounds", "1",
      "--attest-root", mismatchedFx.attestRoot,
      "--attest-key-file", mismatchedFx.keyFile,
      "--harness", mismatchedFx.harnessPath,
      "--control-config", mismatchedFx.controlConfig,
      "--control-attest", mismatched.attest,
      ...taskFlags(mismatchedFx.root),
      ...round0Flags(),
    ]));
    expect(mismatch.code).toBe(1);
    expect(mismatch.stderr).toContain("candidateConfigHash");
  });
});

test("a live role call needs a done line with tokens and exit 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "role-done-"));
  const log = join(dir, "relay.jsonl");
  expect(() => assertLiveRoleCall("gap-finder", 0, log)).toThrow(/no relay request/);
  writeFileSync(log, `${JSON.stringify({ type: "done", usage: { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } } })}\n`);
  expect(() => assertLiveRoleCall("gap-finder", 0, log)).toThrow(/no relay request/);
  writeFileSync(log, `${JSON.stringify({ type: "done", usage: null })}\n`);
  expect(() => assertLiveRoleCall("gap-finder", 0, log)).toThrow(/no relay request/);
  expect(() => assertLiveRoleCall("gap-finder", 2, log)).toThrow(/exited 2/);
  expect(() => assertLiveRoleCall("gap-finder", null, log)).toThrow(/exited null/);
  writeFileSync(log, `${JSON.stringify({ type: "done", usage: { prompt_tokens: 3, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } } })}\n`);
  expect(() => assertLiveRoleCall("gap-finder", 0, log)).not.toThrow();
});

const liveRoleSmoke = process.env.LOOP_LIVE_SMOKE === "1" && Boolean(process.env.PI_BIN);
(liveRoleSmoke ? test : test.skip)(
  "live role smoke runs the role chain on a real round-0 trace and stops before docker",
  async () => {
    const round0TracePath = process.env.LOOP_LIVE_ROUND0 ?? "";
    const round0TraceSha = process.env.LOOP_LIVE_ROUND0_SHA ?? "";
    if (round0TracePath === "" || !/^[0-9a-f]{64}$/.test(round0TraceSha)) {
      throw new Error("live chain needs LOOP_LIVE_ROUND0 and LOOP_LIVE_ROUND0_SHA");
    }
    const fx = fixture();
    const previous = {
      base: process.env.BASE_URL,
      bind: process.env.HARNESS_RELAY_BIND,
      root: process.env.HARNESS_RELAY_LOG_ROOT,
    };
    if (!process.env.BASE_URL) process.env.BASE_URL = "http://127.0.0.1:9";
    process.env.HARNESS_RELAY_BIND = "127.0.0.1";
    process.env.HARNESS_RELAY_LOG_ROOT = join(fx.root, "relay-logs");
    try {
      const report = await runLiveRoleSmoke({
        out: fx.out,
        attestRoot: fx.attestRoot,
        attestKeyFile: fx.keyFile,
        piBin: process.env.PI_BIN ?? "",
        harnessPath: fx.harnessPath,
        controlAttests: [fx.controlAttest],
        controlConfigPath: fx.controlConfig,
        task: LOOP_TASK,
        round0TracePath,
        round0TraceSha,
      });
      expect(report.dockerRuns).toBe(0);
      expect(report.gapCitedTrace).toBe(true);
      expect(existsSync(join(fx.out, "round1/runs"))).toBe(false);
      const gapArgvRecord = JSON.parse(readFileSync(join(fx.out, "round1/sessions/gap-finder.argv.json"), "utf8")) as { argv: string[]; maxTokens: number };
      const gapArgv = gapArgvRecord.argv;
      expect(gapArgvRecord.maxTokens).toBe(16_384);
      const prompt = gapArgv.at(-1) ?? "";
      expect(prompt).toContain("/traces/round0-trace.jsonl");
      expect(prompt).toContain("/traces/control-trace.jsonl");
      expect(prompt).not.toContain("private");
      expect(gapArgv).toContain("--print");
      expect(gapArgv[gapArgv.indexOf("--tools") + 1]).toBe("read");
      expect((gapArgv[gapArgv.indexOf("--tools") + 1] ?? "").split(",")).not.toContain("bash");
      expect(gapArgv[gapArgv.indexOf("--system-prompt") + 1]?.endsWith("/agents/gap-finder.md")).toBe(true);
      const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { rank?: string };
      if (report.rank === "walkover") expect(closure.rank).toBe("walkover");
      else expect(existsSync(join(fx.out, "round1/sessions/ranker.argv.json"))).toBe(true);
      expect(existsSync(join(fx.out, "round1/sessions/reviewer-gate.argv.json"))).toBe(true);
    } finally {
      if (previous.base === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = previous.base;
      if (previous.bind === undefined) delete process.env.HARNESS_RELAY_BIND;
      else process.env.HARNESS_RELAY_BIND = previous.bind;
      if (previous.root === undefined) delete process.env.HARNESS_RELAY_LOG_ROOT;
      else process.env.HARNESS_RELAY_LOG_ROOT = previous.root;
    }
  },
  1_800_000,
);

describe("optimize-one command", () => {
  test("one honest candidate run can be active, and an echoing command cannot", async () => {
    const fx = fixture();
    const candidate = join(fx.root, "candidate.json");
    writeFileSync(candidate, "{\"parts\":{\"agent-loop\":{\"maxSteps\":24}}}\n");
    const honest = join(fx.root, "honest.mjs");
    const attestModule = new URL("./attestation.ts", import.meta.url).href;
    writeFileSync(honest, `
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeHostAttestation } from ${JSON.stringify(attestModule)};
const args = process.argv.slice(2);
const get = (flag) => args[args.indexOf(flag) + 1];
const run = get("--run-dir");
const config = get("--config");
mkdirSync(run, { recursive: true });
writeFileSync(join(run, "argv.json"), JSON.stringify(args));
const bytes = readFileSync(config);
const hash = createHash("sha256").update(bytes).digest("hex");
const parts = JSON.parse(bytes.toString()).parts ?? {};
const effective = {};
for (const [part, value] of Object.entries(parts)) {
  for (const [leaf, item] of Object.entries(value)) effective[part + "." + leaf] = item;
}
mkdirSync(join(run, "outputs"), { recursive: true });
const answer = join(run, "outputs", "answer.txt");
writeFileSync(answer, "ok\\n");
utimesSync(answer, 1700000000, 1700000000);
writeFileSync(join(run, "trace.jsonl"), JSON.stringify({ type: "run_start", candidateConfigHash: hash, effective }) + "\\n");
writeFileSync(join(run, "batch.log"), "2026-10-21T00:00:01.000Z run 1 done\\n");
mkdirSync(join(run, "verifier"), { recursive: true });
writeFileSync(join(run, "verifier", "reward.txt"), "1\\n");
mkdirSync(join(run, ".pi-sessions"), { recursive: true });
const preamble = "\\n\\n### Loaded candidate config\\ncandidateConfigHash: " + hash + "\\n";
writeFileSync(join(run, ".pi-sessions", "session.jsonl"), JSON.stringify({
  type: "message",
  message: { role: "system", content: "", sections: { preamble }, timestamp: 0 },
}) + "\\n");
writeFileSync(join(run, "result.json"), JSON.stringify({ reward: 1, tokens: 4, wall_s: 1, timed_out: false, score_status: "scored", runId: get("--run-id") }) + "\\n");
writeHostAttestation({
  attestDir: get("--attest-dir"),
  runDir: run,
  key: readFileSync(process.env.HARNESS_ATTEST_KEY_FILE),
  harnessPath: get("--harness"),
  configPath: config,
  reward: 1,
  meta: { task: get("--task"), seed: Number(get("--seed")), arm: get("--arm"), score_status: "scored", tokens: 4, exit: 0, runDir: run, runId: get("--run-id"), nonce: get("--nonce"), runPath: run, at: "2026-10-21T00:00:00+09:00" },
});
console.log(JSON.stringify({ attestation: "/tmp/not-read/attestation.json" }));
`);
    const previous = process.env.BASE_URL;
    const previousKey = process.env.HARNESS_ATTEST_KEY_FILE;
    process.env.BASE_URL = "http://127.0.0.1:9";
    process.env.HARNESS_ATTEST_KEY_FILE = fx.keyFile;
    const command = [
      process.execPath, honest,
      "--task", "{taskPath}",
      "--seed", "{seed}",
      "--arm", "{arm}",
      "--config", "{config}",
      "--run-dir", "{runDir}",
      "--attest-dir", "{attestDir}",
      "--harness", "{harness}",
      "--model", "{model}",
      "--network", "{network}",
      "--token-cap", "{tokenCap}",
      "--run-id", "{runId}",
      "--nonce", "{nonce}",
    ];
    try {
      const code = await main([
        "optimize-one",
        "--out", fx.out,
        "--attest-root", fx.attestRoot,
        "--attest-key-file", fx.keyFile,
        "--harness", fx.harnessPath,
        "--config", candidate,
        "--control-config", fx.controlConfig,
        "--knob", "agent-loop.maxSteps",
        "--seed", "0",
        "--executor-cmd", JSON.stringify(command),
        ...taskFlags(fx.root),
      ]);
      expect(code).toBe(0);
      const saved = JSON.parse(readFileSync(join(fx.out, "once/activation.json"), "utf8")) as { patchActive: boolean };
      expect(saved.patchActive).toBe(true);
      expect(existsSync(join(fx.out, "final/order.json"))).toBe(false);
      const argv = JSON.parse(readFileSync(join(fx.out, "once/hb003/seed0/candidate/argv.json"), "utf8")) as string[];
      expect(argv).toContain("devii-004-int");
      expect(argv).not.toContain("open");
      expect(argv).not.toContain("shared");
      expect(argv.join(" ")).not.toContain(fx.keyFile);
    } finally {
      if (previous === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = previous;
      if (previousKey === undefined) delete process.env.HARNESS_ATTEST_KEY_FILE;
      else process.env.HARNESS_ATTEST_KEY_FILE = previousKey;
    }

    const echoFx = fixture();
    const echoScript = join(echoFx.root, "echo.mjs");
    writeFileSync(echoScript, `
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const get = (flag) => args[args.indexOf(flag) + 1];
const run = get("--run-dir");
const bytes = readFileSync(get("--config"));
const hash = createHash("sha256").update(bytes).digest("hex");
mkdirSync(join(run, "outputs"), { recursive: true });
const answer = join(run, "outputs", "answer.txt");
writeFileSync(answer, "echo\\n");
utimesSync(answer, 1700000000, 1700000000);
writeFileSync(join(run, "trace.jsonl"), JSON.stringify({ type: "run_start", candidateConfigHash: hash, effective: { "agent-loop.maxSteps": 24 } }) + "\\n");
writeFileSync(join(run, "batch.log"), "2026-10-21T00:00:01.000Z run 1 done\\n");
mkdirSync(join(run, "verifier"), { recursive: true });
writeFileSync(join(run, "verifier", "reward.txt"), "1\\n");
mkdirSync(join(run, ".pi-sessions"), { recursive: true });
const preamble = "\\n\\n### Loaded candidate config\\ncandidateConfigHash: " + hash + "\\n";
writeFileSync(join(run, ".pi-sessions", "session.jsonl"), JSON.stringify({
  type: "message",
  message: { role: "system", content: "", sections: { preamble }, timestamp: 0 },
}) + "\\n");
writeFileSync(join(run, "attestation.json"), "{\\"hmacSha256\\":\\"00\\"}\\n");
writeFileSync(join(run, "result.json"), JSON.stringify({ reward: 1, tokens: 4, wall_s: 1, timed_out: false, score_status: "scored", attestation: join(run, "attestation.json") }) + "\\n");
console.log(JSON.stringify({ attestation: join(run, "attestation.json") }));
`);
    writeFileSync(join(echoFx.root, "candidate.json"), readFileSync(candidate));
    process.env.BASE_URL = "http://127.0.0.1:9";
    process.env.HARNESS_ATTEST_KEY_FILE = echoFx.keyFile;
    try {
      const code = await main([
        "optimize-one",
        "--out", echoFx.out,
        "--attest-root", echoFx.attestRoot,
        "--attest-key-file", echoFx.keyFile,
        "--harness", echoFx.harnessPath,
        "--config", join(echoFx.root, "candidate.json"),
        "--control-config", echoFx.controlConfig,
        "--knob", "agent-loop.maxSteps",
        "--executor-cmd", JSON.stringify([process.execPath, echoScript, "--task", "{taskPath}", "--config", "{config}", "--run-dir", "{runDir}", "--attest-dir", "{attestDir}", "--harness", "{harness}", "--model", "{model}", "--network", "{network}"]),
        ...taskFlags(echoFx.root),
      ]);
      expect(code).toBe(1);
      const saved = JSON.parse(readFileSync(join(echoFx.out, "once/activation.json"), "utf8")) as { patchActive: boolean };
      expect(saved.patchActive).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = previous;
      if (previousKey === undefined) delete process.env.HARNESS_ATTEST_KEY_FILE;
      else process.env.HARNESS_ATTEST_KEY_FILE = previousKey;
    }
  });

  test("the direct once helper does not run the final block", async () => {
    const fx = fixture();
    const candidate = join(fx.root, "candidate.json");
    writeFileSync(candidate, "{\"parts\":{\"agent-loop\":{\"maxSteps\":24}}}\n");
    const result = await runOptOnce({
      out: fx.out,
      attestRoot: fx.attestRoot,
      attestKeyFile: fx.keyFile,
      harnessPath: fx.harnessPath,
      configPath: candidate,
      controlConfigPath: fx.controlConfig,
      knob: "agent-loop.maxSteps",
      seed: 0,
      task: LOOP_TASK,
      executor: {
        name: "honest",
        async run(request) {
          writeRunArtifacts(request, {
            reward: 1,
            tokens: 10,
            wallS: 1,
            timedOut: false,
            tWrite: 1_700_000_000,
            tEnd: 1_700_000_001,
            assistantTs: [],
          }, { key: fx.key, harnessPath: fx.harnessPath });
          return observation(request, { reward: 1, tokens: 10, wallS: 1, timedOut: false });
        },
      },
    });
    expect(result.patchActive).toBe(true);
    expect(existsSync(join(fx.out, "final/order.json"))).toBe(false);
    expect(existsSync(join(fx.out, "round1"))).toBe(false);
  });

  test("a read-only token cap starts no executor call", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 2,
      roles: rejectingRoles(fx),
      executor: fake.executor,
      readOnlyTokens: () => 30_000_000,
    });
    expect(fake.calls).toEqual([]);
    expect(result.rounds).toEqual([]);
    expect(result.skippedFinal).toBe(true);
    expect(result.stopReport).toEqual({ reason: "readOnlyTokenCap", faultRounds: 0, reviewerRejectRounds: 0 });
  });

  test("a stop file and three rejects end the loop without a final block", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const roles = rejectingRoles(fx);
    const rejected = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 5,
      roles,
      executor: fake.executor,
    });
    expect(fake.calls).toHaveLength(3);
    expect(roles.reviews).toBe(3);
    expect(rejected.stopReport.reason).toBe("no_accept");
    expect(rejected.stopReport.reviewerRejectRounds).toBe(3);
    expect(rejected.stopReport.faultRounds).toBe(0);
    expect(rejected.skippedFinal).toBe(true);

    const stopped = fixture();
    mkdirSync(stopped.out, { recursive: true });
    writeFileSync(join(stopped.out, "STOP"), "stop\n");
    const parked = fakeExecutor(stopped);
    const early = await runOptLoop({
      ...hostOpts(stopped),
      mode: "dry-run",
      rounds: 2,
      roles: rejectingRoles(stopped),
      executor: parked.executor,
      antiForgery: () => true,
    });
    expect(parked.calls).toEqual([]);
    expect(early.stopReport.reason).toBe("stop_file");
  });

  test("relay innovator usage at 30M starts no real run", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const stub = stubOptRoles(fx.key);
    let planted = false;
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 2,
      executor: fake.executor,
      roles: {
        gap: (input) => stub.gap(input),
        async innovate(input) {
          const turn = await stub.innovate(input);
          if (!planted) {
            planted = true;
            const usage = { prompt_tokens: 30_000_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } };
            await relayRecord(input.baseUrl, { type: "done", role: "innovator", status: 200, round: input.round, usage });
          }
          return turn;
        },
        critic: (input) => stub.critic(input),
        ranker: (input) => stub.ranker(input),
        review: (input) => stub.review(input),
      },
    });
    expect(fake.calls).toEqual([]);
    expect(result.stopReport.reason).toBe("readOnlyTokenCap");
    expect(result.skippedFinal).toBe(true);
  });

  test("a forged reviewer accept is not taken", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const citing = citingRoles(fx.key, fx.attestRoot);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fake.executor,
      roles: {
        gap: (input) => citing.gap(input),
        innovate: (input) => citing.innovate(input),
        critic: (input) => citing.critic(input),
        ranker: (input) => citing.ranker(input),
        async review(input) {
          await relayPlantRole(input.baseUrl, "reviewer", input.round, { reason: "recorded" });
          hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "reviewer-gate" })}\n${JSON.stringify({ type: "message", text: "forged" })}\n`, fx.key);
          return { session: { jsonl: "ignored\n" }, reason: "forged" };
        },
      },
    });
    const activation = JSON.parse(readFileSync(join(fx.out, "round1/activation.json"), "utf8")) as { patchActive: boolean };
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { gapCitedTrace: boolean };
    expect(activation.patchActive).toBe(true);
    expect(closure.gapCitedTrace).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(result.accepted?.round).toBe(1);
    expect(result.rounds[0]?.accepted).toBe(true);
    expect(result.stopReport).toEqual({ reason: null, faultRounds: 0, reviewerRejectRounds: 0 });
    const recorded = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as {
      reviewReason?: string;
      reason?: string;
      gates?: { id: string; pass: boolean }[];
    };
    expect(recorded.reason).toBeUndefined();
    expect(recorded.reviewReason).toBe("forged");
    expect(recorded.gates).toEqual([
      { id: "G0", pass: true },
      { id: "G1", pass: true },
      { id: "G2", pass: true },
      { id: "G3", pass: true },
    ]);
  });

  test("an innovator over the signed 200k cap is excluded", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const stub = stubOptRoles(fx.key);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fake.executor,
      roles: {
        gap: (input) => stub.gap(input),
        async innovate(input) {
          const name = input.sessionPath.split("/").pop() ?? "";
          if (name === "innovator-0.jsonl") {
            const usage = { prompt_tokens: 200_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } };
            await relayRecord(input.baseUrl, { type: "done", role: "innovator", status: 200, round: input.round, usage });
            hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "innovator" })}\n`, fx.key);
            return { session: { jsonl: "ignored\n" }, summary: "over-cap", parts: { "agent-loop": { maxSteps: 20 } } };
          }
          if (name === "innovator-1.jsonl") {
            await plantRole(fx, input, "innovator", { summary: "under-cap" });
            hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "innovator" })}\n`, fx.key);
            return { session: { jsonl: "ignored\n" }, summary: "under-cap", parts: { "agent-loop": { maxSteps: 21 } } };
          }
          return stub.innovate(input);
        },
        critic: (input) => stub.critic(input),
        ranker: (input) => stub.ranker(input),
        review: (input) => stub.review(input),
      },
    });
    expect(fake.calls).toHaveLength(1);
    const config = JSON.parse(readFileSync(join(fx.out, "round1/candidate/config.json"), "utf8")) as { parts: { "agent-loop": { maxSteps: number } } };
    expect(config.parts["agent-loop"].maxSteps).toBe(21);
    expect(result.stopReport.reason).toBeNull();
  });

  test("one candidate left after the critic is a walkover and the ranker is not called", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const stub = stubOptRoles(fx.key);
    let rankerCalls = 0;
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fake.executor,
      roles: {
        gap: (input) => stub.gap(input),
        innovate: (input) => stub.innovate(input),
        critic: (input) => stub.critic(input),
        async ranker(input) {
          rankerCalls += 1;
          return stub.ranker(input);
        },
        review: (input) => stub.review(input),
      },
    });
    expect(rankerCalls).toBe(0);
    expect(existsSync(join(fx.out, "round1/ranker-input.json"))).toBe(false);
    expect(existsSync(join(fx.out, "round1/sessions/ranker.spawn.json"))).toBe(false);
    const ledger = JSON.parse(readFileSync(join(fx.out, "round1/sessions/ledger.json"), "utf8")) as { rank?: string };
    expect(ledger.rank).toBe("walkover");
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { rank?: string };
    expect(closure.rank).toBe("walkover");
    expect(fake.calls.map((call) => `${call.task.id}:${call.seed}`)).toEqual(["hb003:0"]);
    const config = JSON.parse(readFileSync(join(fx.out, "round1/candidate/config.json"), "utf8")) as { parts: { "agent-loop": { maxSteps: number } } };
    expect(config.parts["agent-loop"].maxSteps).toBe(24);
    expect(result.stopReport.reason).toBeNull();
  });

  test("zero candidates left records no_winner and the next round generates candidates", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const stub = stubOptRoles(fx.key);
    let rankerCalls = 0;
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 2,
      executor: fake.executor,
      roles: {
        gap: (input) => stub.gap(input),
        innovate: (input) => stub.innovate(input),
        async critic(input) {
          if (input.round !== 1) return stub.critic(input);
          const excluded = input.candidates.map((item) => item.id);
          await relayPlantRole(input.baseUrl, "critic", input.round, { excluded });
          hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "critic" })}\n`, fx.key);
          return { session: { jsonl: "ignored\n" }, excluded };
        },
        async ranker(input) {
          rankerCalls += 1;
          return stub.ranker(input);
        },
        review: (input) => stub.review(input),
      },
    });
    expect(rankerCalls).toBe(0);
    expect(existsSync(join(fx.out, "round1/candidate/config.json"))).toBe(false);
    expect(existsSync(join(fx.out, "round1/ranker-input.json"))).toBe(false);
    const review = readFileSync(join(fx.out, "round1/sessions/reviewer-gate.jsonl"), "utf8");
    expect(review).toContain("no_winner");
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { noWinner?: string };
    expect(closure.noWinner).toBe("no_winner");
    const gap = JSON.parse(readFileSync(join(fx.out, "round2/gap-input.json"), "utf8")) as { previousReview?: { reason?: string } };
    expect(gap.previousReview?.reason).toBe("no_winner");
    expect(existsSync(join(fx.out, "round2/innovator-0-input.json"))).toBe(true);
    expect(fake.calls.map((call) => call.runDir.includes("/round2/"))).toEqual([true]);
    expect(result.rounds[0]?.accepted).toBe(false);
    expect(result.rounds[0]?.noWinner).toBe("no_winner");
    expect(result.stopReport.reason).toBeNull();
    expect(result.stopReport.noWinner).toEqual([{ round: 1, reason: "no_winner" }]);
  });

  test("tied changed keys: the ranker's non-first winnerId wins and the key order is only recorded", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      stopBeforeRun: true,
      rounds: 1,
      executor: fake.executor,
      roles: equalKeyRoles(fx, "c1"),
    });
    expect(fake.calls).toEqual([]);
    expect(existsSync(join(fx.out, "round1/runs"))).toBe(false);
    const config = JSON.parse(readFileSync(join(fx.out, "round1/candidate/config.json"), "utf8")) as { parts: { "agent-loop": { maxSteps: number } } };
    expect(config.parts["agent-loop"].maxSteps).toBe(21);
    const ranking = JSON.parse(readFileSync(join(fx.out, "round1/ranking.json"), "utf8")) as { codeWinner: string | null; rankerWinnerId: string };
    expect(ranking.codeWinner).toBe("c0");
    expect(ranking.rankerWinnerId).toBe("c1");
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as {
      codeRank?: { winner?: string };
      noWinner?: string;
      preflight?: boolean;
      final?: boolean;
      gates?: { id: string; pass: boolean; code?: string }[];
      reason?: string;
    };
    expect(closure.codeRank?.winner).toBe("c0");
    expect(closure.noWinner).toBeUndefined();
    expect(closure.reason).toBeUndefined();
    expect(closure.preflight).toBe(true);
    expect(closure.final).toBe(false);
    expect(closure.gates).toEqual([
      { id: "G1", pass: false },
      { id: "G2", pass: true },
    ]);
    expect(result.rounds[0]?.codeRank?.winner).toBe("c0");
    expect(result.rounds[0]?.noWinner).toBeUndefined();
    expect(result.stopReport.reason).toBeNull();
    expect(result.stopReport.noWinner).toBeUndefined();
    const review = readFileSync(join(fx.out, "round1/sessions/reviewer-gate.jsonl"), "utf8");
    expect(review).not.toContain("这一轮没有候选");
    const reviewSpawn = JSON.parse(readFileSync(join(fx.out, "round1/sessions/reviewer-gate.spawn.json"), "utf8")) as { baseUrl?: string };
    const reviewLog = readFileSync(roleLog(join(fx.attestRoot, "relay-logs"), reviewSpawn.baseUrl ?? ""), "utf8");
    expect(reviewLog).toContain("hold");
  });

  test("an empty ranker winnerId is no_winner:ranker_invalid in the closure, the round, and stopReport", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      stopBeforeRun: true,
      rounds: 1,
      executor: fake.executor,
      roles: equalKeyRoles(fx, ""),
    });
    expect(fake.calls).toEqual([]);
    expect(existsSync(join(fx.out, "round1/candidate/config.json"))).toBe(false);
    expect(existsSync(join(fx.out, "round1/review-input.json"))).toBe(false);
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { noWinner?: string; codeRank?: { winner?: string } };
    expect(closure.noWinner).toBe("no_winner:ranker_invalid");
    expect(closure.codeRank?.winner).toBe("c0");
    expect(result.rounds[0]?.noWinner).toBe("no_winner:ranker_invalid");
    expect(result.stopReport.reason).toBeNull();
    expect(result.stopReport.noWinner).toEqual([{ round: 1, reason: "no_winner:ranker_invalid" }]);
  });

  test("an unknown ranker winnerId is no_winner:ranker_invalid", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fake.executor,
      roles: equalKeyRoles(fx, "c9"),
    });
    expect(existsSync(join(fx.out, "round1/candidate/config.json"))).toBe(false);
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { noWinner?: string };
    expect(closure.noWinner).toBe("no_winner:ranker_invalid");
    expect(result.rounds[0]?.noWinner).toBe("no_winner:ranker_invalid");
    expect(result.stopReport.noWinner).toEqual([{ round: 1, reason: "no_winner:ranker_invalid" }]);
    expect(fake.calls).toEqual([]);
  });

  test("a critic-excluded ranker winnerId is no_winner:ranker_invalid", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fake.executor,
      roles: equalKeyRoles(fx, "c2", { excluded: ["c2"], third: true }),
    });
    expect(existsSync(join(fx.out, "round1/candidate/config.json"))).toBe(false);
    const ranking = JSON.parse(readFileSync(join(fx.out, "round1/ranking.json"), "utf8")) as { codeWinner: string | null; rankerWinnerId: string };
    expect(ranking.codeWinner).toBe("c0");
    expect(ranking.rankerWinnerId).toBe("c2");
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { noWinner?: string };
    expect(closure.noWinner).toBe("no_winner:ranker_invalid");
    expect(result.rounds[0]?.noWinner).toBe("no_winner:ranker_invalid");
    expect(result.stopReport.noWinner).toEqual([{ round: 1, reason: "no_winner:ranker_invalid" }]);
    expect(fake.calls).toEqual([]);
  });

  test("stop-before-run fails when the ranker names a winner and reviewer-gate made no relay call", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    await expect(runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      stopBeforeRun: true,
      rounds: 1,
      executor: fake.executor,
      roles: equalKeyRoles(fx, "c1", { reviewPlant: false }),
    })).rejects.toThrow("ranker named a winner but reviewer-gate did not run");
    expect(fake.calls).toEqual([]);
    expect(existsSync(join(fx.out, "round1/runs"))).toBe(false);
  });

  test("execute mode ignores a read-only token override", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const upstream = await listenEchoUpstream();
    const session = (input: { spawn: RoleSpawnConfig }, role: string) => {
      hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role })}\n`, fx.key);
    };
    try {
      const result = await runOptLoop({
        ...hostOpts(fx),
        mode: "execute",
        env: {
          BASE_URL: "https://example.test/v1",
          HARNESS_RELAY_LOG_ROOT: join(fx.attestRoot, "relay-logs"),
          HARNESS_RELAY_BIND: "127.0.0.1",
          HARNESS_RELAY_UPSTREAM: upstream.url,
        },
        rounds: 1,
        executor: fake.executor,
        readOnlyTokens: () => 30_000_000,
        roles: {
          gap: (input) => stubOptRoles(fx.key).gap(input),
          async innovate(input) {
            await postConclusion(input.baseUrl, { summary: "agent-loop.maxSteps=24" });
            session(input, "innovator");
            return { session: { jsonl: "ignored\n" }, summary: "agent-loop.maxSteps=24", parts: { "agent-loop": { maxSteps: 24 } } };
          },
          async critic(input) {
            await postConclusion(input.baseUrl, { excluded: [] });
            session(input, "critic");
            return { session: { jsonl: "ignored\n" }, excluded: [] };
          },
          async ranker(input) {
            const winnerId = input.candidates[0]?.id ?? "";
            await postConclusion(input.baseUrl, { winnerId });
            session(input, "ranker");
            return { session: { jsonl: "ignored\n" }, winnerId };
          },
          async review(input) {
            await postConclusion(input.baseUrl, { reason: "still idle" });
            session(input, "reviewer-gate");
            return { session: { jsonl: "ignored\n" }, reason: "still idle" };
          },
        },
      });
      expect(fake.calls).toHaveLength(1);
      expect(result.stopReport.reason).toBeNull();
    } finally {
      await upstream.close();
    }
  });

  test("a deleted innovator relay record stops the loop", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const stub = stubOptRoles(fx.key);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 2,
      executor: fake.executor,
      roles: {
        gap: (input) => stub.gap(input),
        async innovate(input) {
          const turn = await stub.innovate(input);
          if (input.sessionPath.endsWith("innovator-0.jsonl")) unlinkSync(roleLog(join(fx.attestRoot, "relay-logs"), input.baseUrl));
          return turn;
        },
        critic: (input) => stub.critic(input),
        ranker: (input) => stub.ranker(input),
        review: (input) => stub.review(input),
      },
    });
    expect(fake.calls).toEqual([]);
    expect(result.stopReport.reason).toBe("usage_missing");
    expect(result.stopReport.faultRounds).toBe(1);
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]?.reason).toBe("usage_missing");
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { reason?: string };
    expect(closure.reason).toBe("usage_missing");
  });

  test("a gap-finder relay fault writes closure", async () => {
    const fx = fixture();
    const stub = stubOptRoles(fx.key);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fakeExecutor(fx).executor,
      roles: {
        async gap(input) {
          const turn = await stub.gap(input);
          unlinkSync(roleLog(join(fx.attestRoot, "relay-logs"), input.baseUrl));
          return turn;
        },
        innovate: (input) => stub.innovate(input),
        critic: (input) => stub.critic(input),
        ranker: (input) => stub.ranker(input),
        review: (input) => stub.review(input),
      },
    });
    expect(result.stopReport.reason).toBe("usage_missing");
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { reason?: string };
    expect(closure.reason).toBe("usage_missing");
    expect(existsSync(join(fx.out, "loop-result.json"))).toBe(true);
  });

  test("null innovator usage and a request without a done line stop the loop", async () => {
    const fx = fixture();
    const stub = stubOptRoles(fx.key);
    const nullUsage = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fakeExecutor(fx).executor,
      roles: {
        gap: (input) => stub.gap(input),
        async innovate(input) {
          const turn = await stub.innovate(input);
          if (input.sessionPath.endsWith("innovator-0.jsonl")) {
            await relayRecord(input.baseUrl, { type: "done", role: "innovator", status: 200, round: input.round, usage: null });
          }
          return turn;
        },
        critic: (input) => stub.critic(input),
        ranker: (input) => stub.ranker(input),
        review: (input) => stub.review(input),
      },
    });
    expect(nullUsage.stopReport).toEqual({ reason: "usage_missing", faultRounds: 1, reviewerRejectRounds: 0 });

    const reqOnly = fixture();
    const reqStub = stubOptRoles(reqOnly.key);
    const missingDone = await runOptLoop({
      ...hostOpts(reqOnly),
      mode: "dry-run",
      rounds: 1,
      executor: fakeExecutor(reqOnly).executor,
      roles: {
        gap: (input) => reqStub.gap(input),
        async innovate(input) {
          if (input.sessionPath.endsWith("innovator-0.jsonl")) {
            await relayRecord(input.baseUrl, { type: "req", role: "innovator", seq: 1, round: input.round });
            hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "innovator" })}\n`, reqOnly.key);
            return { session: { jsonl: "ignored\n" }, summary: "no-done", parts: { "agent-loop": { maxSteps: 20 } } };
          }
          return reqStub.innovate(input);
        },
        critic: (input) => reqStub.critic(input),
        ranker: (input) => reqStub.ranker(input),
        review: (input) => reqStub.review(input),
      },
    });
    expect(missingDone.stopReport.reason).toBe("usage_missing");
    expect(missingDone.stopReport.faultRounds).toBe(1);
  });

  test("a missing critic relay record is a fault round", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const stub = stubOptRoles(fx.key);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fake.executor,
      roles: {
        gap: (input) => stub.gap(input),
        innovate: (input) => stub.innovate(input),
        async critic(input) {
          const turn = await stub.critic(input);
          unlinkSync(roleLog(join(fx.attestRoot, "relay-logs"), input.baseUrl));
          return turn;
        },
        ranker: (input) => stub.ranker(input),
        review: (input) => stub.review(input),
      },
    });
    expect(fake.calls).toEqual([]);
    expect(result.stopReport.reason).toBe("usage_missing");
    expect(result.stopReport.faultRounds).toBe(1);
  });

  test("a 10M innovator is cap_hit and a 10M critic stops the round at the 3M ranking cap", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const stub = stubOptRoles(fx.key);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fake.executor,
      roles: {
        gap: (input) => stub.gap(input),
        async innovate(input) {
          if (input.sessionPath.endsWith("innovator-1.jsonl")) return secondProposal(fx.key, input);
          if (input.sessionPath.endsWith("innovator-2.jsonl")) {
            const summary = "memory.recall=recent";
            await relayPlantRole(input.baseUrl, "innovator", input.round, { summary });
            hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "innovator" })}\n`, fx.key);
            return { session: { jsonl: "ignored\n" }, summary, parts: { memory: { recall: "recent" } } };
          }
          const turn = await stub.innovate(input);
          if (input.sessionPath.endsWith("innovator-0.jsonl")) {
            await relayRecord(input.baseUrl, { type: "done", role: "innovator", status: 200, round: input.round, usage: { prompt_tokens: 10_000_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } } });
          }
          return turn;
        },
        async critic(input) {
          const turn = await stub.critic(input);
          await relayRecord(input.baseUrl, { type: "done", role: "critic", status: 200, round: input.round, usage: { prompt_tokens: 10_000_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } } });
          return turn;
        },
        async ranker(input) {
          const turn = await stub.ranker(input);
          await relayRecord(input.baseUrl, { type: "done", role: "ranker", status: 200, round: input.round, usage: { prompt_tokens: 10_000_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } } });
          return turn;
        },
        review: (input) => stub.review(input),
      },
    });
    expect(fake.calls).toEqual([]);
    expect(result.stopReport.reason).toBeNull();
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as {
      reason?: string;
      invalidCandidates?: { id: string; reason: string }[];
    };
    expect(closure.invalidCandidates?.some((item) => item.id === "c0" && item.reason === "cap_hit")).toBe(true);
    expect(closure.reason).toBe("no_winner:cap_hit");
    expect(existsSync(join(fx.out, "round1/sessions/ranker.spawn.json"))).toBe(false);
  });

  test("the role relay log is outside the role cwd and the spawn points at the relay", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fake.executor,
      roles: stubOptRoles(fx.key),
    });
    const spawn = JSON.parse(readFileSync(join(fx.out, "round1/sessions/innovator-0.spawn.json"), "utf8")) as RoleSpawnConfig;
    const relayRoot = join(fx.attestRoot, "relay-logs");
    expect(spawn.baseUrl?.startsWith("http://127.0.0.1:8642/r/")).toBe(true);
    expect(spawn.baseUrl?.endsWith("/v1")).toBe(true);
    expect(spawn.relayLog).toBeUndefined();
    expect(JSON.stringify(spawn)).not.toContain(relayRoot);
    const logPath = roleLog(relayRoot, spawn.baseUrl ?? "");
    expect(resolve(logPath).startsWith(`${resolve(spawn.cwd)}/`)).toBe(false);
    const before = readFileSync(logPath);
    expect(roleWrite(spawn, logPath, "forged\n")).toBe(false);
    expect(readFileSync(logPath)).toEqual(before);
    const innovatorInput = readFileSync(join(fx.out, "round1/innovator-0-input.json"), "utf8");
    expect(innovatorInput).not.toContain("relayLog");
    expect(innovatorInput).not.toContain("relay.jsonl");
    expect(innovatorInput).toContain("baseUrl");
    expect(fake.calls).toHaveLength(1);
  });

  test("the on-disk spawn file omits the relay log", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const relayRoot = join(fx.attestRoot, "relay-logs");
    await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fake.executor,
      roles: stubOptRoles(fx.key),
    });
    const dir = join(fx.out, "round1/sessions");
    const names = readdirSync(dir).filter((name) => name.endsWith(".spawn.json") || name.endsWith(".argv.json"));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const text = readFileSync(join(dir, name), "utf8");
      expect(text).not.toContain("relayLog");
      expect(text).not.toContain("relay.jsonl");
      expect(text).not.toContain(relayRoot);
    }
    expect(fake.calls).toHaveLength(1);
  });

  test("execute mode keeps the role relay under the host relay root", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const relayRoot = join(fx.attestRoot, "relay-logs");
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "execute",
      env: { BASE_URL: "https://example.test/v1", HARNESS_RELAY_LOG_ROOT: relayRoot, HARNESS_RELAY_BIND: "127.0.0.1" },
      rounds: 1,
      executor: fake.executor,
      roles: {
        ...stubOptRoles(fx.key),
        async innovate(input) {
          expect(input).not.toHaveProperty("relayLog");
          expect(input).not.toHaveProperty("runId");
          expect(input.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:8642\/r\/[0-9a-f]{32}\/v1$/);
          const shown = readFileSync(join(fx.out, "round1/innovator-0-input.json"), "utf8");
          expect(shown).not.toContain("relayLog");
          expect(shown).not.toContain("relay.jsonl");
          const spawn = JSON.parse(readFileSync(join(fx.out, "round1/sessions/innovator-0.spawn.json"), "utf8")) as RoleSpawnConfig;
          const shownSpawn = JSON.stringify(spawn);
          expect(spawn.relayLog).toBeUndefined();
          expect(shownSpawn).not.toContain("relayLog");
          expect(shownSpawn).not.toContain("relay.jsonl");
          expect(shownSpawn).not.toContain(relayRoot);
          const logPath = roleLog(relayRoot, input.baseUrl);
          expect(resolve(logPath).startsWith(`${resolve(input.spawn.cwd)}/`)).toBe(false);
          expect(roleWrite(input.spawn, logPath, "forged\n")).toBe(false);
          hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "innovator" })}\n`, fx.key);
          return { session: { jsonl: "ignored\n" }, summary: "missing-relay", parts: { "agent-loop": { maxSteps: 21 } } };
        },
      },
    });
    expect(result.stopReport.reason).toBe("usage_missing");
    expect(result.stopReport.faultRounds).toBe(1);
    const spawn = JSON.parse(readFileSync(join(fx.out, "round1/sessions/gap-finder.spawn.json"), "utf8")) as RoleSpawnConfig;
    const shownSpawn = JSON.stringify(spawn);
    expect(spawn.relayLog).toBeUndefined();
    expect(shownSpawn).not.toContain(relayRoot);
    expect(shownSpawn).not.toContain("relay.jsonl");
    expect(spawn.baseUrl?.startsWith("http://127.0.0.1:8642/r/")).toBe(true);
    const gapInput = readFileSync(join(fx.out, "round1/gap-input.json"), "utf8");
    expect(gapInput).not.toContain("relayLog");
    expect(gapInput).not.toContain("relay.jsonl");
    expect(gapInput).toContain("baseUrl");
    expect(fake.calls).toEqual([]);
  });

  test("a role HTTP call through the relay is the production record", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const upstream = await listenUpstream();
    const session = (input: { spawn: RoleSpawnConfig }, role: string) => {
      hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role })}\n`, fx.key);
    };
    const call = async (baseUrl: string) => {
      await postRole(baseUrl);
    };
    try {
      const result = await runOptLoop({
        ...hostOpts(fx),
        mode: "dry-run",
        env: { HARNESS_RELAY_BIND: "127.0.0.1", HARNESS_RELAY_UPSTREAM: upstream.url },
        rounds: 1,
        executor: fake.executor,
        roles: {
          async gap(input) {
            session(input, "gap-finder");
            return { session: { jsonl: "ignored\n" }, citations: [], knob: "agent-loop.maxSteps", failureClass: "idle-loop", summary: "early write then idle" };
          },
          async innovate(input) {
            await call(input.baseUrl);
            session(input, "innovator");
            const slot = input.sessionPath.match(/innovator-(\d+)\.jsonl$/)?.[1] ?? "0";
            const maxSteps = slot === "1" ? 20 : 24;
            return { session: { jsonl: "ignored\n" }, summary: `agent-loop.maxSteps=${maxSteps}`, parts: { "agent-loop": { maxSteps } } };
          },
          async critic(input) {
            await call(input.baseUrl);
            session(input, "critic");
            return { session: { jsonl: "ignored\n" }, excluded: [] };
          },
          async ranker(input) {
            await call(input.baseUrl);
            session(input, "ranker");
            return { session: { jsonl: "ignored\n" }, winnerId: input.candidates[0]?.id ?? "" };
          },
          async review(input) {
            await call(input.baseUrl);
            session(input, "reviewer-gate");
            return { session: { jsonl: "ignored\n" }, reason: "hold" };
          },
        },
      });
      expect(result.stopReport).toEqual({
        reason: null,
        faultRounds: 0,
        reviewerRejectRounds: 0,
        noWinner: [{ round: 1, reason: "no_winner" }],
      });
      expect(fake.calls).toEqual([]);
      expect(upstream.hits.length).toBeGreaterThan(0);
      const spawn = JSON.parse(readFileSync(join(fx.out, "round1/sessions/innovator-0.spawn.json"), "utf8")) as RoleSpawnConfig;
      expect(spawn.relayLog).toBeUndefined();
      const logPath = roleLog(join(fx.attestRoot, "relay-logs"), spawn.baseUrl ?? "");
      const log = readFileSync(logPath, "utf8");
      expect(log).toContain("\"type\":\"req\"");
      expect(log).toContain("\"type\":\"done\"");
      expect(log).not.toContain("plant-boot");
      const done = log.split("\n").map((line) => line.trim()).filter((line) => line !== "").map((line) => JSON.parse(line) as { type?: string; usage?: unknown }).find((row) => row.type === "done");
      expect(done?.usage).toEqual(UPSTREAM_USAGE);
      expect(existsSync(`${logPath}.sig`)).toBe(true);
      for (const name of ["gap-input.json", "innovator-0-input.json", "critic-input.json", "ranker-input.json"]) {
        const text = readFileSync(join(fx.out, "round1", name), "utf8");
        expect(text).not.toContain("relayLog");
        expect(text).not.toContain("relay.jsonl");
        expect(text).not.toContain(fx.keyFile);
        expect(text).toContain("baseUrl");
      }
    } finally {
      await upstream.close();
    }
  });

  test("execute path binds critic, ranker, and reviewer from the last assistant message", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const upstream = await listenEchoUpstream();
    const relayRoot = join(fx.attestRoot, "relay-logs");
    const verdict = { reason: "accept the idle cap" };
    try {
      const result = await runOptLoop({
        ...hostOpts(fx),
        mode: "execute",
        env: {
          BASE_URL: "https://example.test/v1",
          HARNESS_RELAY_LOG_ROOT: relayRoot,
          HARNESS_RELAY_BIND: "127.0.0.1",
          HARNESS_RELAY_UPSTREAM: upstream.url,
        },
        rounds: 1,
        executor: fake.executor,
        roles: chatRoles(fx, { reported: verdict, recorded: verdict }),
      });
      expect(upstream.hits).toBe(10);
      expect(fake.calls.map((call) => `${call.task.id}:${call.seed}`)).toEqual(["hb003:0"]);
      expect(result.accepted?.round).toBe(1);
      expect(result.rounds[0]?.accepted).toBe(true);
      expect(result.stopReport).toEqual({ reason: null, faultRounds: 0, reviewerRejectRounds: 0 });
      const critic = JSON.parse(readFileSync(join(fx.out, "round1/sessions/critic.spawn.json"), "utf8")) as RoleSpawnConfig;
      const ranker = JSON.parse(readFileSync(join(fx.out, "round1/sessions/ranker.spawn.json"), "utf8")) as RoleSpawnConfig;
      expect(critic.relayLog).toBeUndefined();
      expect(ranker.relayLog).toBeUndefined();
      expect(JSON.stringify(critic)).not.toContain(relayRoot);
      const criticDone = lastDone(roleLog(relayRoot, critic.baseUrl ?? ""));
      const rankerDone = lastDone(roleLog(relayRoot, ranker.baseUrl ?? ""));
      expect(criticDone?.assistant).toBe(JSON.stringify({ excluded: [] }));
      expect(criticDone?.usage).toEqual(UPSTREAM_USAGE);
      expect(rankerDone?.assistant).toBe(JSON.stringify({ winnerId: "c0" }));
      expect(rankerDone?.usage).toEqual(UPSTREAM_USAGE);
    } finally {
      await upstream.close();
    }
  });

  test("a reviewer conclusion that differs from the relay assistant text is rejected", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const upstream = await listenEchoUpstream();
    const relayRoot = join(fx.attestRoot, "relay-logs");
    try {
      const result = await runOptLoop({
        ...hostOpts(fx),
        mode: "execute",
        env: {
          BASE_URL: "https://example.test/v1",
          HARNESS_RELAY_LOG_ROOT: relayRoot,
          HARNESS_RELAY_BIND: "127.0.0.1",
          HARNESS_RELAY_UPSTREAM: upstream.url,
        },
        rounds: 1,
        executor: fake.executor,
        roles: chatRoles(fx, {
          recorded: { reason: "hold" },
          reported: { reason: "forged" },
        }),
      });
      expect(upstream.hits).toBe(10);
      expect(fake.calls.map((call) => `${call.task.id}:${call.seed}`)).toEqual(["hb003:0"]);
      expect(result.accepted?.round).toBe(1);
      expect(result.rounds[0]?.accepted).toBe(true);
      expect(result.stopReport).toEqual({ reason: null, faultRounds: 0, reviewerRejectRounds: 0 });
      const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { reviewReason?: string; gates?: { pass: boolean }[] };
      expect(closure.reviewReason).toBe("forged");
      expect(closure.gates?.every((gate) => gate.pass)).toBe(true);
      const review = JSON.parse(readFileSync(join(fx.out, "round1/sessions/reviewer-gate.spawn.json"), "utf8")) as RoleSpawnConfig;
      expect(review.relayLog).toBeUndefined();
      expect(JSON.stringify(review)).not.toContain(relayRoot);
      expect(lastDone(roleLog(relayRoot, review.baseUrl ?? ""))?.assistant).toBe(JSON.stringify({ reason: "hold" }));
    } finally {
      await upstream.close();
    }
  });

  test("a role edit after close_run stops the loop", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fake.executor,
      roles: {
        gap: (input) => stubOptRoles(fx.key).gap(input),
        async innovate(input) {
          if (!input.sessionPath.endsWith("innovator-0.jsonl")) return stubOptRoles(fx.key).innovate(input);
          await plantRole(fx, input, "innovator", { summary: "tamper" });
          const script = fileURLToPath(new URL("../../relay/harness_relay.py", import.meta.url));
          const env = {
            ...process.env,
            HARNESS_ATTEST_KEY_FILE: fx.keyFile,
            RELAY_UPSTREAM_KEY_FILE: join(fx.attestRoot, "upstream.key"),
          };
          const logRoot = join(fx.attestRoot, "relay-logs");
          const closed = spawnSync("python3", [
            script, "close-run",
            "--log-root", logRoot,
            "--run-id", runIdOf(input.baseUrl),
            "--port", "8642",
          ], { encoding: "utf8", env });
          if (closed.status !== 0) throw new Error(closed.stderr || closed.stdout || "close-run failed");
          appendFileSync(roleLog(logRoot, input.baseUrl), "{\"type\":\"tamper\"}\n");
          hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "innovator" })}\n`, fx.key);
          return { session: { jsonl: "ignored\n" }, summary: "tamper", parts: { "agent-loop": { maxSteps: 20 } } };
        },
        critic: (input) => stubOptRoles(fx.key).critic(input),
        ranker: (input) => stubOptRoles(fx.key).ranker(input),
        review: (input) => stubOptRoles(fx.key).review(input),
      },
    });
    expect(fake.calls).toEqual([]);
    expect(result.stopReport.reason).toBe("attest_mismatch");
    expect(result.stopReport.faultRounds).toBe(1);
    const shown = readFileSync(join(fx.out, "round1/innovator-0-input.json"), "utf8");
    expect(shown).not.toContain("relay.jsonl");
    expect(shown).not.toContain("relayLog");
  });

  test("editing jsonl is detected", async () => {
    const edit = async (kind: "rewrite" | "append" | "truncate") => {
      const fx = fixture();
      const fake = fakeExecutor(fx);
      const stub = stubOptRoles(fx.key);
      const result = await runOptLoop({
        ...hostOpts(fx),
        mode: "dry-run",
        rounds: 1,
        executor: fake.executor,
        roles: {
          gap: (input) => stub.gap(input),
          async innovate(input) {
            if (!input.sessionPath.endsWith("innovator-0.jsonl")) return stub.innovate(input);
            await plantRole(fx, input, "innovator", { summary: kind });
            const log = roleLog(join(fx.attestRoot, "relay-logs"), input.baseUrl);
            if (kind === "rewrite") writeFileSync(log, readFileSync(log, "utf8").replace('"prompt_tokens":1', '"prompt_tokens":1000'));
            else if (kind === "append") appendFileSync(log, "{\"type\":\"done\",\"status\":200,\"role\":\"innovator\"}\n");
            else writeFileSync(log, readFileSync(log).subarray(0, 8));
            hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "innovator" })}\n`, fx.key);
            return { session: { jsonl: "ignored\n" }, summary: kind, parts: { "agent-loop": { maxSteps: 20 } } };
          },
          critic: (input) => stub.critic(input),
          ranker: (input) => stub.ranker(input),
          review: (input) => stub.review(input),
        },
      });
      expect(fake.calls).toEqual([]);
      expect(result.stopReport.reason).toBe("attest_mismatch");
      expect(result.stopReport.faultRounds).toBeGreaterThanOrEqual(1);
      const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { reason?: string };
      expect(closure.reason).toBe("attest_mismatch");
    };
    await edit("rewrite");
    await edit("append");
    await edit("truncate");
  }, 20000);

  test("a refused call still counts toward the loop cap", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const stub = stubOptRoles(fx.key);
    const usage = { prompt_tokens: 20_000_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } };
    const upstream = await listenUpstream(usage);
    let calls = 0;
    try {
      const result = await runOptLoop({
        ...hostOpts(fx),
        mode: "dry-run",
        env: { HARNESS_RELAY_BIND: "127.0.0.1", HARNESS_RELAY_UPSTREAM: upstream.url },
        rounds: 1,
        executor: fake.executor,
        roles: {
          gap: (input) => stub.gap(input),
          async innovate(input) {
            calls += 1;
            const response = await fetch(`${input.baseUrl}/chat/completions`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ messages: [{ role: "user", content: "spent" }] }),
            });
            const body = await response.json() as { error?: string };
            expect(response.status).toBe(429);
            expect(body.error).toBe(calls === 1 ? "innovatorCap" : "readOnlyTokenCap");
            hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "innovator" })}\n`, fx.key);
            return { session: { jsonl: "ignored\n" }, summary: `spent-${calls}`, parts: { "agent-loop": { maxSteps: 20 } } };
          },
          critic: (input) => stub.critic(input),
          ranker: (input) => stub.ranker(input),
          review: (input) => stub.review(input),
        },
      });
      expect(calls).toBe(2);
      expect(fake.calls).toEqual([]);
      expect(result.stopReport).toEqual({ reason: "readOnlyTokenCap", faultRounds: 0, reviewerRejectRounds: 0 });
      const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { reason?: string };
      expect(closure.reason).toBe("readOnlyTokenCap");
    } finally {
      await upstream.close();
    }
  });

  test("execute mode disables control-channel record and plant ops", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "execute",
      env: { BASE_URL: "https://example.test/v1", HARNESS_RELAY_LOG_ROOT: join(fx.attestRoot, "relay-logs"), HARNESS_RELAY_BIND: "127.0.0.1" },
      rounds: 1,
      executor: fake.executor,
      roles: {
        gap: (input) => stubOptRoles(fx.key).gap(input),
        async innovate(input) {
          await expect(relayRecord(input.baseUrl, { type: "req", role: "innovator", seq: 1, round: input.round })).rejects.toThrow(/control plant disabled/);
          await expect(relayPlantRole(input.baseUrl, "innovator", input.round, { summary: "x" })).rejects.toThrow(/control plant disabled/);
          await expect(relayPlantRead(input.baseUrl, [fx.controlConfig])).rejects.toThrow(/control plant disabled/);
          hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "innovator" })}\n`, fx.key);
          return { session: { jsonl: "ignored\n" }, summary: "bare", parts: { "agent-loop": { maxSteps: 20 } } };
        },
        critic: (input) => stubOptRoles(fx.key).critic(input),
        ranker: (input) => stubOptRoles(fx.key).ranker(input),
        review: (input) => stubOptRoles(fx.key).review(input),
      },
    });
    expect(fake.calls).toEqual([]);
    expect(result.stopReport).toEqual({ reason: "usage_missing", faultRounds: 1, reviewerRejectRounds: 0 });
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { reason?: string };
    expect(closure.reason).toBe("usage_missing");
  });

  test("over-limit is refused by relay", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const stub = stubOptRoles(fx.key);
    const upstream = await listenUpstream({ prompt_tokens: 30_000_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } });
    try {
      const result = await runOptLoop({
        ...hostOpts(fx),
        mode: "dry-run",
        env: { HARNESS_RELAY_BIND: "127.0.0.1", HARNESS_RELAY_UPSTREAM: upstream.url },
        rounds: 2,
        executor: fake.executor,
        roles: {
          gap: (input) => stub.gap(input),
          async innovate(input) {
            const response = await fetch(`${input.baseUrl}/chat/completions`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ messages: [{ role: "user", content: "over-limit" }] }),
            });
            expect(response.status).toBe(429);
            const body = await response.json() as { error?: string };
            expect(body.error).toBe("readOnlyTokenCap");
            hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "innovator" })}\n`, fx.key);
            return { session: { jsonl: "ignored\n" }, summary: "over-limit", parts: { "agent-loop": { maxSteps: 20 } } };
          },
          critic: (input) => stub.critic(input),
          ranker: (input) => stub.ranker(input),
          review: (input) => stub.review(input),
        },
      });
      expect(fake.calls).toEqual([]);
      expect(result.stopReport).toEqual({ reason: "readOnlyTokenCap", faultRounds: 0, reviewerRejectRounds: 0 });
      const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { reason?: string };
      expect(closure.reason).toBe("readOnlyTokenCap");
    } finally {
      await upstream.close();
    }
  });

  for (const [role, mode] of [
    ["innovator", "missing"],
    ["innovator", "null"],
    ["innovator", "no-done"],
    ["critic", "missing"],
    ["critic", "null"],
    ["critic", "no-done"],
    ["ranker", "missing"],
    ["ranker", "null"],
    ["ranker", "no-done"],
    ["reviewer", "missing"],
    ["reviewer", "null"],
    ["reviewer", "no-done"],
  ] as const) test(`${role} relay usage ${mode} stops the loop`, async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const stub = stubOptRoles(fx.key);
    const root = join(fx.attestRoot, "relay-logs");
    const damage = async (baseUrl: string): Promise<void> => {
      if (mode === "missing") {
        unlinkSync(roleLog(root, baseUrl));
        return;
      }
      if (mode === "null") {
        await relayRecord(baseUrl, { type: "done", role, status: 200, round: 1, usage: null });
      }
    };
    const bare = async (baseUrl: string, spawn: RoleSpawnConfig): Promise<void> => {
      await relayRecord(baseUrl, { type: "req", role, seq: 1, round: 1 });
      hostWriteSession(spawn, `${JSON.stringify({ type: "session", role })}\n`, fx.key);
    };
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fake.executor,
      roles: {
        gap: (input) => stub.gap(input),
        async innovate(input) {
          if (role === "ranker" && input.sessionPath.endsWith("innovator-1.jsonl")) return secondProposal(fx.key, input);
          const mine = role === "innovator" && input.sessionPath.endsWith("innovator-0.jsonl");
          if (mine && mode === "no-done") {
            await bare(input.baseUrl, input.spawn);
            return { session: { jsonl: "ignored\n" }, summary: "no-done", parts: { "agent-loop": { maxSteps: 20 } } };
          }
          const turn = await stub.innovate(input);
          if (mine) await damage(input.baseUrl);
          return turn;
        },
        async critic(input) {
          if (role === "critic" && mode === "no-done") {
            await bare(input.baseUrl, input.spawn);
            return { session: { jsonl: "ignored\n" }, excluded: [] };
          }
          const turn = await stub.critic(input);
          if (role === "critic") await damage(input.baseUrl);
          return turn;
        },
        async ranker(input) {
          if (role === "ranker" && mode === "no-done") {
            await bare(input.baseUrl, input.spawn);
            return { session: { jsonl: "ignored\n" }, winnerId: input.candidates[0]?.id ?? "" };
          }
          const turn = await stub.ranker(input);
          if (role === "ranker") await damage(input.baseUrl);
          return turn;
        },
        async review(input) {
          if (role === "reviewer" && mode === "no-done") {
            await bare(input.baseUrl, input.spawn);
            return { session: { jsonl: "ignored\n" }, reason: "no-done" };
          }
          const turn = await stub.review(input);
          if (role === "reviewer") await damage(input.baseUrl);
          return turn;
        },
      },
    });
    expect(result.accepted).toBeNull();
    expect(result.stopReport.reason).toBe("usage_missing");
    expect(result.stopReport.faultRounds).toBeGreaterThanOrEqual(1);
    expect(fake.calls).toHaveLength(role === "reviewer" ? 1 : 0);
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { reason?: string };
    expect(closure.reason).toBe("usage_missing");
  });

  test("the run-record child argv does not carry the attest key", () => {
    const fx = fixture();
    const argv = runRecordArgv(join(fx.root, "checker"), join(fx.root, "run"), "sign", "ab".repeat(16));
    const flat = argv.join("\n");
    expect(flat).not.toContain(fx.key.toString("hex"));
    expect(flat).not.toContain(fx.keyFile);
    expect(argv[0]).toBe("python3");
    expect(argv.slice(3).join("\n")).not.toContain("fromhex");
  });

  test("the loop starts against the deployed harness 4d4e12e5", async () => {
    const deployed = fileURLToPath(new URL("../../fixtures/harness.4d4e12e5.mjs", import.meta.url));
    const fx = fixture(readFileSync(deployed, "utf8"));
    expect(createHash("sha256").update(readFileSync(fx.harnessPath)).digest("hex")).toBe(
      "4d4e12e51958650b5ee6f4768f1bd809202ecec23a4db6ef910bfcc36222fd8c",
    );
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fakeExecutor(fx).executor,
    });
    expect(result.stopReport.reason).toBeNull();
  });

  test("a harness missing a whitelisted effective key refuses to start", async () => {
    const fx = fixture();
    writeFileSync(fx.harnessPath, `${EFFECTIVE_KNOBS.filter((key) => key !== "agent-loop.maxSteps").map((key) => `effective["${key}"]`).join("\n")}\n`);
    await expect(runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fakeExecutor(fx).executor,
    })).rejects.toThrow(/harness is missing effective-config for agent-loop.maxSteps/);
    expect(existsSync(join(fx.out, "pre-round1.json"))).toBe(false);
  });

  test("a relative task path uses once's data root and its official timeout", async () => {
    const fx = fixture();
    const dataRoot = join(fx.root, "contest-data");
    const mirror = join(fx.root, "empty-mirror");
    mkdirSync(join(dataRoot, "tasks3", "hb003"), { recursive: true });
    mkdirSync(mirror, { recursive: true });
    writeFileSync(join(dataRoot, "tasks3", "hb003", "task.toml"), "[agent]\ntimeout_sec = 31\n\n[verifier]\ntimeout_sec = 60\n");
    const citing = citingRoles(fx.key, fx.attestRoot);
    const result = await runOptLoop({
      ...hostOpts(fx),
      task: { ...LOOP_TASK, path: "tasks3/hb003" },
      taskDataRoot: dataRoot,
      taskMirrorRoot: mirror,
      mode: "dry-run",
      rounds: 1,
      executor: {
        name: "at-limit",
        async run(request) {
          expect(request.task.path).toBe("tasks3/hb003");
          const script = timing(request, 1);
          writeRunArtifacts(request, { ...script, wallS: 30, timedOut: false }, { key: fx.key, harnessPath: fx.harnessPath });
          return observation(request, { reward: 1, tokens: script.tokens, wallS: 30, timedOut: false });
        },
      },
      roles: citing,
    });
    expect(result.accepted).not.toBeNull();
    expect(result.stopReport).toEqual({ reason: null, faultRounds: 0, reviewerRejectRounds: 0 });
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { gates?: { id: string; pass: boolean }[] };
    expect(closure.gates).toEqual([
      { id: "G0", pass: true },
      { id: "G1", pass: true },
      { id: "G2", pass: true },
      { id: "G3", pass: true },
    ]);
  });

  test("startup refuses a task.toml that is missing or has no agent timeout", async () => {
    const fx = fixture();
    const dataRoot = join(fx.root, "contest-data");
    const mirror = join(fx.root, "empty-mirror");
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(mirror, { recursive: true });
    const base = {
      ...hostOpts(fx),
      task: { ...LOOP_TASK, path: "tasks3/hb003" },
      taskDataRoot: dataRoot,
      taskMirrorRoot: mirror,
      mode: "dry-run" as const,
      rounds: 1,
      executor: fakeExecutor(fx).executor,
    };
    await expect(runOptLoop(base)).rejects.toThrow("task.toml missing for tasks3/hb003");
    expect(existsSync(join(fx.out, "pre-round1.json"))).toBe(false);
    const nested = join(mirror, "tasks3", "hb003", "task");
    mkdirSync(nested, { recursive: true });
    const body = "[verifier]\ntimeout_sec = 60\n";
    const file = join(nested, "task.toml");
    writeFileSync(file, body);
    const rel = "tasks3/hb003/task/task.toml";
    writeFileSync(join(mirror, "SHA256SUMS"), `${createHash("sha256").update(body).digest("hex")}  ${rel}\n`);
    await expect(runOptLoop(base)).rejects.toThrow(`task.toml has no [agent].timeout_sec: ${file}`);
    expect(existsSync(join(fx.out, "pre-round1.json"))).toBe(false);
    writeFileSync(file, "[agent]\ntimeout_sec = 120\n\n[verifier]\ntimeout_sec = 60\n");
    await expect(runOptLoop(base)).rejects.toThrow(`task.toml mirror sha mismatch: ${rel}`);
    const good = "[agent]\ntimeout_sec = 120\n\n[verifier]\ntimeout_sec = 60\n";
    writeFileSync(file, good);
    writeFileSync(join(mirror, "SHA256SUMS"), `${createHash("sha256").update(good).digest("hex")}  ${rel}\n`);
    const resolved = resolveOfficialTask("tasks3/hb003", dataRoot, mirror);
    expect(resolved.timeoutSec).toBe(120);
    expect(resolved.file).toBe(file);
    expect(resolved.dir).toBe(join(mirror, "tasks3", "hb003"));
    const absolute = resolveOfficialTask(join(fx.root, "task"));
    expect(absolute.timeoutSec).toBe(3600);
    expect(absolute.dir).toBe(join(fx.root, "task"));
  });

  test("a gap-finder knob outside the whitelist stops before the innovators", async () => {
    const fx = fixture();
    const stub = stubOptRoles(fx.key);
    const sleeps: number[] = [];
    let innovators = 0;
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      roleRetrySleep: async (ms) => {
        sleeps.push(ms);
      },
      executor: fakeExecutor(fx).executor,
      roles: {
        async gap() {
          return {
            session: { jsonl: "ignored\n" },
            knob: "skills.trigger.mode",
            failureClass: "skill-not-triggered",
            summary: "skill did not trigger",
            citations: [],
          };
        },
        async innovate(input) {
          innovators += 1;
          return stub.innovate(input);
        },
        critic: (input) => stub.critic(input),
        ranker: (input) => stub.ranker(input),
        review: (input) => stub.review(input),
      },
    });
    expect(innovators).toBe(0);
    expect(sleeps).toEqual([]);
    expect(existsSync(join(fx.out, "round1/sessions/innovator-0.spawn.json"))).toBe(false);
    expect(result.accepted).toBeNull();
    expect(result.stopReport.reason).toBe("invalid: non_effective_key");
    expect(result.stopReport.role).toBe("gap-finder");
    expect(result.stopReport.stderrTail).toContain("skills.trigger.mode");
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as {
      reason?: string;
      roleFailure?: { role?: string; stderrTail?: string };
    };
    expect(closure.reason).toBe("invalid: non_effective_key");
    expect(closure.roleFailure?.role).toBe("gap-finder");
    expect(closure.roleFailure?.stderrTail).toContain("skills.trigger.mode");
    const prompt = JSON.parse(readFileSync(join(fx.out, "round1/sessions/gap-finder.argv.json"), "utf8")) as { argv: string[] };
    const text = prompt.argv[prompt.argv.length - 1] ?? "";
    expect(text).toContain("effective-knobs.json");
    for (const knob of EFFECTIVE_KNOBS) expect(text).toContain(knob);
    expect(text).not.toContain("skills.trigger.mode");
    const listed = JSON.parse(readFileSync(join(fx.out, "round1/roles/gap-finder/effective-knobs.json"), "utf8")) as { knobs: { key: string }[] };
    expect(listed.knobs.map((item) => item.key)).toEqual([...EFFECTIVE_KNOBS]);
    expect(listed.knobs.map((item) => item.key)).not.toContain("skills.trigger.mode");
    const spawn = JSON.parse(readFileSync(join(fx.out, "round1/sessions/gap-finder.spawn.json"), "utf8")) as {
      attempts?: { n: number; transient: boolean; exitCode: number | null; stderrTail: string }[];
    };
    expect(spawn.attempts).toHaveLength(1);
    expect(spawn.attempts?.[0]?.n).toBe(1);
    expect(spawn.attempts?.[0]?.transient).toBe(false);
    expect(spawn.attempts?.[0]?.exitCode).toBeNull();
    expect(spawn.attempts?.[0]?.stderrTail).toContain("skills.trigger.mode");
  });

  test("reviewer-gate gets read-only copies and only the read tool", async () => {
    const fx = fixture();
    await runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 1, executor: fakeExecutor(fx).executor });
    const cwd = join(fx.out, "round1/roles/reviewer-gate");
    for (const rel of [
      "candidates/gap.json",
      "candidates/patch.diff",
      "candidates/activation.json",
      "candidates/effective.json",
      "state/nodes/run_end.json",
      "state/nodes/gates.json",
    ]) {
      const file = join(cwd, rel);
      expect(lstatSync(file).isSymbolicLink()).toBe(false);
      expect(statSync(file).mode & 0o777).toBe(0o444);
    }
    const gap = JSON.parse(readFileSync(join(cwd, "candidates/gap.json"), "utf8")) as { knob: string };
    expect(gap.knob).toBe("agent-loop.maxSteps");
    expect(readFileSync(join(cwd, "candidates/patch.diff"), "utf8")).toBe(readFileSync(join(fx.out, "round1/patch.diff"), "utf8"));
    const activation = JSON.parse(readFileSync(join(cwd, "candidates/activation.json"), "utf8")) as { patchHash: string };
    const roundActivation = JSON.parse(readFileSync(join(fx.out, "round1/activation.json"), "utf8")) as { patchHash: string };
    expect(activation).toEqual(roundActivation);
    const effective = JSON.parse(readFileSync(join(cwd, "candidates/effective.json"), "utf8")) as Record<string, unknown>;
    expect(effective["agent-loop.maxSteps"]).toBe(24);
    expect(JSON.parse(readFileSync(join(cwd, "state/nodes/run_end.json"), "utf8"))).toBeNull();
    const staged = JSON.parse(readFileSync(join(cwd, "state/nodes/gates.json"), "utf8")) as { gates: { id: string; pass: boolean }[] };
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { gates: { id: string; pass: boolean }[] };
    expect(staged.gates).toEqual(closure.gates);
    const argv = JSON.parse(readFileSync(join(fx.out, "round1/sessions/reviewer-gate.argv.json"), "utf8")) as { argv: string[] };
    expect(argv.argv[argv.argv.indexOf("--tools") + 1]).toBe("read");
    const prompt = argv.argv[argv.argv.length - 1] ?? "";
    expect(prompt).toContain("candidates/gap.json");
    expect(prompt).toContain("state/nodes/gates.json");
    expect(prompt).not.toContain("ls");
    const agent = readFileSync(fileURLToPath(new URL("../../agents/reviewer-gate.md", import.meta.url)), "utf8");
    expect(agent).toMatch(/^tools: read$/m);
    expect(agent).not.toMatch(/^tools:.*\bls\b/m);
  });

  test("G3 rejects a scored run whose wall time meets the official agent timeout", async () => {
    const fx = fixture();
    writeFileSync(join(fx.root, "task", "task.toml"), "[agent]\ntimeout_sec = 30\n\n[verifier]\ntimeout_sec = 60\n");
    const citing = citingRoles(fx.key, fx.attestRoot);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: {
        name: "slow",
        async run(request) {
          const script = timing(request, 1);
          writeRunArtifacts(request, { ...script, wallS: 30, timedOut: false }, { key: fx.key, harnessPath: fx.harnessPath });
          return observation(request, { reward: 1, tokens: script.tokens, wallS: 30, timedOut: false });
        },
      },
      roles: {
        gap: (input) => citing.gap(input),
        innovate: (input) => citing.innovate(input),
        critic: (input) => citing.critic(input),
        ranker: (input) => citing.ranker(input),
        review: (input) => citing.review(input),
      },
    });
    expect(result.accepted).toBeNull();
    expect(result.stopReport).toEqual({ reason: null, faultRounds: 0, reviewerRejectRounds: 1 });
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as {
      preflight?: boolean;
      gates?: { id: string; pass: boolean }[];
    };
    expect(closure.preflight).toBeUndefined();
    expect(closure.gates).toEqual([
      { id: "G0", pass: true },
      { id: "G1", pass: true },
      { id: "G2", pass: true },
      { id: "G3", pass: false },
    ]);
  });

  test("an LLM accept cannot override a reward below the signed baseline", async () => {
    const fx = fixture();
    const citing = citingRoles(fx.key, fx.attestRoot);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: {
        name: "fake",
        async run(request) {
          const script = timing(request, 0);
          writeRunArtifacts(request, script, { key: fx.key, harnessPath: fx.harnessPath });
          return observation(request, { reward: 0, tokens: script.tokens, wallS: script.wallS, timedOut: script.timedOut });
        },
      },
      roles: {
        gap: (input) => citing.gap(input),
        innovate: (input) => citing.innovate(input),
        critic: (input) => citing.critic(input),
        ranker: (input) => citing.ranker(input),
        async review(input) {
          await relayPlantRole(input.baseUrl, "reviewer", input.round, { reason: "forged accept" });
          hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "reviewer-gate" })}\n`, fx.key);
          return { session: { jsonl: "ignored\n" }, reason: "forged accept" };
        },
      },
    });
    expect(result.accepted).toBeNull();
    expect(result.rounds[0]?.accepted).toBe(false);
    expect(result.stopReport).toEqual({ reason: null, faultRounds: 0, reviewerRejectRounds: 1 });
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as {
      reason?: string;
      reviewReason?: string;
      gates?: { id: string; pass: boolean; code?: string }[];
    };
    expect(closure.reason).toBeUndefined();
    expect(closure.reviewReason).toBe("forged accept");
    expect(closure.gates).toEqual([
      { id: "G0", pass: true },
      { id: "G1", pass: true },
      { id: "G2", pass: true },
      { id: "G3", pass: false },
    ]);
  });

  test("a knob outside the harness whitelist is invalid: non_effective_key", async () => {
    const fx = fixture();
    const stub = stubOptRoles(fx.key);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fakeExecutor(fx).executor,
      roles: {
        gap: (input) => stub.gap(input),
        async innovate(input) {
          if (!input.sessionPath.endsWith("innovator-0.jsonl")) return stub.innovate(input);
          await relayPlantRole(input.baseUrl, "innovator", input.round, { summary: "context.compression=1" });
          hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "innovator" })}\n`, fx.key);
          return { session: { jsonl: "ignored\n" }, summary: "context.compression=1", parts: { context: { compression: 1 } } };
        },
        critic: (input) => stub.critic(input),
        ranker: (input) => stub.ranker(input),
        review: (input) => stub.review(input),
      },
    });
    expect(result.stopReport.reason).toBeNull();
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { invalidCandidates?: { id: string; reason: string }[] };
    expect(closure.invalidCandidates?.some((item) => item.id === "c0" && item.reason === "invalid: non_effective_key")).toBe(true);
    const listed = JSON.parse(readFileSync(join(fx.out, "round1/roles/innovator-0/effective-knobs.json"), "utf8")) as { knobs: { key: string }[] };
    expect(listed.knobs.map((item) => item.key)).toContain("agent-loop.maxSteps");
    expect(listed.knobs.map((item) => item.key)).not.toContain("goal.maxContinuationTurns");
    expect(listed.knobs.map((item) => item.key)).not.toContain("context.compression");
    const prompt = (JSON.parse(readFileSync(join(fx.out, "round1/sessions/innovator-0.argv.json"), "utf8")) as { argv: string[] }).argv.at(-1) ?? "";
    expect(prompt).toContain("invalid: non_effective_key");
    expect(prompt).toContain("invalid: no_op_change");
    expect(prompt).not.toContain("goal.maxContinuationTurns");
    expect(prompt).toContain("agent-loop.maxSteps 是 agent_end 步数");
    expect(readFileSync(fileURLToPath(new URL("../../agents/innovator.md", import.meta.url)), "utf8")).not.toContain("non_effective_key");
  });

  test("an innovator already at 200k is not launched again", async () => {
    const fx = fixture();
    const stub = stubOptRoles(fx.key);
    const delays: number[] = [];
    let launches = 0;
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      roleRetrySleep: async (ms) => { delays.push(ms); },
      executor: fakeExecutor(fx).executor,
      roles: {
        gap: (input) => stub.gap(input),
        async innovate(input) {
          if (!input.sessionPath.endsWith("innovator-0.jsonl")) return stub.innovate(input);
          launches += 1;
          const usage = { prompt_tokens: 200_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } };
          await relayRecord(input.baseUrl, { type: "done", role: "innovator", status: 200, round: input.round, usage });
          throw new RoleFailed("innovator", 1, "again", true);
        },
        critic: (input) => stub.critic(input),
        ranker: (input) => stub.ranker(input),
        review: (input) => stub.review(input),
      },
    });
    expect(launches).toBe(1);
    expect(delays).toEqual([]);
    expect(result.stopReport.reason).toBeNull();
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { invalidCandidates?: { id: string; reason: string }[] };
    expect(closure.invalidCandidates?.some((item) => item.id === "c0" && item.reason === "cap_hit")).toBe(true);
  });

  test("a cap kill whose close reports an integrity fault stops as anti_forgery", async () => {
    const fx = fixture();
    const stub = stubOptRoles(fx.key);
    const fake = fakeExecutor(fx);
    let innovators = 0;
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fake.executor,
      roles: {
        gap: (input) => stub.gap(input),
        async innovate(input) {
          innovators += 1;
          if (!input.sessionPath.endsWith("innovator-0.jsonl")) return stub.innovate(input);
          const usage = { prompt_tokens: 200_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } };
          await relayRecord(input.baseUrl, { type: "done", role: "innovator", status: 200, round: input.round, usage });
          appendFileSync(roleLog(join(fx.attestRoot, "relay-logs"), input.baseUrl), "{\"type\":\"tamper\"}\n");
          await new Promise((resolve) => setTimeout(resolve, 300));
          hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "innovator" })}\n`, fx.key);
          return { session: { jsonl: "ignored\n" }, summary: "agent-loop.maxSteps=20", parts: { "agent-loop": { maxSteps: 20 } } };
        },
        critic: (input) => stub.critic(input),
        ranker: (input) => stub.ranker(input),
        review: (input) => stub.review(input),
      },
    });
    expect(innovators).toBe(1);
    expect(fake.calls).toEqual([]);
    expect(existsSync(join(fx.out, "round1/runs"))).toBe(false);
    expect(result.stopReport.reason).toBe("anti_forgery");
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as {
      reason?: string;
      roleFailure?: { stderrTail?: string };
      invalidCandidates?: { reason: string }[];
    };
    expect(closure.reason).toBe("anti_forgery");
    expect(closure.roleFailure?.stderrTail).toBe("attest_mismatch");
    expect(closure.invalidCandidates ?? []).toEqual([]);
    const saved = JSON.parse(readFileSync(join(fx.out, "loop-result.json"), "utf8")) as { stopReport: { reason: string | null } };
    expect(saved.stopReport.reason).toBe("anti_forgery");
  });

  test("critic plus ranker already at 3M is not retried", async () => {
    const fx = fixture();
    const stub = stubOptRoles(fx.key);
    const delays: number[] = [];
    let launches = 0;
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      roleRetrySleep: async (ms) => { delays.push(ms); },
      executor: fakeExecutor(fx).executor,
      roles: {
        gap: (input) => stub.gap(input),
        innovate: (input) => stub.innovate(input),
        async critic(input) {
          launches += 1;
          const usage = { prompt_tokens: 3_000_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } };
          await relayRecord(input.baseUrl, { type: "done", role: "critic", status: 200, round: input.round, usage });
          throw new RoleFailed("critic", 1, "again", true);
        },
        ranker: (input) => stub.ranker(input),
        review: (input) => stub.review(input),
      },
    });
    expect(launches).toBe(1);
    expect(delays).toEqual([]);
    expect(result.stopReport.reason).toBeNull();
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { reason?: string };
    expect(closure.reason).toBe("no_winner:cap_hit");
    expect(existsSync(join(fx.out, "round1/sessions/ranker.spawn.json"))).toBe(false);
  });

  test("a failed relay close stops the loop instead of retrying", async () => {
    const fx = fixture();
    const stub = stubOptRoles(fx.key);
    let gapCalls = 0;
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fakeExecutor(fx).executor,
      roles: {
        async gap(input) {
          gapCalls += 1;
          const turn = await stub.gap(input);
          const listed = spawnSync("ps", ["-eo", "pid,args"], { encoding: "utf8" });
          const line = listed.stdout.split("\n").find((row) => row.includes("harness_relay.py") && row.includes(fx.attestRoot));
          const pid = Number(line?.trim().split(/\s+/)[0]);
          if (!pid) throw new Error("relay control pid missing");
          process.kill(pid, "SIGKILL");
          return turn;
        },
        innovate: (input) => stub.innovate(input),
        critic: (input) => stub.critic(input),
        ranker: (input) => stub.ranker(input),
        review: (input) => stub.review(input),
      },
    });
    expect(gapCalls).toBe(1);
    expect(result.stopReport.reason).toBe("relay_close_failed");
    expect(result.stopReport.faultRounds).toBe(1);
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { reason?: string };
    expect(closure.reason).toBe("relay_close_failed");
    const spawn = JSON.parse(readFileSync(join(fx.out, "round1/sessions/gap-finder.spawn.json"), "utf8")) as { attempts?: { n: number }[] };
    expect(spawn.attempts?.map((item) => item.n)).toEqual([1]);
    expect(existsSync(join(fx.out, "loop-result.json"))).toBe(true);
  });

  test("a failed attempt keeps its own session file", async () => {
    const fx = fixture();
    const stub = stubOptRoles(fx.key);
    let tries = 0;
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      roleRetrySleep: async () => undefined,
      executor: fakeExecutor(fx).executor,
      roles: {
        gap: (input) => stub.gap(input),
        async innovate(input) {
          if (!input.sessionPath.endsWith("innovator-0.jsonl")) return stub.innovate(input);
          tries += 1;
          if (tries === 1) {
            hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "innovator", text: "attempt-one" })}\n`, fx.key);
            throw new RoleFailed("innovator", 1, "again", true);
          }
          hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "innovator", text: "attempt-two" })}\n`, fx.key);
          await relayPlantRole(input.baseUrl, "innovator", input.round, { summary: "second-try" });
          return { session: { jsonl: "ignored\n" }, summary: "second-try", parts: { "agent-loop": { maxSteps: 20 } } };
        },
        critic: (input) => stub.critic(input),
        ranker: (input) => stub.ranker(input),
        review: (input) => stub.review(input),
      },
    });
    expect(tries).toBe(2);
    expect(result.stopReport.reason).toBeNull();
    const kept = readFileSync(join(fx.out, "round1/sessions/innovator-0.attempt-1.jsonl"), "utf8");
    const live = readFileSync(join(fx.out, "round1/sessions/innovator-0.jsonl"), "utf8");
    expect(kept).toContain("attempt-one");
    expect(live).toContain("attempt-two");
    expect(live).not.toContain("attempt-one");
    const spawn = JSON.parse(readFileSync(join(fx.out, "round1/sessions/innovator-0.spawn.json"), "utf8")) as { attempts?: { n: number; sessionPath: string }[] };
    expect(spawn.attempts?.[0]?.sessionPath).toBe(join(fx.out, "round1/sessions/innovator-0.attempt-1.jsonl"));
    expect(spawn.attempts?.[1]?.sessionPath).toBe(join(fx.out, "round1/sessions/innovator-0.attempt-2.jsonl"));
  });

  test("a pi innovator is killed once the open relay log crosses 200k", async () => {
    const fx = fixture();
    const upstream = await new Promise<{ url: string; close(): Promise<void> }>((resolve, reject) => {
      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          let content = "{}";
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: { content?: string }[] };
            content = body.messages?.[body.messages.length - 1]?.content ?? content;
          } catch {
            content = "{}";
          }
          const spend = content === "spend";
          const payload = JSON.stringify({
            choices: [{ message: { role: "assistant", content: spend ? "ok" : content } }],
            usage: spend
              ? { prompt_tokens: 120_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } }
              : UPSTREAM_USAGE,
          });
          res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
          res.end(payload);
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("upstream did not listen"));
          return;
        }
        resolve({
          url: `http://127.0.0.1:${addr.port}/v1/chat/completions`,
          close: () => new Promise((done) => server.close(() => done())),
        });
      });
    });
    const script = join(fx.root, "answer.mjs");
    const bin = join(fx.root, "pi");
    const started = join(fx.root, "innovator-started");
    const finished = join(fx.root, "innovator-finished");
    writeFileSync(script, [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const system = args[args.indexOf('--system-prompt') + 1] ?? '';",
      "const role = system.split('/').pop()?.replace(/\\.md$/, '') ?? '';",
      "const prompt = args.at(-1) ?? '';",
      "const base = process.env.BASE_URL ?? '';",
      "const slot = process.cwd().match(/innovator-(\\d+)/)?.[1] ?? '';",
      "async function post(messages) {",
      "  const response = await fetch(base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages }) });",
      "  if (!response.ok) { process.stderr.write('relay ' + response.status + '\\n'); process.exit(2); }",
      "  await response.arrayBuffer();",
      "}",
      "if (role === 'innovator' && slot === '0') {",
      `  writeFileSync(${JSON.stringify(started)}, String(process.pid));`,
      "  await post([{ role: 'user', content: 'spend' }]);",
      "  await post([{ role: 'user', content: 'spend' }]);",
      "  await new Promise((resolve) => setTimeout(resolve, 20000));",
      `  writeFileSync(${JSON.stringify(finished)}, 'yes');`,
      "  process.exit(0);",
      "}",
      "const bodies = {",
      "  'gap-finder': { knob: 'agent-loop.maxSteps', failureClass: 'idle-loop', summary: 'early write then idle', citations: [] },",
      "  innovator: { summary: 'agent-loop.maxSteps=24', parts: { 'agent-loop': { maxSteps: 24 } } },",
      "  critic: { excluded: [] },",
      "  ranker: { winnerId: 'c1' },",
      "  'reviewer-gate': { reason: 'hold' },",
      "};",
      "const body = bodies[role];",
      "if (!body) { process.stderr.write('unknown role ' + role + '\\n'); process.exit(2); }",
      "if (role === 'gap-finder') {",
      "  const files = prompt.split('\\n').flatMap((line) => { const path = line.split(' ')[0] ?? ''; return path.includes('/traces/') ? [path] : []; });",
      "  const messages = [];",
      "  files.forEach((file, index) => {",
      "    const id = 'c' + index;",
      "    messages.push({ role: 'assistant', tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: file }) } }] });",
      "    messages.push({ role: 'tool', tool_call_id: id, content: readFileSync(file, 'utf8') });",
      "  });",
      "  messages.push({ role: 'user', content: JSON.stringify(body) });",
      "  await post(messages);",
      "} else {",
      "  await post([{ role: 'user', content: JSON.stringify(body) }]);",
      "}",
      "",
    ].join("\n"));
    writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(script)} "$@"\n`);
    chmodSync(bin, 0o755);
    const startedAt = Date.now();
    try {
      await runOptLoop({
        ...hostOpts(fx),
        mode: "execute",
        env: {
          BASE_URL: "https://example.test/v1",
          HARNESS_RELAY_BIND: "127.0.0.1",
          HARNESS_RELAY_LOG_ROOT: join(fx.attestRoot, "relay-logs"),
          HARNESS_RELAY_UPSTREAM: upstream.url,
        },
        rounds: 1,
        piBin: bin,
        executor: fakeExecutor(fx).executor,
      });
      expect(Date.now() - startedAt).toBeLessThan(15_000);
      expect(existsSync(started)).toBe(true);
      expect(existsSync(finished)).toBe(false);
      const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { invalidCandidates?: { id: string; reason: string }[] };
      expect(closure.invalidCandidates?.some((item) => item.id === "c0" && item.reason === "cap_hit")).toBe(true);
    } finally {
      await upstream.close();
    }
  }, 20_000);

  test("gap-finder and innovators see each knob's current value, type, and bounds", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    await runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 1, executor: fake.executor });
    const catalog = knobCatalog(JSON.parse(CONTROL_CONFIG_TEXT));
    for (const role of ["gap-finder", "innovator-0"]) {
      const listed = JSON.parse(readFileSync(join(fx.out, `round1/roles/${role}/effective-knobs.json`), "utf8")) as { knobs: unknown };
      expect(listed.knobs).toEqual(catalog);
      const prompt = (JSON.parse(readFileSync(join(fx.out, `round1/sessions/${role}.argv.json`), "utf8")) as { argv: string[] }).argv.at(-1) ?? "";
      for (const fact of catalog) expect(prompt).toContain(formatKnobLine(fact));
      expect(prompt).not.toContain("goal.maxContinuationTurns");
    }
    const innovatorPrompt = (JSON.parse(readFileSync(join(fx.out, "round1/sessions/innovator-0.argv.json"), "utf8")) as { argv: string[] }).argv.at(-1) ?? "";
    expect(innovatorPrompt).toContain("invalid: no_op_change");
    expect(innovatorPrompt).toContain("整条候选无效");
    expect(catalog.find((fact) => fact.key === "agent-loop.maxSteps")?.current).toBe(25);
    expect(catalog.find((fact) => fact.key === "agent-loop.noProgressTurns")?.current).toBe(3);
    expect(fake.calls).toHaveLength(1);
    const config = JSON.parse(readFileSync(join(fx.out, "round1/candidate/config.json"), "utf8")) as { parts: { "agent-loop": { maxSteps: number } } };
    expect(config.parts["agent-loop"].maxSteps).toBe(24);
  });

  test("preflight8 rejects noProgressTurns=3 because the deployed default is already 3", async () => {
    const fx = fixture();
    const harness = readFileSync(fileURLToPath(new URL("../../fixtures/harness.4d4e12e5.mjs", import.meta.url)), "utf8");
    expect(harness.split("\n")[153]).toContain('positiveInt(candidateValue("agent-loop", "noProgressTurns"), 3)');
    expect(readFileSync(fx.controlConfig, "utf8")).not.toContain("noProgressTurns");
    const stub = stubOptRoles(fx.key);
    const fake = fakeExecutor(fx);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fake.executor,
      roles: {
        gap: (input) => stub.gap(input),
        async innovate(input) {
          const summary = "agent-loop.noProgressTurns=3";
          await relayPlantRole(input.baseUrl, "innovator", input.round, { summary });
          hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "innovator" })}\n`, fx.key);
          return { session: { jsonl: "ignored\n" }, summary, parts: { "agent-loop": { noProgressTurns: 3 } } };
        },
        critic: (input) => stub.critic(input),
        ranker: (input) => stub.ranker(input),
        review: (input) => stub.review(input),
      },
    });
    expect(fake.calls).toEqual([]);
    expect(existsSync(join(fx.out, "round1/runs"))).toBe(false);
    expect(existsSync(join(fx.out, "round1/candidate"))).toBe(false);
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as {
      noWinner?: string;
      reason?: string;
      invalidCandidates?: { id: string; reason: string; keys?: string[] }[];
    };
    expect(closure.noWinner).toBe("no_winner");
    expect(closure.reason).toBe("no_winner");
    expect(closure.invalidCandidates).toHaveLength(6);
    for (const item of closure.invalidCandidates ?? []) {
      expect(item.reason).toBe("invalid: no_op_change");
      expect(item.keys).toEqual(["agent-loop.noProgressTurns"]);
    }
    expect(result.stopReport.reason).toBeNull();
    expect(result.stopReport.noWinner).toEqual([{ round: 1, reason: "no_winner" }]);
    const saved = JSON.parse(readFileSync(join(fx.out, "loop-result.json"), "utf8")) as {
      stopReport: { noWinner?: { round: number; reason: string }[] };
    };
    expect(saved.stopReport.noWinner).toEqual([{ round: 1, reason: "no_winner" }]);
  });

  test("a partial no-op invalidates the whole candidate and the real candidates still run", async () => {
    const fx = fixture();
    const stub = stubOptRoles(fx.key);
    const fake = fakeExecutor(fx);
    await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fake.executor,
      roles: {
        gap: (input) => stub.gap(input),
        async innovate(input) {
          if (!input.sessionPath.endsWith("innovator-0.jsonl")) return stub.innovate(input);
          const summary = "agent-loop.maxSteps=20";
          await relayPlantRole(input.baseUrl, "innovator", input.round, { summary });
          hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "innovator" })}\n`, fx.key);
          return {
            session: { jsonl: "ignored\n" },
            summary,
            parts: { "agent-loop": { maxSteps: 20, noProgressTurns: 3 } },
          };
        },
        critic: (input) => stub.critic(input),
        ranker: (input) => stub.ranker(input),
        review: (input) => stub.review(input),
      },
    });
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as {
      invalidCandidates?: { id: string; reason: string; keys?: string[] }[];
    };
    const rejected = closure.invalidCandidates?.find((item) => item.id === "c0");
    expect(rejected?.reason).toBe("invalid: no_op_change");
    expect(rejected?.keys).toEqual(["agent-loop.noProgressTurns"]);
    expect(fake.calls).toHaveLength(1);
    const config = JSON.parse(readFileSync(join(fx.out, "round1/candidate/config.json"), "utf8")) as {
      parts: { "agent-loop": { maxSteps?: number; noProgressTurns?: number } };
    };
    expect(config.parts["agent-loop"]).toEqual({ maxSteps: 24 });
  });

  test("a round where every candidate is rejected ends as no_winner without a run", async () => {
    const fx = fixture();
    const stub = stubOptRoles(fx.key);
    const fake = fakeExecutor(fx);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fake.executor,
      roles: {
        gap: (input) => stub.gap(input),
        async innovate(input) {
          const noop = !input.sessionPath.endsWith("innovator-0.jsonl");
          const summary = noop ? "agent-loop.noProgressTurns=3" : "agent-loop.maxSteps=20";
          const parts = noop ? { "agent-loop": { noProgressTurns: 3 } } : { "agent-loop": { maxSteps: 20 } };
          await relayPlantRole(input.baseUrl, "innovator", input.round, { summary });
          hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "innovator" })}\n`, fx.key);
          return { session: { jsonl: "ignored\n" }, summary, parts };
        },
        async critic(input) {
          const excluded = input.candidates.map((item) => item.id);
          await relayPlantRole(input.baseUrl, "critic", input.round, { excluded });
          hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "critic" })}\n`, fx.key);
          return { session: { jsonl: "ignored\n" }, excluded };
        },
        ranker: (input) => stub.ranker(input),
        review: (input) => stub.review(input),
      },
    });
    expect(fake.calls).toEqual([]);
    expect(existsSync(join(fx.out, "round1/runs"))).toBe(false);
    expect(existsSync(join(fx.out, "round1/candidate"))).toBe(false);
    expect(existsSync(join(fx.out, "round1/sessions/ranker.spawn.json"))).toBe(false);
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as {
      noWinner?: string;
      invalidCandidates?: { id: string; reason: string; keys?: string[] }[];
    };
    expect(closure.noWinner).toBe("no_winner");
    expect(closure.invalidCandidates?.map((item) => item.id).sort()).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    for (const item of closure.invalidCandidates ?? []) {
      expect(item.reason).toBe("invalid: no_op_change");
      expect(item.keys).toEqual(["agent-loop.noProgressTurns"]);
    }
    expect(result.stopReport.reason).toBeNull();
    expect(result.stopReport.noWinner).toEqual([{ round: 1, reason: "no_winner" }]);
    const saved = JSON.parse(readFileSync(join(fx.out, "loop-result.json"), "utf8")) as {
      stopReport: { reason: string | null; noWinner?: { round: number; reason: string }[] };
    };
    expect(saved.stopReport.reason).toBeNull();
    expect(saved.stopReport.noWinner).toEqual([{ round: 1, reason: "no_winner" }]);
  });
});
