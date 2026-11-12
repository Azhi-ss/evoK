/**
 * The one execution protocol — `ExecutionRequest` / `ExecutionReceipt` (PRD §3
 * B4, §4 Stage 2; #253/#255).
 *
 * The main Run path (`pi-agent-runtime`) and delegated children
 * (`pi-child-dispatch`) used to carry their own credential, cancellation,
 * attribution, tool-turn and provenance rules. Two rule sets for one concept is
 * a second execution semantics with a different meaning for every word, so the
 * rules live here and the backends only supply what is genuinely theirs.
 *
 * B4 — protocol versus backend. A backend may run a Pi main session or a
 * pi-subagents child; both consume one `ExecutionRequest` and answer one
 * `ExecutionReceipt`. Backends differ internally (session vs native child), not
 * in what an execution IS.
 *
 * B3 — raw usage only. A receipt carries what the backend measured and says
 * whether that number is already inside a parent aggregate
 * (`usage.attribution`); `aggregateUsage` is the only place that may sum
 * receipts and counts each execution once. Attribution and budget settlement
 * remain the Mission's (see `mission/run-preparation.ts`).
 *
 * B2 — collection versus adoption. The `artifacts` field has ONE shape
 * (`producer` = execution id, optional `parentExecutionId`, content `digest`).
 * Collecting and content-addressing a workspace is the harness's
 * (`harness/artifacts.ts`, at snapshot commit), so a backend declares only what
 * it itself produced — nothing on both paths today. A Run's workspace snapshot
 * is adopted by the Mission, never by the backend that ran it.
 *
 * Credentials: `closeExecution` is the one write rule. It redacts free text and
 * refuses a structurally credential-shaped record, using the same guard the
 * child records already use — a receipt is a durable record on both paths.
 */
import { redactedRecord } from "./pi-child-records";

/** Who executed; the protocol is shared, the backend is not. */
export type ExecutionBackend = "pi-agent-runtime" | "pi-child-dispatch";

/**
 * The terminal outcome of one execution. `unknown` is a real answer: an
 * execution that could not be confirmed terminal is never success, and never a
 * silent failure either.
 */
export type ExecutionOutcome = "succeeded" | "failed" | "cancelled" | "unknown";

/** Frozen input identity: digests only, never the inputs themselves. */
export interface ExecutionInputRefs {
  readonly inputDigest: string;
}

/**
 * Where the execution ran. Environment refs are the backend's (B1); they never
 * carry Mission conditions such as the authorization or budget of a Run.
 */
export interface ExecutionEnvironmentRefs {
  readonly backend: ExecutionBackend;
  readonly workspace: string;
  readonly modelId?: string;
  /**
   * B1: content address of the execution environment the harness froze before
   * the execution was declared (`harness/snapshot.ts`). Mission conditions —
   * plan version, authorization, budget, memory — never appear here.
   */
  readonly environmentDigest?: string;
}

/** What the execution may do, as granted — a role plan cannot widen it later. */
export interface ExecutionCapabilityGrant {
  readonly tools: readonly string[];
}

export interface ExecutionLimits {
  readonly timeoutMs?: number;
  /** Tool-turn budget; absent means the backend does not bound turns. */
  readonly toolTurns?: number;
}

export interface ExecutionRequest {
  readonly executionId: string;
  readonly parentExecutionId?: string;
  readonly inputs: ExecutionInputRefs;
  readonly environment: ExecutionEnvironmentRefs;
  readonly capabilities: ExecutionCapabilityGrant;
  readonly limits: ExecutionLimits;
}

/**
 * What one execution consumed, before anyone attributes it (B3). It lives with
 * the receipt contract because a receipt carries it; the harness measures into
 * this shape (`harness/metering.ts`) instead of owning a second copy.
 */
export interface RawUsage {
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
}

/** Raw usage plus whose number it is (B3). */
export interface ExecutionUsage extends RawUsage {
  /**
   * `own`: this number is not inside any parent aggregate and must be added.
   * `included-in-parent`: the parent already reports this usage; adding it again
   * is the B3 double count.
   */
  readonly attribution: "own" | "included-in-parent";
}

/** One produced artifact; the shape is identical on both paths (B2). */
export interface ArtifactProvenance {
  /** The execution that produced it. */
  readonly producer: string;
  readonly parentExecutionId?: string;
  readonly digest: string;
}

export interface ExecutionToolTurns {
  readonly spent: number;
  readonly limit?: number;
}

/**
 * What one execution turned out to be: the request it answered, plus the
 * terminal facts. A receipt is the durable record of a request, so it repeats
 * the frozen refs rather than pointing at state that may have moved since.
 */
export interface ExecutionReceipt extends ExecutionRequest {
  readonly outcome: ExecutionOutcome;
  /** Absent when the execution was never confirmed far enough to measure. */
  readonly usage?: ExecutionUsage;
  readonly toolTurns: ExecutionToolTurns;
  readonly artifacts: readonly ArtifactProvenance[];
  /** Already-redacted evidence of how it ended; never a transcript. */
  readonly diagnostics?: { readonly status: string; readonly error?: string };
}

