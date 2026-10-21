import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PACKAGE_AGENT_DIR, pinPackageAgentDir } from "../pi/agent-dirs";

/** Read-only evidence roles. Critic and ranker launch the same way as gap and reviewer. */
export const EVIDENCE_ROLES = ["gap-finder", "reviewer-gate", "critic", "ranker"] as const;

export const READ_ONLY_ROLE_TOOLS = ["read", "grep", "find", "ls"] as const;

const FORBIDDEN_ROLE_TOOLS = ["write", "edit", "bash", "powershell"] as const;

export type EvidenceRole = (typeof EVIDENCE_ROLES)[number];
export type OptRoleName = EvidenceRole | "innovator";

export interface RoleSpawnConfig {
  readonly role: OptRoleName;
  readonly cwd: string;
  /** Files this role may read. The session file is not one of them. */
  readonly allowedPaths: readonly string[];
  readonly tools: readonly string[];
  /** Host-owned Pi session. Outside `cwd` and outside `allowedPaths`. */
  readonly sessionPath: string;
  /** Host ledger of the session sha. The role cannot write this file. */
  readonly ledgerPath: string;
  /** Host relay log for this call. Outside `cwd`. The relay writes it. */
  readonly relayLog?: string;
  /** Relay data-plane URL for this call. Spawned as BASE_URL. */
  readonly baseUrl?: string;
  /** Output-token cap written into this role's models.json. */
  readonly maxTokens: number;
}

/**
 * Per-role output cap. Ranker, critic, and reviewer-gate need room for a full
 * pairwise or review answer. Gap-finder and innovator stay smaller.
 */
export const ROLE_OUTPUT_CAPS: Readonly<Record<OptRoleName, number>> = {
  "gap-finder": 16_384,
  innovator: 16_384,
  critic: 32_768,
  ranker: 32_768,
  "reviewer-gate": 32_768,
};

/**
 * DeepSeek V4.1 Flash output max. pi-ai 1.3.0 `providers/data/deepseek.json`,
 * model `deepseek-flash` (`name` "DeepSeek V4.1 Flash"). The local id
 * `deepseek-v4-1-flash-261017` is that model. A lower catalog max wins.
 */
export const DOCUMENTED_MODEL_MAX_TOKENS = 384_000;

/** `min(role setting, documented model max)`. The role setting defaults from `ROLE_OUTPUT_CAPS`. */
export function roleOutputCap(role: OptRoleName, override?: number, documentedMax: number = DOCUMENTED_MODEL_MAX_TOKENS): number {
  const requested = override ?? ROLE_OUTPUT_CAPS[role];
  if (!Number.isInteger(requested) || requested <= 0) throw new Error(`role ${role} output cap`);
  if (!Number.isInteger(documentedMax) || documentedMax <= 0) throw new Error(`role ${role} documented max`);
  return Math.min(requested, documentedMax);
}

/** Pi print mode writes this to stderr and exits 1 when `stopReason` is `length`. */
export const PI_OUTPUT_LIMIT_STDERR = "Response was truncated: the model reached its output token limit.";

export const ROLE_OUTPUT_TRUNCATED = "role_output_truncated";

export class RoleOutputTruncated extends Error {
  readonly reason = ROLE_OUTPUT_TRUNCATED;
  constructor(readonly role: string) {
    super(ROLE_OUTPUT_TRUNCATED);
    this.name = "RoleOutputTruncated";
  }
}

/** Non-zero exit, no stdout and no assistant text, and Pi's length-limit line. */
export function outputHitLengthLimit(status: number | null, stdout: string, stderr: string, assistant: string | null): boolean {
  if (status === null || status === 0) return false;
  if (stdout.trim() !== "") return false;
  if (assistant !== null && assistant.trim() !== "") return false;
  return stderr.includes(PI_OUTPUT_LIMIT_STDERR);
}

export function evidenceRoleTools(): readonly string[] {
  return ["read"];
}

export function buildRoleSpawn(input: {
  readonly role: OptRoleName;
  readonly cwd: string;
  readonly allowedPaths: readonly string[];
  readonly sessionPath: string;
  readonly ledgerPath: string;
  readonly relayLog?: string;
  readonly baseUrl?: string;
  /** Per-role override. Absent uses `ROLE_OUTPUT_CAPS`. */
  readonly maxTokens?: number;
  /** Test seam. Absent uses `DOCUMENTED_MODEL_MAX_TOKENS`. */
  readonly documentedMaxTokens?: number;
}): RoleSpawnConfig {
  const tools = input.role === "innovator" ? ["read", "write"] : evidenceRoleTools();
  const maxTokens = roleOutputCap(input.role, input.maxTokens, input.documentedMaxTokens);
  const config: RoleSpawnConfig = {
    role: input.role,
    cwd: input.cwd,
    allowedPaths: input.allowedPaths,
    tools,
    sessionPath: input.sessionPath,
    ledgerPath: input.ledgerPath,
    ...(input.relayLog !== undefined ? { relayLog: input.relayLog } : {}),
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    maxTokens,
  };
  assertRoleSpawn(config);
  return config;
}

