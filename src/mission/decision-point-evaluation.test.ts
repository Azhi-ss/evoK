/**
 * L1 decision-point counterfactual evaluation (#232, parent spec #222).
 *
 * One frozen decision point is re-decided once per Off/Sham/Real packet over a
 * shared base state. Nothing is dispatched, no Experiment budget is reserved,
 * and the score references the action the original Mission actually took. The
 * report states a DIRECTION only, carries both caveats, and refuses an
 * under-powered sample (< 50 points).
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESEARCH_MEMORY_EVALUATION_MODES,
  projectResearchDecisionPacket,
  projectResearchMemorySnapshot,
  shamResearchDecisionPacket,
} from "../memory";
import { digestValue } from "../execution/security-boundary";
import { missionResearchSource, type ExperimentTrailEntry, type MissionRecord } from "./mission-start";
import {
  buildDirectorInput,
  recordRetainedState,
  type DirectorInput,
  type DirectorProposal,
} from "./mission-director";
import { RESEARCH_MEMORY_CONTROL_CAVEAT } from "./memory-evaluation";
import { submitInsightDraft } from "./insight-inbox";
import { buildDirectorInsightSidecar, type DirectorInsightSidecar } from "./director-insight-sidecar";
import { InMemoryResearchLedger } from "./research-loop";
import {
  DECISION_POINT_HINDSIGHT_SCORING,
  DECISION_POINT_MIN_SAMPLE,
  DECISION_POINT_SELECTION_BIAS_CAVEAT,
  DECISION_POINT_TRAJECTORY_CAVEAT,
  evaluateDecisionPoint,
  summarizeDecisionPoints,
  type DecisionPointInsight,
  type FrozenDecisionPoint,
} from "./decision-point-evaluation";

const HERE = dirname(fileURLToPath(import.meta.url));

const USAGE = {
  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const POLICY = { permissions: ["read-project"], hardRules: [], stopConditions: ["budget exhausted"] };
const AT = { baseline: "2026-01-01T00:00:00.000Z", one: "2026-01-01T00:01:00.000Z", two: "2026-01-01T00:02:00.000Z" };

function trail(overrides: Partial<ExperimentTrailEntry> & { runId: string; at: string }): ExperimentTrailEntry {
  return {
    attempt: 1,
    action: "investigate",
    ok: true,
    taskObjective: "materialize answer.txt",
    evidenceRefs: [],
    ...overrides,
  };
}

function recordOf(id = "m-l1", overrides: Partial<MissionRecord> = {}): MissionRecord {
  return {
    schemaVersion: 1,
    id,
    status: "iteration-limit",
    stateVersion: 1,
    objective: "decide the next bounded research action",
    contract: {
      objective: "decide the next bounded research action",
      expectedOutputs: ["answer.txt"],
      evaluationMethod: "file-answer-deterministic",
      metric: "answer",
      hardRules: [],
    },
    budget: { total: 1, units: "model-USD", consumed: 0.2, remaining: 0.8 },
    reserved: 0,
    usage: { intake: { tokens: USAGE.tokens, cost: USAGE.cost }, runs: [] },
    runs: {},
    permissions: ["read-project"],
    stopConditions: ["budget exhausted", "evidence conclusive"],
    modelTier: "default",
    tasks: [{ taskId: "task-baseline", objective: "produce the baseline artifact", expectedOutputs: ["answer.txt"], source: "intake" }],
    decisions: [],
    experiments: [
      trail({ runId: `${id}:exp:1`, at: AT.one, taskObjective: "materialize answer.txt", evaluation: { ok: true, score: 0.7 } }),
      trail({ runId: `${id}:exp:2`, at: AT.two, action: "change-direction", taskObjective: "probe a competing kernel", evaluation: { ok: true, score: 0.6 } }),
    ],
    history: [],
    createdAt: AT.baseline,
    updatedAt: AT.two,
    ...overrides,
  } as MissionRecord;
}

function baseStateOf(record: MissionRecord): DirectorInput {
  return buildDirectorInput(record, POLICY);
}

function proposal(objective: string, action: "investigate" | "change-direction" = "investigate"): DirectorProposal {
  return {
    stateVersion: 1,
    action,
    rationale: `bounded next step: ${objective}`,
    task: { objective, expectedOutputs: ["answer.txt"] },
    expectedCost: 0.001,
  };
}

/** A deterministic Director that only diverges when real research content is pinned. */
function scriptedDirector(chosen?: (input: DirectorInput) => DirectorProposal) {
  const calls: DirectorInput[] = [];
  return {
    calls,
    director: {
      id: "l1-scripted-director",
      async decide(input: DirectorInput) {
        calls.push(structuredClone(input));
        const packet = input.decisionPhase?.memoryPacket;
        const researchContent = packet !== undefined && packet.control !== "sham" && packet.cards.length > 0;
        const picked = chosen?.(input)
          ?? (researchContent ? proposal("probe the memory-informed competing kernel", "change-direction") : proposal("materialize answer.txt again"));
        return { proposal: picked, sessionId: "l1-session", usage: USAGE };
      },
    },
  };
}

