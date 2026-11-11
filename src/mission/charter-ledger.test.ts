import { describe, expect, test } from "bun:test";
import {
  CHARTER_EVENT_SCHEMA,
  CharterApprovalRejectedError,
  CharterApprovalRequiredError,
  CharterLedgerError,
  addBenchmarkExtension,
  approveResearchCharter,
  freezeBenchmarkProtocol,
  projectCharterLedger,
  proposeResearchCharter,
  requireApprovedCharter,
} from "./charter-ledger";
import { researchCharterFixture as baseCharter } from "../fixtures/research-charter";
import { ResearchCharterValidationError, charterDigest } from "./research-charter";
import { InMemoryResearchLedger, MissionDirector, type ResearchEvent, type ResearchTask } from "./research-loop";
import type { CharterLedger } from "./charter-ledger";

const MISSION = "charter-mission";

const tasks: readonly ResearchTask[] = [{ taskId: "baseline", objective: "measure the baseline" }];

function mission(): MissionDirector {
  return new MissionDirector({ missionId: MISSION, objective: "improve conditional molecular generation", budget: 10, tasks });
}

/** A second charter version: same design, a changed primary protocol (new version + seeds). */
function nextCharter(): any {
  const charter = baseCharter();
  charter.version = 2;
  charter.evaluation.protocolVersion = "p2";
  charter.evaluation.seedStrategy = { seeds: [1, 2, 3, 4, 5] };
  return charter;
}

function propose(ledger: CharterLedger, charter: any = baseCharter(), overrides: Record<string, unknown> = {}) {
  return proposeResearchCharter(ledger, {
    missionId: MISSION,
    charter,
    artifactRef: `artifacts/charter-v${charter.version}.json`,
    proposedBy: "scout-agent",
    ...overrides,
  });
}

function approve(ledger: CharterLedger, charter: any = baseCharter(), overrides: Record<string, unknown> = {}) {
  return approveResearchCharter(ledger, {
    missionId: MISSION,
    charterId: charter.charterId,
    charterVersion: charter.version,
    charterDigest: charterDigest(charter),
    approvedBy: "Azhi-ss",
    authorization: { requested: true, token: "/approve-charter", missionSelector: "displayed" },
    ...overrides,
  });
}

function freeze(ledger: CharterLedger, charter: any = baseCharter(), overrides: Record<string, unknown> = {}) {
  return freezeBenchmarkProtocol(ledger, {
    missionId: MISSION,
    charter,
    artifactRef: `artifacts/protocol-${charter.evaluation.protocolVersion}.json`,
    ...overrides,
  });
}

function extension(ledger: CharterLedger, overrides: Record<string, unknown> = {}) {
  return addBenchmarkExtension(ledger, {
    missionId: MISSION,
    extensionId: "ext-diffsbdd",
    baselineId: "b-diffsbdd",
    comparator: "DiffSBDD (2023)",
    rationale: "a newer conditional generator that appeared after the protocol was frozen",
    artifactRef: "artifacts/ext-diffsbdd.json",
    ...overrides,
  });
}

/** Proposed + approved + frozen p1; the state a long-running research loop may start from. */
function frozenMission(): MissionDirector {
  const director = mission();
  propose(director.ledger);
  approve(director.ledger);
  freeze(director.ledger);
  return director;
}

function projected(director: MissionDirector) {
  return projectCharterLedger(director.events(), { missionId: MISSION });
}

