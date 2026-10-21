import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
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

function taskFlags(): string[] {
  return ["--task", LOOP_TASK.id, "--task-path", LOOP_TASK.path, "--network", LOOP_TASK.network, "--token-w", String(LOOP_TASK.tokenW)];
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

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "opt-loop-"));
  const keyFile = join(root, "attest.key");
  const key = Buffer.alloc(32, 9);
  writeFileSync(keyFile, key);
  chmodSync(keyFile, 0o600);
  const harnessPath = join(root, "harness.mjs");
  writeFileSync(harnessPath, "/* host harness */\n");
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
    task: LOOP_TASK,
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
      await plantRole(fx, input, "reviewer", { accept: false, reason });
      hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "reviewer-gate" })}\n${JSON.stringify({ type: "message", text: reason })}\n`, fx.key);
      return { session: { jsonl: "ignored\n" }, accept: false, reason };
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

async function postRole(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "role-call" }] }),
  });
  if (!response.ok) throw new Error(`relay ${response.status}`);
  await response.arrayBuffer();
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
  review: { readonly reported: { readonly accept: boolean; readonly reason: string }; readonly recorded: { readonly accept: boolean; readonly reason: string } },
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
      await postConclusion(input.baseUrl, { summary: "agent-loop.maxSteps=24" });
      session(input, "innovator");
      return { session: { jsonl: "ignored\n" }, summary: "agent-loop.maxSteps=24", parts: { "agent-loop": { maxSteps: 24 } } };
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
      return { session: { jsonl: "ignored\n" }, accept: review.reported.accept, reason: review.reported.reason };
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
      round0Record: { srcPath: string; srcSha256: string; hostCopyPath: string };
    };
    expect(pre.maxRounds).toBe(10);
    expect(pre.readOnlyTokenCap).toBe(30_000_000);
    expect(pre.readOnlyWallCapS).toBe(48 * 3600);
    expect(pre.realRunWallCapS).toBe(103 * 3600);
    expect(pre.seed).toBe(0);
    expect(pre.innovatorCap).toBe(200_000);
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
      "ranker",
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
      await expect(runOptLoop({
        ...hostOpts(fx),
        mode: "dry-run",
        rounds: 1,
        roles: rejectingRoles(fx),
        executor: fakeExecutor(fx).executor,
      })).rejects.toThrow(/EWI_IDLE_SCRIPT/);
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
        await plantRole(fx, input, "reviewer", { accept: false, reason });
        hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "reviewer-gate" })}\n${JSON.stringify({ type: "message", text: reason })}\n`, fx.key);
        return { session: { jsonl: "ignored\n" }, accept: false, reason };
      },
    };
    await runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 2, roles, executor: fake.executor });
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
          return { session: { jsonl: perfectRead(input.sessionPath, "nope") }, accept: true, reason: "accept" };
        },
      },
    });
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { gapCitedTrace: boolean };
    expect(readFileSync(join(fx.out, "round1/sessions/gap-finder.jsonl"), "utf8")).toContain(`${fx.controlTrace}:1`);
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
        await plantRole(fx, input, "reviewer", { accept: false, reason });
        hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "reviewer-gate" })}\n${JSON.stringify({ type: "message", text: reason })}\n`, fx.key);
        return { session: { jsonl: "ignored\n" }, accept: false, reason };
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
        await plantRole(fx, input, "reviewer", { accept: true, reason });
        expect(roleWrite(input.spawn, input.sessionPath, "forged\n")).toBe(false);
        hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "reviewer-gate" })}\n${JSON.stringify({ type: "message", text: "accept" })}\n`, fx.key);
        return { session: { jsonl: "ignored\n" }, accept: true, reason: "accept" };
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
    expect(gap.traces[0]?.file).toBe(pre.round0Record.hostCopyPath);
    expect(gap.traces[0]?.sha256).toBe(pre.round0Record.srcSha256);
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
    expect(result.rounds).toEqual([{ round: 1, accepted: false, duplicate: false, patchHash: null, ewiSeeds: [] }]);
    expect(result.stopReport.reason).toBe("anti_forgery");
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

