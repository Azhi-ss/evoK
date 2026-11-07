import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliPhase2Platform, phase2AttemptMarker, type Phase2CliRunResult } from "./phase2-cli-platform";
import { PHASE2_CHALLENGE_ID, PHASE2_HARBOR_PIN, PHASE2_ORGANIZER_SUBJECT, Phase2AmbiguousSubmitError, type Phase2Revision } from "./phase2-playground";

const REV: Phase2Revision = { id: "rev-abcdef1234567890", summary: "candidate", change: {}, contentDigest: "digest", createdAt: "2026-11-01", evidence: [] };

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "phase2-cli-"));
  const sourceDir = join(root, "agent");
  mkdirSync(join(sourceDir, "runtime"), { recursive: true });
  writeFileSync(join(sourceDir, "agent.json"), '{"import_path":"my_agent:ScienceAgent","kwargs":{}}\n');
  writeFileSync(join(sourceDir, "runtime", "agent.py"), "print('ok')\n");
  const tracePath = join(root, "trace.jsonl");
  writeFileSync(tracePath, '{"role":"user","content":"placeholder"}\n{"role":"assistant","content":"placeholder"}\n');
  return { root, sourceDir, tracePath, kitDir: join(root, "kit"), workDir: join(root, "work") };
}

/** Scripted bohr/playground. No real CLI, no credentials, no network. */
function scripted(calls: string[], respond?: (argv: readonly string[]) => Partial<Phase2CliRunResult> | void) {
  return async (argv: readonly string[]): Promise<Phase2CliRunResult> => {
    calls.push(argv.join(" "));
    const extra = respond?.(argv) ?? {};
    if (argv[0] === "bohr" && argv.includes("upload")) return { code: 0, stdout: '{"version": 1}', stderr: "", ...extra };
    if (argv[0] === "bohr" && argv.includes("status")) return { code: 0, stdout: '{"lifecycle_state":"ready"}', stderr: "", ...extra };
    if (argv[0] === "bohr" && argv.includes("grant") && argv.includes("list")) {
      return { code: 0, stdout: `{"grants":[{"subject_type":"user","subject_id":"${PHASE2_ORGANIZER_SUBJECT.replace("user:", "")}","action":"read"}]}`, stderr: "", ...extra };
    }
    return { code: 0, stdout: "{}", stderr: "", ...extra };
  };
}

describe("phase2 CLI platform kit and quota", () => {
  test("missing or mismatched pinned kit never verifies", async () => {
    const ws = workspace();
    const platform = new CliPhase2Platform({ ...ws, run: scripted([]) });
    expect((await platform.kit()).status).toBe("missing");
    mkdirSync(ws.kitDir, { recursive: true });
    writeFileSync(join(ws.kitDir, PHASE2_HARBOR_PIN.tarball), "not the pinned harbor source");
    const mismatch = await platform.kit();
    expect(mismatch.status).toBe("mismatch");
    expect(mismatch.action).toContain(PHASE2_HARBOR_PIN.kitDataset);
  });

  test("quota is unknown unless the operator confirmed it on the platform", async () => {
    const ws = workspace();
    expect((await new CliPhase2Platform({ ...ws, run: scripted([]) }).quota()).remainingToday).toBeNull();
    expect((await new CliPhase2Platform({ ...ws, confirmedQuotaToday: 1, run: scripted([]) }).quota()).remainingToday).toBe(1);
  });
});

describe("phase2 revision-bound source tree", () => {
  test("change.tree binds the upload to the nominated tree, not a stale --source-dir", async () => {
    const ws = workspace();
    const workspaceDir = join(ws.root, "ws");
    mkdirSync(join(workspaceDir, "treeB"), { recursive: true });
    writeFileSync(join(workspaceDir, "treeB", "agent.json"), '{"import_path":"other:Agent"}\n');
    const revision: Phase2Revision = { ...REV, change: { tree: "treeB" } };
    const calls: string[] = [];
    const platform = new CliPhase2Platform({ ...ws, workspaceDir, run: scripted(calls) });
    const bound = await platform.localTreeDigest(revision);
    const stale = await platform.localTreeDigest(REV);
    expect(bound).not.toBe(stale);
    await platform.createSource({ revision, treeDigest: bound });
    const upload = calls.find((line) => line.includes("dataset upload"));
    expect(upload).toContain(join(workspaceDir, "treeB"));
    await expect(platform.localTreeDigest({ ...REV, change: { tree: "../outside" } })).rejects.toThrow("escapes");
  });
});