describe("charter proposals", () => {
  test("record version, digest, schema and an artifact reference only", () => {
    const director = mission();
    const before = director.events().length;
    const proposal = propose(director.ledger);

    const events = director.events();
    expect(events).toHaveLength(before + 1);
    const appended = events.at(-1)!;
    expect(appended.type).toBe("RESEARCH_CHARTER_PROPOSED");
    expect(appended.sequence).toBe(before + 1);
    expect(Object.keys(appended.payload).sort()).toEqual([
      "artifactRef", "charterDigest", "charterId", "charterSchema", "charterVersion",
      "missionId", "operationId", "proposedBy", "schema",
    ]);
    // The ledger is not a document store: full charter text stays in the artifact.
    expect(appended.payload.objective).toBeUndefined();
    expect(appended.payload.evaluation).toBeUndefined();

    expect(proposal).toEqual({
      charterId: "nose-conditional-generation",
      charterVersion: 1,
      charterDigest: charterDigest(baseCharter()),
      artifactRef: "artifacts/charter-v1.json",
      proposedBy: "scout-agent",
      proposedOrdinal: before + 1,
    });
  });

  test("reject an invalid charter with the C1 validation issues and append nothing", () => {
    const director = mission();
    const invalid = baseCharter();
    delete invalid.evaluation;
    expect(() => propose(director.ledger, invalid)).toThrow(ResearchCharterValidationError);
    expect(director.events().some((event) => event.type === "RESEARCH_CHARTER_PROPOSED")).toBe(false);
  });

  test("refuse a second digest for the same charter version", () => {
    const director = mission();
    propose(director.ledger);
    const edited = baseCharter();
    edited.objective.question = "a quietly edited question";
    expect(() => propose(director.ledger, edited)).toThrow(/already proposed/);
  });

  test("collapse an identical retry instead of duplicating the proposal", () => {
    const director = mission();
    const first = propose(director.ledger);
    const count = director.events().length;
    expect(propose(director.ledger)).toEqual(first);
    expect(director.events()).toHaveLength(count);
  });

  test("refuse a proposal that moves the charter version backwards", () => {
    const director = mission();
    propose(director.ledger, nextCharter());
    expect(() => propose(director.ledger)).toThrow(/version/);
  });
});

describe("human approval", () => {
  test("records a user approval pinning the proposed version and digest", () => {
    const director = mission();
    propose(director.ledger);
    const approval = approve(director.ledger);

    expect(approval.charterVersion).toBe(1);
    expect(approval.charterDigest).toBe(charterDigest(baseCharter()));
    expect(approval.source).toBe("user");
    const state = projected(director);
    expect(state.approval).toEqual(approval);
  });

  test("refuses a model-authored approval and appends nothing", () => {
    const director = mission();
    propose(director.ledger);
    const count = director.events().length;
    expect(() => approve(director.ledger, baseCharter(), {
      authorization: { requested: true, token: "/approve-charter", missionSelector: "displayed", source: "model" },
    })).toThrow(CharterApprovalRejectedError);
    expect(director.events()).toHaveLength(count);
  });

  test("refuses approval that was not requested or that targets another mission", () => {
    const director = mission();
    propose(director.ledger);
    expect(() => approve(director.ledger, baseCharter(), {
      authorization: { requested: false, token: "maybe approve", missionSelector: "displayed" },
    })).toThrow(CharterApprovalRejectedError);
    expect(() => approve(director.ledger, baseCharter(), {
      authorization: { requested: true, token: "/approve-charter", missionSelector: "another-mission" },
    })).toThrow(CharterApprovalRejectedError);
  });

  test("refuses to approve a version and digest that was never proposed", () => {
    const director = mission();
    expect(() => approve(director.ledger)).toThrow(/never proposed/);
    propose(director.ledger);
    expect(() => approve(director.ledger, baseCharter(), { charterDigest: "0".repeat(64) })).toThrow(/never proposed/);
  });

  test("a later charter edit cannot silently change what was approved", () => {
    const director = mission();
    propose(director.ledger);
    const approved = approve(director.ledger);
    propose(director.ledger, nextCharter());

    const state = projected(director);
    expect(state.approval).toEqual(approved);
    expect(state.proposals.map((proposal) => proposal.charterVersion)).toEqual([1, 2]);
    expect(state.digest).toBe(projected(director).digest);
  });

  test("rejects a model-sourced approval event written by another writer", () => {
    const director = mission();
    propose(director.ledger);
    director.ledger.append({
      type: "RESEARCH_CHARTER_APPROVED",
      payload: {
        schema: CHARTER_EVENT_SCHEMA,
        missionId: MISSION,
        operationId: "forged-approval",
        charterId: baseCharter().charterId,
        charterVersion: 1,
        charterDigest: charterDigest(baseCharter()),
        approvedBy: "director-model",
        authorizationToken: "/approve-charter",
        source: "model",
      },
    });
    expect(() => projected(director)).toThrow(/human authorization/);
  });

  test("refuses re-approving an older charter version", () => {
    const director = mission();
    propose(director.ledger);
    propose(director.ledger, nextCharter());
    approve(director.ledger, nextCharter());
    expect(() => approve(director.ledger)).toThrow(/move backwards/);
  });
});

