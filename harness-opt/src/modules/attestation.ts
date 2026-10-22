import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Schema written by the host executor wrapper after the container exits. */
export const ATTEST_SCHEMA = "devii-opt-attest/v1";

/** Env var the wrapper reads. The loop host sets it. It is not an argv placeholder. */
export const ATTEST_ENV = "HARNESS_ATTEST_KEY_FILE";

export const ATTEST_FILENAME = "attestation.json";

/**
 * Field names from the wrapper's ATTEST_FIELDS dict.
 * The mac covers every other field. Canonical bytes are
 * `json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.
 */
export const ATTEST_FIELDS = {
  schema: "schema",
  harness: "mountedHarnessSha",
  config: "mountedConfigSha",
  trace: "traceSha",
  sessions: "piSessionShas",
  outputs: "outputShas",
  reward: "reward",
  rewardFile: "rewardFileSha",
  result: "resultSha",
  meta: "run",
  mac: "hmacSha256",
} as const;

export interface AttestRunMeta {
  readonly task: string;
  readonly seed: number;
  readonly arm: string;
  readonly score_status: string;
  readonly tokens: number;
  readonly exit: number | string;
  readonly runDir: string;
  /** Host-allocated id. The wrapper copies this; it does not invent one. */
  readonly runId: string;
  /** Host-assigned run directory. Stored relative to `outDir`, not as an absolute path. */
  readonly runPath: string;
  readonly at: string;
  /** One-time host nonce. Present only when the loop issued one. */
  readonly nonce?: string;
}

export interface HostAttestationWrite {
  readonly attestDir: string;
  /** Loop output directory. `runDir` and `runPath` are signed relative to this directory. */
  readonly outDir: string;
  readonly runDir: string;
  readonly key: Buffer;
  readonly harnessPath: string;
  readonly configPath: string;
  readonly reward: number | null;
  readonly meta: AttestRunMeta;
}

export interface VerifiedAttestation {
  readonly ok: true;
  readonly attestDir: string;
  readonly runDir: string;
  readonly runPath: string;
  readonly runId: string;
  readonly mountedHarnessSha: string;
  readonly mountedConfigSha: string;
  readonly traceSha: string | null;
  readonly tracePath: string | null;
  readonly piSessionShas: Readonly<Record<string, string>>;
  readonly sessionFiles: readonly string[];
  readonly outputShas: Readonly<Record<string, string>>;
  readonly reward: number | null;
  readonly rewardFileSha: string | null;
  readonly resultSha: string | null;
  readonly arm: string;
  /** `run.tokens` from the signed record. Absent becomes 0. */
  readonly tokens: number;
}

export interface AttestationRejection {
  readonly ok: false;
  readonly reasons: readonly string[];
}

type JsonNode =
  | { readonly t: "null" }
  | { readonly t: "bool"; readonly v: boolean }
  | { readonly t: "num"; readonly lex: string }
  | { readonly t: "str"; readonly v: string }
  | { readonly t: "arr"; readonly v: readonly JsonNode[] }
  | { readonly t: "obj"; readonly v: readonly (readonly [string, JsonNode])[] };

const NULL_NODE: JsonNode = { t: "null" };

export function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function loadAttestKey(keyFile: string): Buffer {
  let linked;
  try {
    linked = lstatSync(keyFile);
  } catch {
    throw new Error(`attest key is missing: ${keyFile}`);
  }
  if (!linked.isFile() || linked.isSymbolicLink()) throw new Error("attest key must be a regular file");
  if ((linked.mode & 0o777) !== 0o600) throw new Error("attest key must be mode 0600");
  const key = readFileSync(keyFile);
  if (key.length < 32) throw new Error("attest key too short");
  return key;
}

/** Regular files only. Symlinks are omitted, matching the wrapper's tree_shas. */
export function treeShas(root: string): Record<string, string> {
  if (!existsSync(root)) return {};
  let linked;
  try {
    linked = lstatSync(root);
  } catch {
    return {};
  }
  if (!linked.isDirectory() || linked.isSymbolicLink()) return {};
  const out: Record<string, string> = {};
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!stat.isFile()) continue;
      const rel = relative(root, full).split(sep).join("/");
      out[rel] = sha256File(full);
    }
  }
  return out;
}

