import { describe, expect, test } from "bun:test";
import type { ClaimCard } from "../predict-reconcile";
import { LEDGER_EVENT_KINDS, ledgerEventKind } from "../evidence/ledger-kinds";
import {
  HUMAN_INSIGHT_DRAFT_SCHEMA,
  INSIGHT_INBOX_SCHEMA,
  type HumanInsightDraft,
  projectInsightInbox,
  recordInsightDisposition,
  submitInsightDraft,
} from "./insight-inbox";
import {
  InMemoryResearchLedger,
  MissionDirector,
  type EvidenceRecord,
  type ResearchEvent,
  type ResearchTask,
} from "./research-loop";

const prediction = {
  predictionId: "insight-prediction",
  hypothesis: "temperature matters",
  expectedObservation: "the evaluator returns a score",
  failureModes: ["evaluator unavailable"],
};

const tasks: readonly ResearchTask[] = [
  { taskId: "baseline", objective: "measure the baseline", estimatedCost: 1, priority: 3, prediction },
  { taskId: "cheap-check", objective: "check a cheap alternative", estimatedCost: 1, priority: 1, prediction: {
    predictionId: "cheap-prediction", hypothesis: "the cheap alternative works", expectedObservation: "the evaluator returns a score", failureModes: ["evaluation fails"],
  } },
];

const MISSION = "insight-mission";

function director(): MissionDirector {
  return new MissionDirector({ missionId: MISSION, objective: "learn", budget: 5, tasks });
}

function draftInput(overrides: Partial<Parameters<typeof submitInsightDraft>[1]> = {}) {
  return { missionId: MISSION, insightId: "insight-1", text: "temperature may be underweighted in the diffusion mechanism", author: "operator", ...overrides };
}

