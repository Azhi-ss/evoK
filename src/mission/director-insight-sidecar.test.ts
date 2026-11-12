import { describe, expect, test } from "bun:test";
import { digestValue } from "../execution/security-boundary";
import { projectResearchDecisionPacket, projectResearchMemorySnapshot } from "../memory";
import {
  InsightInboxError,
  recordInsightDisposition,
  submitInsightDraft,
  type InsightDisposition,
} from "./insight-inbox";
import { buildDirectorPrompt, type DirectorInput, type DirectorProposal } from "./mission-director";
import {
  buildDirectorInsightSidecar,
  DIRECTOR_INSIGHT_DEFAULT_MAX,
  DIRECTOR_INSIGHT_SIDECAR_SCHEMA,
  recordRevisionInsightDispositions,
  undispositionedInsightIds,
} from "./director-insight-sidecar";
import { InMemoryResearchLedger, type ResearchEvent } from "./research-loop";

const MISSION = "insight-sidecar-mission";

function draft(ledger: InMemoryResearchLedger, insightId: string, text = `${insightId}: temperature may be underweighted`): void {
  submitInsightDraft(ledger, { missionId: MISSION, insightId, text, author: "operator" });
}

function eventsOf(ledger: InMemoryResearchLedger): readonly ResearchEvent[] {
  return ledger.events();
}