/** One arm's Insight pin, built the way a Revision would build it. */
function sidecarOf(missionId: string, insightIds: readonly string[] = ["insight-a", "insight-b"]): DirectorInsightSidecar {
  const ledger = new InMemoryResearchLedger();
  for (const insightId of insightIds) {
    submitInsightDraft(ledger, { missionId, insightId, text: `${insightId}: temperature may be underweighted`, author: "operator" });
  }
  return buildDirectorInsightSidecar(ledger.events(), { missionId });
}

/** The default fixture: one identical Insight snapshot per arm (D7 / §6). */
function identicalInsight(missionId: string): DecisionPointInsight {
  return RESEARCH_MEMORY_EVALUATION_MODES.map((mode) => ({ mode, sidecar: sidecarOf(missionId) }));
}

/** Re-pins one item's version and keeps the digest a real derivation, not a stale bytes blob. */
function reversioned(sidecar: DirectorInsightSidecar, index: number, version: number): DirectorInsightSidecar {
  const { digest: _digest, ...body } = sidecar;
  const items = body.items.map((item, at) => (at === index ? { ...item, version } : item));
  return { ...body, items, digest: digestValue({ ...body, items }) };
}

function pointOf(record: MissionRecord, overrides: Partial<FrozenDecisionPoint> = {}): FrozenDecisionPoint {
  const real = projectResearchDecisionPacket(projectResearchMemorySnapshot(missionResearchSource(record)));
  return {
    pointId: `${record.id}:director:1`,
    baseState: baseStateOf(record),
    // Read independently of the projection: the durable Mission state the arms
    // may never lose (F5 / #231).
    missionState: recordRetainedState(record),
    blindProposal: proposal("materialize answer.txt again"),
    packets: [{ mode: "off" }, { mode: "sham", packet: shamResearchDecisionPacket(real) }, { mode: "real", packet: real }],
    insight: identicalInsight(record.id),
    actionTaken: { runId: `${record.id}:exp:3`, proposal: proposal("probe a competing kernel", "change-direction") },
    futureRunIds: [],
    ...overrides,
  };
}

function researchPacketOf(point: FrozenDecisionPoint) {
  const real = point.packets.find((entry) => entry.mode === "real")?.packet;
  if (real === undefined) throw new Error("test fixture needs a real packet");
  return real;
}

