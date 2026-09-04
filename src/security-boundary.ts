import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type SandboxViolationKind =
  | "path-traversal"
  | "symlink"
  | "protected-path"
  | "credential"
  | "network"
  | "host-socket"
  | "tool"
  | "trust";

export class SandboxViolation extends Error {
  readonly retryable = false;

  constructor(readonly kind: SandboxViolationKind, message: string) {
    super(message);
    this.name = "SandboxViolation";
  }
}

export class TrustViolation extends SandboxViolation {
  constructor(message: string) {
    super("trust", message);
    this.name = "TrustViolation";
  }
}

export interface SandboxPolicy {
  readonly root?: string;
  /** Omit or set to `none` to deny all network access. */
  readonly network?: "none" | readonly string[];
  readonly credentialPaths?: readonly string[];
  readonly protectedPaths?: readonly string[];
  readonly allowedTools?: readonly string[];
  readonly allowBash?: boolean;
  readonly allowHostSockets?: boolean;
  readonly maxFileBytes?: number;
}

const DEFAULT_PROTECTED_SEGMENTS = new Set([
  ".env", "credentials", "credential", "secret", "secrets", "evaluator", "evaluation", "contract", "ledger", "policy",
]);
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const KNOWN_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;
const NETWORK_COMMAND = /\b(?:curl|wget|nc|ncat|netcat|telnet|socat|ssh|scp|ftp|httpie|nslookup|dig|ping|fetch|docker|podman|kubectl|psql|mysql|redis-cli)\b|\b(?:git\s+(?:clone|fetch|pull|push)|npm\s+(?:install|ci|update)|bun\s+(?:install|add|update)|pnpm\s+(?:install|add|update))\b|\/dev\/(?:tcp|udp)\b|\b(?:connect|socket)\s*\(/i;
const INLINE_COMMAND = /(?:^|[;&|\r\n])\s*(?:sh|bash|zsh|fish|node|bun|deno|python(?:3)?|perl|ruby)\s+(?:-e|--eval|-c)\b|\b(?:eval|exec)\s*\(|\$\(|`/i;
const PROTECTED_COMMAND_PATH = /(?:^|[\s"'=])(?:~(?:\/|\\)|\/)(?:[^\s"']*\/)?(?:\.ssh|\.aws|\.config|\.npmrc|\.git-credentials|\.env(?:\.|\b)|credentials?|secrets?|id_rsa|id_ed25519|etc\/(?:passwd|shadow|sudoers)|var\/run|proc(?:\/|\b)|sys(?:\/|\b)|dev\/((?:tcp|udp)|docker\.sock))/i;
const HOST_SOCKET_COMMAND = /\b(?:docker|podman|kubectl)\b|\/var\/run\/|docker\.sock/i;
const URL_TOKEN = /https?:\/\/[^\s"'`;&|)]+/gi;

function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => clone(entry)) as T;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, clone(entry)])) as T;
}

export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): Readonly<T> {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value as Readonly<T>;
  if (seen.has(value as object)) return value as Readonly<T>;
  seen.add(value as object);
  for (const key of Reflect.ownKeys(value as object)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value) as Readonly<T>;
}