/** Refuse a spawn that could let an evidence role write its own session. */
export function assertRoleSpawn(config: RoleSpawnConfig): void {
  if (isEvidenceRole(config.role)) {
    if (config.tools.length === 0) throw new Error(`role ${config.role} tools are empty`);
    for (const tool of config.tools) {
      if ((FORBIDDEN_ROLE_TOOLS as readonly string[]).includes(tool) || !(READ_ONLY_ROLE_TOOLS as readonly string[]).includes(tool)) {
        throw new Error(`role ${config.role} cannot use tool ${tool}`);
      }
    }
  }
  const session = resolve(config.sessionPath);
  const cwd = resolve(config.cwd);
  if (inside(session, cwd)) throw new Error("role session must be outside the role cwd");
  const ledger = resolve(config.ledgerPath);
  if (inside(ledger, cwd) || ledger === session) throw new Error("role session ledger must be outside the role cwd");
  if (config.relayLog) {
    const log = resolve(config.relayLog);
    if (log === cwd || inside(log, cwd)) throw new Error("role relay log must stay outside the role cwd");
  }
  for (const allowed of config.allowedPaths) {
    const root = resolve(allowed);
    if (overlaps(session, root) || overlaps(ledger, root) || overlaps(resolve(config.sessionPath, ".."), root)) {
      throw new Error("role session overlaps an allowed path");
    }
  }
}

/**
 * The only write entry a role is given.
 * Evidence roles have no write tool, so this returns false and does not touch the file.
 * A session path, the ledger, and anything outside the role cwd are refused for every role.
 */
export function roleWrite(config: RoleSpawnConfig, path: string, body: string): boolean {
  if (!config.tools.includes("write")) return false;
  const target = isAbsolute(path) ? resolve(path) : resolve(config.cwd, path);
  const session = resolve(config.sessionPath);
  const ledger = resolve(config.ledgerPath);
  const sessionDir = resolve(session, "..");
  if (target === session || target === ledger || inside(target, sessionDir) || sessionDir === target) return false;
  let realTarget = target;
  try {
    realTarget = realpathSync(target);
  } catch {
    realTarget = target;
  }
  if (realTarget === session || realTarget === ledger || inside(realTarget, sessionDir)) return false;
  const cwd = resolve(config.cwd);
  if (!inside(target, cwd)) return false;
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, body);
  return true;
}

/** Replace the session bytes and HMAC the ledger with the attest key. */
export function hostWriteSession(config: RoleSpawnConfig, text: string, key: Buffer): void {
  mkdirSync(resolve(config.sessionPath, ".."), { recursive: true });
  mkdirSync(resolve(config.ledgerPath, ".."), { recursive: true });
  writeFileSync(config.sessionPath, text);
  const ledger = readLedger(config.ledgerPath);
  ledger.sessions[config.role] = { sha256: sha256(text) };
  const mac = ledgerMac(key, ledger.sessions);
  writeFileSync(config.ledgerPath, `${JSON.stringify(ledgerBody(ledger.sessions, mac, ledger.rank), null, 2)}\n`);
}

/** Record how this round was ranked. The session HMAC stays over the session map. */
export function recordLedgerRank(ledgerPath: string, rank: "walkover"): void {
  mkdirSync(resolve(ledgerPath, ".."), { recursive: true });
  const ledger = readLedger(ledgerPath);
  writeFileSync(ledgerPath, `${JSON.stringify(ledgerBody(ledger.sessions, ledger.hmacSha256, rank), null, 2)}\n`);
}

export function recordedSessionSha(ledgerPath: string, role: string, key: Buffer): string | null {
  const ledger = readLedger(ledgerPath);
  if (ledgerMac(key, ledger.sessions) !== ledger.hmacSha256) return null;
  const recorded = ledger.sessions[role]?.sha256;
  return typeof recorded === "string" && recorded !== "" ? recorded : null;
}

/** Same placeholder the relay accepts. The upstream key stays off this process. */
const ROLE_API_KEY = "relay-placeholder-not-a-key";

/** Agent definition for this role. `harness-opt/agents/<role>.md`. */
export function roleAgentPath(role: OptRoleName): string {
  const file = join(PACKAGE_AGENT_DIR, `${role}.md`);
  if (!existsSync(file)) throw new Error(`role ${role} agent file is missing`);
  return file;
}

/**
 * Non-interactive Pi. `--print` plus the task prompt is what makes a model call.
 * `--tools` replaces Pi's defaults, so read-only roles stay on `read` and the
 * innovator gets one `read,write` list. The agent file is the system prompt.
 */