describe("optimize command", () => {
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
        ...taskFlags(),
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
      ...taskFlags(),
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
        ...taskFlags(),
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
        ...taskFlags(),
        ...round0Flags(),
      ]));
      expect(code).toBe(1);
      expect(stderr).toContain("role gap-finder returned no conclusion");
      const argv = readFileSync(recorded, "utf8");
      const lines = argv.split("\n");
      expect(lines[0]).toBe("--print");
      expect(lines[lines.indexOf("--tools") + 1]).toBe("read");
      expect(lines).toContain("--system-prompt");
      expect(lines[lines.indexOf("--system-prompt") + 1]?.endsWith("/agents/gap-finder.md")).toBe(true);
      expect(lines.slice(lines.indexOf("--system-prompt") + 2).join("\n").trim().length).toBeGreaterThan(0);
      expect(argv).not.toContain("write");
      expect(argv).not.toContain("bash");
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
        ...taskFlags(),
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
        ...taskFlags(),
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
      ...taskFlags(),
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
      ...taskFlags(),
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
        ...taskFlags(),
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
      ...taskFlags(),
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
  "live role smoke requires a relay done with tokens and does not start docker",
  async () => {
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
      });
      expect(report.dockerRuns).toBe(0);
      expect(report.launches).toEqual({
        "gap-finder": 1,
        innovator: 1,
        critic: 1,
        ranker: 1,
        "reviewer-gate": 1,
      });
      expect(existsSync(join(fx.out, "round1/runs"))).toBe(false);
      const innovatorArgv = JSON.parse(readFileSync(join(fx.out, "round1/sessions/innovator-0.argv.json"), "utf8")) as string[];
      const gapArgv = JSON.parse(readFileSync(join(fx.out, "round1/sessions/gap-finder.argv.json"), "utf8")) as string[];
      expect(innovatorArgv[0]).toBe(process.env.PI_BIN);
      expect(gapArgv[0]).toBe(process.env.PI_BIN);
      expect(gapArgv).toContain("--print");
      expect(innovatorArgv).toContain("--print");
      expect(gapArgv[gapArgv.indexOf("--tools") + 1]).toBe("read");
      expect(innovatorArgv[innovatorArgv.indexOf("--tools") + 1]).toBe("read,write");
      expect(gapArgv[gapArgv.indexOf("--system-prompt") + 1]?.endsWith("/agents/gap-finder.md")).toBe(true);
      expect(innovatorArgv[innovatorArgv.indexOf("--system-prompt") + 1]?.endsWith("/agents/innovator.md")).toBe(true);
      expect(gapArgv.at(-1)?.includes("knob")).toBe(true);
      expect(gapArgv.join("\n")).not.toContain("bash");
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
        ...taskFlags(),
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
        ...taskFlags(),
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
          hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "reviewer-gate" })}\n${JSON.stringify({ type: "message", text: "forged" })}\n`, fx.key);
          return { session: { jsonl: "ignored\n" }, accept: true, reason: "forged" };
        },
      },
    });
    const activation = JSON.parse(readFileSync(join(fx.out, "round1/activation.json"), "utf8")) as { patchActive: boolean };
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { gapCitedTrace: boolean };
    expect(activation.patchActive).toBe(true);
    expect(closure.gapCitedTrace).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(result.accepted).toBeNull();
    expect(result.rounds[0]?.accepted).toBe(false);
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
            await postConclusion(input.baseUrl, { accept: false, reason: "still idle" });
            session(input, "reviewer-gate");
            return { session: { jsonl: "ignored\n" }, accept: false, reason: "still idle" };
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

  test("30M sums innovator, critic, and ranker relay usage", async () => {
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
    expect(result.stopReport.reason).toBe("readOnlyTokenCap");
    expect(result.stopReport.faultRounds).toBe(0);
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
            return { session: { jsonl: "ignored\n" }, summary: "agent-loop.maxSteps=24", parts: { "agent-loop": { maxSteps: 24 } } };
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
            return { session: { jsonl: "ignored\n" }, accept: false, reason: "hold" };
          },
        },
      });
      expect(result.stopReport).toEqual({ reason: null, faultRounds: 0, reviewerRejectRounds: 0 });
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
    const verdict = { accept: true, reason: "accept the idle cap" };
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
          recorded: { accept: false, reason: "hold" },
          reported: { accept: true, reason: "forged" },
        }),
      });
      expect(upstream.hits).toBe(10);
      expect(fake.calls.map((call) => `${call.task.id}:${call.seed}`)).toEqual(["hb003:0"]);
      expect(result.accepted).toBeNull();
      expect(result.rounds[0]?.accepted).toBe(false);
      expect(result.stopReport).toEqual({ reason: null, faultRounds: 0, reviewerRejectRounds: 1 });
      const review = JSON.parse(readFileSync(join(fx.out, "round1/sessions/reviewer-gate.spawn.json"), "utf8")) as RoleSpawnConfig;
      expect(review.relayLog).toBeUndefined();
      expect(JSON.stringify(review)).not.toContain(relayRoot);
      expect(lastDone(roleLog(relayRoot, review.baseUrl ?? ""))?.assistant).toBe(JSON.stringify({ accept: false, reason: "hold" }));
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
            return { session: { jsonl: "ignored\n" }, accept: false, reason: "no-done" };
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
});
