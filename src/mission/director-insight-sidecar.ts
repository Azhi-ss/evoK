/**
 * The Insight sidecar the Director Revision receives (#238 D3/D6, #240).
 *
 * Human Insight is advisor context, not evidence: it carries zero epistemic
 * authority, so it never enters the `ResearchDecisionPacket` (#238 D3 rejected a
 * third reserved category). It arrives as an independent sidecar that is pinned,
 * ordered, bounded and explainable exactly the way the packet is:
 *
 *   1. Blind Proposal   frozen without Memory AND without Insight
 *   2. Decision Packet  one pinned snapshot
 *   3. Insight Sidecar  the pending Insight this Revision actually reads
 *   4. Revision         weighs both and records one disposition per pinned Insight
 *
 * Loading is unconditional: the Revision stage always hands a sidecar, and "no
 * pending Insight" is an explicit empty sidecar, never a skipped step (§4.1).
 * The pin is the snapshot guarantee: a draft submitted mid-decision cannot
 * change an already-assembled input, and a disposition can only name an Insight
 * (and version) this Revision was actually shown.
 *
 * An Insight never dispatches: a disposition is a ledger event, and only an
 * ordinary Revised Proposal can create an Experiment through the existing path.
 */
import { deepFreeze, digestValue } from "../security-boundary";
import {
  INSIGHT_DISPOSITIONS,
  InsightInboxError,
  type HumanInsightDraft,
  type InsightDisposition,
  type InsightDispositionRecord,
  type InsightLedger,
  projectInsightInbox,
  recordInsightDisposition,
} from "./insight-inbox";
import type { ResearchEvent } from "./research-loop";

export const DIRECTOR_INSIGHT_SIDECAR_SCHEMA = "director-insight-sidecar/1";
/** Mirrors the Decision Packet's default bound of 8 cards. */
export const DIRECTOR_INSIGHT_DEFAULT_MAX = 8;
const DIRECTOR_INSIGHT_MAX_CEILING = 64;

/**
 * One pending Insight as the Revision sees it: the pinned id and version plus
 * the human's words. It carries no Evidence refs, no authority and no score.
 */
export type DirectorInsightSidecarItem = Pick<
  HumanInsightDraft,
  "insightId" | "version" | "createdOrdinal" | "text" | "falsificationHint" | "author"
>;

/**
 * The bounded, pinned Insight input of ONE Revision: pending drafts in Inbox
 * order plus the omission count, so a cut sidecar is never read as "the
 * operator said nothing else". It is a presentation projection of the Mission
 * ledger, never a second store and never an epistemic source.
 */
export interface DirectorInsightSidecar {
  readonly schema: typeof DIRECTOR_INSIGHT_SIDECAR_SCHEMA;
  readonly missionId: string;
  readonly maxInsights: number;
  readonly items: readonly DirectorInsightSidecarItem[];
  /** Pending Insight this sidecar does not carry; 0 when everything fits. */
  readonly omittedCount: number;
  /** True whenever anything is missing: a truncated sidecar is not the Inbox. */
  readonly truncated: boolean;
  readonly digest: string;
}

/** One judgement the Revision recorded about one pinned Insight (§5). */
export interface RevisionInsightDispositionInput {
  readonly insightId: string;
  readonly disposition: InsightDisposition;
  readonly reason?: string;
  readonly proposalRef?: string;
}

export interface RecordRevisionInsightDispositionsInput {
  readonly missionId: string;
  /** The pin of the Revision that decided; only its items can be dispositioned. */
  readonly sidecar: DirectorInsightSidecar;
  /** One Revision decision, so a retry inside that cycle cannot decide twice. */
  readonly decisionRef: string;
  readonly dispositions: readonly RevisionInsightDispositionInput[];
}

function maxInsightsOf(value: number | undefined): number {
  const max = value ?? DIRECTOR_INSIGHT_DEFAULT_MAX;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > DIRECTOR_INSIGHT_MAX_CEILING) {
    throw new InsightInboxError(`insight sidecar maxInsights must be an integer in [1, ${DIRECTOR_INSIGHT_MAX_CEILING}]; missing or invalid limits fail closed`);
  }
  return max;
}

/**
 * Builds the sidecar of one Revision from the Mission ledger events. It always
 * returns a sidecar: an empty Inbox yields an explicit empty pin with its own
 * digest, so "nothing pending" is a stated fact rather than a missing stage.
 */
export function buildDirectorInsightSidecar(
  events: readonly ResearchEvent[],
  options: { readonly missionId: string; readonly maxInsights?: number },
): DirectorInsightSidecar {
  const inbox = projectInsightInbox(events, { missionId: options.missionId });
  const maxInsights = maxInsightsOf(options.maxInsights);
  const pending = inbox.items.filter((item) => item.status === "pending");
  const items = pending.slice(0, maxInsights).map((item) => deepFreeze({
    insightId: item.draft.insightId,
    version: item.draft.version,
    createdOrdinal: item.draft.createdOrdinal,
    text: item.draft.text,
    ...(item.draft.falsificationHint === undefined ? {} : { falsificationHint: item.draft.falsificationHint }),
    author: item.draft.author,
  }));
  const omittedCount = pending.length - items.length;
  const body = {
    schema: DIRECTOR_INSIGHT_SIDECAR_SCHEMA as typeof DIRECTOR_INSIGHT_SIDECAR_SCHEMA,
    missionId: inbox.missionId,
    maxInsights,
    items: Object.freeze(items),
    omittedCount,
    truncated: omittedCount > 0,
  };
  return deepFreeze({ ...body, digest: digestValue(body) });
}

