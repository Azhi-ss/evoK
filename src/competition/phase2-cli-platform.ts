/**
 * Real Phase 2 platform over the operator's own `bohr` / `playground` CLIs.
 * Credentials stay in the user's CLI login; argv never carries secrets and
 * nothing secret is persisted. Every undocumented or unavailable capability
 * fails closed with an actionable status instead of a guess.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  PHASE2_CHALLENGE_ID,
  PHASE2_HARBOR_PIN,
  PHASE2_ORGANIZER_SUBJECT,
  Phase2AmbiguousSubmitError,
  Phase2Error,
  parsePhase2OfficialStatus,
  type Phase2AttemptStatus,
  type Phase2BundleCheck,
  type Phase2KitStatus,
  type Phase2Platform,
  type Phase2QuotaStatus,
  type Phase2Receipt,
  type Phase2Revision,
  type Phase2SourceRef,
} from "./phase2-playground";
import { digestValue } from "../execution/security-boundary";

export interface Phase2CliRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type Phase2CliRunner = (argv: readonly string[]) => Promise<Phase2CliRunResult>;

/** Exact attempt marker carried by `submit --detail`, used to recover a lost
 * receipt from the operator's own attempt list. */
export function phase2AttemptMarker(idempotencyKey: string): string {
  return `evok-phase2/${idempotencyKey}`;
}

/** Default argv runner (no shell). Exported for the workspace research hook. */
export const runPhase2Command: Phase2CliRunner = (argv) => new Promise((resolve, reject) => {
  const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.on("error", reject);
  child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
});

/** Content digest of a source tree: sorted relative paths + per-file sha256. */
export function digestPhase2Directory(root: string): string {
  const files: { path: string; sha256: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Phase2Error(`source tree must not contain symlinks: ${relative(root, full)}`);
      if (stat.isDirectory()) {
        if ([".git", "__pycache__"].includes(name)) throw new Phase2Error(`source tree must not contain ${name}`);
        walk(full);
      } else if (stat.isFile()) {
        if (name === ".env" || name.startsWith(".env.")) throw new Phase2Error(`source tree must not contain ${name}`);
        files.push({ path: relative(root, full), sha256: createHash("sha256").update(readFileSync(full)).digest("hex") });
      } else {
        throw new Phase2Error(`source tree must contain regular files only: ${relative(root, full)}`);
      }
    }
  };
  walk(root);
  if (files.length > 10_000) throw new Phase2Error("source tree exceeds 10,000 files");
  return digestValue(files);
}

export interface Phase2CliPlatformOptions {
  /** Directory holding the official pinned kit (tarball + tools/). */
  readonly kitDir: string;
  /** Source tree of the candidate being released (agent.json, runtime/, ...). */
  readonly sourceDir: string;
  /** Placeholder trace file for the Playground bundle. */
  readonly tracePath: string;
  /** Scratch dir for outputs/ and downloaded verification trees. */
  readonly workDir: string;
  readonly run?: Phase2CliRunner;
  /** Operator-attested free slots after they checked the platform themselves. */
  readonly confirmedQuotaToday?: number;
  readonly bohrBin?: string;
  readonly playgroundBin?: string;
  /** Root for revision-relative trees (`change.tree`). When a revision
   * carries its own tree, THAT tree is uploaded — never a stale --source-dir. */
  readonly workspaceDir?: string;
}

export class CliPhase2Platform implements Phase2Platform {
  private readonly options: Phase2CliPlatformOptions;
  private readonly run: Phase2CliRunner;

  constructor(options: Phase2CliPlatformOptions) {
    this.options = options;
    this.run = options.run ?? runPhase2Command;
  }

  private async call(argv: readonly string[]): Promise<Phase2CliRunResult> {
    const result = await this.run(argv);
    if (result.code !== 0) {
      throw new Phase2Error(`${argv[0]} ${argv[1] ?? ""} ${argv[2] ?? ""} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 400)}`);
    }
    return result;
  }

  private get bohr(): string {
    return this.options.bohrBin ?? "bohr";
  }

  private get playground(): string {
    return this.options.playgroundBin ?? "playground";
  }

  private get bundlePath(): string {
    return join(this.options.workDir, "playground-arm.zip");
  }

  private bundleSha256(): string {
    return createHash("sha256").update(readFileSync(this.bundlePath)).digest("hex");
  }

  /** Resolve the immutable tree of this revision. A revision that carries
   * `change.tree` (workspace runner) is bound to its own tree inside
   * `workspaceDir`; otherwise the operator-attested --source-dir is used. */
  private treeFor(revision: Phase2Revision): string {
    const tree = revision.change.tree;
    if (typeof tree === "string" && tree.trim() !== "" && this.options.workspaceDir) {
      const root = resolve(this.options.workspaceDir);
      const resolved = resolve(root, tree);
      if (resolved !== root && !resolved.startsWith(root + sep)) {
        throw new Phase2Error(`revision tree ${tree} escapes the workspace`);
      }
      return resolved;
    }
    return this.options.sourceDir;
  }