describe("L1 one decision point, three arms (R1 / A2 / A5)", () => {
  test("returns one proposal per arm and dispatches no Experiment", async () => {
    const record = recordOf();
    const point = pointOf(record);
    const budgetBefore = structuredClone(point.baseState.budget);
    const { director, calls } = scriptedDirector();
    const result = await evaluateDecisionPoint({ point, director });

    // One revision call per arm, in the fixed mode order, each on a shared base state.
    expect(calls).toHaveLength(3);
    expect(result.arms.map((arm) => arm.mode)).toEqual(["off", "sham", "real"]);
    expect(calls.map((input) => input.decisionPhase?.memoryPacket?.control ?? "none")).toEqual(["none", "sham", "none"]);
    // Nothing is dispatched and no Experiment budget is reserved or consumed.
    expect(result.dispatchedExperiments).toBe(0);
    expect(point.baseState.budget).toEqual(budgetBefore);
    for (const call of calls) expect(call.budget).toEqual(budgetBefore);
  });

  test("the base state is byte-identical across arms except the Memory packet", async () => {
    const point = pointOf(recordOf());
    const { director, calls } = scriptedDirector();
    await evaluateDecisionPoint({ point, director });
    const baseDigest = digestValue(point.baseState);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      // Dropping ONLY the decision phase reproduces the shared base state.
      const { decisionPhase: _phase, ...bare } = call;
      expect(digestValue(bare)).toBe(baseDigest);
      expect(call.decisionPhase?.blindProposal).toEqual(point.blindProposal);
    }
    // Off carries no packet at all; Sham is the schema-only control input.
    expect((calls[0]!.decisionPhase!.memoryPacket)).toBeUndefined();
    expect(calls[1]!.decisionPhase!.memoryPacket!.control).toBe("sham");
    expect(calls[2]!.decisionPhase!.memoryPacket!.control).toBeUndefined();
  });

  test("proposals diverge where Memory is relevant", async () => {
    const point = pointOf(recordOf());
    const { director } = scriptedDirector();
    const result = await evaluateDecisionPoint({ point, director });
    const [off, sham, real] = result.arms;
    expect(off!.proposal.task?.objective).toBe("materialize answer.txt again");
    expect(sham!.proposal.task?.objective).toBe("materialize answer.txt again");
    expect(real!.proposal.task?.objective).toBe("probe the memory-informed competing kernel");
    // The controller-derived delta says what Memory changed, not the model.
    expect(off!.delta).toBe("unchanged");
    expect(real!.delta).toBe("replaced");
    expect(new Set(result.arms.map((arm) => digestValue(arm.proposal))).size).toBe(2);
  });

  test("refuses a missing, duplicated or mislabelled arm packet", async () => {
    const point = pointOf(recordOf());
    const [off, sham, real] = point.packets;
    const { director } = scriptedDirector();
    await expect(evaluateDecisionPoint({ point: { ...point, packets: [off!, sham!] }, director })).rejects.toThrow(/exactly one .*off.*sham.*real/);
    await expect(evaluateDecisionPoint({ point: { ...point, packets: [off!, sham!, real!, real!] }, director })).rejects.toThrow(/duplicate/);
    // Off is the Memory-denied arm: handing it a packet would hide Memory in the control.
    await expect(evaluateDecisionPoint({ point: { ...point, packets: [{ mode: "off", packet: real!.packet }, sham!, real!] }, director })).rejects.toThrow(/off arm carries no Memory packet/);
    // A Sham arm without the control packet is not a control input.
    await expect(evaluateDecisionPoint({ point: { ...point, packets: [off!, { mode: "sham", packet: real!.packet }, real!] }, director })).rejects.toThrow(/sham.*control/);
  });
});