describe("phase2 CLI platform deterministic pipeline", () => {
  test("private source, organizer read, downloaded verify, bundle and receipt argv", async () => {
    const ws = workspace();
    const calls: string[] = [];
    const run = scripted(calls, (argv) => {
      if (argv.includes("download")) {
        const target = argv[argv.indexOf("--output-dir") + 1];
        cpSync(ws.sourceDir, target, { recursive: true });
      }
      if (argv.includes("--dry-run")) {
        writeFileSync(argv[argv.indexOf("--bundle-out") + 1], "fake arm bundle bytes");
      }
      if (argv[0] === "playground" && argv[1] === "submit" && !argv.includes("--dry-run")) {
        return { stdout: '{"attempt_id":"att-123","status":"accepted"}' };
      }
    });
    const platform = new CliPhase2Platform({ ...ws, run });
    const localDigest = await platform.localTreeDigest(REV);
    const source = await platform.createSource({ revision: REV, treeDigest: localDigest });
    expect(source.datasetId).toBe("harness-source-abcdef1234567890");
    expect(source.version).toBe("1");
    await platform.grantOrganizerRead(source.datasetId);
    const verified = await platform.verifyDownloadedTree({ datasetId: source.datasetId, version: "1", treeDigest: source.treeDigest });
    expect(verified.ok).toBe(true);
    const bundle = await platform.validateBundle({ revisionId: "rev-abcdef1234567890", submissionJson: '{"source_url":"https://wenyon.dp.tech/app/console/datasets/x"}', treeDigest: source.treeDigest });
    expect(bundle.ok).toBe(true);
    const receipt = await platform.submit({ revisionId: "rev-abcdef1234567890", bundleDigest: bundle.bundleDigest, idempotencyKey: "key" });
    expect(receipt.attemptId).toBe("att-123");

    const create = calls.find((line) => line.includes("dataset create"));
    expect(create).toContain("--visibility private");
    const grant = calls.find((line) => line.includes("grant create"));
    expect(grant).toContain(PHASE2_ORGANIZER_SUBJECT);
    expect(grant).toContain("--action read");
    const dryRun = calls.find((line) => line.startsWith("playground submit") && line.includes("--dry-run"));
    expect(dryRun).toContain(`--challenge-id ${PHASE2_CHALLENGE_ID}`);
    const real = calls.find((line) => line.startsWith("playground submit") && !line.includes("--dry-run"));
    expect(real).toContain(`--challenge-id ${PHASE2_CHALLENGE_ID}`);
    // The real submit reuses the exact validated ZIP, never a repack.
    expect(real).toContain("--bundle");
    expect(real).not.toContain("--outputs");
    expect(real).toContain(`--detail ${phase2AttemptMarker("key")}`);
    expect(calls.every((line) => !/api[_-]?key|token|secret/i.test(line))).toBe(true);
  });

  test("a changed downloaded tree fails verification", async () => {
    const ws = workspace();
    const run = scripted([], (argv) => {
      if (argv.includes("download")) {
        const target = argv[argv.indexOf("--output-dir") + 1];
        cpSync(ws.sourceDir, target, { recursive: true });
        writeFileSync(join(target, "agent.json"), '{"import_path":"other:Agent"}\n');
      }
    });
    const platform = new CliPhase2Platform({ ...ws, run });
    const localDigest = await platform.localTreeDigest(REV);
    const source = await platform.createSource({ revision: REV, treeDigest: localDigest });
    const verified = await platform.verifyDownloadedTree({ datasetId: source.datasetId, version: "1", treeDigest: localDigest });
    expect(verified.ok).toBe(false);
  });

  test("an unreadable submit response is ambiguous, never a fabricated receipt", async () => {
    const ws = workspace();
    mkdirSync(ws.workDir, { recursive: true });
    writeFileSync(join(ws.workDir, "playground-arm.zip"), "bundle");
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update("bundle").digest("hex");
    const run = scripted([], (argv) => argv[0] === "playground" && argv[1] === "submit" && !argv.includes("--dry-run") ? { code: 1, stderr: "connection reset" } : {});
    const platform = new CliPhase2Platform({ ...ws, run });
    await expect(platform.submit({ revisionId: "rev-x", bundleDigest: digest, idempotencyKey: "k" })).rejects.toThrow(Phase2AmbiguousSubmitError);
    await expect(platform.submit({ revisionId: "rev-x", bundleDigest: "stale", idempotencyKey: "k" })).rejects.toThrow("validated bytes");
  });

  test("lost receipts recover only through one exact own-attempt marker match", async () => {
    const ws = workspace();
    const marker = phase2AttemptMarker("key");
    const withAttempts = (attempts: Record<string, unknown>[]) => scripted([], (argv) => argv[0] === "playground" && argv[1] === "attempt" ? { stdout: JSON.stringify({ attempts, next_cursor: null }) } : {});
    const found = await new CliPhase2Platform({ ...ws, run: withAttempts([{ id: 62146, challengeId: PHASE2_CHALLENGE_ID, detail: marker }]) }).findAttempt("key");
    expect(found).toEqual({ attemptId: "62146" });
    expect(await new CliPhase2Platform({ ...ws, run: withAttempts([]) }).findAttempt("key")).toBeNull();
    expect(await new CliPhase2Platform({ ...ws, run: withAttempts([{ id: 1, detail: marker }, { id: 2, detail: marker }]) }).findAttempt("key")).toBeNull();
    expect(await new CliPhase2Platform({ ...ws, run: withAttempts([{ id: 1, challengeId: "other", detail: marker }]) }).findAttempt("key")).toBeNull();
    expect(await new CliPhase2Platform({ ...ws, run: withAttempts([{ id: 1, detail: "other-marker" }]) }).findAttempt("key")).toBeNull();
  });

  test("real attempt status ingests the official summary, preserving a graded zero", async () => {
    const ws = workspace();
    const payload = {
      id: 62146,
      challengeId: PHASE2_CHALLENGE_ID,
      execStatus: "completed",
      outcome: "failed",
      resultsJson: {
        harbor_reward: 0,
        harness2_eval_status: "succeeded",
        harness2_raw_result: { score_complete: true, score_status: "complete", cost: 0, tasks: [{ hidden:true }] },
      },
    };
    const run = scripted([], (argv) => argv[0] === "playground" && argv[1] === "status" ? { stdout: JSON.stringify(payload) } : {});
    const platform = new CliPhase2Platform({ ...ws, run });
    const status = await platform.attemptStatus("62146");
    expect(status.state).toBe("scored");
    expect(status.score).toBe(0);
    expect(status.cost).toBe(0);
    expect(JSON.stringify(status)).not.toContain("hidden");
    await expect(platform.attemptStatus("99999")).rejects.toThrow("does not match");
  });
});

test("recover a lost receipt with a unique detail from the user's paginated attempt statuses", async () => {
  const {phase2AttemptMarker} = await import("./phase2-cli-platform");
  const marker = phase2AttemptMarker("our-key");
  let duplicate = false;
  const run = scripted([], argv => {
    if (argv[1] === "attempt") {
      const second = argv.includes("--cursor");
      return {stdout:JSON.stringify({attempts:[{id:second ? 2 : 1, challenge_id:PHASE2_CHALLENGE_ID}], next_cursor:second ? null : "p2"})};
    }
    const id = argv.at(-1);
    return {stdout:JSON.stringify({id, challengeId:PHASE2_CHALLENGE_ID, detail:id === "2" || duplicate ? marker : "other"})};
  });
  const platform = new CliPhase2Platform({...workspace(),run});
  expect(await platform.findAttempt("our-key")).toEqual({attemptId:"2"});
  duplicate = true;
  expect(await platform.findAttempt("our-key")).toBeNull();
});
