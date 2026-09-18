/**
 * K1 before-promotion kill-test hang, K2-wired to the H2 HypothesisLedger.
 *
 * Stacks on the SuccessAuditor family (same `before-promotion` trigger) and
 * does not replace it. Runs after T48 `auditMethodology` / `oofEnsembleGate`
 * (those gates sleep when no contract is injected) and before the Broker
 * analog: local promote (`PROMOTED_LOCAL`) and `HumanAcceptanceGate`.
 *
 * When a ledger + planId are supplied, the hang reads `KillTestPlan` and
 * writes `KillTestResult` through H2. It does not invent a second store,
 * skip the hang, or relax T48 / Broker.
 */
import { deepFreeze } from "../security-boundary";
import {
  T48MappedCatalog,
  asKillTestPass,
  killTestOutcomeIsPass,
  type HypothesisLedger,
  type KillTestOutcome,
  type KillTestPlan,
  type KillTestResult,
  type T48MappedRef,
} from "./hypothesis-ledger";
import {
  auditMethodology,
  oofEnsembleGate,
  type MethodologyContracts,
  type MethodologyEvidence,
} from "./methodology";
import type { VerificationContext, VerificationHook, VerificationResult } from "./verification-gates";

const KILL_TEST_OUTCOMES: ReadonlySet<KillTestOutcome> = new Set(["pass", "fail", "inconclusive"]);
const SCALAR_VERDICT_FIELDS = [
  "mmd",
  "mmdScore",
  "sideSlot",
  "side_slot",
  "sideSlotScore",
  "score",
  "nearDup",
  "near_dup",
  "nearDupScore",
  "nearDuplicate",
  "diversity",
  "diversityScore",
] as const;

export interface KillTestHangInput {
  readonly outcome: KillTestOutcome;
  readonly evidenceRefs: readonly unknown[];
  readonly catalog: T48MappedCatalog;
  readonly ledger?: Pick<HypothesisLedger, "state" | "finishKillTest" | "resultFor">;
  readonly planId?: string;
  readonly resultId?: string;
  readonly artifacts?: readonly unknown[];
  readonly contracts?: MethodologyContracts;
  readonly methodologyEvidence?: MethodologyEvidence;
  readonly verdictBasis?: readonly unknown[];
  readonly result?: Pick<KillTestResult, "outcome" | "evidenceRefs">;
}

export interface KillTestHangDecision {
  readonly ok: boolean;
  readonly outcome: KillTestOutcome;
  readonly objections: readonly string[];
  readonly mappedEvidence: readonly T48MappedRef[];
  readonly blocksPromotion: boolean;
  readonly blocksBroker: boolean;
  readonly plan?: KillTestPlan;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNumericString(value: string): boolean {
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim());
}