describe("L1 holds Insight constant across arms (#241, #238 D7 / §6)", () => {
  const PINNED = [{ insightId: "insight-a", version: 1 }, { insightId: "insight-b", version: 1 }];

  test("every arm reads the identical pinned Insight: same ids, versions, order", async () => {
    const point = pointOf(recordOf());
    const { director, calls } = scriptedDirector();
    const result = await evaluateDecisionPoint({ point, director });
    const handed = calls.map((call) => call.decisionPhase!.insightSidecar);
    // All three arms read one snapshot: a differing arm would measure the
    // operator's intuition instead of Memory.
    expect(handed.map((sidecar) => sidecar.digest)).toEqual([handed[0]!.digest, handed[0]!.digest, handed[0]!.digest]);
    expect(handed[0]!.items.map((item) => [item.insightId, item.version])).toEqual(PINNED.map((pin) => [pin.insightId, pin.version]));
    // The Sham arm stays a control on Memory content only: same Insight as Real.
    expect(calls[1]!.decisionPhase!.memoryPacket!.control).toBe("sham");
    expect(handed[1]).toEqual(handed[2]!);
    // Insight is never Evidence and never dispatches: the arms only amend the proposal.
    expect(result.dispatchedExperiments).toBe(0);
    expect(result.insight.state).toBe("identical");
    expect(result.insight.pinned).toEqual(PINNED);
    // The recorded digest is the snapshot the arms read, so the pin is re-verifiable.
    expect(result.insight.digest).toBe(handed[0]!.digest);
  });

  test("refuses arms that read different Insight, naming the mismatch", async () => {
    const record = recordOf();
    const point = pointOf(record);
    const off = { mode: "off" as const, sidecar: sidecarOf(record.id) };
    const sham = { mode: "sham" as const, sidecar: sidecarOf(record.id) };
    const real = { mode: "real" as const, sidecar: sidecarOf(record.id) };
    const { director, calls } = scriptedDirector();
    // Same ids, different version: the arms read different bytes for one Insight.
    await expect(evaluateDecisionPoint({
      point: { ...point, insight: [off, { mode: "sham" as const, sidecar: reversioned(sham.sidecar, 0, 2) }, real] },
      director,
    })).rejects.toThrow(/identical Insight snapshot.*off.*sham/);
    // Same ids, different order: the pin, not just the set, is the contract.
    await expect(evaluateDecisionPoint({
      point: { ...point, insight: [off, { mode: "sham" as const, sidecar: sidecarOf(record.id, ["insight-b", "insight-a"]) }, real] },
      director,
    })).rejects.toThrow(/identical Insight snapshot/);
    // An arm with no Insight at all is not a constant: missing and duplicated arms are refused.
    await expect(evaluateDecisionPoint({ point: { ...point, insight: [off, real] }, director })).rejects.toThrow(/missing \[sham\]/);
    await expect(evaluateDecisionPoint({ point: { ...point, insight: [off, sham, real, real] }, director })).rejects.toThrow(/duplicate \[real\]/);
    // Insight is Mission-scoped: another Mission's pin is not this point's context.
    await expect(evaluateDecisionPoint({
      point: { ...point, insight: [off, { mode: "sham" as const, sidecar: sidecarOf("other-mission") }, real] },
      director,
    })).rejects.toThrow(/Mission-scoped/);
    // Refused before any priced decision call is made.
    expect(calls).toHaveLength(0);
  });

  test("Insight can be disabled entirely, and the choice is visible in the report", async () => {
    const point = pointOf(recordOf(), { insight: "disabled" });
    const { director, calls } = scriptedDirector();
    const result = await evaluateDecisionPoint({ point, director });
    // Disabled is still an explicit empty pin: loading Insight is never a skipped stage (#240 / §4.1).
    for (const call of calls) {
      const sidecar = call.decisionPhase!.insightSidecar;
      expect(sidecar.items).toEqual([]);
      expect(sidecar.omittedCount).toBe(0);
      expect(sidecar.missionId).toBe("m-l1");
    }
    expect(result.insight).toEqual({ state: "disabled", pinned: [] });
    const disabled = await Promise.all(Array.from({ length: DECISION_POINT_MIN_SAMPLE }, async (_unused, index) => {
      const { director: armDirector } = scriptedDirector();
      return evaluateDecisionPoint({ point: pointOf(recordOf(`m-l1-off-${index}`), { insight: "disabled" }), director: armDirector });
    }));
    expect(summarizeDecisionPoints(disabled).insight).toEqual({ state: "disabled", pinned: [], digests: [] });
  });
});

describe("L1 refuses future information (A3)", () => {
  test("a packet naming a Run produced after the decision point is refused", async () => {
    const point = pointOf(recordOf());
    const real = researchPacketOf(point);
    const leaked = {
      ...real,
      cards: real.cards.map((card) => ({ ...card, summary: `${card.summary} future:exp:9` })),
    };
    const { director, calls } = scriptedDirector();
    await expect(evaluateDecisionPoint({
      point: {
        ...point,
        futureRunIds: ["future:exp:9"],
        packets: [
          { mode: "off" },
          { mode: "sham", packet: shamResearchDecisionPacket(leaked) },
          { mode: "real", packet: leaked },
        ],
      },
      director,
    })).rejects.toThrow(/future:exp:9/);
    // A control packet that itself names the future is refused too, not only a
    // research packet: the guard reads the delivered cards of every armed mode.
    const sham = point.packets.find((entry) => entry.mode === "sham")!.packet!;
    const leakedControl = {
      ...sham,
      cards: sham.cards.map((card) => ({ ...card, summary: `control slot future:exp:9` })),
    };
    await expect(evaluateDecisionPoint({
      point: { ...point, futureRunIds: ["future:exp:9"], packets: [point.packets[0]!, { mode: "sham", packet: leakedControl }, point.packets[2]!] },
      director,
    })).rejects.toThrow(/had a sham packet leaked information produced after it began \(future:exp:9\)/);
    // The guard fires before any priced decision call is made.
    expect(calls).toHaveLength(0);
  });
});

