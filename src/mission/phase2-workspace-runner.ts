/**
 * Production research hook for a Phase 2 tick (#208). Drives the
 * coordinator-provided workspace evaluator. A Pi-managed campaign already
 * has a single writer; its tick reads that handoff instead. Legacy contract:
 *
 *   python3 local/evaluate_candidate.py --propose PARENT_TREE FEEDBACK_JSON NEW_TREE
 *   python3 local/evaluate_candidate.py CANDIDATE TASK_ID NEW_RESULT_DIR
 *
 * The result carries sourceDigest, score, executionExit and costCNY. Both
 * commands charge the existing S1 meter exclusively, so the evidence is
 * recorded with `externalBooking: true` — never a second Phase2SpendEntry.
 * The proposal feedback is the researcher view: no withheld scores, no
 * credentials, no release internals.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Phase2Error, type Phase2EvidenceKind } from "../competition/phase2-playground";
import { runPhase2Command, type Phase2CliRunner } from "../competition/phase2-cli-platform";
import type { Phase2Research } from "./phase2-research";

export interface Phase2WorkspaceRunnerOptions {
  readonly workspaceDir: string;
  readonly taskId: string;
  /** Parent source tree before any nominee exists (e.g. "evok-agent"). */
  readonly baseTree?: string;
  /** Which local evidence channel this tick measures. Default screening. */
  readonly kind?: Extract<Phase2EvidenceKind, "screening" | "withheld-validation" | "noisy-repeat">;
  readonly python?: string;
  readonly run?: Phase2CliRunner;
}

interface WorkspaceEvalResult {
  readonly sourceDigest: string;
  readonly executionExit: number;
  readonly score?: number;
  readonly costCNY?: number;
}

function parseEvalResult(resultDir: string, stdout: string): WorkspaceEvalResult {
  const file = join(resultDir, "result.json");
  const text = existsSync(file) ? readFileSync(file, "utf8") : stdout;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Phase2Error(`workspace evaluator produced no JSON result in ${file} or stdout`);
  }
  const body = parsed as Partial<WorkspaceEvalResult>;
  if (typeof body.sourceDigest !== "string" || body.sourceDigest.trim() === "") {
    throw new Phase2Error("workspace evaluator result is missing sourceDigest");
  }
  if (typeof body.executionExit !== "number") throw new Phase2Error("workspace evaluator result is missing executionExit");
  if (body.score !== undefined && !Number.isFinite(body.score)) throw new Phase2Error("workspace evaluator score must be finite");
  return body as WorkspaceEvalResult;
}

export function createPhase2WorkspaceRunner(options: Phase2WorkspaceRunnerOptions) {
  const run = options.run ?? runPhase2Command;
  const python = options.python ?? "python3";
  const script = join(options.workspaceDir, "local", "evaluate_candidate.py");
  const handoff = join(options.workspaceDir, "scripts", "pi_campaign_work.py");
  if (existsSync(handoff)) {
    return async (): Promise<Record<string, unknown>> => {
      const status = await run([python, handoff, "pending"]);
      if (status.code !== 0) throw new Phase2Error("could not read Pi campaign handoff: " + status.stderr.trim().slice(0, 300));
      return {owner: "pi-main-session", pending: JSON.parse(status.stdout)};
    };
  }
  return async (research: Phase2Research): Promise<Record<string, unknown>> => {
    const view = research.directorView();
    const parent = view.nomineeId ? research.getRevision(view.nomineeId) : null;
    const parentTree = parent?.change.tree ?? options.baseTree;
    if (typeof parentTree !== "string" || parentTree.trim() === "") {
      throw new Phase2Error("no parent source tree: pass --base-tree (or nominate a revision that carries change.tree)");
    }
    const stamp = `${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
    const workDir = join(options.workspaceDir, ".phase2-research", stamp);
    mkdirSync(workDir, { recursive: true });
    const feedbackPath = join(workDir, "feedback.json");
    const newTree = join(workDir, "tree");
    const resultDir = join(workDir, "result");
    writeFileSync(feedbackPath, `${JSON.stringify(research.researcherView(), null, 2)}\n`);

    const proposed = await run([python, script, "--propose", resolve(options.workspaceDir, parentTree), feedbackPath, newTree]);
    if (proposed.code !== 0) {
      throw new Phase2Error(`workspace proposal failed (exit ${proposed.code}): ${(proposed.stderr || proposed.stdout).trim().slice(0, 300)}`);
    }
    const evaluated = await run([python, script, newTree, options.taskId, resultDir]);
    const result = parseEvalResult(resultDir, evaluated.stdout);
    const revision = research.proposeRevision({
      summary: `workspace candidate ${stamp} on ${options.taskId}`,
      change: {
        tree: relative(options.workspaceDir, newTree),
        sourceDigest: result.sourceDigest,
        parent: parent?.id ?? null,
        taskId: options.taskId,
      },
    });
    research.recordEvidence(revision.id, {
      kind: options.kind ?? "screening",
      ...(result.executionExit === 0 && typeof result.score === "number" ? { score: result.score } : {}),
      passed: result.executionExit === 0,
      cost: result.costCNY ?? 0,
      externalBooking: true,
      ref: resultDir,
      note: "S1-metered workspace evaluation; cost booked in the S1 ledger, not charged twice",
    });
    return {
      revisionId: revision.id,
      executionExit: result.executionExit,
      ...(result.score !== undefined ? { score: result.score } : {}),
      costCNY: result.costCNY ?? 0,
      resultDir,
    };
  };
}