function isScalarVerdictKey(value: unknown): boolean {
  if (typeof value === "number" && Number.isFinite(value)) return true;
  if (typeof value === "string" && isNumericString(value)) return true;
  if (!isPlainRecord(value)) return false;
  return SCALAR_VERDICT_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function decision(
  outcome: KillTestOutcome,
  objections: readonly string[],
  mappedEvidence: readonly T48MappedRef[] = [],
  plan?: KillTestPlan,
): KillTestHangDecision {
  const blocked = objections.length > 0 || !killTestOutcomeIsPass(outcome);
  return deepFreeze({
    ok: !blocked,
    outcome,
    objections: Object.freeze([...objections]),
    mappedEvidence: Object.freeze([...mappedEvidence]),
    blocksPromotion: blocked,
    blocksBroker: blocked,
    ...(plan === undefined ? {} : { plan }),
  }) as KillTestHangDecision;
}

export function killTestOutcomeBlocksBroker(outcome: KillTestOutcome): boolean {
  if (outcome === "inconclusive") return true;
  return !killTestOutcomeIsPass(outcome);
}

function normalizeOutcome(value: unknown): KillTestOutcome {
  if (typeof value !== "string" || !KILL_TEST_OUTCOMES.has(value as KillTestOutcome)) {
    throw new RangeError(`unknown kill-test outcome: ${String(value)}`);
  }
  return value as KillTestOutcome;
}

function mapEvidence(catalog: T48MappedCatalog, values: readonly unknown[]): T48MappedRef[] | string {
  try {
    return [...catalog.mapAll(values)];
  } catch (error) {
    return error instanceof Error ? error.message : "kill-test evidence_refs must be T48-mapped";
  }
}

function rejectUnmappedArtifacts(catalog: T48MappedCatalog, artifacts: readonly unknown[] | undefined): string | undefined {
  if (artifacts === undefined) return undefined;
  if (!Array.isArray(artifacts)) return "kill-test artifacts must be an array";
  for (const artifact of artifacts) {
    if (isScalarVerdictKey(artifact)) {
      return "artifact lacks T48 mapping; side-slot/MMD/near-dup scalars cannot be a Kill-test verdict";
    }
    const mapped = mapEvidence(catalog, [artifact]);
    if (typeof mapped === "string") return `artifact lacks T48 mapping: ${mapped}`;
    if (mapped.some((ref) => ref.kind !== "artifact")) {
      return "artifact lacks T48 mapping";
    }
  }
  return undefined;
}

function rejectSoleScalarVerdict(values: readonly unknown[], label: string): string | undefined {
  if (values.length === 0) return undefined;
  if (values.every(isScalarVerdictKey)) {
    return `${label} cannot use side-slot/MMD/near-dup/diversity scalars as the sole Kill-test verdict`;
  }
  return undefined;
}

function readKillTestPlan(input: KillTestHangInput): KillTestPlan | string | undefined {
  if (input.ledger === undefined && input.planId === undefined) return undefined;
  if (input.ledger === undefined || typeof input.planId !== "string" || input.planId.trim() === "") {
    return "kill-test hang requires a ledger KillTestPlan";
  }
  const plan = input.ledger.state().plans[input.planId];
  if (!plan) return `unknown kill-test plan: ${input.planId}`;
  return plan;
}

function writeLedgerResult(
  ledger: NonNullable<KillTestHangInput["ledger"]>,
  input: KillTestHangInput,
  plan: KillTestPlan,
  outcome: KillTestOutcome,
  mapped: readonly T48MappedRef[],
): KillTestResult | string {
  if (ledger.resultFor(plan.planId)) {
    return `kill-test plan already has a result: ${plan.planId}`;
  }
  try {
    return ledger.finishKillTest({
      resultId: input.resultId,
      planId: plan.planId,
      outcome,
      evidenceRefs: mapped,
    });
  } catch (error) {
    return error instanceof Error ? error.message : "kill-test hang failed to write KillTestResult";
  }
}

/**
 * Before-promotion hang: T48 methodology/OOF first, then T48-mapped kill-test
 * evidence, then tri-state outcome. Only `pass` may reach the Broker analog.
 * Ledger-bound hangs read KillTestPlan and write KillTestResult through H2.
 */
export function runKillTestHang(input: KillTestHangInput): KillTestHangDecision {
  const outcome = normalizeOutcome(input.result?.outcome ?? input.outcome);
  const evidenceRefs = input.result?.evidenceRefs ?? input.evidenceRefs;
  if (!Array.isArray(evidenceRefs)) {
    return decision(outcome, ["kill-test evidence_refs must be an array"]);
  }

  const methodology = input.methodologyEvidence ?? { splitDigestAgreement: "unknown", oofPresent: false };
  const audit = auditMethodology(methodology, input.contracts);
  const oof = oofEnsembleGate(methodology, input.contracts);
  if (!audit.ok || !oof.ok) {
    return decision(outcome, [...audit.objections, ...oof.objections]);
  }

  const artifactObjection = rejectUnmappedArtifacts(input.catalog, input.artifacts);
  if (artifactObjection !== undefined) return decision(outcome, [artifactObjection]);

  const soleEvidence = rejectSoleScalarVerdict(evidenceRefs, "kill-test evidence_refs");
  if (soleEvidence !== undefined) return decision(outcome, [soleEvidence]);
  const soleBasis = rejectSoleScalarVerdict(input.verdictBasis ?? [], "kill-test verdict");
  if (soleBasis !== undefined) return decision(outcome, [soleBasis]);

  const nonScalarRefs = evidenceRefs.filter((value) => !isScalarVerdictKey(value));
  if (nonScalarRefs.length === 0) {
    return decision(outcome, ["kill-test result requires T48-mapped evidence_refs"]);
  }
  const mapped = mapEvidence(input.catalog, nonScalarRefs);
  if (typeof mapped === "string") {
    return decision(outcome, [mapped.includes("T48") || mapped.includes("unknown") || mapped.includes("side-slot")
      ? mapped
      : `unknown T48-mapped evidence or artifact id: ${mapped}`]);
  }

  const plan = readKillTestPlan(input);
  if (typeof plan === "string") {
    return decision(outcome, [plan], mapped);
  }
  if (plan !== undefined && input.ledger !== undefined) {
    const recorded = writeLedgerResult(input.ledger, input, plan, outcome, mapped);
    if (typeof recorded === "string") {
      return decision(outcome, [recorded], mapped, plan);
    }
  }

  if (killTestOutcomeBlocksBroker(outcome) || !killTestOutcomeIsPass(outcome)) {
    const reason = outcome === "inconclusive"
      ? "inconclusive kill-test outcome is not pass"
      : "kill-test fail blocks promotion and the submission broker";
    return decision(outcome, [reason], mapped, plan);
  }
  asKillTestPass(outcome);
  return decision(outcome, [], mapped, plan);
}

export function createKillTestHangHook(
  input: KillTestHangInput | ((context: VerificationContext) => KillTestHangInput),
): VerificationHook {
  return (context) => {
    try {
      const request = typeof input === "function" ? input(context) : input;
      const hang = runKillTestHang(request);
      return deepFreeze({
        ok: hang.ok,
        objections: hang.objections,
      }) as VerificationResult;
    } catch (error) {
      return deepFreeze({
        ok: false,
        objections: Object.freeze([error instanceof Error ? error.message : "kill-test hang rejected the candidate"]),
      }) as VerificationResult;
    }
  };
}