  async localTreeDigest(revision: Phase2Revision): Promise<string> {
    return digestPhase2Directory(this.treeFor(revision));
  }

  async kit(): Promise<Phase2KitStatus> {
    const tarball = join(this.options.kitDir, PHASE2_HARBOR_PIN.tarball);
    const action = `bohr wenyon dataset download ${PHASE2_HARBOR_PIN.kitDataset} --version ${PHASE2_HARBOR_PIN.kitVersion} --output-dir ${this.options.kitDir}`;
    if (!existsSync(tarball)) {
      return { status: "missing", detail: `${PHASE2_HARBOR_PIN.tarball} not found under ${this.options.kitDir}`, action };
    }
    const sha = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    if (sha !== PHASE2_HARBOR_PIN.tarballSha256) {
      return { status: "mismatch", detail: `tarball sha256 ${sha} != pinned ${PHASE2_HARBOR_PIN.tarballSha256}; do not install it`, action };
    }
    return { status: "verified", detail: `pinned Harbor-LBG ${PHASE2_HARBOR_PIN.version} tarball sha256 verified` };
  }

  async quota(): Promise<Phase2QuotaStatus> {
    if (this.options.confirmedQuotaToday !== undefined) {
      return { remainingToday: this.options.confirmedQuotaToday, detail: "operator confirmed free slots after checking the platform; no reset timezone was guessed" };
    }
    return { remainingToday: null, detail: "playground CLI has no daily-quota query; check the platform and pass --confirm-quota <n> before a real submit" };
  }

  async createSource(input: { revision: Phase2Revision; treeDigest: string }): Promise<Phase2SourceRef> {
    const tree = this.treeFor(input.revision);
    const treeDigest = digestPhase2Directory(tree);
    if (treeDigest !== input.treeDigest) {
      throw new Phase2Error(`local source tree changed between nomination and upload (${input.treeDigest} -> ${treeDigest}); re-nominate the new immutable revision`);
    }
    const datasetId = `harness-source-${input.revision.id.slice(4, 20)}`;
    await this.call([this.bohr, "wenyon", "dataset", "create", datasetId, "--kind", "file", "--name", `Harness phase2 ${input.revision.id}`, "--visibility", "private"]);
    const upload = await this.call([this.bohr, "wenyon", "dataset", "upload", datasetId, tree, "--output", "json"]);
    // Poll until the uploaded version is ready before granting or downloading.
    let ready = false;
    for (let poll = 0; poll < 30 && !ready; poll += 1) {
      const status = await this.call([this.bohr, "wenyon", "dataset", "status", datasetId, "--output", "json"]);
      ready = /"lifecycle_state"\s*:\s*"ready"/.test(status.stdout);
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!ready) throw new Phase2Error(`dataset ${datasetId} did not reach lifecycle_state=ready; retry status before granting or submitting`);
    // One upload creates one new version; take the version the CLI reports.
    const version = /"version"\s*:\s*"?(\d+)"?/.exec(upload.stdout)?.[1];
    if (!version) {
      const versions = await this.call([this.bohr, "wenyon", "dataset", "versions", datasetId, "--output", "json"]);
      const all = [...versions.stdout.matchAll(/"version"\s*:\s*"?(\d+)"?/g)].map((hit) => Number(hit[1]));
      if (all.length === 0) throw new Phase2Error(`cannot determine the uploaded source version for ${datasetId}`);
      return { datasetId, version: String(Math.max(...all)), treeDigest };
    }
    return { datasetId, version, treeDigest };
  }

  async grantOrganizerRead(datasetId: string): Promise<void> {
    await this.call([this.bohr, "wenyon", "dataset", "visibility", datasetId, "private"]);
    await this.call([this.bohr, "wenyon", "dataset", "grant", "create", "--dataset", datasetId, "--subject", PHASE2_ORGANIZER_SUBJECT, "--action", "read"]);
    const grants = await this.call([this.bohr, "wenyon", "dataset", "grant", "list", "--dataset", datasetId, "--output", "json"]);
    if (!grants.stdout.includes(PHASE2_ORGANIZER_SUBJECT.replace("user:", "")) || !grants.stdout.includes("read")) {
      throw new Phase2Error(`organizer read grant for ${datasetId} could not be verified`);
    }
  }

