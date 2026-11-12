/**
 * The harness's one execution close (PRD §3 B2–B4, §4 Stage 3; #253/#256).
 *
 * A backend observes what happened; the harness measures the raw usage, validates
 * the artifact receipts, checks that the environment it froze is still the one
 * the execution declared, and hands all of it to the ONE protocol assembly. It
 * makes no research decision: no score, no promotion, no admission, no budget
 * settlement, no continue/stop, and it never converts `unknown` into an answer.
 *
 * B3: the attribution is passed through, never assumed. A backend that reports
 * usage without saying whether it is already inside a parent aggregate is
 * refused, because guessing there is exactly the double count B3 exists to stop.
 */
import {
  closeExecution,
  type ArtifactProvenance,
  type ExecutionOutcome,
  type ExecutionReceipt,
  type ExecutionRequest,
  type ExecutionToolTurns,
  type ExecutionUsage,
} from "../execution/execution-protocol";
import { assertArtifactReceipt } from "./artifacts";
import type { EnvironmentSnapshot } from "./contracts";
import { measureUsage } from "./metering";
import { assertEnvironmentRefs } from "./snapshot";

export interface HarnessObservation {
  /** The terminal outcome the backend confirmed; `unknown` stays `unknown`. */
  readonly outcome: ExecutionOutcome;
  readonly toolTurns: ExecutionToolTurns;
  /** What the backend measured, in whatever shape it measured it. */
  readonly usage?: unknown;
  /** `own` or `included-in-parent` — whose number this is (B3). */
  readonly usageAttribution?: ExecutionUsage["attribution"];
  /** Artifacts the harness collected for this execution (B2). */
  readonly artifacts?: readonly ArtifactProvenance[];
  readonly diagnostics?: { readonly status: string; readonly error?: string };
}

/**
 * Close one execution: the request it answered, plus the measured facts. One
 * place assembles the harness side of a receipt, so two backends cannot
 * disagree about what a measurement or an artifact provenance is.
 */
export function closeHarnessExecution(
  request: ExecutionRequest,
  environment: EnvironmentSnapshot,
  observation: HarnessObservation,
): ExecutionReceipt {
  assertEnvironmentRefs(environment, request.environment);
  const usage = measureUsage(observation.usage);
  if (observation.usage !== undefined && usage === undefined)
    throw Error("execution reported usage that is not measurable; refusing to record a zero");
  if (usage !== undefined && observation.usageAttribution === undefined)
    throw Error("execution usage needs an attribution (own or included-in-parent); that decision is not the harness's");
  const artifacts = (observation.artifacts ?? []).map((receipt) => {
    assertArtifactReceipt(receipt);
    if (receipt.producer !== request.executionId)
      throw Error(`artifact producer ${receipt.producer} is not this execution (${request.executionId})`);
    return receipt;
  });
  return closeExecution(request, {
    outcome: observation.outcome,
    toolTurns: observation.toolTurns,
    ...(usage === undefined ? {} : { usage: { ...usage, attribution: observation.usageAttribution! } }),
    artifacts,
    ...(observation.diagnostics === undefined ? {} : { diagnostics: observation.diagnostics }),
  });
}
