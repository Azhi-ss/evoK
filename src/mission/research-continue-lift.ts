/**
 * One authorized suite-metric continue circle (ET-RSI-LIFT / #174).
 *
 * Called from continueResearch after the existing authority / baseline /
 * Budget guards. Search owns the opt-in harness (default `fixed_uct`).
 * Evidence owns the hang. This module does not dispatch a Pi Run, does
 * not thaw External Submission, and does not change Admission / Budget /
 * hang / T48 predicates.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EvaluationContractError } from "../local-file-evaluator";
import {
  createProjectBaselineEvaluator,
  loadProjectEvaluationContract,
} from "../project-evaluator";
import { EvidenceMemory } from "./research-loop";
import { HypothesisLedger, T48MappedCatalog } from "../evidence/hypothesis-ledger";
import { runKillTestHang, type KillTestHangDecision } from "../evidence/kill-test-hang";
import type { KillTestOutcome } from "../evidence/hypothesis-ledger";
import {
  DEFAULT_SUITE_LIFT_TARGET,
  SUITE_LIFT_CIRCLE_ID,
  runSuiteLiftCircle,
  type SuiteLiftPropose,
} from "../search/suite-lift-circle";
import {
  DEFAULT_SEARCH_SELECTION_ID,
  SELECTION_POLICY_40,
} from "../search/search-selection-port";

export type ResearchCircleVerdict = "lifted" | "killed";

export interface ResearchLiftCircleView {
  readonly kind: "suite-lift";
  readonly verdict: ResearchCircleVerdict;
  readonly baselineScore?: number;
  readonly measuredScore?: number;
  readonly liftTarget: number;
  readonly evidencePath: string;
  readonly promotionBlocked: boolean;
  readonly hangOutcome: KillTestOutcome;
  readonly selectionId: typeof DEFAULT_SEARCH_SELECTION_ID;
  readonly selectionPolicy40: typeof SELECTION_POLICY_40;
  readonly reason: string;
}

export type ResearchLiftHang = (args: {
  readonly outcome: KillTestOutcome;
  readonly evidenceRefs: readonly string[];
  readonly catalog: T48MappedCatalog;
  readonly artifacts: readonly { readonly artifactId: string }[];
}) => KillTestHangDecision;

export interface ResearchLiftOptions {
  readonly propose?: SuiteLiftPropose;
  readonly hang?: ResearchLiftHang;
  readonly liftTarget?: number;
}

export function researchContinueEvidencePath(
  projectRoot: string,
  missionId: string,
  experimentId: string,
): string {
  return join(projectRoot, "evidence", "research-continue", missionId, `${experimentId}.json`);
}

export function circleFromLiftExperiment(entry: {
  readonly source: string;
  readonly verdict?: ResearchCircleVerdict;
  readonly measuredScore?: number;
  readonly baselineScore?: number;
  readonly liftTarget?: number;
  readonly evidencePath?: string;
  readonly promotionBlocked?: boolean;
  readonly hangOutcome?: KillTestOutcome;
  readonly selectionId?: typeof DEFAULT_SEARCH_SELECTION_ID;
  readonly selectionPolicy40?: typeof SELECTION_POLICY_40;
  readonly reason?: string;
}): ResearchLiftCircleView | undefined {
  if (entry.source !== "suite-lift") return undefined;
  if (entry.verdict !== "lifted" && entry.verdict !== "killed") return undefined;
  if (typeof entry.evidencePath !== "string" || entry.evidencePath === "") return undefined;
  if (typeof entry.liftTarget !== "number" || !Number.isFinite(entry.liftTarget)) return undefined;
  if (entry.hangOutcome !== "pass" && entry.hangOutcome !== "fail" && entry.hangOutcome !== "inconclusive") {
    return undefined;
  }
  if (typeof entry.promotionBlocked !== "boolean") return undefined;
  return {
    kind: "suite-lift",
    verdict: entry.verdict,
    ...(typeof entry.baselineScore === "number" && Number.isFinite(entry.baselineScore)
      ? { baselineScore: entry.baselineScore }
      : {}),
    ...(typeof entry.measuredScore === "number" && Number.isFinite(entry.measuredScore)
      ? { measuredScore: entry.measuredScore }
      : {}),
    liftTarget: entry.liftTarget,
    evidencePath: entry.evidencePath,
    promotionBlocked: entry.promotionBlocked,
    hangOutcome: entry.hangOutcome,
    selectionId: entry.selectionId ?? DEFAULT_SEARCH_SELECTION_ID,
    selectionPolicy40: entry.selectionPolicy40 ?? SELECTION_POLICY_40,
    reason: typeof entry.reason === "string" && entry.reason !== "" ? entry.reason : entry.verdict,
  };
}

async function loadBaselineFiles(projectRoot: string): Promise<Readonly<Record<string, string>>> {
  try {
    return { "src/solve.js": await readFile(join(projectRoot, "src", "solve.js"), "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function trySuiteLiftCircle(input: {
  readonly projectRoot: string;
  readonly missionId: string;
  readonly experimentId: string;
  readonly at: string;
  readonly objective?: string;
  readonly baseline: { readonly runId: string; readonly ok: boolean; readonly score?: number };
  readonly lift?: ResearchLiftOptions;
}): Promise<ResearchLiftCircleView | undefined> {
  let loaded;
  try {
    loaded = await loadProjectEvaluationContract(input.projectRoot);
  } catch (error) {
    if (error instanceof EvaluationContractError) return undefined;
    throw error;
  }
  if (loaded.kind !== "suite-metric") return undefined;

  const liftTarget = input.lift?.liftTarget ?? DEFAULT_SUITE_LIFT_TARGET;
  const baselineFiles = await loadBaselineFiles(input.projectRoot);
  const circle = runSuiteLiftCircle({
    baselineFiles,
    baselineScore: input.baseline.score,
    liftTarget,
    ...(input.lift?.propose ? { propose: input.lift.propose } : {}),
  });

  const evaluator = await createProjectBaselineEvaluator(input.projectRoot);
  const measurement = await evaluator.evaluate(circle.proposal.files, {
    missionId: input.missionId,
    runId: input.experimentId,
    snapshotDigest: `${SUITE_LIFT_CIRCLE_ID}:${input.experimentId}`,
    contract: {
      objective: input.objective ?? input.missionId,
      expectedOutputs: ["src/solve.js"],
      evaluationMethod: "suite-metric",
      metric: "pass_rate",
      hardRules: [],
    },
  });

  const baselineScore = input.baseline.score;
  const measuredScore = measurement.score;
  const rose = typeof measuredScore === "number" && typeof baselineScore === "number" && measuredScore > baselineScore;
  const reached = typeof measuredScore === "number" && measuredScore >= liftTarget;
  const hangOutcome: KillTestOutcome = !measurement.ok || measuredScore === undefined
    ? "inconclusive"
    : rose && reached
      ? "pass"
      : "fail";

  const evidenceId = `${input.experimentId}-suite`;
  const baselineEvidenceId = `${input.experimentId}-baseline`;
  const artifactId = `${input.experimentId}-suite-report`;
  const memory = new EvidenceMemory();
  memory.addEvidence({
    id: baselineEvidenceId,
    kind: "observation",
    summary: `recorded baseline pass_rate ${baselineScore ?? "unknown"}`,
    verified: true,
  });
  memory.addEvidence({
    id: evidenceId,
    kind: "experiment",
    summary: measurement.ok
      ? `independent suite-metric measured pass_rate ${measuredScore}`
      : `independent suite-metric did not yield a usable pass_rate`,
    verified: true,
    refs: [baselineEvidenceId],
  });
  const catalog = T48MappedCatalog.fromMemory(memory, [{ artifactId }]);
  const hypothesisId = `${input.experimentId}-h`;
  const planId = `${input.experimentId}-kt`;
  const ledger = new HypothesisLedger({ catalog });
  ledger.createHypothesis({
    hypothesisId,
    statement: "local helper-completion raises the independent suite-metric pass_rate to the lift target without a self-score",
    evidenceRefs: [baselineEvidenceId],
  });
  ledger.planKillTest({
    planId,
    hypothesisId,
    predicate: "independent suite-metric pass_rate must rise above the recorded baseline and reach the lift target; T48-mapped suite evidence is required",
    evidenceRefs: [baselineEvidenceId],
  });
  const hangArgs = {
    outcome: hangOutcome,
    evidenceRefs: [evidenceId] as const,
    catalog,
    artifacts: [{ artifactId }],
    ledger,
    planId,
    resultId: `${input.experimentId}-ktr`,
  };
  const hang = input.lift?.hang
    ? input.lift.hang(hangArgs)
    : runKillTestHang(hangArgs);

  const hangOk = hang.ok && !hang.blocksPromotion;
  const lifted = measurement.ok && rose && reached && hangOk;
  const verdict: ResearchCircleVerdict = lifted ? "lifted" : "killed";
  const reason = lifted
    ? "measured suite-metric pass_rate rose to the lift target"
    : hang.blocksPromotion || !hang.ok
      ? (hang.objections[0] ?? "promotion hang blocked the candidate")
      : "measured pass_rate did not rise to the lift target";

  const evidencePath = researchContinueEvidencePath(input.projectRoot, input.missionId, input.experimentId);
  await mkdir(dirname(evidencePath), { recursive: true });
  const archive = {
    schemaVersion: 1,
    kind: "suite-lift",
    circleId: SUITE_LIFT_CIRCLE_ID,
    missionId: input.missionId,
    experimentId: input.experimentId,
    at: input.at,
    verdict,
    reason,
    baselineScore,
    measuredScore,
    liftTarget,
    facts: measurement.facts ?? [],
    hang: {
      ok: hang.ok,
      outcome: hang.outcome,
      blocksPromotion: hang.blocksPromotion,
      blocksBroker: hang.blocksBroker,
      objections: hang.objections,
    },
    selectionId: DEFAULT_SEARCH_SELECTION_ID,
    selectionPolicy40: SELECTION_POLICY_40,
    submit: "frozen — true External Submission is not authorized",
    admissionUnchanged: true,
    evidenceRefs: [baselineEvidenceId, evidenceId],
    hypothesisId,
    planId,
    ledgerEvents: ledger.events().map((event) => ({ type: event.type, sequence: event.sequence })),
    candidateFiles: circle.proposal.files,
    proposalNote: circle.proposal.note,
    selectedNodeId: circle.selectedNodeId,
  };
  await writeFile(evidencePath, `${JSON.stringify(archive, null, 2)}\n`);

  return {
    kind: "suite-lift",
    verdict,
    ...(typeof baselineScore === "number" && Number.isFinite(baselineScore) ? { baselineScore } : {}),
    ...(typeof measuredScore === "number" && Number.isFinite(measuredScore) ? { measuredScore } : {}),
    liftTarget,
    evidencePath,
    promotionBlocked: hang.blocksPromotion,
    hangOutcome: hang.outcome,
    selectionId: DEFAULT_SEARCH_SELECTION_ID,
    selectionPolicy40: SELECTION_POLICY_40,
    reason,
  };
}