describe("L1 hindsight scoring references the action actually taken (#222)", () => {
  test("a wider declared output set is still the taken action, not another one", async () => {
    const point = pointOf(recordOf());
    const taken = point.actionTaken.proposal;
    const { director } = scriptedDirector((input) => input.decisionPhase?.memoryPacket?.control === "sham" || input.decisionPhase?.memoryPacket === undefined
      ? proposal("materialize answer.txt again")
      : { ...taken, task: { objective: taken.task!.objective, expectedOutputs: ["answer.txt", "notes.txt"] } });
    const result = await evaluateDecisionPoint({ point, director });
    // From the frozen Blind Proposal it is a replacement, yet against the action
    // actually taken it is the same action with wider outputs: still a match.
    expect(result.arms[2]!.delta).toBe("replaced");
    expect(result.arms[2]!.matchedActionTaken).toBe(true);
    expect(result.arms[0]!.matchedActionTaken).toBe(false);
  });

  test("only a proposal naming the taken action scores as matched", async () => {
    const point = pointOf(recordOf());
    let handed = "";
    const { director, calls } = scriptedDirector((input) => {
      handed += JSON.stringify(input);
      const packet = input.decisionPhase?.memoryPacket;
      return packet?.control === "sham"
        ? proposal("materialize answer.txt again")
        : packet === undefined
          ? proposal("materialize answer.txt again")
          : proposal("probe a competing kernel", "change-direction");
    });
    const result = await evaluateDecisionPoint({ point, director });
    expect(result.actionTakenRunId).toBe("m-l1:exp:3");
    expect(result.arms.map((arm) => arm.matchedActionTaken)).toEqual([false, false, true]);
    // The hindsight reference is never handed to the arms: it did not exist at
    // the decision point, so an arm that saw it would decide on the future.
    expect(calls).toHaveLength(3);
    expect(handed).not.toContain("m-l1:exp:3");
  });
});

describe("L1 off arm retains Mission state (A4 / #231)", () => {
  test("a base state that lost a measured score is refused", async () => {
    const record = recordOf();
    // The shared base state is stripped of the measured Experiments while the
    // durable Mission state still carries them: that arm measures amnesia.
    const point = pointOf(record, { baseState: baseStateOf({ ...record, experiments: [] }) });
    const { director } = scriptedDirector();
    await expect(evaluateDecisionPoint({ point, director })).rejects.toThrow(/lost the Mission scoreboard/);
  });

  test("the full base state passes and the off arm is the only arm denied a packet", async () => {
    const point = pointOf(recordOf());
    const { director, calls } = scriptedDirector();
    const result = await evaluateDecisionPoint({ point, director });
    expect(result.arms[0]!.mode).toBe("off");
    expect(calls[0]!.decisionPhase!.memoryPacket).toBeUndefined();
    // The off arm's handed state still carries every measured score.
    expect(calls[0]!.observations.map((observation) => observation.runId)).toEqual(["m-l1:exp:1", "m-l1:exp:2"]);
  });
});

