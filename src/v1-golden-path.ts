/**
 * V1-G self-serve golden-path glue (control-plane orchestration seam).
 *
 * propose/claim → HypothesisLedger → T48-mapped evidence → optional Kill-test
 * hang → local promotion *consideration* → reviewable events.
 *
 * Two-step:
 *   1. `assembleV1GoldenPath({ statement })` — setup + attach existing hang hook
 *   2. `attachGoldenPathHang(setup)` — run the hang against that ledger
 * One-shot: `runGoldenPath({ statement })` (hang on unless `{ hang: false }`).
 *
 * How to run one claim:
 *   const path = await runGoldenPath({ statement: "hold-out must not move" });
 * Review fields (ledger stays authority; `summary` is not):
 *   path.hypothesisId / path.planId / path.evidenceRefs
 *   path.timeline — `hypothesis.created`, `kill_test.planned`,
 *                   `kill_test.finished` (if hang ran), `hypothesis.status_changed`
 *   path.summary.passed === true  → hang ok; local promotion may be considered
 *   path.summary.blocked === true → hang/gates blocked (fail / inconclusive / unmapped)
 *
 * Default is the L2 mock (zero network). Live only via `{ live: true }` + key
 * fail-closed. `EVOK_NEWAPI_LIVE` alone does not open this product path.
 *
 * Reuses `assembleLlmCompArmSetup` / `assembleOuterMinPath` / existing hang.
 * Does not change T48 / hang three-state / Broker sim, weld #40, change
 * default parent-selection A (tree+fixed_uct), submit a contest, or schedule
 * MissionDirector / ResearchWeave.
 */
import {
  runKillTestHang,
  type KillTestHangDecision,
  type KillTestHangInput,
} from "./kill-test-hang";
import {
  killTestOutcomeIsPass,
  type HypothesisEvent,
  type HypothesisEventType,
  type HypothesisStatus,
  type T48MappedRef,
} from "./hypothesis-ledger";
import {
  assembleLlmCompArmSetup,
  type AssembleLlmCompArmSetupInput,
  type LlmCompArmSetup,
} from "./llm-propose-outer-min";
import { OUTER_MIN_KILL_EVIDENCE_ID } from "./outer-min-path";

export const V1_GOLDEN_HYPOTHESIS_ID = "h-v1-golden";
export const V1_GOLDEN_PLAN_ID = "kt-v1-golden";

const DEFAULT_STATEMENT =
  "v1 golden path: mapped proposal artifact and diagnostic search-space refs";

const TIMELINE_TYPES: ReadonlySet<HypothesisEventType> = new Set([
  "hypothesis.created",
  "hypothesis.status_changed",
  "kill_test.planned",
  "kill_test.finished",
]);

export interface AssembleV1GoldenPathInput extends AssembleLlmCompArmSetupInput {
  /** When used with `runGoldenPath`, omit / true runs hang; `false` is setup-only. */
  readonly hang?: boolean;
}

export interface GoldenPathTimelineEntry {
  readonly type: HypothesisEventType;
  readonly sequence: number;
}

export interface GoldenPathSummary {
  /** Non-authoritative review aid. Ledger events / `state()` are authority. */
  readonly authoritative: false;
  readonly status: HypothesisStatus;
  readonly hangRun: boolean;
  readonly passed: boolean;
  readonly blocked: boolean;
  readonly objections: readonly string[];
}

export interface GoldenPathReview {
  readonly hypothesisId: string;
  readonly planId: string;
  readonly evidenceRefs: readonly T48MappedRef[];
  readonly timeline: readonly GoldenPathTimelineEntry[];
  readonly events: readonly HypothesisEvent[];
  readonly summary: GoldenPathSummary;
}

export interface V1GoldenPath extends GoldenPathReview {
  readonly arm: LlmCompArmSetup;
  readonly killTestHang: LlmCompArmSetup["killTestHang"];
  readonly hang?: KillTestHangDecision;
}