export function assertAttestIsolated(attestDir: string, runDir: string): void {
  const attest = resolve(attestDir);
  const run = resolve(runDir);
  if (attest === run || attest.startsWith(run + sep) || run.startsWith(attest + sep)) {
    throw new Error("attest dir overlaps the run dir");
  }
}

export function assertAttestRoot(attestRoot: string, out: string): void {
  const attest = resolve(attestRoot);
  const output = resolve(out);
  if (attest === output || attest.startsWith(output + sep) || output.startsWith(attest + sep)) {
    throw new Error("attest root must be outside the loop output directory");
  }
}

/**
 * Write `{attestDir}/attestation.json` the way the host wrapper does.
 * Call this only after the run directory's artifacts are complete.
 */
export function writeHostAttestation(input: HostAttestationWrite): void {
  assertAttestIsolated(input.attestDir, input.runDir);
  const body = attestBody(input);
  const mac = hmacSha256(input.key, canonicalNode(body));
  const signed: JsonNode = {
    t: "obj",
    v: [...(body.t === "obj" ? body.v : []), [ATTEST_FIELDS.mac, { t: "str", v: mac }]],
  };
  mkdirSync(input.attestDir, { recursive: true });
  writeFileSync(join(input.attestDir, ATTEST_FILENAME), `${prettyNode(signed, 0)}\n`);
}

/**
 * Read the attestation from the host-assigned directory.
 * `attestDir` and `key` come from the loop host. This function does not look at executor stdout.
 */
