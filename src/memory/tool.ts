/**
 * `memory_read(ref)`: the read-only second serving channel (M-d / #245).
 *
 * It answers ONE question an agent can already ask in words — "give me the body
 * of a card I was shown a reference to" — and nothing else:
 *
 * - the only accepted argument is a `cardId` that is present in the decision
 *   packet THIS Run was served (`projectResearchDecisionPacket` over the
 *   slice's pinned snapshot). Anything else is refused, so the tool can never
 *   become a free-form retrieval channel beside the measured injection;
 * - it resolves against that same pinned snapshot, which travels in the
 *   validated `MemorySlice` — the tool holds no store handle and cannot read
 *   "latest", another Run's slice, another Mission, or the other arm;
 * - it cannot enumerate or search: there is no list parameter and no query;
 * - every attempt is recorded (`reads()`), so the caller can write a
 *   ledger-visible read event instead of memory reads staying invisible.
 *
 * It answers from the pinned snapshot's own published card, never from an
 * artifact store: the slice's fixed `readPolicy` denies raw bodies *inside* the
 * slice, and reading a card body here cannot add content outside the snapshot
 * the Run was already served.
 *
 * Sham parity: the Sham arm's slice carries the Sham snapshot, whose cards are
 * control slots. The same factory therefore exposes the same tool with the same
 * name, description and parameters, and it returns control-slot bodies — so an
 * Off/Sham/Real comparison measures memory, not tool access.
 */
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { deepFreeze } from "../execution/security-boundary";
import { assertPacketCardRefs, projectResearchDecisionPacket } from "./packet";
import { ResearchMemoryError, type ResearchMemoryCard } from "./schema";
import type { MemorySlice } from "./slice";

export const MEMORY_READ_TOOL = "memory_read" as const;
export const MEMORY_READ_SCHEMA = "evok.memory-read/v1" as const;
const MAX_REF_LENGTH = 512;

/** Card fields that carry provenance refs; every published card declares a subset. */
const PROVENANCE_FIELDS = ["sourceRefs", "supportingRefs", "contradictingRefs", "competingRefs"] as const;
/** The revision chain lives under `lineage`, never on the card itself. */
const LINEAGE_FIELDS = ["derivesFrom", "supersedes", "supersededBy"] as const;

export interface MemoryReadProvenance {
  readonly missionId: string;
  readonly snapshotId: string;
  readonly snapshotDigest: string;
  readonly ledgerRevision: number;
  /** Every provenance ref the published card declares, de-duplicated and sorted. */
  readonly refs: readonly string[];
}

/** The body of one served card plus the provenance a reader can check it against. */
export interface MemoryReadBody {
  readonly schema: typeof MEMORY_READ_SCHEMA;
  readonly cardId: string;
  readonly kind: ResearchMemoryCard["kind"];
  readonly body: ResearchMemoryCard;
  readonly provenance: MemoryReadProvenance;
}

/**
 * One read attempt. `refused` is recorded as well as `delivered`: an attempt to
 * read outside the served packet is exactly what the ledger must show.
 */
export interface MemoryReadRecord {
  readonly cardId: string;
  readonly snapshotId: string;
  readonly snapshotDigest: string;
  readonly outcome: "delivered" | "refused";
  readonly reason?: string;
}

export interface MemoryReadTool {
  readonly definition: ToolDefinition;
  /** Reads observed so far, in call order. */
  readonly reads: () => readonly MemoryReadRecord[];
}

function provenanceRefsOf(card: ResearchMemoryCard): string[] {
  const record = card as unknown as Record<string, unknown>;
  const refs = new Set<string>();
  for (const field of PROVENANCE_FIELDS) {
    const value = record[field];
    if (!Array.isArray(value)) continue;
    for (const entry of value) if (typeof entry === "string" && entry !== "") refs.add(entry);
  }
  const lineage = record.lineage as Record<string, unknown> | undefined;
  for (const field of LINEAGE_FIELDS) {
    const value = lineage?.[field];
    if (typeof value === "string" && value !== "") refs.add(value);
    else if (Array.isArray(value)) for (const entry of value) if (typeof entry === "string" && entry !== "") refs.add(entry);
  }
  return [...refs].sort();
}

/**
 * Resolves ONE card reference against the packet this slice was served. A ref
 * outside the delivered packet, a slice with no pinned snapshot, and a
 * malformed ref all fail closed with a `ResearchMemoryError`.
 */
export function readMemoryCard(memorySlice: MemorySlice, ref: unknown): MemoryReadBody {
  if (typeof ref !== "string" || ref.trim() === "" || ref.length > MAX_REF_LENGTH) {
    throw new ResearchMemoryError("memory_read needs one non-empty card reference");
  }
  const snapshot = memorySlice.research;
  if (snapshot === undefined) {
    throw new ResearchMemoryError("this Run was served no Research Memory packet, so there is nothing to read");
  }
  // Scope is the DELIVERED packet, not the snapshot, and it uses the one rule
  // the rest of the memory module already uses for delivered refs.
  const packet = projectResearchDecisionPacket(snapshot);
  assertPacketCardRefs(packet, [ref]);
  const card = packet.cards.find((entry) => entry.cardId === ref)!;
  return deepFreeze({
    schema: MEMORY_READ_SCHEMA,
    cardId: card.cardId,
    kind: card.kind,
    body: card,
    provenance: {
      missionId: snapshot.missionId,
      snapshotId: snapshot.snapshotId,
      snapshotDigest: snapshot.digest,
      ledgerRevision: snapshot.ledgerRevision,
      refs: provenanceRefsOf(card),
    },
  });
}

/**
 * Binds the tool to exactly one validated Run slice that carries a pinned
 * snapshot. Execution calls this once per dispatched Run; nothing outside that
 * Run can reach the returned tool, and a Run served no packet gets no tool.
 */
export function createMemoryReadTool(memorySlice: MemorySlice): MemoryReadTool {
  const snapshot = memorySlice.research;
  if (snapshot === undefined) {
    throw new ResearchMemoryError("a Run served no Research Memory packet gets no memory_read tool");
  }
  const reads: MemoryReadRecord[] = [];
  const pin = { snapshotId: snapshot.snapshotId, snapshotDigest: snapshot.digest };
  const definition = defineTool({
    name: MEMORY_READ_TOOL,
    label: "Read a served Research Memory card",
    description: "Return the body and provenance references of ONE Research Memory card this Run was already "
      + "served a reference to. Pass the exact cardId shown in the Research Memory packet. Any other reference is "
      + "refused: there is no search, no listing, and no access to another Run, Mission, snapshot or arm.",
    promptSnippet: "read one served Research Memory card body by its cardId",
    parameters: Type.Object({ ref: Type.String({ minLength: 1, maxLength: MAX_REF_LENGTH }) }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      try {
        const body = readMemoryCard(memorySlice, params.ref);
        reads.push({ cardId: body.cardId, ...pin, outcome: "delivered" });
        return { content: [{ type: "text" as const, text: JSON.stringify(body) }], details: {} };
      } catch (error) {
        reads.push({
          cardId: typeof params.ref === "string" ? params.ref : "",
          ...pin,
          outcome: "refused",
          reason: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  });
  return { definition, reads: () => [...reads] };
}