function hangInput(
  arm: LlmCompArmSetup,
  input: AssembleV1GoldenPathInput,
): KillTestHangInput {
  return {
    outcome: input.outcome ?? "pass",
    evidenceRefs: input.killEvidenceRefs ?? [OUTER_MIN_KILL_EVIDENCE_ID],
    catalog: arm.setup.fixture.catalog,
    ledger: arm.setup.ledger,
    planId: arm.setup.planId,
    ...(input.resultId === undefined ? {} : { resultId: input.resultId }),
    ...(input.contracts === undefined ? {} : { contracts: input.contracts }),
    ...(input.methodologyEvidence === undefined ? {} : { methodologyEvidence: input.methodologyEvidence }),
    ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
  };
}

function timelineOf(events: readonly HypothesisEvent[]): readonly GoldenPathTimelineEntry[] {
  return Object.freeze(
    events
      .filter((event) => TIMELINE_TYPES.has(event.type))
      .map((event) => Object.freeze({ type: event.type, sequence: event.sequence })),
  );
}

/**
 * Non-authoritative review projection. Use ledger `events()` / `state()` for
 * authority; `summary.passed` / `summary.blocked` only tell an operator whether
 * local promotion may be considered.
 */
export function projectGoldenPathReview(
  path: Pick<V1GoldenPath, "arm" | "hang">,
): GoldenPathReview {
  const hypothesisId = path.arm.hypothesisId;
  const planId = path.arm.planId;
  const ledger = path.arm.setup.ledger;
  const events = ledger.events();
  const status = ledger.state().hypotheses[hypothesisId]?.status ?? "open";
  const recorded = ledger.resultFor(planId);
  const hangRun = path.hang !== undefined || recorded !== undefined;
  const passed = path.hang !== undefined
    ? path.hang.ok === true
    : recorded !== undefined && killTestOutcomeIsPass(recorded.outcome);
  const blocked = hangRun && !passed;
  return Object.freeze({
    hypothesisId,
    planId,
    evidenceRefs: path.arm.evidenceRefs,
    timeline: timelineOf(events),
    events,
    summary: Object.freeze({
      authoritative: false,
      status,
      hangRun,
      passed,
      blocked,
      objections: Object.freeze([...(path.hang?.objections ?? [])]),
    }),
  }) as GoldenPathReview;
}

function pack(arm: LlmCompArmSetup, hang?: KillTestHangDecision): V1GoldenPath {
  const review = projectGoldenPathReview({ arm, hang });
  return Object.freeze({
    ...review,
    arm,
    killTestHang: arm.killTestHang,
    ...(hang === undefined ? {} : { hang }),
  }) as V1GoldenPath;
}

/**
 * Setup step: propose/claim → T48 map → L2 assemble (which calls
 * `assembleOuterMinPath` / `runOuterMinPathSetup`). Attaches the existing
 * hang hook; does not run hang.
 */
export async function assembleV1GoldenPath(
  input: AssembleV1GoldenPathInput = {},
): Promise<V1GoldenPath> {
  const { hang: _hang, ...setupInput } = input;
  const arm = await assembleLlmCompArmSetup({
    ...setupInput,
    hypothesisId: input.hypothesisId ?? V1_GOLDEN_HYPOTHESIS_ID,
    planId: input.planId ?? V1_GOLDEN_PLAN_ID,
    statement: input.statement ?? DEFAULT_STATEMENT,
  });
  return pack(arm);
}

/** Run the already-attached hang against this assembly's ledger. */
export function attachGoldenPathHang(
  path: V1GoldenPath,
  input: AssembleV1GoldenPathInput = {},
): V1GoldenPath {
  return pack(path.arm, runKillTestHang(hangInput(path.arm, input)));
}

/**
 * One-shot golden path. Hang runs unless `{ hang: false }`.
 * Live stays off unless `{ live: true }`.
 */
export async function runGoldenPath(
  input: AssembleV1GoldenPathInput = {},
): Promise<V1GoldenPath> {
  const setup = await assembleV1GoldenPath(input);
  if (input.hang === false) return setup;
  return attachGoldenPathHang(setup, input);
}