export function verifyHostAttestation(input: {
  readonly attestDir: string;
  readonly key: Buffer;
  readonly configPath: string;
  readonly harnessPath?: string;
  /**
   * Loop output directory the signed run path is relative to.
   * A copied or relocated tree verifies when this is the new location.
   * Omitted: a relative path resolves against the parent of `attestDir`.
   */
  readonly outDir?: string;
  /** When set, the signed runDir and runPath must be this host path. */
  readonly runDir?: string;
  /** When set, the signed runId must be this host-allocated id. */
  readonly runId?: string;
  /** When set, the signed nonce must be this host-issued value. */
  readonly expectedNonce?: string;
}): VerifiedAttestation | AttestationRejection {
  const file = join(input.attestDir, ATTEST_FILENAME);
  if (!existsSync(file)) return { ok: false, reasons: ["missing"] };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { ok: false, reasons: ["missing"] };
  }
  let root: JsonNode;
  try {
    root = parseJson(text);
  } catch {
    return { ok: false, reasons: ["json"] };
  }
  if (root.t !== "obj") return { ok: false, reasons: ["json"] };
  const macNode = field(root, ATTEST_FIELDS.mac);
  const mac = macNode && macNode.t === "str" ? macNode.v : "";
  const unsigned: JsonNode = { t: "obj", v: root.v.filter(([key]) => key !== ATTEST_FIELDS.mac) };
  const expected = hmacSha256(input.key, canonicalNode(unsigned));
  if (!macEqual(mac, expected)) return { ok: false, reasons: ["hmac"] };

  const reasons: string[] = [];
  const schema = stringField(unsigned, ATTEST_FIELDS.schema);
  if (schema !== ATTEST_SCHEMA) reasons.push("schema");
  const mountedHarnessSha = stringField(unsigned, ATTEST_FIELDS.harness);
  const mountedConfigSha = stringField(unsigned, ATTEST_FIELDS.config);
  if (!isSha(mountedHarnessSha)) reasons.push("harness");
  if (!isSha(mountedConfigSha)) reasons.push("config");
  if (input.harnessPath && mountedHarnessSha !== hashOrEmpty(input.harnessPath)) reasons.push("harness");
  if (mountedConfigSha !== hashOrEmpty(input.configPath)) reasons.push("config");

  const runNode = field(unsigned, ATTEST_FIELDS.meta);
  const signedRunDir = runNode && runNode.t === "obj" ? stringField(runNode, "runDir") : null;
  const signedRunPath = runNode && runNode.t === "obj" ? stringField(runNode, "runPath") : null;
  const signedRunId = runNode && runNode.t === "obj" ? stringField(runNode, "runId") : null;
  const arm = runNode && runNode.t === "obj" ? stringField(runNode, "arm") : null;
  if (!signedRunDir || !arm) reasons.push("runDir");
  if (!signedRunPath) reasons.push("runPath");
  if (!signedRunId) reasons.push("runId");
  const locatedDir = signedRunDir ? locateSignedRunPath(signedRunDir, input.outDir, input.attestDir) : null;
  const locatedPath = signedRunPath ? locateSignedRunPath(signedRunPath, input.outDir, input.attestDir) : null;
  if (!locatedDir || locatedDir.escaped) reasons.push("runDir");
  if (!locatedPath || locatedPath.escaped) reasons.push("runPath");
  const runDir = locatedDir && !locatedDir.escaped ? locatedDir.abs : "";
  const runPath = locatedPath && !locatedPath.escaped ? locatedPath.abs : "";
  if (runDir && runPath && runDir !== runPath) reasons.push("runPath");
  if (input.runDir && runDir && resolve(input.runDir) !== runDir) reasons.push("runDir");
  if (input.runDir && runPath && resolve(input.runDir) !== runPath) reasons.push("runPath");
  if (input.runId && signedRunId !== input.runId) reasons.push("runId");
  const signedNonce = runNode && runNode.t === "obj" ? stringField(runNode, "nonce") : null;
  if (input.expectedNonce && signedNonce !== input.expectedNonce) reasons.push("nonce");

  const traceSha = shaOrNull(unsigned, ATTEST_FIELDS.trace, reasons, "trace");
  const rewardFileSha = shaOrNull(unsigned, ATTEST_FIELDS.rewardFile, reasons, "rewardFile");
  const resultSha = shaOrNull(unsigned, ATTEST_FIELDS.result, reasons, "result");
  const sessions = mapField(unsigned, ATTEST_FIELDS.sessions, reasons, "sessions");
  const outputs = mapField(unsigned, ATTEST_FIELDS.outputs, reasons, "outputs");
  const reward = rewardField(unsigned, reasons);

  const layout = runDir ? attestLayout(runDir) : null;
  if (reasons.length === 0 && runDir && layout) {
    if (traceSha !== fileShaOrNull(layout.trace)) reasons.push("trace");
    if (rewardFileSha !== fileShaOrNull(join(runDir, "verifier", "reward.txt"))) reasons.push("rewardFile");
    if (resultSha !== fileShaOrNull(join(runDir, "result.json"))) reasons.push("result");
    if (!sameMap(sessions, treeShas(layout.sessions))) reasons.push("sessions");
    if (!sameMap(outputs, treeShas(layout.outputs))) reasons.push("outputs");
  }
  if (reasons.length > 0 || !mountedHarnessSha || !mountedConfigSha || !arm) {
    return { ok: false, reasons: unique(reasons.length > 0 ? reasons : ["json"]) };
  }
  const sessionsRoot = layout?.sessions ?? join(runDir, ".pi-sessions");
  const sessionFiles = Object.keys(sessions)
    .sort()
    .map((rel) => sessionFile(sessionsRoot, rel))
    .filter((item): item is string => item !== null);
  if (sessionFiles.length !== Object.keys(sessions).length) return { ok: false, reasons: ["sessions"] };
  return {
    ok: true,
    attestDir: input.attestDir,
    runDir,
    runPath: signedRunPath ?? "",
    runId: signedRunId ?? "",
    mountedHarnessSha,
    mountedConfigSha,
    traceSha,
    tracePath: traceSha && layout ? layout.trace : null,
    piSessionShas: sessions,
    sessionFiles,
    outputShas: outputs,
    reward,
    rewardFileSha,
    resultSha,
    arm,
    tokens: runNode && runNode.t === "obj" ? integerField(runNode, "tokens") : 0,
  };
}

