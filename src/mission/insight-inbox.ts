/**
 * Human Insight drafts and the Mission Insight Inbox (#238 / D1, D2).
 *
 * A draft is **advisor context, not evidence**: zero epistemic authority (it
 * proves nothing, it is never Evidence, never a Verified Claim, never
 * promotable) and explicitly non-zero decision relevance (it may change what
 * the Director proposes). The only promotion path runs through measurement:
 * `Insight -> Director proposes Experiment -> Experiment runs -> result -> Evidence`.
 *
 * Drafts live in the Mission ledger as events and are projected into a separate
 * Inbox. The Inbox has no independent write path and no separate durability: it
 * is rebuilt from the events alone, and replaying the same events yields a
 * byte-identical digest. Submission only appends an event, so it never
 * interrupts, aborts or pre-empts a running Run.
 */
import { deepFreeze, digestValue } from "../execution/security-boundary";
import type { ResearchEvent, ResearchLedger } from "./research-loop";

export const HUMAN_INSIGHT_DRAFT_SCHEMA = "human-insight-draft/1";
export const INSIGHT_INBOX_SCHEMA = "mission-insight-inbox/1";

export type HumanInsightEventType = "HUMAN_INSIGHT_DRAFT_CREATED" | "HUMAN_INSIGHT_DISPOSITION_RECORDED";

/** The four dispositions of #238 D4. `ignored` and `rejected` are never merged. */
export type InsightDisposition = "ignored" | "rejected" | "experiment_proposed" | "deferred";
export const INSIGHT_DISPOSITIONS: readonly InsightDisposition[] = ["ignored", "rejected", "experiment_proposed", "deferred"];

/** Typed coding defect in the insight ledger or a submission against it. */
export class InsightInboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsightInboxError";
  }
}

export interface HumanInsightDraft {
  readonly schema: typeof HUMAN_INSIGHT_DRAFT_SCHEMA;
  readonly insightId: string;
  readonly missionId: string;
  readonly text: string;
  /** The human's own suggested way to falsify the idea, if any. */
  readonly falsificationHint?: string;
  readonly author: string;
  /** Ledger sequence of the create event; the Inbox orders by it. */
  readonly createdOrdinal: number;
  readonly version: number;
  /** Zero epistemic authority: a draft proves nothing and is never promotable. */
  readonly epistemicAuthority: 0;
  /** Non-zero decision relevance: a draft may change what the Director proposes. */
  readonly decisionRelevance: "non-zero";
}

export interface InsightDispositionRecord {
  readonly insightId: string;
  readonly version: number;
  readonly disposition: InsightDisposition;
  readonly reason?: string;
  readonly decisionRef: string;
  readonly proposalRef?: string;
}

export interface InsightInboxItem {
  readonly draft: HumanInsightDraft;
  /** `pending` until a disposition event names the draft. */
  readonly status: "pending" | InsightDisposition;
  readonly disposition?: InsightDispositionRecord;
}

export interface InsightInbox {
  readonly schema: typeof INSIGHT_INBOX_SCHEMA;
  readonly missionId: string;
  readonly items: readonly InsightInboxItem[];
  readonly digest: string;
}

/** The Mission ledger as this module needs it: append plus read. */
export type InsightLedger = Pick<ResearchLedger, "append" | "events">;

export interface SubmitHumanInsightDraftInput {
  readonly missionId: string;
  readonly insightId: string;
  readonly text: string;
  readonly falsificationHint?: string;
  readonly author: string;
}

const DRAFT_KEYS: ReadonlySet<string> = new Set(["schema", "insightId", "missionId", "text", "falsificationHint", "author", "version", "operationId"]);
const DISPOSITION_KEYS: ReadonlySet<string> = new Set(["insightId", "missionId", "version", "disposition", "reason", "decisionRef", "proposalRef", "operationId"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new InsightInboxError(`${name} must be a non-empty string`);
  return value;
}

function positiveInteger(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new InsightInboxError(`${name} must be a positive integer`);
  return value;
}

function optionalText(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(name, value);
}

/** Closed payload: a draft event can never carry evidence-shaped fields. */
function assertClosed(name: string, keys: ReadonlySet<string>, payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (!keys.has(key)) throw new InsightInboxError(`${name} carries an undeclared field: ${key}`);
  }
}

function draftPayload(input: SubmitHumanInsightDraftInput): Record<string, unknown> {
  const missionId = requiredString("missionId", input.missionId);
  const insightId = requiredString("insightId", input.insightId);
  const text = requiredString("insight text", input.text);
  const author = requiredString("author", input.author);
  const falsificationHint = optionalText("falsificationHint", input.falsificationHint);
  return {
    schema: HUMAN_INSIGHT_DRAFT_SCHEMA,
    insightId,
    missionId,
    text,
    ...(falsificationHint === undefined ? {} : { falsificationHint }),
    author,
    version: 1,
  };
}

