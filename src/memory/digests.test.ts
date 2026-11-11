/**
 * M-a digest pin (#242): the physical aggregation into `src/memory/` is a move,
 * not a behaviour change. For one fixed input, every snapshot/packet/sham/slice
 * digest must keep the exact bytes it had at review base `8b62aa8`, so
 * `MissionRunRecord.researchMemory.ledgerRevision` and every completed Run stay
 * reproducible.
 *
 * These literals were computed BEFORE the move and must never be updated to
 * match new code: a change here is a served-content change (PRD §4.1 P4).
 */
import { describe, expect, test } from "bun:test";
import {
  createResearchMemorySlice,
  projectResearchDecisionPacket,
  projectResearchMemorySnapshot,
  shamResearchDecisionPacket,
  shamResearchMemorySnapshot,
  type ResearchMemorySource,
} from "./index";
import type { SynthesisProposal } from "../evidence/synthesis-proposal";

// The old paths stay re-export shims during migration; the same values must be
// reachable through them, so importers keep working unchanged.
import * as evidenceShim from "../evidence/research-memory";
import * as providerShim from "../execution/research-memory-provider";
import * as sliceShim from "../execution/memory-slice";

const PINNED = {
  snapshot: "dfe9a8f80f6d9b3eb46fb99fe5bdaf425cfcaac15e019634abf23b0919c0eb88",
  narrowSnapshot: "d505adf160e6c75a16683e2ad0729ada8ad9f8a819436dc05eaca5817b2c17c4",
  packet: "3a21fcc31f42c296ec72a8a0accf9eb3e1520e4b1b57209da2439df51ff0ea71",
  narrowPacket: "515a2929e012944e0ba968fb7499b97c667959a29612e9d07f2695e6573251bb",
  shamSnapshot: "0f8efae53f6f0457d9e6c1bfbdbc2570b8ed9db060cb282e2bcfe8d16109bc76",
  shamPacket: "8a36fe2494e7d2e46f0401d364f11ef55ad6721eccf9655ad33bd6b98ad33696",
  slice: "433ba88b2d75eca18439e6d8ff632b65594ac24a27ebc12dfd32f5be79d5ef51",
} as const;

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

/** One input that exercises runs, replication, proposals, staleness and withdrawal. */
function source(over: Partial<ResearchMemorySource> = {}): ResearchMemorySource {
  return {
    missionId: "m-demo",
    ledgerRevision: 7,
    conditions: ["dataset:v2", "method:gbdt"],
    withdrawals: [{ cardId: "pitfall:synthesis:p-3", reason: "superseded by run evidence" }],
    maxCards: 8,
    runs: [
      { runId: "m-demo:baseline:1", taskId: "t-1", taskObjective: "raise AUC", ok: true, score: 0.75, evidenceRefs: ["runs/1/result.json"] },
      {
        runId: "m-demo:exp:2",
        taskId: "t-1",
        taskObjective: "raise AUC",
        ok: false,
        score: 0.71,
        ruleViolations: ["answer.txt is missing"],
        evidenceRefs: ["runs/2/result.json"],
      },
      { runId: "m-demo:exp:3", taskId: "t-1", ok: false, error: "CUDA out of memory", configuration: "batch=512", evidenceRefs: ["runs/3/result.json"] },
      { runId: "m-demo:exp:4", taskId: "t-1", ok: false, score: 0.7, evidenceRefs: ["runs/4/result.json"] },
    ],
    proposals: [
      proposal({
        proposalId: "p-1",
        operationId: "op-1",
        kind: "hypothesis",
        statement: "A wider feature block lifts AUC under dataset v1",
        rationale: "observed on run 1",
        supportingRefs: [{ kind: "run", ref: "m-demo:baseline:1" }],
        competingRefs: [{ kind: "claim", ref: "p-2" }],
        unknowns: ["seed sensitivity"],
        applicability: ["dataset:v1", "method:gbdt"],
        nextValidation: { objective: "repeat under 3 seeds", advisory: true },
      }),
      proposal({
        proposalId: "p-2",
        operationId: "op-2",
        kind: "hypothesis",
        statement: "Wider features overfit; the lift is noise",
        rationale: "run 2 regressed",
        contradictingRefs: [{ kind: "negative-evidence", ref: "m-demo:exp:2" }],
        applicability: ["dataset:v1", "method:gbdt"],
      }),
      proposal({
        proposalId: "p-3",
        operationId: "op-3",
        kind: "pitfall",
        statement: "Oversized batches OOM on the shared GPU",
        rationale: "keep batch <= 256",
        applicability: ["runtime:a800"],
        conditions: ["batch >= 512"],
      }),
      proposal({
        proposalId: "p-4",
        operationId: "op-4",
        kind: "finding",
        statement: "Calibration improves with isotonic regression",
        rationale: "measured on dataset v1",
        applicability: ["dataset:v1", "evaluation:logloss"],
        limitations: ["single split"],
      }),
    ],
    ...over,
  };
}

describe("research memory content addresses are unchanged by the move (#242)", () => {
  test("snapshot, packet, sham and slice digests match the pre-move bytes", () => {
    const snapshot = projectResearchMemorySnapshot(source());
    const narrow = projectResearchMemorySnapshot(source({ maxCards: 2 }));
    const packet = projectResearchDecisionPacket(snapshot);
    const narrowPacket = projectResearchDecisionPacket(narrow);
    const slice = createResearchMemorySlice({
      sliceId: "slice-1",
      missionId: "m-demo",
      taskId: "t-1",
      runId: "m-demo:exp:9",
      targetAgentId: "agent-2",
      evidenceRefs: ["runs/9/result.json"],
      findings: [],
      research: snapshot,
    });

    expect(snapshot.digest).toBe(PINNED.snapshot);
    expect(narrow.digest).toBe(PINNED.narrowSnapshot);
    expect(packet.digest).toBe(PINNED.packet);
    expect(narrowPacket.digest).toBe(PINNED.narrowPacket);
    expect(shamResearchMemorySnapshot(snapshot).digest).toBe(PINNED.shamSnapshot);
    expect(shamResearchDecisionPacket(packet).digest).toBe(PINNED.shamPacket);
    expect(slice.digest).toBe(PINNED.slice);
  });

  test("the old module paths are the same symbols, not copies", () => {
    expect(evidenceShim.projectResearchMemorySnapshot).toBe(projectResearchMemorySnapshot);
    expect(evidenceShim.projectResearchDecisionPacket).toBe(projectResearchDecisionPacket);
    expect(evidenceShim.shamResearchMemorySnapshot).toBe(shamResearchMemorySnapshot);
    expect(providerShim.loadResearchMemorySnapshot).toBeTypeOf("function");
    expect(providerShim.createResearchMemoryProvider).toBeTypeOf("function");
    expect(providerShim.createDelegatedResearchMemoryProvider).toBeTypeOf("function");
    expect(sliceShim.createResearchMemorySlice).toBe(createResearchMemorySlice);
    expect(sliceShim.MemorySliceError).toBeTypeOf("function");
  });
});