/**
 * A signed run path is relative to the out dir.
 * `..`, an empty segment, or a path that resolves outside that directory is an escape.
 * An absolute path is the legacy docker writer. It is kept only when it stays inside
 * the out dir (when one was given) and matches the host run.
 */
function locateSignedRunPath(
  signed: string,
  outDir: string | undefined,
  attestDir: string,
): { readonly abs: string; readonly escaped: boolean } {
  if (signed.trim() === "" || signed.split(/[\\/]/).some((part) => part === "..")) {
    return { abs: "", escaped: true };
  }
  if (isAbsolute(signed)) {
    const abs = resolve(signed);
    if (outDir && !insideDir(outDir, abs)) return { abs, escaped: true };
    return { abs, escaped: false };
  }
  if (signed.split(/[\\/]/).some((part) => part === "")) return { abs: "", escaped: true };
  const base = outDir ? resolve(outDir) : resolve(dirname(attestDir));
  const abs = resolve(base, signed);
  if (!insideDir(base, abs)) return { abs, escaped: true };
  return { abs, escaped: false };
}

function insideDir(root: string, target: string): boolean {
  const base = resolve(root);
  const abs = resolve(target);
  return abs === base || abs.startsWith(base + sep);
}

/** Posix path of `target` inside `outDir`. A path that leaves the out dir is refused. */
export function relativeOutPath(outDir: string, target: string): string {
  const rel = relative(resolve(outDir), resolve(target));
  const posix = rel.split(sep).join("/");
  if (rel === "" || isAbsolute(rel) || posix.split("/").some((part) => part === ".." || part === "")) {
    throw new Error("attestation run path escapes the out dir");
  }
  return posix;
}

function attestBody(input: HostAttestationWrite): JsonNode {
  if (input.meta.runId.trim() === "") throw new Error("attestation runId is empty");
  if (input.meta.runPath.trim() === "") throw new Error("attestation runPath is empty");
  if (input.outDir.trim() === "") throw new Error("attestation out dir is empty");
  const runAbs = resolve(input.runDir);
  const run = relativeOutPath(input.outDir, input.runDir);
  const runPath = relativeOutPath(input.outDir, input.meta.runPath);
  const layout = attestLayout(runAbs);
  const pairs: (readonly [string, JsonNode])[] = [
    [ATTEST_FIELDS.schema, { t: "str", v: ATTEST_SCHEMA }],
    [ATTEST_FIELDS.harness, { t: "str", v: sha256File(input.harnessPath) }],
    [ATTEST_FIELDS.config, { t: "str", v: sha256File(input.configPath) }],
    [ATTEST_FIELDS.trace, shaNode(fileShaOrNull(layout.trace))],
    [ATTEST_FIELDS.sessions, mapNode(treeShas(layout.sessions))],
    [ATTEST_FIELDS.outputs, mapNode(treeShas(layout.outputs))],
    [ATTEST_FIELDS.reward, input.reward === null ? NULL_NODE : { t: "num", lex: pythonFloatLexeme(input.reward) }],
    [ATTEST_FIELDS.rewardFile, shaNode(fileShaOrNull(join(runAbs, "verifier", "reward.txt")))],
    [ATTEST_FIELDS.result, shaNode(fileShaOrNull(join(runAbs, "result.json")))],
    [ATTEST_FIELDS.meta, {
      t: "obj",
      v: [
        ["arm", { t: "str", v: input.meta.arm }],
        ["at", { t: "str", v: input.meta.at }],
        ["exit", exitNode(input.meta.exit)],
        ["runDir", { t: "str", v: run }],
        ["runId", { t: "str", v: input.meta.runId }],
        ["runPath", { t: "str", v: runPath }],
        ...(input.meta.nonce ? [["nonce", { t: "str", v: input.meta.nonce }] as const] : []),
        ["score_status", { t: "str", v: input.meta.score_status }],
        ["seed", { t: "num", lex: integerLexeme(input.meta.seed) }],
        ["task", { t: "str", v: input.meta.task }],
        ["tokens", { t: "num", lex: integerLexeme(input.meta.tokens) }],
      ],
    }],
  ];
  return { t: "obj", v: pairs };
}