describe("frozen benchmark protocol", () => {
  test("records the protocol version, digest and frozen baseline set", () => {
    const director = mission();
    propose(director.ledger);
    expect(() => freeze(director.ledger)).toThrow(CharterApprovalRequiredError);

    approve(director.ledger);
    const frozen = freeze(director.ledger);
    expect(frozen.protocolVersion).toBe("p1");
    expect(frozen.protocolDigest).toBe(charterDigest(baseCharter()));
    expect(frozen.baselineIds).toEqual(["b-simple", "b-strong", "b-strong-repro", "b-ablation"]);
    expect(frozen.artifactRef).toBe("artifacts/protocol-p1.json");
    expect(projected(director).frozenProtocol).toEqual(frozen);
  });

  test("refuses to freeze a protocol from a charter that is not the approved one", () => {
    const director = mission();
    propose(director.ledger);
    approve(director.ledger);
    expect(() => freeze(director.ledger, nextCharter())).toThrow(/approved/);
  });

  test("a primary-protocol change needs a new version with a recorded reason", () => {
    const director = frozenMission();
    propose(director.ledger, nextCharter());
    approve(director.ledger, nextCharter());

    expect(() => freeze(director.ledger, nextCharter())).toThrow(/reason/);
    const p2 = freeze(director.ledger, nextCharter(), { reason: "the fixed 3-seed sample was under-powered for the diversity metric" });
    expect(p2.protocolVersion).toBe("p2");
    expect(p2.reason).toBe("the fixed 3-seed sample was under-powered for the diversity metric");

    const state = projected(director);
    expect(state.frozenProtocol?.protocolVersion).toBe("p2");
    expect(state.frozenHistory.map((entry) => entry.protocolVersion)).toEqual(["p1", "p2"]);
  });

  test("keeps the earlier protocol version and digest for results that already ran", () => {
    const director = frozenMission();
    const p1 = projected(director).frozenProtocol!;
    propose(director.ledger, nextCharter());
    approve(director.ledger, nextCharter());
    freeze(director.ledger, nextCharter(), { reason: "more seeds for the same metric set" });

    const history = projected(director).frozenHistory;
    expect(history[0]).toEqual(p1);
    expect(history[0].protocolDigest).toBe(charterDigest(baseCharter()));
  });

  test("refuses re-freezing a protocol version with different content", () => {
    const director = frozenMission();
    propose(director.ledger, nextCharter());
    approve(director.ledger, nextCharter());
    freeze(director.ledger, nextCharter(), { reason: "more seeds" });

    // p1 is already frozen; re-freezing it under a changed approval would re-score old results.
    const replay = baseCharter();
    replay.evaluation.seedStrategy = { seeds: [9] };
    const replayV3 = { ...replay, version: 3 };
    replayV3.evaluation.protocolVersion = "p1";
    propose(director.ledger, replayV3);
    approve(director.ledger, replayV3);
    expect(() => freeze(director.ledger, replayV3)).toThrow(/already frozen/);
  });
});

