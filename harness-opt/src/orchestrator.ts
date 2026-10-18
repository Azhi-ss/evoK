import { writeRoleFile, writeRoleJson } from "./artifacts";
import { LineageStore } from "./lineage";
import { evaluateEvidenceGate, type EvidenceGateInput, type EvidenceGateResult, type TtsStatus } from "./modules/evidence-gate";
import { buildInnovatorInput, applyPatch, validatePatch, type GapFinderInput, type InnovatorInput } from "./modules/proposer";
import type { HeldOutVault } from "./modules/probe";
import { runDev, type RunObservation, type SandboxExec } from "./modules/runner";
import {
  DEFAULT_SELECTOR_ID,
  DEFAULT_SELECTOR_SEARCH,
  DEFAULT_STAGED_THRESHOLDS,
  getPromotionCriterion,
  type PromotionDecision,
  type SelectorSearchConfig,
  type StagedThresholds,
} from "./modules/selector";
import { RecordingScheduler, type RoleScheduler } from "./pi/subagents-port";
import type { RoleId } from "./roles";
import type { GapReport, HarnessConfig, LineageNode, PatchProposal, Scorecard, TaskRef, TraceRecord } from "./types";

/**
 * Deterministic orchestrator (PRD §5.3). This file does not call a model.
 * It advances the fixed machine, writes `run_state.json`, `schedule.log`,
 * and `history/`, and refuses to invent a patch or a score.
 *
 * Held-out stays in the vault until the evidence gate. The dev selector
 * does not see it. PRD §5.2 also mentions a held-out regression check at
 * promotion time; this skeleton follows the later instruction and keeps
 * that read on the submission gate.
 * TODO(PRD §5.2 / evolution-selector): if promotion-time held-out smoke
 * returns, it belongs on Reviewer, still not on Gap Finder or Innovator.
 */

export interface ReviewerInput {
  readonly decision: PromotionDecision;
  readonly baseline: Scorecard;
  readonly observation: RunObservation;
}

export interface ReviewVerdict {
  readonly accept: boolean;
  readonly reason: string;
  readonly criterionId: string;
}

export interface EvidencePack {
  readonly modelId: string;
  readonly config: HarnessConfig;
  readonly devScore: number;
  readonly tokens: number;
  readonly changeNote: string;
  readonly traceIndex: readonly string[];
  readonly tts: TtsStatus;
  readonly heldOutScore: number | null;
}

export interface SubmitReceipt {
  readonly ok: boolean;
  readonly mode: "dry-run" | "live";
  readonly submitted: boolean;
  readonly detail: string;
}

export interface RoundHandlers {
  readonly gapFinder: (input: GapFinderInput) => GapReport;
  readonly innovator: (input: InnovatorInput) => PatchProposal;
  readonly reviewer: (input: ReviewerInput) => ReviewVerdict;
  readonly reportWriter: (input: { readonly verdict: ReviewVerdict; readonly observation: RunObservation; readonly config: HarnessConfig; readonly tts: TtsStatus; readonly heldOutScore: number | null }) => EvidencePack;
  readonly submitter: (input: { readonly pack: EvidencePack; readonly live: boolean }) => SubmitReceipt;
}

export interface RoundRequest {
  readonly root: string;
  readonly incumbent: HarnessConfig;
  readonly baseline: Scorecard;
  readonly priorTraces: readonly TraceRecord[];
  readonly devTasks: readonly TaskRef[];
  readonly heldOut: HeldOutVault;
  readonly exec: SandboxExec;
  readonly handlers: RoundHandlers;
  readonly scheduler?: RoleScheduler;
  readonly selectorId?: string;
  readonly thresholds?: StagedThresholds;
  readonly selectorSearch?: SelectorSearchConfig;
  readonly tts?: TtsStatus;
  readonly heldOutScore?: number | null;
  readonly heldOutFloor?: number;
  readonly submitCountToday?: number;
  readonly maxSubmitsPerDay?: number;
  readonly tokenBudget?: number;
  readonly liveSubmit?: boolean;
  readonly parentId?: string | null;
  readonly consultEvok?: EvidenceGateInput["consultEvok"];
  readonly ids?: () => string;
}