function dispositionRecord(input: InsightDispositionRecord): InsightDispositionRecord {
  const insightId = requiredString("insightId", input.insightId);
  if (!INSIGHT_DISPOSITIONS.includes(input.disposition)) throw new InsightInboxError(`unknown insight disposition: ${String(input.disposition)}`);
  const reason = optionalText("disposition reason", input.reason);
  const proposalRef = optionalText("disposition proposalRef", input.proposalRef);
  // PRD #238 §5: a refutation owes its reasons, a proposed experiment owes its proposal.
  if (input.disposition === "rejected" && reason === undefined) throw new InsightInboxError("a rejected insight disposition requires a reason");
  if (input.disposition === "experiment_proposed" && proposalRef === undefined) throw new InsightInboxError("an experiment_proposed insight disposition requires a proposalRef");
  return {
    insightId,
    version: positiveInteger("disposition version", input.version),
    disposition: input.disposition,
    ...(reason === undefined ? {} : { reason }),
    decisionRef: requiredString("decisionRef", input.decisionRef),
    ...(proposalRef === undefined ? {} : { proposalRef }),
  };
}

function draftFromEvent(event: ResearchEvent): HumanInsightDraft {
  const payload = event.payload as Record<string, unknown>;
  assertClosed("human insight draft event", DRAFT_KEYS, payload);
  if (payload.schema !== HUMAN_INSIGHT_DRAFT_SCHEMA) throw new InsightInboxError(`human insight draft event has an unknown schema: ${String(payload.schema)}`);
  const falsificationHint = optionalText("falsificationHint", payload.falsificationHint);
  return deepFreeze({
    schema: HUMAN_INSIGHT_DRAFT_SCHEMA,
    insightId: requiredString("insightId", payload.insightId),
    missionId: requiredString("missionId", payload.missionId),
    text: requiredString("insight text", payload.text),
    ...(falsificationHint === undefined ? {} : { falsificationHint }),
    author: requiredString("author", payload.author),
    createdOrdinal: positiveInteger("insight created ordinal", event.sequence),
    version: positiveInteger("insight version", payload.version),
    epistemicAuthority: 0 as const,
    decisionRelevance: "non-zero" as const,
  });
}

function dispositionFromEvent(event: ResearchEvent): InsightDispositionRecord {
  const payload = event.payload as Record<string, unknown>;
  assertClosed("human insight disposition event", DISPOSITION_KEYS, payload);
  requiredString("disposition operationId", payload.operationId);
  return deepFreeze(dispositionRecord({
    insightId: payload.insightId as string,
    version: payload.version as number,
    disposition: payload.disposition as InsightDisposition,
    reason: payload.reason as string | undefined,
    decisionRef: payload.decisionRef as string,
    proposalRef: payload.proposalRef as string | undefined,
  }));
}

function assertSameVersion(disposition: InsightDispositionRecord, draft: HumanInsightDraft): void {
  if (disposition.version !== draft.version) {
    throw new InsightInboxError(`disposition version ${disposition.version} does not match insight ${draft.insightId} version ${draft.version}`);
  }
}

function samePayload(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return digestValue(left) === digestValue(right);
}

/** A retry that landed twice collapses to the recorded draft; different content is corruption. */
function assertSameDraft(insightId: string, incoming: Record<string, unknown>, recorded: Record<string, unknown>): void {
  if (!samePayload(incoming, recorded)) throw new InsightInboxError(`insight ${insightId} already contains a different draft`);
}

/** Refuses a submission filed against a ledger that already declares another Mission. */
function assertLedgerMission(ledger: InsightLedger, missionId: string): void {
  const declared = ledger.events()[0]?.payload.missionId;
  if (typeof declared === "string" && declared !== missionId) {
    throw new InsightInboxError(`insight submission belongs to another mission: ${missionId} (ledger holds ${declared})`);
  }
}

function draftOperationId(insightId: string): string {
  return `insight-draft-created:${insightId}`;
}

/**
 * Appends one `HUMAN_INSIGHT_DRAFT_CREATED` event through the Mission ledger.
 * A retry of the same draft is a no-op returning the recorded draft; re-using
 * the id for different content is refused. Nothing else is emitted, so a
 * running Run is untouched.
 */