function exitNode(exit: number | string): JsonNode {
  return typeof exit === "number"
    ? { t: "num", lex: integerLexeme(exit) }
    : { t: "str", v: exit };
}

function shaNode(value: string | null): JsonNode {
  return value === null ? NULL_NODE : { t: "str", v: value };
}

function mapNode(map: Readonly<Record<string, string>>): JsonNode {
  return {
    t: "obj",
    v: Object.keys(map).sort().map((key) => [key, { t: "str", v: map[key] ?? "" }] as const),
  };
}

function fileShaOrNull(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    const linked = lstatSync(file);
    if (!linked.isFile() || linked.isSymbolicLink()) return null;
    return sha256File(file);
  } catch {
    return null;
  }
}

function hashOrEmpty(file: string): string {
  try {
    return sha256File(file);
  } catch {
    return "";
  }
}

/**
 * `task-copy/trace.jsonl` wins when once left a regular file there.
 * Sessions and outputs then come from that same directory.
 * Otherwise top-level `trace.jsonl` wins, then the lexicographically last
 * `workspace/runs/task-*` trace. Session and output trees stay at the top
 * level when they already have files.
 */
function attestLayout(runDir: string): { readonly trace: string; readonly sessions: string; readonly outputs: string } {
  const copied = taskCopyDir(runDir);
  if (copied) {
    return {
      trace: join(copied, "trace.jsonl"),
      sessions: join(copied, ".pi-sessions"),
      outputs: join(copied, "outputs"),
    };
  }
  const topTrace = join(runDir, "trace.jsonl");
  const nested = taskTrace(runDir);
  const taskDir = nested ? resolve(nested, "..") : null;
  return {
    trace: isRegularFile(topTrace) ? topTrace : nested ?? topTrace,
    sessions: artifactTree(runDir, ".pi-sessions", taskDir),
    outputs: artifactTree(runDir, "outputs", taskDir),
  };
}

function taskCopyDir(runDir: string): string | null {
  const root = join(runDir, "task-copy");
  return isRegularFile(join(root, "trace.jsonl")) ? root : null;
}

function artifactTree(runDir: string, name: string, taskDir: string | null): string {
  const top = join(runDir, name);
  if (Object.keys(treeShas(top)).length > 0) return top;
  if (taskDir) {
    const nested = join(taskDir, name);
    if (Object.keys(treeShas(nested)).length > 0) return nested;
  }
  return top;
}