describe("L1 report: direction only, both caveats, real sample (A8)", () => {
  async function points(count: number) {
    const results = [];
    for (let index = 0; index < count; index += 1) {
      const point = pointOf(recordOf(`m-l1-${index}`));
      const { director } = scriptedDirector((input) => {
        const packet = input.decisionPhase?.memoryPacket;
        return packet !== undefined && packet.control !== "sham"
          ? proposal("probe a competing kernel", "change-direction")
          : proposal("materialize answer.txt again");
      });
      results.push(await evaluateDecisionPoint({ point, director }));
    }
    return results;
  }

  test("refuses fewer than the minimum sample", async () => {
    const below = await points(DECISION_POINT_MIN_SAMPLE - 1);
    expect(() => summarizeDecisionPoints(below)).toThrow(/at least 50 decision points/);
  });

  test("refuses the same decision point counted twice", async () => {
    const sample = await points(DECISION_POINT_MIN_SAMPLE);
    const duplicated = [sample[0]!, ...sample.slice(1, -1), sample[0]!];
    expect(() => summarizeDecisionPoints(duplicated)).toThrow(/distinct decision points/);
  });

  test("50 points state a direction and carry both caveats without a significance claim", async () => {
    const report = summarizeDecisionPoints(await points(DECISION_POINT_MIN_SAMPLE));
    expect(report.kind).toBe("decision-point-counterfactual");
    expect(report.decisionPoints).toBe(DECISION_POINT_MIN_SAMPLE);
    expect(report.missions).toHaveLength(DECISION_POINT_MIN_SAMPLE);
    expect(report.directionOnly).toBe(true);
    expect(report.statisticalSignificance).toBe("none");
    // Both caveats, always: the Sham control limit and the L1 scope limit.
    expect(report.caveats).toContain(RESEARCH_MEMORY_CONTROL_CAVEAT);
    expect(report.caveats).toContain(DECISION_POINT_TRAJECTORY_CAVEAT);
    expect(report.caveats.join(" ")).toMatch(/trajectory steering/);
    // A direction, never an effect size.
    expect(report.directions).toEqual([
      { metric: "matched-action-taken", baseline: "off", treatment: "real", direction: "treatment-higher" },
      { metric: "matched-action-taken", baseline: "sham", treatment: "real", direction: "treatment-higher" },
    ]);
    expect(report.arms.map((arm) => [arm.mode, arm.matchedActionTaken, arm.proposals])).toEqual([
      ["off", 0, 50],
      ["sham", 0, 50],
      ["real", 50, 50],
    ]);
    expect(report.dispatchedExperiments).toBe(0);
    // The Insight control is auditable after the fact: which ids and versions
    // were supplied, and how many distinct snapshots the sample read.
    expect(report.insight.state).toBe("identical");
    expect(report.insight.pinned).toEqual([{ insightId: "insight-a", version: 1 }, { insightId: "insight-b", version: 1 }]);
    expect(report.insight.digests).toHaveLength(DECISION_POINT_MIN_SAMPLE);
    // Different Missions have their own Inbox, so the supply is a union of pins,
    // never a snapshot: identity is enforced per decision point (see results).
    const replayed = await evaluateDecisionPoint({ point: pointOf(recordOf("m-l1-0")), director: scriptedDirector().director });
    expect(report.insight.digests).toContain(replayed.insight.digest!);
  });

  test("refuses a sample that mixes Insight on with Insight off", async () => {
    const sample = await points(DECISION_POINT_MIN_SAMPLE);
    const { director } = scriptedDirector();
    const disabled = await evaluateDecisionPoint({ point: pointOf(recordOf("m-l1-disabled"), { insight: "disabled" }), director });
    expect(() => summarizeDecisionPoints([disabled, ...sample.slice(1)])).toThrow(/mixes Insight on and off/);
  });

  // #234: the hindsight reference is part of the contract, not an implementation
  // detail, so every report carries it verbatim and labels its bias limits.
  test("every report carries the versioned action-taken scoring rule and its caveat", async () => {
    const report = summarizeDecisionPoints(await points(DECISION_POINT_MIN_SAMPLE));
    expect(report.hindsightScoring).toEqual(DECISION_POINT_HINDSIGHT_SCORING);
    expect(report.hindsightScoring.reference).toBe("action-taken");
    expect(report.hindsightScoring.id).toBe("evok.l1-hindsight-scoring/v1");
    // Rationale and limits travel with the rule: a reviewer never has to infer
    // which reference was used or what it cannot prove.
    expect(report.hindsightScoring.rationale).toMatch(/already recorded/);
    expect(report.hindsightScoring.biasLimits.length).toBeGreaterThan(0);
    expect(report.hindsightScoring.biasLimits.join(" ")).toMatch(/not the best action/);
    expect(report.caveats).toContain(DECISION_POINT_SELECTION_BIAS_CAVEAT);
    expect(report.caveats.join(" ")).toMatch(/best action among those later measured/);
    expect(report.caveats.join(" ")).toMatch(/selection bias/);
  });

  test("changing the rule requires an explicit versioned contract change", async () => {
    expect(DECISION_POINT_HINDSIGHT_SCORING.changeRequires).toMatch(/versioned evaluation-contract change/);
    // The rule is recorded in the contract the code points at, with the same
    // identity: a rule change that skips the contract is visible here.
    const contract = await readFile(join(HERE, "../../docs/research-memory-evaluation-v2.md"), "utf8");
    expect(contract).toContain(DECISION_POINT_HINDSIGHT_SCORING.id);
    expect(contract).toMatch(/action actually taken/);
    expect(contract).toMatch(/versioned evaluation-contract change/);
  });
});