describe("Human Insight drafts on the Mission ledger", () => {
  test("submission appends one draft event and yields a typed draft with no epistemic authority", () => {
    const mission = director();
    const before = mission.events().length;
    const draft = submitInsightDraft(mission.ledger, draftInput({ falsificationHint: "run the split at two temperatures" }));

    const events = mission.events();
    expect(events.length).toBe(before + 1);
    const appended = events.at(-1)!;
    expect(appended.type).toBe("HUMAN_INSIGHT_DRAFT_CREATED");
    expect(appended.sequence).toBe(before + 1);
    expect(typeof appended.payload.operationId).toBe("string");
    expect(appended.payload.missionId).toBe(MISSION);

    expect(draft).toEqual({
      schema: HUMAN_INSIGHT_DRAFT_SCHEMA,
      insightId: "insight-1",
      missionId: MISSION,
      text: "temperature may be underweighted in the diffusion mechanism",
      falsificationHint: "run the split at two temperatures",
      author: "operator",
      createdOrdinal: appended.sequence,
      version: 1,
      epistemicAuthority: 0,
      decisionRelevance: "non-zero",
    });
  });

  test("the inbox schema, ordering and digest come from the ledger alone", () => {
    const mission = director();
    submitInsightDraft(mission.ledger, draftInput({ text: "first idea" }));
    submitInsightDraft(mission.ledger, draftInput({ insightId: "insight-2", text: "second idea" }));

    const inbox = projectInsightInbox(mission.events(), { missionId: MISSION });
    expect(inbox.schema).toBe(INSIGHT_INBOX_SCHEMA);
    expect(inbox.missionId).toBe(MISSION);
    expect(inbox.items.map((item) => [item.draft.insightId, item.status])).toEqual([
      ["insight-1", "pending"],
      ["insight-2", "pending"],
    ]);
    expect(inbox.digest).toMatch(/^[0-9a-f]{64}$/);
    // no independent write path: the same events rebuilt into a fresh ledger project identically.
    const rebuilt = MissionDirector.fromEvents({ missionId: MISSION, objective: "learn", budget: 5, tasks }, mission.events());
    expect(projectInsightInbox(rebuilt.ledger.events(), { missionId: MISSION })).toEqual(inbox);
    expect(projectInsightInbox(rebuilt.ledger.events(), { missionId: MISSION }).digest).toBe(inbox.digest);
  });

  test("rejection or divergence in the event set is refused instead of silently reordered", () => {
    const mission = director();
    submitInsightDraft(mission.ledger, draftInput());
    submitInsightDraft(mission.ledger, draftInput({ insightId: "insight-2", text: "second idea" }));
    const events = mission.events();
    expect(() => projectInsightInbox([...events].reverse(), { missionId: MISSION })).toThrow(/ledger order|sequence/);
    expect(() => projectInsightInbox(events, { missionId: "another-mission" })).toThrow(/another mission/);
  });

  test("re-submitting the same draft is idempotent: one event, one inbox item, one digest", () => {
    const mission = director();
    const first = submitInsightDraft(mission.ledger, draftInput());
    const digest = projectInsightInbox(mission.events(), { missionId: MISSION }).digest;
    const second = submitInsightDraft(mission.ledger, draftInput());

    expect(second).toEqual(first);
    expect(mission.events().filter((event) => event.type === "HUMAN_INSIGHT_DRAFT_CREATED")).toHaveLength(1);
    const inbox = projectInsightInbox(mission.events(), { missionId: MISSION });
    expect(inbox.items).toHaveLength(1);
    expect(inbox.digest).toBe(digest);

    // A retry that landed twice in the ledger (bypassing submit) still projects once.
    const duplicated = [...mission.events(), { ...mission.events().at(-1)!, sequence: mission.events().length + 1 }];
    const collapsed = projectInsightInbox(duplicated, { missionId: MISSION });
    expect(collapsed.items).toHaveLength(1);
    expect(collapsed.digest).toBe(digest);
  });

  test("re-using an insight id for different content is refused", () => {
    const mission = director();
    submitInsightDraft(mission.ledger, draftInput());
    expect(() => submitInsightDraft(mission.ledger, draftInput({ text: "a different idea" }))).toThrow(/insight-1/);
    const forged: ResearchEvent = {
      sequence: mission.events().length + 1,
      eventId: "forged-draft",
      type: "HUMAN_INSIGHT_DRAFT_CREATED",
      payload: { ...mission.events().at(-1)!.payload, text: "a different idea" },
    };
    expect(() => projectInsightInbox([...mission.events(), forged], { missionId: MISSION })).toThrow(/insight-1/);
  });

  test("a disposition is appended as an event and projected onto its draft", () => {
    const mission = director();
    submitInsightDraft(mission.ledger, draftInput());
    const recorded = recordInsightDisposition(mission.ledger, {
      missionId: MISSION,
      insightId: "insight-1",
      version: 1,
      disposition: "rejected",
      reason: "temperature covaries with another variable, so it is not identified here",
      decisionRef: "decision-31",
    });
    expect(recorded.disposition).toBe("rejected");
    expect(mission.events().at(-1)!.type).toBe("HUMAN_INSIGHT_DISPOSITION_RECORDED");

    const [item] = projectInsightInbox(mission.events(), { missionId: MISSION }).items;
    expect(item?.status).toBe("rejected");
    expect(item?.disposition).toEqual({
      insightId: "insight-1",
      version: 1,
      disposition: "rejected",
      reason: "temperature covaries with another variable, so it is not identified here",
      decisionRef: "decision-31",
    });
    // `ignored` is recorded verbatim and never normalised into `rejected`.
    recordInsightDisposition(mission.ledger, { missionId: MISSION, insightId: "insight-1", version: 1, disposition: "ignored", decisionRef: "decision-32" });
    expect(projectInsightInbox(mission.events(), { missionId: MISSION }).items[0]?.status).toBe("ignored");
  });

  test("dispositions are validated against the ledger they land in", () => {
    const mission = director();
    expect(() => recordInsightDisposition(mission.ledger, { missionId: MISSION, insightId: "unknown", version: 1, disposition: "ignored", decisionRef: "d-1" })).toThrow(/unknown insight/);
    submitInsightDraft(mission.ledger, draftInput());
    expect(() => recordInsightDisposition(mission.ledger, { missionId: MISSION, insightId: "insight-1", version: 2, disposition: "ignored", decisionRef: "d-1" })).toThrow(/version/);
    expect(() => recordInsightDisposition(mission.ledger, { missionId: MISSION, insightId: "insight-1", version: 1, disposition: "considered" as never, decisionRef: "d-1" })).toThrow(/disposition/);
    // a refutation owes its reasons; a proposed experiment owes its proposal
    expect(() => recordInsightDisposition(mission.ledger, { missionId: MISSION, insightId: "insight-1", version: 1, disposition: "rejected", decisionRef: "d-1" })).toThrow(/requires a reason/);
    expect(() => recordInsightDisposition(mission.ledger, { missionId: MISSION, insightId: "insight-1", version: 1, disposition: "experiment_proposed", decisionRef: "d-1" })).toThrow(/requires a proposalRef/);
    expect(() => submitInsightDraft(mission.ledger, draftInput({ insightId: "insight-2", text: "   " }))).toThrow(/text/);
    // a draft filed against another Mission is refused at write time, not at read time
    expect(() => submitInsightDraft(mission.ledger, draftInput({ missionId: "another-mission", insightId: "insight-3" }))).toThrow(/another mission/);
  });

  test("a draft cannot be coerced into an Evidence or Verified Claim record", () => {
    const mission = director();
    const draft = submitInsightDraft(mission.ledger, draftInput());

    // Type level: the draft carries the zero-authority literals and is not assignable
    // to either authority-bearing record.
    expect(draft.epistemicAuthority).toBe(0);
    expect(draft.decisionRelevance).toBe("non-zero");
    // @ts-expect-error a Human Insight draft is never a Verified Claim
    const claim: ClaimCard = draft;
    // @ts-expect-error a Human Insight draft is never Evidence
    const evidence: EvidenceRecord = draft;
    expect([claim, evidence]).toHaveLength(2);

    // The ledger's Approval/Evidence/Evaluation accounting has no kind for Insight:
    // it is keyed on the competition-arm MissionEventType, so a research-ledger
    // insight event is unclassifiable (`null`) and can never be Evidence.
    const kinds = LEDGER_EVENT_KINDS as Record<string, string>;
    for (const type of ["HUMAN_INSIGHT_DRAFT_CREATED", "HUMAN_INSIGHT_DISPOSITION_RECORDED"]) {
      expect(kinds[type]).toBeUndefined();
      expect(ledgerEventKind(type)).toBeNull();
    }
    // positive control: the same classifier does label real Evidence
    expect(ledgerEventKind("EVALUATOR_SUCCEEDED")).toBe("Evidence");

    // Runtime: the event payload is closed, so evidence-shaped fields cannot ride along.
    for (const extra of [{ evidenceRefs: [] }, { claimId: "claim-1" }, { verified: true }, { evidenceGatePassed: true }]) {
      const forged = { ...mission.events().at(-1)!, sequence: mission.events().length + 1, eventId: `forged-${Object.keys(extra)[0]}`, payload: { ...mission.events().at(-1)!.payload, ...extra } };
      expect(() => projectInsightInbox([...mission.events(), forged], { missionId: MISSION })).toThrow();
    }
  });

  test("submission never interrupts, aborts or pre-empts a running Run", () => {
    const mission = director();
    const running = mission.selectNextTask();
    expect(running?.status).toBe("RUNNING");
    const stateBefore = mission.state();
    const eventsBefore = mission.events().length;

    const draft = submitInsightDraft(mission.ledger, draftInput());
    const appended = mission.events().slice(eventsBefore);

    expect(appended).toHaveLength(1);
    expect(appended[0]?.type).toBe("HUMAN_INSIGHT_DRAFT_CREATED");
    expect(appended.map((event) => event.type)).not.toContain("MISSION_STOPPED");
    expect(mission.state()).toEqual(stateBefore);
    expect(mission.state().tasks[running!.taskId]?.status).toBe("RUNNING");
    expect(mission.events().at(-1)?.payload).toMatchObject({ insightId: draft.insightId });
    // the running task still completes normally afterwards
    mission.completeTask(running!.taskId, {
      operationId: "insight-run-completion",
      reconcile: { status: "inconclusive", observationRefs: [], artifactRefs: [], evidenceRefs: [], independentEvaluator: false, evidenceGatePassed: false },
    });
    expect(mission.state().tasks[running!.taskId]?.status).toBe("COMPLETED");
  });

  test("non-insight ledger events are ignored by the projection", () => {
    const mission = director();
    mission.selectNextTask();
    submitInsightDraft(mission.ledger, draftInput());
    const inbox = projectInsightInbox(mission.events(), { missionId: MISSION });
    expect(inbox.items).toHaveLength(1);
    expect(projectInsightInbox(new InMemoryResearchLedger().events(), { missionId: MISSION }).items).toEqual([]);
  });
});