export interface RoundResult {
  readonly phases: readonly RoleId[];
  readonly accepted: boolean;
  readonly evidence: EvidenceGateResult | null;
  readonly receipt: SubmitReceipt | null;
  readonly stoppedReason: string;
  readonly node: LineageNode | null;
}

export function runRound(request: RoundRequest): RoundResult {
  const scheduler = request.scheduler ?? new RecordingScheduler();
  const phases: RoleId[] = [];
  const note = (role: RoleId) => {
    phases.push(role);
    writeRoleFile(request.root, "orchestrator", "schedule.log", phases.map((phase) => phase).join("\n"));
  };
  const ids = request.ids ?? createIds();
  const lineage = LineageStore.open(request.root);
  lineage.load();
  const tts = request.tts ?? "not-run";
  const heldOutScore = request.heldOutScore ?? null;
  const liveSubmit = request.liveSubmit === true;

  writeRoleJson(request.root, "orchestrator", "run_state.json", {
    phase: "start",
    incumbentId: request.incumbent.id,
    modelId: request.incumbent.modelId,
    selectorId: request.selectorId ?? DEFAULT_SELECTOR_ID,
    liveSubmit,
    heldOutSealed: request.heldOut.size,
  });

  const gaps = scheduler.schedule("gap-finder", "read traces", () => {
    note("gap-finder");
    return request.handlers.gapFinder({ traces: request.priorTraces });
  });
  writeRoleJson(request.root, "gap-finder", "gaps.json", gaps);
  writeRoleFile(
    request.root,
    "gap-finder",
    "gaps.md",
    gaps.gaps.map((gap) => `- ${gap.id}: ${gap.failureClass} — ${gap.summary}`).join("\n") || "_no gaps_",
  );

  const innovatorInput = buildInnovatorInput({
    config: request.incumbent,
    gaps,
    history: lineage.all().map((node) => ({ id: node.id, status: node.status, reason: node.reason })),
    traces: request.priorTraces,
  });
  let patch: PatchProposal;
  try {
    patch = scheduler.schedule("innovator", "propose patch", () => {
      note("innovator");
      return request.handlers.innovator(innovatorInput);
    });
    validatePatch(patch);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const node = reject(lineage, ids, request, null, reason, null);
    return finish(request, phases, false, null, null, reason, node);
  }
  writeRoleJson(request.root, "innovator", "patch.json", patch);
  const candidate = applyPatch(request.incumbent, patch);

  let observation: RunObservation;
  try {
    observation = scheduler.schedule("runner", "run dev", () => {
      note("runner");
      return runDev({ config: candidate, tasks: request.devTasks, exec: request.exec });
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const node = reject(lineage, ids, request, candidate, reason, null);
    return finish(request, phases, false, null, null, reason, node);
  }
  observation.traces.forEach((trace, index) => {
    writeRoleJson(request.root, "runner", `traces/${trace.taskId}-${index}.json`, trace);
  });

  const criterion = getPromotionCriterion(request.selectorId ?? DEFAULT_SELECTOR_ID);
  const decision = criterion.decide({
    parent: request.baseline,
    candidate: observation.score,
    thresholds: request.thresholds ?? DEFAULT_STAGED_THRESHOLDS,
    genes: candidate.search,
    search: request.selectorSearch ?? DEFAULT_SELECTOR_SEARCH,
  });
  const verdict = scheduler.schedule("reviewer", "dev gate", () => {
    note("reviewer");
    return request.handlers.reviewer({ decision, baseline: request.baseline, observation });
  });
  writeRoleJson(request.root, "reviewer", "review.json", verdict);

  if (!verdict.accept || !observation.qualified) {
    const reason = verdict.accept ? observation.reason : verdict.reason;
    const node = reject(lineage, ids, request, candidate, reason, verdict.criterionId);
    return finish(request, phases, false, null, null, reason, node);
  }

  const pack = scheduler.schedule("report-writer", "evidence pack", () => {
    note("report-writer");
    return request.handlers.reportWriter({
      verdict,
      observation,
      config: candidate,
      tts,
      heldOutScore,
    });
  });
  if (pack.devScore !== observation.score.devScore || pack.tokens !== observation.score.tokens) {
    throw new Error("report writer changed the measured score");
  }
  writeRoleJson(request.root, "report-writer", "evidence_pack/pack.json", pack);
  writeRoleFile(request.root, "report-writer", "evidence_pack/change-note.md", pack.changeNote);
  writeRoleJson(request.root, "orchestrator", "history/latest.json", {
    id: candidate.id,
    config: candidate,
    devScore: observation.score.devScore,
    tokens: observation.score.tokens,
    traces: observation.traces.map((trace) => trace.taskId),
  });

  const evidence = evaluateEvidenceGate({
    modelId: candidate.modelId,
    heldOutScore,
    heldOutFloor: request.heldOutFloor ?? 0,
    tracePackComplete: observation.traces.length > 0 && pack.traceIndex.length > 0,
    changeNotePresent: pack.changeNote.trim() !== "",
    tts,
    submitCountToday: request.submitCountToday ?? 0,
    maxSubmitsPerDay: request.maxSubmitsPerDay ?? 1,
    tokensSpent: observation.score.tokens,
    tokenBudget: request.tokenBudget ?? Number.POSITIVE_INFINITY,
    consultEvok: request.consultEvok,
  });
  writeRoleJson(request.root, "orchestrator", "run_state.json", {
    phase: evidence.ok ? "evidence-green" : "stopped-local-best",
    incumbentId: candidate.id,
    modelId: candidate.modelId,
    selectorId: verdict.criterionId,
    liveSubmit,
    heldOutSealed: request.heldOut.size,
    evidence,
  });

  const node = lineage.append({
    id: ids(),
    parentId: request.parentId ?? null,
    status: "accepted",
    config: candidate,
    devScore: observation.score.devScore,
    tokens: observation.score.tokens,
    reason: verdict.reason,
    criterionId: verdict.criterionId,
  });

  if (!evidence.ok) {
    const failed = evidence.checks.filter((item) => !item.ok).map((item) => item.id);
    return finish(request, phases, true, evidence, null, `evidence gate refused: ${failed.join(",")}`, node);
  }

  const receipt = scheduler.schedule("submitter", liveSubmit ? "live submit" : "dry-run", () => {
    note("submitter");
    return request.handlers.submitter({ pack, live: liveSubmit });
  });
  writeRoleJson(request.root, "submitter", "submit-receipt.json", receipt);
  if (!receipt.ok) {
    return finish(request, phases, true, evidence, receipt, `submitter refused: ${receipt.detail}`, node);
  }
  return finish(
    request,
    phases,
    true,
    evidence,
    receipt,
    liveSubmit ? "submitted" : "dry-run only; live submit is off",
    node,
  );
}

function reject(
  lineage: LineageStore,
  ids: () => string,
  request: RoundRequest,
  config: HarnessConfig | null,
  reason: string,
  criterionId: string | null,
): LineageNode {
  return lineage.append({
    id: ids(),
    parentId: request.parentId ?? null,
    status: "rejected",
    config: config ?? request.incumbent,
    devScore: null,
    tokens: null,
    reason,
    criterionId,
  });
}

function finish(
  request: RoundRequest,
  phases: readonly RoleId[],
  accepted: boolean,
  evidence: EvidenceGateResult | null,
  receipt: SubmitReceipt | null,
  stoppedReason: string,
  node: LineageNode | null,
): RoundResult {
  writeRoleJson(request.root, "orchestrator", "run_state.json", {
    phase: stoppedReason,
    incumbentId: node?.config.id ?? request.incumbent.id,
    modelId: request.incumbent.modelId,
    accepted,
    stoppedReason,
    heldOutSealed: request.heldOut.size,
    evidence,
  });
  return { phases, accepted, evidence, receipt, stoppedReason, node };
}

function createIds(): () => string {
  let n = 0;
  return () => `n${n++}`;
}