  async verifyDownloadedTree(input: { datasetId: string; version: string; treeDigest: string }): Promise<{ ok: boolean; detail: string }> {
    const target = join(this.options.workDir, "downloaded-source");
    const marker = join(target, ".phase2-download");
    if (existsSync(target)) {
      // Only a directory this platform itself downloaded may be reused; a
      // dry-run followed by a real submit re-verifies the same pinned tree.
      if (!existsSync(marker)) throw new Phase2Error(`${target} already exists and was not created by this adapter; move it away before verifying`);
      rmSync(target, { recursive: true, force: true });
    }
    mkdirSync(target, { recursive: true });
    await this.call([this.bohr, "wenyon", "dataset", "download", input.datasetId, "--version", input.version, "--output-dir", target, "--output", "json"]);
    const actual = digestPhase2Directory(target);
    writeFileSync(marker, `${input.datasetId} ${input.version}\n`);
    return actual === input.treeDigest
      ? { ok: true, detail: `downloaded tree of ${input.datasetId} v${input.version} matches file by file` }
      : { ok: false, detail: `downloaded tree digest ${actual} != local ${input.treeDigest}` };
  }

  async validateBundle(input: { revisionId: string; submissionJson: string; treeDigest: string }): Promise<Phase2BundleCheck> {
    const outputs = join(this.options.workDir, "outputs");
    mkdirSync(outputs, { recursive: true });
    writeFileSync(join(outputs, "submission.json"), input.submissionJson);
    await this.call([this.playground, "trace", "validate", "--trace", this.options.tracePath]);
    await this.call([this.playground, "submit", "--challenge-id", PHASE2_CHALLENGE_ID, "--outputs", outputs, "--trace", this.options.tracePath, "--bundle-out", this.bundlePath, "--dry-run"]);
    // The bundle digest covers the exact validated bytes; the real submit
    // reuses this ZIP via --bundle and never repacks it.
    return { ok: true, bundleDigest: this.bundleSha256(), detail: "playground submit --dry-run validated the exact bundle" };
  }

  async submit(input: { revisionId: string; bundleDigest: string; idempotencyKey: string }): Promise<Phase2Receipt> {
    if (this.bundleSha256() !== input.bundleDigest) {
      throw new Phase2Error("the bundle on disk no longer matches the validated bytes; re-run the dry-run validation before any real submit");
    }
    let result: Phase2CliRunResult;
    try {
      result = await this.run([this.playground, "submit", "--challenge-id", PHASE2_CHALLENGE_ID, "--bundle", this.bundlePath, "--trace", this.options.tracePath, "--detail", phase2AttemptMarker(input.idempotencyKey)]);
    } catch (error) {
      throw new Phase2AmbiguousSubmitError(`playground submit outcome unknown: ${(error as Error).message}; query the original attempt before any retry`);
    }
    const text = `${result.stdout}\n${result.stderr}`;
    const attemptId = /attempt[_-]?id["'\s:=]+([A-Za-z0-9-]+)/i.exec(text)?.[1];
    if (result.code !== 0 || !attemptId) {
      throw new Phase2AmbiguousSubmitError(`playground submit returned no usable attempt_id (exit ${result.code}); query the original attempt, do not resubmit. Output tail: ${text.trim().slice(-300)}`);
    }
    return { attemptId, status: "accepted", raw: { attemptId, status: "accepted" } };
  }

  async attemptStatus(attemptId: string): Promise<Phase2AttemptStatus> {
    const result = await this.call([this.playground, "status", "--attempt-id", attemptId]);
    let payload: unknown;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      throw new Phase2Error(`playground status for ${attemptId} returned non-JSON output; query the attempt manually and bind it explicitly`);
    }
    return parsePhase2OfficialStatus(payload, { attemptId, challengeId: PHASE2_CHALLENGE_ID });
  }

  async findAttempt(idempotencyKey: string): Promise<{ attemptId: string } | null> {
    // Recover a lost receipt through the exact submit --detail marker in the
    // operator's OWN attempt list. Zero or ambiguous matches stay uncertain.
    const marker = phase2AttemptMarker(idempotencyKey);
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let match: string | null = null;
    do {
      const args = [this.playground, "attempt", "list", "--challenge-id", PHASE2_CHALLENGE_ID, "--limit", "100", "--json"];
      if (cursor) args.push("--cursor", cursor);
      const page = JSON.parse((await this.call(args)).stdout);
      if (!Array.isArray(page.attempts)) throw new Phase2Error("invalid Playground own-attempt list");
      for (const entry of page.attempts) {
        if ((entry.challenge_id ?? entry.challengeId) !== PHASE2_CHALLENGE_ID || entry.id == null) continue;
        const id = String(entry.id);
        // CLI 0.1.45 lists the owner's IDs but exposes detail only in status.
        const status = typeof entry.detail === "string" ? entry :
          JSON.parse((await this.call([this.playground, "status", "--attempt-id", id])).stdout);
        if (String(status.id) !== id || (status.challengeId ?? status.challenge_id) !== PHASE2_CHALLENGE_ID || status.detail !== marker) continue;
        if (match !== null && match !== id) return null;
        match = id;
      }
      cursor = page.next_cursor ?? null;
      if (cursor !== null) {
        if (typeof cursor !== "string" || !cursor || cursors.has(cursor)) throw new Phase2Error("invalid Playground history cursor");
        cursors.add(cursor);
      }
    } while (cursor);
    return match === null ? null : { attemptId:match };
  }
}