describe("benchmark extensions", () => {
  test("add a supplementary comparator without changing the frozen set or protocol digest", () => {
    const director = frozenMission();
    const before = projected(director).frozenProtocol!;
    const added = extension(director.ledger);

    const after = projected(director);
    expect(added.protocolVersion).toBe("p1");
    expect(added.protocolDigest).toBe(before.protocolDigest);
    expect(after.frozenProtocol).toEqual(before);
    expect(after.frozenProtocol?.baselineIds).not.toContain("b-diffsbdd");
    expect(after.extensions).toEqual([added]);
  });

  test("refuse an extension before any protocol is frozen", () => {
    const director = mission();
    propose(director.ledger);
    approve(director.ledger);
    expect(() => extension(director.ledger)).toThrow(/frozen/);
  });

  test("refuse a comparator already in the frozen set or already extended", () => {
    const director = frozenMission();
    expect(() => extension(director.ledger, { baselineId: "b-strong" })).toThrow(/frozen set/);
    extension(director.ledger);
    expect(() => extension(director.ledger, { extensionId: "ext-2" })).toThrow(/already added/);
    expect(() => extension(director.ledger, { baselineId: "b-diffsbdd-2" })).toThrow(/already added/);
  });

  test("collapse an identical retry", () => {
    const director = frozenMission();
    const first = extension(director.ledger);
    const count = director.events().length;
    expect(extension(director.ledger)).toEqual(first);
    expect(director.events()).toHaveLength(count);
  });
});

describe("replay and the research-loop gate", () => {
  test("reconstructs the approved charter version and frozen protocol deterministically", () => {
    const director = frozenMission();
    extension(director.ledger);
    const first = projected(director);
    const second = projectCharterLedger(director.events(), { missionId: MISSION });
    expect(second).toEqual(first);
    expect(first.approval?.charterVersion).toBe(1);
    expect(first.frozenProtocol?.protocolVersion).toBe("p1");
    expect(first.frozenProtocol?.artifactRef).toBe("artifacts/protocol-p1.json");
  });

  test("refuses to start a long-running loop on an unapproved charter", () => {
    const director = mission();
    propose(director.ledger);
    expect(() => requireApprovedCharter(director.events(), { missionId: MISSION })).toThrow(CharterApprovalRequiredError);
  });

  test("refuses to start when the charter is approved but no protocol is frozen", () => {
    const director = mission();
    propose(director.ledger);
    approve(director.ledger);
    expect(() => requireApprovedCharter(director.events(), { missionId: MISSION })).toThrow(/no frozen benchmark protocol/);
  });

  test("refuses to start when a newer charter is approved than the frozen protocol", () => {
    const director = frozenMission();
    propose(director.ledger, nextCharter());
    approve(director.ledger, nextCharter());
    expect(() => requireApprovedCharter(director.events(), { missionId: MISSION })).toThrow(/freeze the new protocol/);
  });

  test("returns the pinned charter and protocol reference once approved and frozen", () => {
    const director = frozenMission();
    extension(director.ledger);
    const reference = requireApprovedCharter(director.events(), { missionId: MISSION });
    expect(reference.approval.charterVersion).toBe(1);
    expect(reference.approval.charterDigest).toBe(charterDigest(baseCharter()));
    expect(reference.protocol.protocolVersion).toBe("p1");
    expect(reference.protocol.protocolDigest).toBe(reference.approval.charterDigest);
    expect(reference.extensions.map((entry) => entry.baselineId)).toEqual(["b-diffsbdd"]);
  });

  test("keeps the Mission reducer replaying when charter events are interleaved", () => {
    const director = frozenMission();
    extension(director.ledger);
    expect(director.state().missionId).toBe(MISSION);
    expect(MissionDirector.replay(director.events()).missionId).toBe(MISSION);
  });

  test("rejects charter events that break ledger ordering or the closed payload", () => {
    const director = mission();
    propose(director.ledger);
    const events = director.events();

    const outOfOrder = events.map((event) => event.type === "RESEARCH_CHARTER_PROPOSED" ? { ...event, sequence: 0 } : event);
    expect(() => projectCharterLedger(outOfOrder, { missionId: MISSION })).toThrow(CharterLedgerError);

    const withExtraField: ResearchEvent[] = [...events, {
      sequence: events.length + 1,
      eventId: "extra",
      type: "RESEARCH_CHARTER_PROPOSED",
      payload: { ...events.at(-1)!.payload, objective: { question: "a second copy of the charter" } },
    }];
    expect(() => projectCharterLedger(withExtraField, { missionId: MISSION })).toThrow(/undeclared field/);
  });

  test("a bare ledger without the Mission event cannot own charter events", () => {
    const ledger = new InMemoryResearchLedger();
    expect(() => propose(ledger)).toThrow(/Mission ledger/);
  });
});