export function submitInsightDraft(ledger: InsightLedger, input: SubmitHumanInsightDraftInput): HumanInsightDraft {
  const payload = draftPayload(input);
  const insightId = payload.insightId as string;
  assertLedgerMission(ledger, payload.missionId as string);
  const operationId = draftOperationId(insightId);
  const existing = ledger.events().find((event) => event.type === "HUMAN_INSIGHT_DRAFT_CREATED"
    && (event.payload.insightId === insightId || event.payload.operationId === operationId));
  if (existing) {
    assertSameDraft(insightId, { ...payload, operationId }, existing.payload);
    return draftFromEvent(existing);
  }
  const appended = ledger.append({ type: "HUMAN_INSIGHT_DRAFT_CREATED", payload: { ...payload, operationId } });
  return draftFromEvent(appended);
}

/**
 * Appends one `HUMAN_INSIGHT_DISPOSITION_RECORDED` event for an existing draft
 * of the same version. Recording the identical disposition twice is a no-op.
 */
export function recordInsightDisposition(ledger: InsightLedger, input: InsightDispositionRecord & { readonly missionId: string }): InsightDispositionRecord {
  const missionId = requiredString("missionId", input.missionId);
  const record = dispositionRecord(input);
  assertLedgerMission(ledger, missionId);
  const item = projectInsightInbox(ledger.events(), { missionId }).items.find((entry) => entry.draft.insightId === record.insightId);
  if (!item) throw new InsightInboxError(`disposition references an unknown insight: ${record.insightId}`);
  assertSameVersion(record, item.draft);
  const operationId = `insight-disposition:${digestValue(record)}`;
  if (!ledger.events().some((event) => event.payload.operationId === operationId)) {
    ledger.append({ type: "HUMAN_INSIGHT_DISPOSITION_RECORDED", payload: { ...record, missionId, operationId } });
  }
  return deepFreeze(record);
}

/**
 * Rebuilds the Mission Insight Inbox from ledger events alone. Drafts are
 * ordered by their create-event sequence, a repeated create event collapses to
 * the recorded draft, and the last disposition recorded for a draft wins (v1
 * has one disposition record per Insight; per-decision-cycle history and
 * idempotency belong to the Director Revision, #240). The digest covers the
 * whole inbox body, so the same events always rebuild the same bytes.
 *
 * The created ordinal is the sequence of the create event rather than a
 * duplicated payload field, so the ledger's monotonic-sequence rule stays the
 * single source of truth for ordering.
 */
export function projectInsightInbox(events: readonly ResearchEvent[], options: { readonly missionId: string }): InsightInbox {
  const missionId = requiredString("missionId", options.missionId);
  const drafts: HumanInsightDraft[] = [];
  const byId = new Map<string, { readonly draft: HumanInsightDraft; readonly payload: Readonly<Record<string, unknown>> }>();
  const dispositions = new Map<string, InsightDispositionRecord>();
  let previousSequence = 0;
  for (const event of events) {
    if (event.type !== "HUMAN_INSIGHT_DRAFT_CREATED" && event.type !== "HUMAN_INSIGHT_DISPOSITION_RECORDED") continue;
    if (!isRecord(event.payload)) throw new InsightInboxError(`insight event ${String(event.sequence)} has an invalid payload`);
    positiveInteger("insight event sequence", event.sequence);
    if (event.sequence <= previousSequence) throw new InsightInboxError(`insight events are not in ledger order (sequence ${event.sequence})`);
    previousSequence = event.sequence;
    if (event.payload.missionId !== missionId) throw new InsightInboxError(`insight event ${String(event.sequence)} belongs to another mission`);
    if (event.type === "HUMAN_INSIGHT_DRAFT_CREATED") {
      const draft = draftFromEvent(event);
      const existing = byId.get(draft.insightId);
      if (existing) {
        assertSameDraft(draft.insightId, event.payload, existing.payload);
        continue;
      }
      byId.set(draft.insightId, { draft, payload: event.payload });
      drafts.push(draft);
      continue;
    }
    const disposition = dispositionFromEvent(event);
    const draft = byId.get(disposition.insightId)?.draft;
    if (!draft) throw new InsightInboxError(`disposition references an unknown insight: ${disposition.insightId}`);
    assertSameVersion(disposition, draft);
    dispositions.set(disposition.insightId, disposition);
  }
  const items = drafts.map((draft) => {
    const disposition = dispositions.get(draft.insightId);
    return deepFreeze({
      draft,
      status: disposition === undefined ? "pending" as const : disposition.disposition,
      ...(disposition === undefined ? {} : { disposition }),
    }) as InsightInboxItem;
  });
  const body: Omit<InsightInbox, "digest"> = { schema: INSIGHT_INBOX_SCHEMA, missionId, items: Object.freeze(items) };
  return deepFreeze({ ...body, digest: digestValue(body) });
}