function taskTrace(runDir: string): string | null {
  const root = join(runDir, "workspace", "runs");
  let linked;
  try {
    linked = lstatSync(root);
  } catch {
    return null;
  }
  if (!linked.isDirectory() || linked.isSymbolicLink()) return null;
  let found: string | null = null;
  for (const name of readdirSync(root).filter((item) => item.startsWith("task-")).sort()) {
    const dir = join(root, name);
    let stat;
    try {
      stat = lstatSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    const trace = join(dir, "trace.jsonl");
    if (isRegularFile(trace)) found = trace;
  }
  return found;
}

function isRegularFile(file: string): boolean {
  try {
    const linked = lstatSync(file);
    return linked.isFile() && !linked.isSymbolicLink();
  } catch {
    return false;
  }
}

function sessionFile(sessionsRoot: string, rel: string): string | null {
  if (rel === "" || isAbsolute(rel) || rel.split("/").some((part) => part === ".." || part === "")) return null;
  const full = resolve(sessionsRoot, rel);
  const root = resolve(sessionsRoot);
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

function field(node: JsonNode, key: string): JsonNode | null {
  if (node.t !== "obj") return null;
  let found: JsonNode | null = null;
  for (const [name, child] of node.v) {
    if (name === key) found = child;
  }
  return found;
}

function stringField(node: JsonNode, key: string): string | null {
  const child = field(node, key);
  return child && child.t === "str" ? child.v : null;
}

function shaOrNull(node: JsonNode, key: string, reasons: string[], reason: string): string | null {
  const child = field(node, key);
  if (!child || child.t === "null") return null;
  if (child.t === "str" && isSha(child.v)) return child.v;
  reasons.push(reason);
  return null;
}

function mapField(node: JsonNode, key: string, reasons: string[], reason: string): Record<string, string> {
  const child = field(node, key);
  if (!child || child.t !== "obj") {
    reasons.push(reason);
    return {};
  }
  const out: Record<string, string> = {};
  for (const [name, value] of child.v) {
    if (value.t !== "str" || !isSha(value.v)) {
      reasons.push(reason);
      return {};
    }
    out[name] = value.v;
  }
  return out;
}

function rewardField(node: JsonNode, reasons: string[]): number | null {
  const child = field(node, ATTEST_FIELDS.reward);
  if (!child || child.t === "null") return null;
  if (child.t !== "num") {
    reasons.push("reward");
    return null;
  }
  const value = Number(child.lex);
  if (!Number.isFinite(value)) {
    reasons.push("reward");
    return null;
  }
  return value;
}

function sameMap(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function isSha(value: string | null): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function unique(reasons: readonly string[]): string[] {
  return [...new Set(reasons)];
}

function integerField(node: JsonNode, key: string): number {
  const child = field(node, key);
  if (!child || child.t !== "num" || !/^-?(?:0|[1-9]\d*)$/.test(child.lex)) return 0;
  return Number(child.lex);
}

function integerLexeme(value: number): string {
  if (!Number.isInteger(value)) throw new Error("attestation integer field is not an integer");
  return Object.is(value, -0) ? "0" : String(value);
}

/** CPython `json.dumps` for a float, which matches `repr` for finite values. */
export function pythonFloatLexeme(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  if (Object.is(value, -0)) return "-0.0";
  let text = JSON.stringify(value);
  if (!/[.eE]/.test(text)) text += ".0";
  return text.replace(/e([+-]?)(\d+)$/, (_, sign: string, digits: string) => `e${sign === "-" ? "-" : "+"}${digits.padStart(2, "0")}`);
}

function hmacSha256(key: Buffer, canonical: string): string {
  return createHmac("sha256", key).update(Buffer.from(canonical, "utf8")).digest("hex");
}

function macEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function canonicalNode(node: JsonNode): string {
  switch (node.t) {
    case "null":
      return "null";
    case "bool":
      return node.v ? "true" : "false";
    case "num":
      return canonicalNumber(node.lex);
    case "str":
      return escapePythonString(node.v);
    case "arr":
      return `[${node.v.map((item) => canonicalNode(item)).join(",")}]`;
    case "obj": {
      const entries = [...node.v].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
      return `{${entries.map(([key, value]) => `${escapePythonString(key)}:${canonicalNode(value)}`).join(",")}}`;
    }
    default:
      return "";
  }
}

function canonicalNumber(lex: string): string {
  if (lex === "NaN" || lex === "Infinity" || lex === "-Infinity") return lex;
  if (/^-?(?:0|[1-9]\d*)$/.test(lex)) return lex === "-0" ? "0" : lex;
  const value = JSON.parse(lex) as number;
  return pythonFloatLexeme(value);
}

function escapePythonString(value: string): string {
  let out = "\"";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\"") out += "\\\"";
    else if (char === "\\") out += "\\\\";
    else if (char === "\b") out += "\\b";
    else if (char === "\f") out += "\\f";
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += char;
  }
  return `${out}"`;
}

function prettyNode(node: JsonNode, level: number): string {
  const pad = " ".repeat(level);
  const nested = " ".repeat(level + 1);
  if (node.t === "arr") {
    if (node.v.length === 0) return "[]";
    return `[\n${node.v.map((item) => `${nested}${prettyNode(item, level + 1)}`).join(",\n")}\n${pad}]`;
  }
  if (node.t === "obj") {
    const entries = [...node.v].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    if (entries.length === 0) return "{}";
    return `{\n${entries.map(([key, value]) => `${nested}${escapePythonString(key)}: ${prettyNode(value, level + 1)}`).join(",\n")}\n${pad}}`;
  }
  return canonicalNode(node);
}

function parseJson(text: string): JsonNode {
  const parser = new JsonParser(text);
  const node = parser.parseValue();
  parser.skip();
  if (!parser.done()) throw new Error("trailing json");
  return node;
}

class JsonParser {
  private index = 0;

  constructor(private readonly text: string) {}

  done(): boolean {
    return this.index >= this.text.length;
  }

  parseValue(): JsonNode {
    this.skip();
    const char = this.text[this.index];
    if (char === "{") return this.parseObject();
    if (char === "[") return this.parseArray();
    if (char === "\"") return { t: "str", v: this.parseString() };
    if (char === "t" && this.text.startsWith("true", this.index)) {
      this.index += 4;
      return { t: "bool", v: true };
    }
    if (char === "f" && this.text.startsWith("false", this.index)) {
      this.index += 5;
      return { t: "bool", v: false };
    }
    if (char === "n" && this.text.startsWith("null", this.index)) {
      this.index += 4;
      return NULL_NODE;
    }
    return { t: "num", lex: this.parseNumber() };
  }

  skip(): void {
    while (this.index < this.text.length && /\s/.test(this.text[this.index] ?? "")) this.index += 1;
  }

  private parseObject(): JsonNode {
    this.index += 1;
    const entries: (readonly [string, JsonNode])[] = [];
    this.skip();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return { t: "obj", v: entries };
    }
    while (this.index < this.text.length) {
      this.skip();
      if (this.text[this.index] !== "\"") throw new Error("object key");
      const key = this.parseString();
      this.skip();
      if (this.text[this.index] !== ":") throw new Error("object colon");
      this.index += 1;
      entries.push([key, this.parseValue()]);
      this.skip();
      const mark = this.text[this.index];
      if (mark === ",") {
        this.index += 1;
        continue;
      }
      if (mark === "}") {
        this.index += 1;
        return { t: "obj", v: entries };
      }
      throw new Error("object end");
    }
    throw new Error("object end");
  }

  private parseArray(): JsonNode {
    this.index += 1;
    const items: JsonNode[] = [];
    this.skip();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return { t: "arr", v: items };
    }
    while (this.index < this.text.length) {
      items.push(this.parseValue());
      this.skip();
      const mark = this.text[this.index];
      if (mark === ",") {
        this.index += 1;
        continue;
      }
      if (mark === "]") {
        this.index += 1;
        return { t: "arr", v: items };
      }
      throw new Error("array end");
    }
    throw new Error("array end");
  }

  private parseString(): string {
    this.index += 1;
    let out = "";
    while (this.index < this.text.length) {
      const char = this.text[this.index] ?? "";
      if (char === "\"") {
        this.index += 1;
        return out;
      }
      if (char === "\\") {
        const next = this.text[this.index + 1] ?? "";
        const simple: Record<string, string> = { "\"": "\"", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (simple[next] !== undefined) {
          out += simple[next];
          this.index += 2;
          continue;
        }
        if (next === "u") {
          const hex = this.text.slice(this.index + 2, this.index + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("bad unicode escape");
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.index += 6;
          continue;
        }
        throw new Error("bad escape");
      }
      if (char.charCodeAt(0) < 0x20) throw new Error("raw control");
      out += char;
      this.index += 1;
    }
    throw new Error("unterminated string");
  }

  private parseNumber(): string {
    const start = this.index;
    if (this.text.startsWith("-Infinity", this.index)) {
      this.index += "-Infinity".length;
      return "-Infinity";
    }
    if (this.text.startsWith("Infinity", this.index)) {
      this.index += "Infinity".length;
      return "Infinity";
    }
    if (this.text.startsWith("NaN", this.index)) {
      this.index += 3;
      return "NaN";
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.index));
    if (!match) throw new Error("bad number");
    this.index = start + match[0].length;
    return match[0];
  }
}
