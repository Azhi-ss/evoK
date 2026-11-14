/**
 * M-d (#245): `memory_read(ref)` is the sanctioned second serving channel. These
 * tests pin the four properties that keep Off/Sham/Real comparable — reference
 * scoping, the pinned snapshot, no enumeration, and a recorded read event — plus
 * Sham parity of the tool itself.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEMORY_READ_TOOL,
  createMemoryReadTool,
  createMemorySlice,
  createResearchMemorySlice,
  projectResearchDecisionPacket,
  projectResearchMemorySnapshot,
  researchMemoryStoreFor,
  readMemoryCard,
  shamResearchMemorySnapshot,
  type MemorySlice,
  type ResearchMemorySnapshot,
  type ResearchMemorySource,
  type ResearchOperationalPitfallCard,
} from "./index";
import type { SynthesisProposal } from "../evidence/synthesis-proposal";

function proposal(over: Partial<SynthesisProposal>): SynthesisProposal {
  return {
    schema: "evok.synthesis-proposal/v1",
    missionId: "m-demo",
    agentId: "agent-1",
    supportingRefs: [],
    contradictingRefs: [],
    competingRefs: [],
    unknowns: [],
    applicability: [],
    visibility: "mission",
    limitations: [],
    conditions: [],
    digest: "0".repeat(64),
    ...over,
  } as SynthesisProposal;
}

function source(over: Partial<ResearchMemorySource> = {}): ResearchMemorySource {
  return {
    missionId: "m-demo",
    ledgerRevision: 7,
    maxCards: 8,
    runs: [
      { runId: "m-demo:baseline:1", taskId: "t-1", taskObjective: "raise AUC", ok: true, score: 0.75, evidenceRefs: ["runs/1/result.json"] },
      { runId: "m-demo:exp:2", taskId: "t-1", taskObjective: "raise AUC", ok: false, score: 0.71, evidenceRefs: ["runs/2/result.json"] },
      { runId: "m-demo:exp:3", taskId: "t-1", ok: false, error: "CUDA out of memory", configuration: "batch=512", evidenceRefs: ["runs/3/result.json"] },
    ],
    proposals: [
      proposal({
        proposalId: "p-1",
        operationId: "op-1",
        kind: "hypothesis",
        statement: "A wider feature block lifts AUC",
        rationale: "observed on run 1",
        supportingRefs: [{ kind: "run", ref: "m-demo:baseline:1" }],
        contradictingRefs: [{ kind: "negative-evidence", ref: "m-demo:exp:2" }],
        applicability: ["dataset:v2"],
      }),
    ],
    ...over,
  };
}

type ServedSlice = MemorySlice & { readonly research: ResearchMemorySnapshot };

function sliceFor(missionId: string, snapshot = projectResearchMemorySnapshot(source({ missionId }))): ServedSlice {
  return createResearchMemorySlice({
    sliceId: `${missionId}:slice`,
    missionId,
    taskId: "t-1",
    runId: `${missionId}:exp:9`,
    targetAgentId: `evok-experiment-train@${missionId}:exp:9`,
    findings: [],
    research: snapshot,
  }) as ServedSlice;
}

describe("memory_read is scoped to the served packet", () => {
  test("returns the served card body and its provenance references", () => {
    const slice = sliceFor("m-demo");
    const packet = projectResearchDecisionPacket(slice.research!);
    const delivered = packet.cards[0]!;

    const body = readMemoryCard(slice, delivered.cardId);

    expect(body.cardId).toBe(delivered.cardId);
    expect(body.body).toEqual(delivered);
    expect(body.provenance).toMatchObject({
      missionId: "m-demo",
      snapshotId: slice.research!.snapshotId,
      snapshotDigest: slice.research!.digest,
      ledgerRevision: 7,
    });
    expect(body.provenance.refs.length).toBeGreaterThan(0);
    expect(body.provenance.refs).toEqual([...body.provenance.refs].sort());
  });

  test("the readable scope is exactly the pinned packet: every delivered card, nothing else", () => {
    const slice = sliceFor("m-demo");
    const packet = projectResearchDecisionPacket(slice.research!);
    expect(packet.cards.length).toBeGreaterThan(1);
    for (const card of packet.cards) expect(readMemoryCard(slice, card.cardId).body).toEqual(card);
  });

  test("provenance follows the card's revision chain, not just its source refs", () => {
    const slice = sliceFor("m-demo");
    const pitfall = slice.research!.cards.find(
      (card): card is ResearchOperationalPitfallCard => card.kind === "pitfall" && card.cardId.startsWith("pitfall:run:"),
    )!;

    const refs = readMemoryCard(slice, pitfall.cardId).provenance.refs;

    expect(pitfall.lineage?.derivesFrom?.length).toBeGreaterThan(0);
    for (const derived of pitfall.lineage!.derivesFrom!) expect(refs).toContain(derived);
  });

  test("refuses a card reference the served packet does not carry", () => {
    const slice = sliceFor("m-demo");
    expect(() => readMemoryCard(slice, "finding:m-demo:exp:never")).toThrow("is not part of the delivered packet");
    expect(() => readMemoryCard(slice, "")).toThrow("non-empty card reference");
    expect(() => readMemoryCard(slice, 42)).toThrow("non-empty card reference");
  });

  test("a Run served no packet gets no tool at all", () => {
    const v2 = createMemorySlice({ sliceId: "s", missionId: "m-demo", taskId: "t-1", runId: "m-demo:exp:9", targetAgentId: "agent" });
    expect(() => createMemoryReadTool(v2)).toThrow("gets no memory_read tool");
  });

  test("cannot enumerate or search: the only argument is one card reference", () => {
    const schema = createMemoryReadTool(sliceFor("m-demo")).definition.parameters as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual(["ref"]);
    expect(schema.additionalProperties).toBe(false);
    // The factory is bound to one slice and holds no store handle: there is no
    // path from a tool instance to another snapshot, a directory, or a query.
    expect(createMemoryReadTool.length).toBe(1);
  });
});

describe("memory_read resolves against the pinned snapshot, never latest", () => {
  test("a newer published snapshot cannot change or extend what this Run can read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evok-memory-read-"));
    const pinned = projectResearchMemorySnapshot(source());
    await researchMemoryStoreFor(dir).publish(pinned);
    const tool = createMemoryReadTool(sliceFor("m-demo", pinned));
    const pinnedCardId = projectResearchDecisionPacket(pinned).cards[0]!.cardId;

    // A later Run publishes a snapshot with an extra Run card and a new revision.
    const newer = projectResearchMemorySnapshot(source({ ledgerRevision: 99, runs: [
      ...source().runs,
      { runId: "m-demo:exp:5", taskId: "t-1", ok: false, score: 0.6, evidenceRefs: ["runs/5/result.json"] },
    ] }));
    await researchMemoryStoreFor(dir).publish(newer);

    const served = await tool.definition.execute("call-1", { ref: pinnedCardId }, undefined, undefined, undefined as never);
    expect(JSON.parse((served.content[0] as unknown as { text: string }).text)).toEqual(readMemoryCard(sliceFor("m-demo", pinned), pinnedCardId));
    // The ref only the newer snapshot carries stays unreachable for the pinned Run.
    expect(() => readMemoryCard(sliceFor("m-demo", pinned), "finding:m-demo:exp:5")).toThrow("is not part of the delivered packet");
    expect(tool.reads()).toMatchObject([{ cardId: pinnedCardId, snapshotDigest: pinned.digest, outcome: "delivered" }]);
  });

  test("never crosses a Run, Mission or arm boundary", () => {
    const otherMission = createResearchMemorySlice({
      sliceId: "m-other:slice", missionId: "m-other", taskId: "t-other", runId: "m-other:exp:1", targetAgentId: "agent-other",
      findings: [],
      research: projectResearchMemorySnapshot(source({
        missionId: "m-other",
        runs: [{ runId: "m-other:exp:1", taskId: "t-other", ok: true, score: 0.9, evidenceRefs: ["runs/other.json"] }],
        proposals: [],
      })),
    });
    const otherCardId = projectResearchDecisionPacket(otherMission.research!).cards[0]!.cardId;
    expect(() => readMemoryCard(sliceFor("m-demo"), otherCardId)).toThrow("is not part of the delivered packet");
    const noResearch = createMemorySlice({
      sliceId: "m-demo:slice:v2", missionId: "m-demo", taskId: "t-1", runId: "m-demo:exp:9", targetAgentId: "agent",
    });
    expect(() => readMemoryCard(noResearch, otherCardId)).toThrow("was served no Research Memory packet");
  });
});

describe("memory_read parity across arms and auditability", () => {
  test("the Sham arm exposes the same tool and returns control-slot bodies", () => {
    const real = createMemoryReadTool(sliceFor("m-demo"));
    const shamSlice = sliceFor("m-demo", shamResearchMemorySnapshot(projectResearchMemorySnapshot(source())));
    const sham = createMemoryReadTool(shamSlice);

    expect(sham.definition.name).toBe(real.definition.name);
    expect(sham.definition.name).toBe(MEMORY_READ_TOOL);
    expect(sham.definition.description).toBe(real.definition.description);
    expect(sham.definition.parameters).toEqual(real.definition.parameters);

    const controlId = projectResearchDecisionPacket(shamSlice.research!).cards[0]!.cardId;
    const body = readMemoryCard(shamSlice, controlId);
    expect(body.body).toMatchObject({ control: "sham", lifecycle: "provisional", sourceRefs: [] });
    expect(body.provenance.refs).toEqual([]);

    // Neither arm can read the other's card ids: same tool, different pinned content.
    const realCardId = projectResearchDecisionPacket(sliceFor("m-demo").research!).cards[0]!.cardId;
    expect(() => readMemoryCard(shamSlice, realCardId)).toThrow("is not part of the delivered packet");
    expect(() => readMemoryCard(sliceFor("m-demo"), controlId)).toThrow("is not part of the delivered packet");
  });

  test("delivered and refused reads are both recorded for the ledger", async () => {
    const slice = sliceFor("m-demo");
    const tool = createMemoryReadTool(slice);
    const delivered = projectResearchDecisionPacket(slice.research!).cards[0]!.cardId;

    expect(tool.reads()).toEqual([]);
    await tool.definition.execute("call-1", { ref: delivered }, undefined, undefined, undefined as never);
    await tool.definition.execute("call-2", { ref: "not-a-card" }, undefined, undefined, undefined as never).catch(() => {});

    expect(tool.reads()).toMatchObject([
      { cardId: delivered, outcome: "delivered" },
      { cardId: "not-a-card", outcome: "refused" },
    ]);
    expect(tool.reads()[1]?.reason).toContain("is not part of the delivered packet");
  });
});