/**
 * Cancellation, in one line: only a confirmed terminal cancel is `cancelled`.
 * Anything the backend could not confirm is `unknown`, never `succeeded`.
 */
export function cancellationOutcome(confirmed: boolean): ExecutionOutcome {
  return confirmed ? "cancelled" : "unknown";
}

export interface ToolTurnGate {
  /** Record one assistant message: the tool names it called. */
  turn(calls: readonly string[]): void;
  /** Decide one call in the current batch. */
  call(name: string): { block: true; terminate: true; reason: string } | undefined;
  /** Non-control tool turns spent so far. */
  readonly used: number;
  /** The batch that just ran exceeded the budget or mixed in a control action. */
  overBudget(): boolean;
}

/**
 * The one tool-turn rule (C7, B4). A tool turn is a model message containing
 * tool calls; only non-control turns spend the budget, so the last allowed batch
 * always executes and a terminal control action still runs alone afterwards. The
 * batch after the budget is blocked and ends the turn — never before. With no
 * limit (`undefined`) the gate only counts, which is all the main Run path needs.
 */
export function createToolTurnGate(
  remainingToolTurns: number | undefined,
  granted: readonly string[],
  isControl: (name: string) => boolean,
): ToolTurnGate {
  if (
    remainingToolTurns !== undefined &&
    (!Number.isSafeInteger(remainingToolTurns) || remainingToolTurns < 0)
  )
    throw Error("remaining tool turns must be a non-negative integer");
  let used = 0;
  let mixed = false;
  let spending = false;
  let refused = false;
  const blocked = (reason: string) => {
    refused = true;
    return { block: true, terminate: true, reason } as const;
  };
  return {
    turn(calls) {
      const controls = calls.filter(isControl).length;
      // A control action must be alone in its batch, including next to another one.
      mixed = controls > 0 && calls.length > 1;
      // A batch the budget already refuses never runs, so it never spends a turn.
      spending =
        calls.length > controls && !mixed && (remainingToolTurns === undefined || used < remainingToolTurns);
      if (spending) used++;
    },
    call(name) {
      if (!granted.includes(name)) return blocked("This child was not granted " + name + ".");
      if (mixed) return blocked("A control action must be the only call in its batch.");
      if (!isControl(name) && !spending && remainingToolTurns !== undefined && used >= remainingToolTurns)
        return blocked("The child has used its " + remainingToolTurns + " tool turns.");
      return undefined;
    },
    get used() {
      return used;
    },
    overBudget: () => mixed || refused,
  };
}

export interface ExecutionUsageTotals {
  readonly tokens: ExecutionUsage["tokens"];
  readonly cost: ExecutionUsage["cost"];
}

const ZERO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } as const;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } as const;

/**
 * B3 in one function: attribute every execution's raw usage exactly once.
 * A receipt whose usage its parent already reports is skipped (it is in the
 * parent's number), and the same execution id appearing twice is refused rather
 * than silently summed.
 *
 * shortcut: nothing sums receipts yet — Mission attribution (B3's owner) still
 * reads one Run's raw usage per line. Wire this in when Mission attribution is
 * extracted (PRD §4 Stage 4) instead of letting a second summation appear there.
 */
export function aggregateUsage(receipts: readonly ExecutionReceipt[]): ExecutionUsageTotals {
  const seen = new Set<string>();
  const tokens = { ...ZERO_TOKENS };
  const cost = { ...ZERO_COST };
  for (const receipt of receipts) {
    if (seen.has(receipt.executionId))
      throw Error("execution " + receipt.executionId + " is attributed twice");
    seen.add(receipt.executionId);
    const usage = receipt.usage;
    if (!usage || usage.attribution === "included-in-parent") continue;
    for (const key of Object.keys(tokens) as (keyof typeof tokens)[]) tokens[key] += usage.tokens[key];
    for (const key of Object.keys(cost) as (keyof typeof cost)[]) cost[key] += usage.cost[key];
  }
  return { tokens: { ...tokens }, cost: { ...cost } };
}

/** What a backend adds to its request when the execution ends. */
export interface ExecutionClose {
  readonly outcome: ExecutionOutcome;
  readonly toolTurns: ExecutionToolTurns;
  /** Absent when the execution was never confirmed far enough to measure. */
  readonly usage?: ExecutionUsage;
  readonly diagnostics?: { readonly status: string; readonly error?: string };
  /** Defaults to none: collecting artifacts is the harness's (B2, Stage 3). */
  readonly artifacts?: readonly ArtifactProvenance[];
}

/**
 * Close one execution: the request it answered plus its terminal facts, built in
 * ONE place so two backends cannot assemble two receipts. This is also the one
 * credential rule — a receipt is durable on both paths (the Run path in its
 * intent record, the child path on the delegation result and its errors), so it
 * is redacted and then refused if anything credential-shaped survived.
 */
export function closeExecution(request: ExecutionRequest, close: ExecutionClose): ExecutionReceipt {
  return redactedRecord(
    { ...request, ...close, artifacts: close.artifacts ?? [] },
    "execution receipt",
  );
}