describe("the Director Insight sidecar", () => {
  test("pins pending Insight with ids and versions, and absence is an explicit empty sidecar", () => {
    const empty = buildDirectorInsightSidecar([], { missionId: MISSION });
    expect(empty).toEqual({
      schema: DIRECTOR_INSIGHT_SIDECAR_SCHEMA,
      missionId: MISSION,
      maxInsights: DIRECTOR_INSIGHT_DEFAULT_MAX,
      items: [],
      omittedCount: 0,
      truncated: false,
      digest: empty.digest,
    });
    expect(typeof empty.digest).toBe("string");

    const ledger = new InMemoryResearchLedger();
    draft(ledger, "insight-a", "try a purged split");
    draft(ledger, "insight-b", "temperature matters");
    const sidecar = buildDirectorInsightSidecar(eventsOf(ledger), { missionId: MISSION });
    expect(sidecar.items.map((item) => [item.insightId, item.version])).toEqual([["insight-a", 1], ["insight-b", 1]]);
    expect(sidecar.items[0]!.text).toBe("try a purged split");
    expect(sidecar.truncated).toBe(false);
    expect(sidecar.omittedCount).toBe(0);
    // The pin is a derivation: the same events rebuild the same bytes.
    expect(buildDirectorInsightSidecar(eventsOf(ledger), { missionId: MISSION })).toEqual(sidecar);

    // A dispositioned Insight is no longer pending, so a later Revision cannot pin it again.
    recordInsightDisposition(ledger, {
      missionId: MISSION, insightId: "insight-a", version: 1, disposition: "deferred", decisionRef: "decision-1",
    });
    const after = buildDirectorInsightSidecar(eventsOf(ledger), { missionId: MISSION });
    expect(after.items.map((item) => item.insightId)).toEqual(["insight-b"]);
    expect(after.digest).not.toBe(sidecar.digest);
  });

  test("truncates at the packet bound and counts what it does not carry", () => {
    const ledger = new InMemoryResearchLedger();
    for (let index = 1; index <= 10; index++) draft(ledger, `insight-${index}`);
    const truncated = buildDirectorInsightSidecar(eventsOf(ledger), { missionId: MISSION });
    expect(truncated.items).toHaveLength(DIRECTOR_INSIGHT_DEFAULT_MAX);
    expect(truncated.omittedCount).toBe(10 - DIRECTOR_INSIGHT_DEFAULT_MAX);
    expect(truncated.truncated).toBe(true);
    const whole = buildDirectorInsightSidecar(eventsOf(ledger), { missionId: MISSION, maxInsights: 10 });
    expect(whole.items).toHaveLength(10);
    expect(whole.truncated).toBe(false);
    expect(whole.omittedCount).toBe(0);
    // Bounded, not silently different: the delivered prefix is identical.
    expect(truncated.items).toEqual(whole.items.slice(0, DIRECTOR_INSIGHT_DEFAULT_MAX));
    for (const maxInsights of [0, 65, 1.5]) {
      expect(() => buildDirectorInsightSidecar(eventsOf(ledger), { missionId: MISSION, maxInsights })).toThrow(InsightInboxError);
    }
  });

  test("Insight content can never reach the frozen Blind Proposal", () => {
    const quiet = new InMemoryResearchLedger();
    const loud = new InMemoryResearchLedger();
    draft(loud, "insight-1", "INSERT THE LOUD IDEA HERE");
    const base = directorInput();

    // The blind stage has no decision phase at all, so no Insight can enter it.
    const quietBlind = buildDirectorPrompt(base);
    const loudBlind = buildDirectorPrompt(base);
    expect(loudBlind).toBe(quietBlind);
    expect(loudBlind).not.toContain("INSERT THE LOUD IDEA HERE");
    expect(loudBlind).not.toContain("INSIGHT");

    const quietSidecar = buildDirectorInsightSidecar(eventsOf(quiet), { missionId: MISSION });
    const loudSidecar = buildDirectorInsightSidecar(eventsOf(loud), { missionId: MISSION });
    const quietRevision = buildDirectorPrompt({ ...base, decisionPhase: { blindProposal: BLIND, insightSidecar: quietSidecar } });
    const loudRevision = buildDirectorPrompt({ ...base, decisionPhase: { blindProposal: BLIND, insightSidecar: loudSidecar } });
    expect(loudRevision).toContain("INSERT THE LOUD IDEA HERE");
    expect(loudRevision).toContain("insight-1");
    expect(quietRevision).not.toContain("INSERT THE LOUD IDEA HERE");
    // The frozen Blind Proposal bytes are identical in both revisions.
    expect(quietRevision).toContain(JSON.stringify(BLIND));
    expect(loudRevision).toContain(JSON.stringify(BLIND));
    // An empty sidecar is stated, not skipped.
    expect(quietRevision).toMatch(/no pending human insight/i);
    expect(loudRevision).not.toMatch(/no pending human insight/i);
  });

  test("all four dispositions are recorded through the ledger path with their decision ref", () => {
    const ledger = new InMemoryResearchLedger();
    for (const insightId of ["insight-ignored", "insight-rejected", "insight-proposed", "insight-deferred"]) draft(ledger, insightId);
    const sidecar = buildDirectorInsightSidecar(eventsOf(ledger), { missionId: MISSION });
    const before = ledger.events().length;
    const recorded = recordRevisionInsightDispositions(ledger, {
      missionId: MISSION,
      sidecar,
      decisionRef: "decision-group:7",
      dispositions: [
        { insightId: "insight-ignored", disposition: "ignored" },
        { insightId: "insight-rejected", disposition: "rejected", reason: "the variable is not identifiable in the current data" },
        { insightId: "insight-proposed", disposition: "experiment_proposed", proposalRef: "decision-group:7:revision" },
        { insightId: "insight-deferred", disposition: "deferred", reason: "revisit after the split contract is re-measured" },
      ],
    });
    expect(recorded.map((record) => record.disposition)).toEqual(["ignored", "rejected", "experiment_proposed", "deferred"]);
    expect(recorded.every((record) => record.decisionRef === "decision-group:7")).toBe(true);
    expect(recorded.map((record) => record.version)).toEqual([1, 1, 1, 1]);
    // Appended through the existing ledger path, and nothing else: an Insight
    // never dispatches, reserves, or promotes anything.
    const appended = ledger.events().slice(before);
    expect(appended.map((event) => event.type)).toEqual(Array(4).fill("HUMAN_INSIGHT_DISPOSITION_RECORDED"));
    expect(appended.map((event) => event.payload.decisionRef)).toEqual(Array(4).fill("decision-group:7"));
    // `ignored` and `rejected` stay distinct answers, never normalised.
    expect(new Set(recorded.map((record) => record.disposition))).toEqual(
      new Set<InsightDisposition>(["ignored", "rejected", "experiment_proposed", "deferred"]),
    );
  });

  test("a refutation owes its reason and a proposed experiment owes its proposal", () => {
    const ledger = new InMemoryResearchLedger();
    draft(ledger, "insight-1");
    draft(ledger, "insight-2");
    const sidecar = buildDirectorInsightSidecar(eventsOf(ledger), { missionId: MISSION });
    const before = ledger.events().length;
    expect(() => recordRevisionInsightDispositions(ledger, {
      missionId: MISSION, sidecar, decisionRef: "decision-1",
      dispositions: [{ insightId: "insight-1", disposition: "rejected" }],
    })).toThrow(/requires a reason/);
    expect(() => recordRevisionInsightDispositions(ledger, {
      missionId: MISSION, sidecar, decisionRef: "decision-1",
      dispositions: [{ insightId: "insight-1", disposition: "experiment_proposed" }],
    })).toThrow(/proposalRef/);
    expect(ledger.events().length).toBe(before);
  });

  test("a retry cannot disposition one Insight twice in one decision cycle", () => {
    const ledger = new InMemoryResearchLedger();
    draft(ledger, "insight-1");
    const sidecar = buildDirectorInsightSidecar(eventsOf(ledger), { missionId: MISSION });
    const dispositions = [{ insightId: "insight-1", disposition: "deferred" as const, reason: "not now" }];
    const first = recordRevisionInsightDispositions(ledger, { missionId: MISSION, sidecar, decisionRef: "decision-1", dispositions });
    const count = ledger.events().length;
    const retry = recordRevisionInsightDispositions(ledger, { missionId: MISSION, sidecar, decisionRef: "decision-1", dispositions });
    expect(retry).toEqual(first);
    expect(ledger.events().length).toBe(count);
    // The same cycle cannot quietly change its answer.
    expect(() => recordRevisionInsightDispositions(ledger, {
      missionId: MISSION, sidecar, decisionRef: "decision-1",
      dispositions: [{ insightId: "insight-1", disposition: "ignored" }],
    })).toThrow(/already dispositioned differently/);
    expect(ledger.events().length).toBe(count);
  });

  test("only pinned Insight can be dispositioned, once each, in one cycle", () => {
    const ledger = new InMemoryResearchLedger();
    draft(ledger, "insight-1");
    draft(ledger, "insight-2");
    const sidecar = buildDirectorInsightSidecar(eventsOf(ledger), { missionId: MISSION });
    expect(() => recordRevisionInsightDispositions(ledger, {
      missionId: MISSION, sidecar, decisionRef: "decision-1",
      dispositions: [{ insightId: "insight-never-read", disposition: "ignored" }],
    })).toThrow(/not pinned in this Revision/);
    expect(() => recordRevisionInsightDispositions(ledger, {
      missionId: MISSION, sidecar, decisionRef: "decision-1",
      dispositions: [
        { insightId: "insight-1", disposition: "ignored" },
        { insightId: "insight-1", disposition: "deferred" },
      ],
    })).toThrow(/twice in one decision cycle/);
    // Mandatory visibility, not mandatory adoption: a pinned Insight that got no
    // answer is a visible gap the Revision records, never a blocked Revision.
    expect(recordRevisionInsightDispositions(ledger, {
      missionId: MISSION, sidecar, decisionRef: "decision-1",
      dispositions: [{ insightId: "insight-1", disposition: "ignored" }],
    })).toHaveLength(1);
    expect(undispositionedInsightIds(sidecar, [{ insightId: "insight-1", disposition: "ignored" }])).toEqual(["insight-2"]);
    // A sidecar from another Mission cannot be used to disposition this one.
    expect(() => recordRevisionInsightDispositions(ledger, {
      missionId: MISSION, sidecar: buildDirectorInsightSidecar([], { missionId: "other-mission" }), decisionRef: "decision-1",
      dispositions: [],
    })).toThrow(/another mission/);
  });

  test("the Research Decision Packet keeps its schema, categories and digest", () => {
    const snapshot = projectResearchMemorySnapshot({
      missionId: MISSION,
      ledgerRevision: 2,
      runs: [{ runId: `${MISSION}:baseline:1`, ok: true, score: 0.5, evidenceRefs: [`runs/${MISSION}:baseline:1/result.json`] }],
    });
    const packet = projectResearchDecisionPacket(snapshot);
    const { digest, ...body } = packet;
    // No third reserved category: Insight enters as a sidecar, never as a packet slot.
    expect(Object.keys(packet).sort()).toEqual([
      "cards", "digest", "ledgerRevision", "missionId", "omissions", "omittedCardCount",
      "reserved", "schema", "snapshotDigest", "snapshotId", "truncated",
    ]);
    expect(Object.keys(packet.reserved).sort()).toEqual(["competingHypotheses", "contradictingEvidence"]);
    expect(digestValue(body)).toBe(digest);

    // Insight activity cannot move one byte of the packet a Revision also receives.
    const ledger = new InMemoryResearchLedger();
    draft(ledger, "insight-1");
    buildDirectorInsightSidecar(eventsOf(ledger), { missionId: MISSION });
    recordInsightDisposition(ledger, { missionId: MISSION, insightId: "insight-1", version: 1, disposition: "ignored", decisionRef: "decision-1" });
    expect(projectResearchDecisionPacket(projectResearchMemorySnapshot({
      missionId: MISSION,
      ledgerRevision: 2,
      runs: [{ runId: `${MISSION}:baseline:1`, ok: true, score: 0.5, evidenceRefs: [`runs/${MISSION}:baseline:1/result.json`] }],
    }))).toEqual(packet);
  });
});

const BLIND: DirectorProposal = { stateVersion: 0, action: "investigate", rationale: "measure the baseline first" };

function directorInput(): DirectorInput {
  return {
    missionId: MISSION,
    stateVersion: 0,
    objective: "learn whether temperature matters",
    contract: {} as DirectorInput["contract"],
    policy: { permissions: [], hardRules: [] },
    budget: { total: 5, units: "model-USD", consumed: 0, remaining: 5, reserved: 0 },
    stopConditions: [],
    tasks: [],
    observations: [],
  };
}