/**
 * The explicit empty sidecar: "no pending Insight" is a stated Revision input,
 * never a skipped stage (§4.1).
 */
export function emptyDirectorInsightSidecar(missionId: string): DirectorInsightSidecar {
  return buildDirectorInsightSidecar([], { missionId });
}

/** The disposition fields of one record or ledger payload, in one canonical shape. */
function dispositionFields(source: InsightDispositionRecord | Readonly<Record<string, unknown>>): Record<string, unknown> {
  const payload = source as Readonly<Record<string, unknown>>;
  return {
    insightId: payload.insightId,
    version: payload.version,
    disposition: payload.disposition,
    decisionRef: payload.decisionRef,
    ...(payload.reason === undefined ? {} : { reason: payload.reason }),
    ...(payload.proposalRef === undefined ? {} : { proposalRef: payload.proposalRef }),
  };
}

/** Ids this Revision was shown but recorded no judgement about (§7: a gap, not a stop). */
export function undispositionedInsightIds(
  sidecar: DirectorInsightSidecar,
  dispositions: readonly RevisionInsightDispositionInput[],
): readonly string[] {
  const answered = new Set(dispositions.map((entry) => entry.insightId));
  return sidecar.items.filter((item) => !answered.has(item.insightId)).map((item) => item.insightId);
}

/**
 * Checks the judgements one Revision recorded before anything is written: each
 * names a PINNED Insight, at most one answer per Insight per cycle, `rejected`
 * owes a reason and `experiment_proposed` a proposal. It is pure, so a caller
 * can reject a bad Revision attempt before it becomes durable. An Insight left
 * unanswered is NOT an error: mandatory visibility is the pin, never mandatory
 * adoption, so the gap is recorded (see `undispositionedInsightIds`).
 */
export function assertRevisionInsightDispositions(
  sidecar: DirectorInsightSidecar,
  dispositions: readonly RevisionInsightDispositionInput[],
): void {
  const seen = new Set<string>();
  for (const entry of dispositions) {
    if (!INSIGHT_DISPOSITIONS.includes(entry.disposition)) {
      throw new InsightInboxError(`unknown insight disposition: ${String(entry.disposition)}`);
    }
    if (!sidecar.items.some((item) => item.insightId === entry.insightId)) {
      throw new InsightInboxError(`insight ${entry.insightId} was not pinned in this Revision's sidecar`);
    }
    if (seen.has(entry.insightId)) throw new InsightInboxError(`insight ${entry.insightId} is dispositioned twice in one decision cycle`);
    seen.add(entry.insightId);
    // `ignored` is a judgement, `rejected` is a refutation; never merged (§5).
    if (entry.disposition === "rejected" && (entry.reason === undefined || entry.reason.trim() === "")) {
      throw new InsightInboxError(`a ${entry.disposition} insight disposition requires a reason`);
    }
    if (entry.disposition === "experiment_proposed" && (entry.proposalRef === undefined || entry.proposalRef.trim() === "")) {
      throw new InsightInboxError("an experiment_proposed insight disposition requires a proposalRef");
    }
  }
}

/**
 * Records the judgements one Revision made about its pinned Insight, through the
 * existing ledger path (`recordInsightDisposition`, same events, same
 * validation); an Insight it left unanswered is simply not recorded. The recorded
 * version is the PINNED one, so a draft cannot be dispositioned against a
 * version this Revision never read. Re-recording the identical judgement in the
 * same decision cycle is a no-op; changing the answer requires a new decision.
 */
export function recordRevisionInsightDispositions(
  ledger: InsightLedger,
  input: RecordRevisionInsightDispositionsInput,
): readonly InsightDispositionRecord[] {
  if (input.sidecar.missionId !== input.missionId) {
    throw new InsightInboxError(`the Insight sidecar belongs to another mission: ${input.sidecar.missionId} (expected ${input.missionId})`);
  }
  const decisionRef = input.decisionRef.trim();
  if (decisionRef === "") throw new InsightInboxError("disposition decisionRef must be a non-empty string");
  assertRevisionInsightDispositions(input.sidecar, input.dispositions);
  const recorded: InsightDispositionRecord[] = [];
  const pins = new Map(input.sidecar.items.map((item) => [item.insightId, item]));
  for (const entry of input.dispositions) {
    const pinned = pins.get(entry.insightId);
    if (pinned === undefined) throw new InsightInboxError(`insight ${entry.insightId} was not pinned in this Revision's sidecar`);
    const record: InsightDispositionRecord = {
      insightId: pinned.insightId,
      version: pinned.version,
      disposition: entry.disposition,
      decisionRef,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      ...(entry.proposalRef === undefined ? {} : { proposalRef: entry.proposalRef }),
    };
    const existing = ledger.events().find((event) => event.type === "HUMAN_INSIGHT_DISPOSITION_RECORDED"
      && event.payload.insightId === record.insightId
      && event.payload.decisionRef === decisionRef);
    if (existing && digestValue(dispositionFields(existing.payload)) !== digestValue(dispositionFields(record))) {
      throw new InsightInboxError(`insight ${record.insightId} was already dispositioned differently in decision cycle ${decisionRef}`);
    }
    recorded.push(recordInsightDisposition(ledger, { missionId: input.missionId, ...record }));
  }
  return deepFreeze(recorded);
}