function within(root: string, child: string): boolean {
  const path = relative(root, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownValue(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function safeInteger(name: string, value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${name} must be a finite integer >= ${minimum}`);
}

function stringList(name: string, value: readonly string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new TypeError(`${name} must contain non-empty strings`);
  }
  if (new Set(value).size !== value.length) throw new TypeError(`${name} must contain unique strings`);
  return [...value];
}

function domainName(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("://")) throw new TypeError("sandbox network entries must be hostnames");
  const domain = value.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
  if (!domain || domain.includes("/") || domain.includes("\\")) throw new TypeError("sandbox network entries must be hostnames");
  return domain;
}

function validatePolicy(policy: SandboxPolicy): void {
  if (policy.root !== undefined && (typeof policy.root !== "string" || policy.root.trim() === "")) {
    throw new TypeError("sandbox root must be a non-empty path");
  }
  if (policy.network !== undefined && policy.network !== "none") {
    if (!Array.isArray(policy.network) || policy.network.length === 0) throw new TypeError("sandbox network must be none or a non-empty hostname allowlist");
    for (const entry of policy.network) domainName(entry);
  }
  stringList("sandbox credentialPaths", policy.credentialPaths);
  stringList("sandbox protectedPaths", policy.protectedPaths);
  stringList("sandbox allowedTools", policy.allowedTools);
  if (policy.allowBash !== undefined && typeof policy.allowBash !== "boolean") throw new TypeError("sandbox allowBash must be boolean");
  if (policy.allowHostSockets !== undefined && typeof policy.allowHostSockets !== "boolean") throw new TypeError("sandbox allowHostSockets must be boolean");
  if (policy.maxFileBytes !== undefined) safeInteger("sandbox maxFileBytes", policy.maxFileBytes, 1);
}

function narrowerDomain(left: string, right: string): string | undefined {
  if (left === right) return left;
  if (left.endsWith(`.${right}`)) return left;
  if (right.endsWith(`.${left}`)) return right;
  return undefined;
}

/** Combine an untrusted per-run policy with a trusted runtime policy without widening it. */
export function restrictSandboxPolicy(base: SandboxPolicy = {}, overlay: SandboxPolicy = {}): Readonly<SandboxPolicy> {
  validatePolicy(base);
  validatePolicy(overlay);
  if (base.root !== undefined && overlay.root !== undefined && resolve(base.root) !== resolve(overlay.root)) {
    throw new SandboxViolation("path-traversal", "sandbox policy roots cannot be changed by a run");
  }
  const baseNetwork = base.network ?? "none";
  let network: "none" | string[] = baseNetwork === "none" ? "none" : [...baseNetwork];
  if (overlay.network === "none") network = "none";
  else if (Array.isArray(overlay.network)) {
    const allowedBaseNetwork = network;
    if (allowedBaseNetwork === "none") network = "none";
    else {
      network = [...new Set(overlay.network.flatMap((entry) => {
        const narrowed = allowedBaseNetwork.flatMap((baseEntry: string) => {
          const value = narrowerDomain(domainName(entry), domainName(baseEntry));
          return value ? [value] : [];
        });
        return narrowed;
      }))];
    }
  }
  const baseTools = base.allowedTools;
  const allowedTools = overlay.allowedTools === undefined
    ? baseTools && [...baseTools]
    : baseTools === undefined ? [...overlay.allowedTools] : baseTools.filter((tool) => overlay.allowedTools!.includes(tool));
  const maxFileBytes = base.maxFileBytes === undefined ? overlay.maxFileBytes
    : overlay.maxFileBytes === undefined ? base.maxFileBytes : Math.min(base.maxFileBytes, overlay.maxFileBytes);
  return deepFreeze({
    ...(base.root === undefined ? (overlay.root === undefined ? {} : { root: overlay.root }) : { root: base.root }),
    network,
    ...(base.credentialPaths || overlay.credentialPaths ? { credentialPaths: [...new Set([...(base.credentialPaths ?? []), ...(overlay.credentialPaths ?? [])])] } : {}),
    ...(base.protectedPaths || overlay.protectedPaths ? { protectedPaths: [...new Set([...(base.protectedPaths ?? []), ...(overlay.protectedPaths ?? [])])] } : {}),
    ...(allowedTools === undefined ? {} : { allowedTools }),
    allowBash: base.allowBash === true && overlay.allowBash !== false,
    allowHostSockets: base.allowHostSockets === true && overlay.allowHostSockets !== false,
    ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
  }) as Readonly<SandboxPolicy>;
}

export class SandboxBoundary {
  readonly root: string;
  readonly policy: Readonly<SandboxPolicy>;
  private readonly protectedPaths: readonly string[];

  constructor(policy: SandboxPolicy = {}) {
    validatePolicy(policy);
    this.root = resolve(policy.root ?? "/tmp/evok-sandbox");
    this.policy = deepFreeze({
      ...policy,
      root: this.root,
      ...(policy.network === undefined ? {} : { network: policy.network === "none" ? "none" : [...policy.network] }),
      ...(policy.credentialPaths === undefined ? {} : { credentialPaths: [...policy.credentialPaths] }),
      ...(policy.protectedPaths === undefined ? {} : { protectedPaths: [...policy.protectedPaths] }),
      ...(policy.allowedTools === undefined ? {} : { allowedTools: [...policy.allowedTools] }),
    });
    this.protectedPaths = Object.freeze([
      ...((policy.protectedPaths ?? []).map((path) => resolve(this.root, path))),
      ...((policy.credentialPaths ?? []).map((path) => resolve(this.root, path))),
    ]);
  }

  private isProtected(target: string): boolean {
    if (this.protectedPaths.some((path) => within(path, target))) return true;
    const parts = normalizedPath(relative(this.root, target)).split("/").filter(Boolean).map((part) => part.toLowerCase());
    return parts.some((part) => DEFAULT_PROTECTED_SEGMENTS.has(part) || part.startsWith(".env."));
  }

  assertPath(path: string, operation: "read" | "write" | "execute" | "inspect" = "read"): string {
    if (typeof path !== "string" || path === "" || path.includes("\0")) {
      throw new SandboxViolation("path-traversal", `invalid sandbox path for ${operation}`);
    }
    if (/^(?:@|~(?:[\\/]|$)|file:\/\/)/i.test(path)) {
      throw new SandboxViolation("path-traversal", `path aliases are not allowed in the sandbox: ${path}`);
    }
    const parts = normalizedPath(path).split("/");
    if (parts.includes("..")) throw new SandboxViolation("path-traversal", `path traversal is not allowed: ${path}`);
    const target = isAbsolute(path) ? resolve(path) : resolve(this.root, path);
    if (!within(this.root, target)) throw new SandboxViolation("path-traversal", `path escapes sandbox root: ${path}`);
    if (this.isProtected(target)) throw new SandboxViolation("protected-path", `protected path is not accessible: ${path}`);
    return target;
  }

  async assertPathAsync(path: string, operation: "read" | "write" | "execute" | "inspect" = "read"): Promise<string> {
    const target = this.assertPath(path, operation);
    let existing = target;
    while (true) {
      try {
        await lstat(existing);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(existing);
        if (parent === existing) break;
        existing = parent;
      }
    }
    const rootStat = await lstat(this.root).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (rootStat?.isSymbolicLink()) throw new SandboxViolation("symlink", `sandbox root is a symlink: ${this.root}`);
    const canonicalRoot = await realpath(this.root).catch(() => this.root);
    const canonicalExisting = await realpath(existing).catch(() => existing);
    if (within(this.root, existing) && !within(canonicalRoot, canonicalExisting)) {
      throw new SandboxViolation("symlink", `path resolves outside sandbox root: ${path}`);
    }

    const relativeExisting = relative(this.root, existing);
    let cursor = this.root;
    for (const segment of relativeExisting.split(sep).filter(Boolean)) {
      cursor = resolve(cursor, segment);
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new SandboxViolation("symlink", `symlink path component is not allowed: ${path}`);
    }
    return target;
  }

  assertNetwork(target: string): void {
    if (typeof target !== "string" || target.trim() === "") throw new SandboxViolation("network", "network target is required");
    let host = target.trim();
    try {
      const url = new URL(host.includes("://") ? host : `https://${host}`);
      if (!["http:", "https:"].includes(url.protocol) || url.hostname === "") throw new Error("unsupported network protocol");
      host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    } catch {
      throw new SandboxViolation("network", `invalid network target: ${target}`);
    }
    const network = this.policy.network;
    if (!Array.isArray(network) || network.length === 0) throw new SandboxViolation("network", `network access is denied: ${target}`);
    const allowed = network.some((entry) => {
      const domain = domainName(entry);
      return host === domain || host.endsWith(`.${domain}`);
    });
    if (!allowed) throw new SandboxViolation("network", `network domain is not allowlisted: ${host}`);
  }

  assertHostSocket(target: string): void {
    if (this.policy.allowHostSockets !== true) throw new SandboxViolation("host-socket", `host socket access is denied: ${target}`);
  }

  assertTool(tool: string): void {
    if (typeof tool !== "string" || tool.trim() === "") throw new SandboxViolation("tool", "tool name is required");
    const allowed = this.policy.allowedTools ?? READ_ONLY_TOOLS;
    if (!allowed.includes(tool)) throw new SandboxViolation("tool", `tool is not allowed in this sandbox: ${tool}`);
    if (tool === "bash" && this.policy.allowBash !== true) throw new SandboxViolation("tool", "bash requires an explicitly enabled sandbox policy");
  }

  assertToolCall(tool: string, args: Record<string, unknown> = {}): void {
    this.assertTool(tool);
    if (typeof args.path === "string") this.assertPath(args.path, tool === "read" ? "read" : "write");
    if (tool === "bash") {
      const command = typeof args.command === "string" ? args.command : "";
      if (command.trim() === "") throw new SandboxViolation("tool", "bash command is required");
      if (INLINE_COMMAND.test(command)) throw new SandboxViolation("network", "indirect shell and interpreter commands are not allowed");
      if (normalizedPath(command).split("/").includes("..")) throw new SandboxViolation("path-traversal", "path traversal is not allowed in commands");
      if (PROTECTED_COMMAND_PATH.test(command)) throw new SandboxViolation("protected-path", "protected data is not accessible from commands");
      if (HOST_SOCKET_COMMAND.test(command)) throw new SandboxViolation("host-socket", "host socket commands are not allowed");
      if (NETWORK_COMMAND.test(command)) {
        const urls = command.match(URL_TOKEN) ?? [];
        if (urls.length === 0 || !urls.every((url) => {
          try { this.assertNetwork(url); return true; } catch { return false; }
        })) throw new SandboxViolation("network", "network or socket command is not allowed");
      }
      if (/(?:^|[\s/])(?:\.env|credentials?|secrets?|evaluator|ledger|policy)(?:$|[\s/])/i.test(command)) {
        throw new SandboxViolation("protected-path", "protected data is not accessible from commands");
      }
    }
  }

  validateCandidateFiles(files: unknown): Record<string, string> {
    if (!plainRecord(files)) throw new SandboxViolation("tool", "candidate files must be an ordinary object");
    const result: Record<string, string> = {};
    for (const [path, content] of Object.entries(files)) {
      this.assertPath(path, "write");
      if (typeof content !== "string") throw new SandboxViolation("tool", `candidate file content must be text: ${path}`);
      if (this.policy.maxFileBytes !== undefined && new TextEncoder().encode(content).byteLength > this.policy.maxFileBytes) {
        throw new SandboxViolation("tool", `candidate file exceeds sandbox limit: ${path}`);
      }
      result[path] = content;
    }
    return result;
  }

  createWorkspace(initial: Record<string, string> = {}): Record<string, string> {
    const target: Record<string, string> = {};
    for (const [path, content] of Object.entries(initial)) {
      this.assertPath(path, "write");
      if (typeof content !== "string") throw new SandboxViolation("tool", `workspace content must be text: ${path}`);
      Object.defineProperty(target, path, { value: content, writable: true, enumerable: true, configurable: true });
    }
    return new Proxy(target, {
      set: (object, property, value) => {
        if (typeof property !== "string") throw new SandboxViolation("path-traversal", "workspace property must be a path");
        this.assertPath(property, "write");
        if (typeof value !== "string") throw new SandboxViolation("tool", `workspace content must be text: ${property}`);
        Object.defineProperty(object, property, { value, writable: true, enumerable: true, configurable: true });
        return true;
      },
      defineProperty: (object, property, descriptor) => {
        if (typeof property !== "string") throw new SandboxViolation("path-traversal", "workspace property must be a path");
        this.assertPath(property, "write");
        if (!("value" in descriptor) || typeof descriptor.value !== "string"
          || descriptor.get !== undefined || descriptor.set !== undefined) {
          throw new SandboxViolation("tool", `workspace properties must contain text: ${property}`);
        }
        Object.defineProperty(object, property, {
          value: descriptor.value,
          writable: descriptor.writable ?? true,
          enumerable: descriptor.enumerable ?? true,
          configurable: descriptor.configurable ?? true,
        });
        return true;
      },
      deleteProperty: (_object, property) => {
        if (typeof property !== "string") return false;
        this.assertPath(property, "write");
        return Reflect.deleteProperty(target, property);
      },
    });
  }

  descriptor(): Readonly<Record<string, unknown>> {
    return deepFreeze({
      root: this.root,
      network: Array.isArray(this.policy.network) ? [...this.policy.network] : "none",
      credentials: false,
      hostSockets: this.policy.allowHostSockets === true,
      allowedTools: [...(this.policy.allowedTools ?? READ_ONLY_TOOLS)],
      maxFileBytes: this.policy.maxFileBytes,
    });
  }
}

export class SecretRedactor {
  readonly replacement: string;
  private readonly secrets: readonly string[];
  private readonly patterns: readonly RegExp[];

  constructor(secrets: readonly string[] = [], replacement = "[REDACTED]", patterns: readonly RegExp[] = []) {
    if (!Array.isArray(secrets) || secrets.some((secret) => typeof secret !== "string" || secret.length === 0)) throw new TypeError("secrets must be non-empty strings");
    if (typeof replacement !== "string") throw new TypeError("redaction replacement must be a string");
    this.replacement = replacement;
    this.secrets = Object.freeze([...new Set(secrets)].sort((a, b) => b.length - a.length));
    this.patterns = Object.freeze([
      /((?:authorization|api[_-]?key|token|password|secret)\s*[:=]\s*)([^\s,;"']+)/gi,
      /\b(?:sk|ghp|github_pat|xoxb|xoxp)-[A-Za-z0-9_-]+\b/g,
      /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
      ...patterns,
    ]);
  }

  redactText(value: string): string {
    let result = String(value);
    for (const secret of this.secrets) result = result.split(secret).join(this.replacement);
    for (const pattern of this.patterns) {
      const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
      const copyPattern = new RegExp(pattern.source, flags);
      result = result.replace(copyPattern, (...args: unknown[]) => {
        const prefix = typeof args[1] === "string" && /[:=]\s*$/.test(String(args[1])) ? String(args[1]) : "";
        return prefix ? `${prefix}${this.replacement}` : this.replacement;
      });
    }
    return result;
  }

  redact<T>(value: T): T {
    const seen = new WeakMap<object, unknown>();
    const visit = (entry: unknown): unknown => {
      if (typeof entry === "string") return this.redactText(entry);
      if (!entry || typeof entry !== "object") return entry;
      if (seen.has(entry)) return seen.get(entry);
      if (entry instanceof Error) {
        const error = new Error(this.redactText(entry.message));
        error.name = this.redactText(entry.name);
        seen.set(entry, error);
        return error;
      }
      if (Array.isArray(entry)) {
        const output: unknown[] = [];
        seen.set(entry, output);
        for (const child of entry) output.push(visit(child));
        return output;
      }
      const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      seen.set(entry, output);
      for (const [key, child] of Object.entries(entry)) {
        Object.defineProperty(output, this.redactText(key), {
          value: visit(child), enumerable: true, writable: true, configurable: true,
        });
      }
      return output;
    };
    return visit(value) as T;
  }

  error(error: unknown): Error {
    if (error instanceof Error) {
      const result = new Error(this.redactText(error.message));
      result.name = this.redactText(error.name);
      return result;
    }
    return new Error(this.redactText(String(error)));
  }
}

export function redactSecrets<T>(value: T, secrets: readonly string[], replacement = "[REDACTED]"): T {
  return new SecretRedactor(secrets, replacement).redact(value);
}

function canonical(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("digest input must contain finite numbers");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("digest input must be JSON-like");
  if (seen.has(value)) throw new TypeError("digest input cannot be cyclic");
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) result = `[${value.map((entry) => canonical(entry, seen)).join(",")}]`;
  else {
    const entries = Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], seen)}`);
    result = `{${entries.join(",")}}`;
  }
  seen.delete(value);
  return result;
}

export function digestValue(value: unknown): string {
  return createHash("sha256").update(canonical(value, new Set())).digest("hex");
}

export interface SnapshotManifest {
  readonly snapshotDigest: string;
  readonly filesDigest: string;
  readonly contractDigest: string;
}

function withoutIntegrity(snapshot: Record<string, unknown>): Record<string, unknown> {
  const { digest: _digest, snapshotDigest: _snapshotDigest, filesDigest: _filesDigest, contractDigest: _contractDigest, ...content } = snapshot;
  return content;
}

export function snapshotManifest(snapshot: Record<string, unknown>): SnapshotManifest {
  const content = withoutIntegrity(snapshot);
  return Object.freeze({
    snapshotDigest: digestValue(content),
    filesDigest: digestValue(content.files),
    contractDigest: digestValue(content.contract),
  });
}

export type TrustedSnapshot<T extends Record<string, unknown>> = Readonly<T & {
  digest: string;
  filesDigest: string;
  contractDigest: string;
}>;

export function createTrustedSnapshot<T extends Record<string, unknown>>(snapshot: T): TrustedSnapshot<T> {
  const content = clone(withoutIntegrity(snapshot));
  const manifest = snapshotManifest(content);
  return deepFreeze({ ...content, digest: manifest.snapshotDigest, filesDigest: manifest.filesDigest, contractDigest: manifest.contractDigest }) as TrustedSnapshot<T>;
}

export function assertSnapshotIntegrity(snapshot: unknown): SnapshotManifest {
  if (!plainRecord(snapshot)) throw new TrustViolation("snapshot must be an ordinary object");
  const manifest = snapshotManifest(snapshot);
  const value = snapshot as Record<string, unknown>;
  if (value.digest !== manifest.snapshotDigest || value.snapshotDigest !== undefined && value.snapshotDigest !== manifest.snapshotDigest
    || value.filesDigest !== manifest.filesDigest || value.contractDigest !== manifest.contractDigest) {
    throw new TrustViolation("snapshot digest does not match its contents");
  }
  return manifest;
}

export interface TrustedEvaluation<T> {
  readonly result: T;
  readonly manifest: SnapshotManifest;
}

export async function evaluateTrustedSnapshot<
  S extends Record<string, unknown>,
  C,
  R,
>(snapshot: S, contract: C, evaluator: (snapshot: Readonly<S>, contract: Readonly<C>, manifest: SnapshotManifest) => R | Promise<R>): Promise<TrustedEvaluation<R>> {
  if (plainRecord(snapshot) && ["digest", "snapshotDigest", "filesDigest", "contractDigest"].some((key) => key in snapshot)) {
    const original = assertSnapshotIntegrity(snapshot);
    if (original.contractDigest !== digestValue(contract)) throw new TrustViolation("evaluation contract digest mismatch");
  }
  const trustedSnapshot = createTrustedSnapshot({ ...clone(snapshot), contract: clone(contract) } as S);
  const trustedContract = deepFreeze(clone(contract));
  const manifest = snapshotManifest(trustedSnapshot);
  if (digestValue(trustedContract) !== manifest.contractDigest) throw new TrustViolation("evaluation contract digest mismatch");
  deepFreeze(manifest);
  let result: R;
  try {
    result = await evaluator(trustedSnapshot, trustedContract, manifest);
  } catch (error) {
    if (error instanceof TypeError && /read only|readonly|frozen|extensible|property/i.test(error.message)) {
      throw new TrustViolation("evaluator attempted to mutate trusted input");
    }
    throw error;
  }
  const finalManifest = assertSnapshotIntegrity(trustedSnapshot);
  if (finalManifest.snapshotDigest !== manifest.snapshotDigest
    || finalManifest.filesDigest !== manifest.filesDigest
    || finalManifest.contractDigest !== manifest.contractDigest) {
    throw new TrustViolation("trusted snapshot changed during evaluation");
  }
  return { result, manifest };
}

export interface HumanAcceptanceRequest {
  readonly championDigest: string;
  readonly artifactDigest?: string;
  readonly acceptedBy: string;
  readonly requestId?: string;
  readonly decisionId?: string;
  readonly acceptedAt?: number;
  readonly expiresAt?: number;
  readonly reason?: string;
}

export interface HumanAcceptanceDecision extends HumanAcceptanceRequest {
  readonly decisionId: string;
  readonly acceptedAt: number;
  readonly expiresAt?: number;
}

export class HumanAcceptanceGate {
  private nextDecision = 1;

  accept(request: HumanAcceptanceRequest): Readonly<HumanAcceptanceDecision> {
    if (!plainRecord(request)) throw new TypeError("human acceptance must be an ordinary object");
    const championDigest = ownValue(request, "championDigest");
    const artifactDigest = ownValue(request, "artifactDigest");
    const acceptedBy = ownValue(request, "acceptedBy");
    const requestId = ownValue(request, "requestId");
    const decisionId = ownValue(request, "decisionId");
    const acceptedAtValue = ownValue(request, "acceptedAt");
    const expiresAt = ownValue(request, "expiresAt");
    const reason = ownValue(request, "reason");
    if (typeof championDigest !== "string" || championDigest.trim() === "") throw new TypeError("champion digest is required");
    if (artifactDigest !== undefined && (typeof artifactDigest !== "string" || artifactDigest.trim() === "")) throw new TypeError("artifact digest must be a non-empty string");
    if (typeof acceptedBy !== "string" || acceptedBy.trim() === "") throw new TypeError("human acceptance identity is required");
    if (requestId !== undefined && (typeof requestId !== "string" || requestId.trim() === "")) throw new TypeError("acceptance requestId must be a non-empty string");
    if (decisionId !== undefined && (typeof decisionId !== "string" || decisionId.trim() === "")) throw new TypeError("decisionId must be a non-empty string");
    if (reason !== undefined && typeof reason !== "string") throw new TypeError("acceptance reason must be a string");
    const acceptedAt = acceptedAtValue === undefined ? Date.now() : acceptedAtValue;
    if (typeof acceptedAt !== "number" || !Number.isFinite(acceptedAt)) throw new RangeError("acceptedAt must be finite");
    if (expiresAt !== undefined && (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= acceptedAt)) {
      throw new RangeError("expiresAt must be finite and after acceptedAt");
    }
    return deepFreeze({
      championDigest,
      ...(artifactDigest === undefined ? {} : { artifactDigest }),
      acceptedBy,
      ...(requestId === undefined ? {} : { requestId }),
      decisionId: decisionId ?? `human-acceptance-${this.nextDecision++}`,
      acceptedAt,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(reason === undefined ? {} : { reason }),
    });
  }
}