export function rolePiArgv(piBin: string, config: RoleSpawnConfig, prompt: string): string[] {
  const text = prompt.trim();
  if (text === "") throw new Error(`role ${config.role} task prompt is empty`);
  const tools = config.role === "innovator" ? "read,write" : "read";
  return [
    piBin,
    "--print",
    "--no-session",
    "--no-context-files",
    "--no-skills",
    "--tools",
    tools,
    "--model",
    roleModel(config.role),
    "--system-prompt",
    roleAgentPath(config.role),
    text,
  ];
}

export interface RoleArgvRecord {
  readonly argv: readonly string[];
  readonly maxTokens: number;
}

/** The argv Pi receives, plus the output cap that `models.json` enforces. Pi has no max-tokens flag. */
export function roleArgvRecord(config: RoleSpawnConfig, argv: readonly string[]): RoleArgvRecord {
  return { argv, maxTokens: config.maxTokens };
}

export function launchRolePi(
  piBin: string,
  config: RoleSpawnConfig,
  prompt: string,
): { readonly status: number | null; readonly argv: readonly string[]; readonly stdout: string; readonly stderr: string } {
  const argv = rolePiArgv(piBin, config, prompt);
  const [bin, ...args] = argv;
  if (!bin) throw new Error("pi binary is empty");
  const env = { ...process.env };
  delete env.HARNESS_ATTEST_KEY_FILE;
  delete env.HARNESS_RELAY_LOG_ROOT;
  delete env.RELAY_UPSTREAM_KEY_FILE;
  if (config.baseUrl) env.BASE_URL = config.baseUrl;
  pinPackageAgentDir(env);
  pinRoleRelay(env, config);
  const child = spawnSync(bin, args, {
    encoding: "utf8",
    cwd: config.cwd,
    env,
  });
  return { status: child.status, argv, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
}

function roleModel(role: OptRoleName): string {
  const text = readFileSync(roleAgentPath(role), "utf8");
  const front = text.match(/^---\n([\s\S]*?)\n---/);
  const model = front?.[1]?.split("\n").find((line) => line.startsWith("model:"))?.slice("model:".length).trim();
  if (!model) throw new Error(`role ${role} agent file has no model`);
  return model;
}

/** Point this Pi process at the relay run. The user's agent dir is left untouched. */
function pinRoleRelay(env: NodeJS.ProcessEnv, config: RoleSpawnConfig): void {
  if (!config.baseUrl) return;
  const model = roleModel(config.role);
  const slash = model.indexOf("/");
  const provider = slash > 0 ? model.slice(0, slash) : "ai-modeling";
  const id = slash > 0 ? model.slice(slash + 1) : model;
  const agentDir = join(resolve(config.sessionPath, ".."), `${config.role}-pi-agent`);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), `${JSON.stringify({
    providers: {
      [provider]: {
        name: provider,
        baseUrl: config.baseUrl,
        api: "openai-completions",
        apiKey: "${API_KEY}",
        models: [{
          id,
          name: id,
          reasoning: false,
          contextWindow: 131072,
          maxTokens: config.maxTokens,
          compat: { supportsDeveloperRole: false },
        }],
      },
    },
  }, null, 2)}\n`);
  env.PI_CODING_AGENT_DIR = agentDir;
  env.API_KEY = ROLE_API_KEY;
}

function isEvidenceRole(role: string): role is EvidenceRole {
  return (EVIDENCE_ROLES as readonly string[]).includes(role);
}

function inside(path: string, root: string): boolean {
  if (path === root) return true;
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

function overlaps(left: string, right: string): boolean {
  return left === right || inside(left, right) || inside(right, left);
}

function readLedger(file: string): { sessions: Record<string, { sha256?: string }>; hmacSha256: string; rank?: "walkover" } {
  if (!existsSync(file)) return { sessions: {}, hmacSha256: "" };
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { sessions?: Record<string, { sha256?: string }>; hmacSha256?: string; rank?: string };
  return {
    sessions: parsed.sessions ?? {},
    hmacSha256: parsed.hmacSha256 ?? "",
    ...(parsed.rank === "walkover" ? { rank: "walkover" as const } : {}),
  };
}

function ledgerBody(
  sessions: Record<string, { sha256?: string }>,
  hmacSha256: string,
  rank?: "walkover",
): { sessions: Record<string, { sha256?: string }>; hmacSha256: string; rank?: "walkover" } {
  return { sessions, hmacSha256, ...(rank ? { rank } : {}) };
}

function ledgerMac(key: Buffer, sessions: Record<string, { sha256?: string }>): string {
  const ordered: Record<string, { sha256: string }> = {};
  for (const name of Object.keys(sessions).sort()) {
    const sha = sessions[name]?.sha256;
    if (typeof sha === "string") ordered[name] = { sha256: sha };
  }
  return createHmac("sha256", key).update(JSON.stringify(ordered)).digest("hex");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
