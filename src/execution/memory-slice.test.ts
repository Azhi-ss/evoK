/**
 * MemorySlice: the bounded, reference-first memory one Run may receive.
 * Covers freezing/serialization/digest validation, the fixed read policy, and
 * the fail-closed rejection of credentials / hidden data / transcripts /
 * global budgets. Also covers MemoryWriteProposal and AgentResult binding.
 */
import { describe, expect, test } from "bun:test";
import { projectResearchMemorySnapshot } from "../evidence/research-memory";
import {
  AGENT_RESULT_SCHEMA,
  MEMORY_SLICE_SCHEMA,
  MemorySliceError,
  createMemorySlice,
  createMemoryWriteProposal,
  createResearchMemorySlice,
  deriveDelegatedMemorySlice,
  validateAgentResult,
  validateMemorySlice,
  validateMemoryWriteProposal,
  type MemorySliceInput,
} from "./memory-slice";

function input(overrides: Partial<MemorySliceInput> = {}): MemorySliceInput {
  return {
    sliceId: "slice-exp-3",
    missionId: "m-1",
    taskId: "task-exp-2",
    runId: "m-1:exp:2",
    targetAgentId: "researcher@m-1:exp:2",
    sourceRefs: ["runs/exp-2/result.json"],
    evidenceRefs: ["runs/exp-2/snapshot", "runs/exp-2/result.json"],
    artifactRefs: ["runs/exp-2/snapshot/model.py"],
    facts: [{ name: "best_score", value: 0.42, source: "runs/exp-2/result.json" }],
    findings: [{ findingId: "f-1", summary: "target encoding overfit the validation fold", ok: false, sourceRefs: ["runs/exp-2/result.json"] }],
    issuedAt: "2026-10-24T01:00:00.000Z",
    ...overrides,
  };
}

describe("MemorySlice", () => {
  test("is frozen, serializable, and digest-addressed", () => {
    const slice = createMemorySlice(input());
    expect(slice.schema).toBe(MEMORY_SLICE_SCHEMA);
    expect(Object.isFrozen(slice)).toBe(true);
    expect(Object.isFrozen(slice.facts[0])).toBe(true);
    const restored = validateMemorySlice(JSON.parse(JSON.stringify(slice)));
    expect(restored).toEqual(slice);
    expect(restored.digest).toBe(slice.digest);
    expect(createMemorySlice(input()).digest).toBe(slice.digest);
    // Any content change changes the digest.
    expect(createMemorySlice(input({ facts: [{ name: "best_score", value: 0.43 }] })).digest).not.toBe(slice.digest);
    expect(slice.readPolicy).toEqual({ references: true, summaries: true, bodies: false, sensitive: false });
  });

  test("rejects credentials, hidden data, transcripts, and global budgets", () => {
    for (const key of ["credentials", "APIKEY", "hiddenData", "holdout", "transcript", "history", "globalBudget", "rules"]) {
      expect(() => createMemorySlice({ ...input(), [key]: "leak" } as MemorySliceInput)).toThrow(MemorySliceError);
      expect(() => createMemorySlice({ ...input(), [key]: "leak" } as MemorySliceInput)).toThrow(/sensitive/);
    }
    expect(() => createMemorySlice(input({ facts: [{ name: "transcript", value: "full chat log" }] }))).toThrow(/sensitive/);
    expect(() => createMemorySlice(input({ facts: [{ name: "TrAnScRiPt", value: "full chat log" }] }))).toThrow(/sensitive/);
    expect(() => createMemorySlice(input({ findings: [{ findingId: "f", summary: "x", ...{ globalBudget: 100 } } as never] }))).toThrow(/sensitive/);
    expect(() => createMemorySlice(input({ readPolicy: { references: true, summaries: true, bodies: true, sensitive: false } as never }))).toThrow(/deny bodies/);
  });

  test("persisted tampering fails validation", () => {
    const slice = createMemorySlice(input());
    expect(() => validateMemorySlice({ ...slice, findings: [] })).toThrow(/digest mismatch/);
    expect(() => validateMemorySlice({ ...slice, schema: "evok.memory-slice/v3" })).toThrow(/schema/);
    expect(() => validateMemorySlice({ ...slice, readPolicy: { references: true, summaries: true, bodies: true, sensitive: true } }))
      .toThrow(/deny bodies/);
    expect(() => createMemorySlice(input({ runId: "" }))).toThrow(/runId is required/);
    expect(() => createMemorySlice(input({ targetAgentId: "" }))).toThrow(/targetAgentId is required/);
  });
});

describe("MemoryWriteProposal", () => {
  test("is a frozen, validated proposal and never applied by the agent", () => {
    const proposal = createMemoryWriteProposal({
      proposalId: "p-1",
      missionId: "m-1",
      taskId: "task-exp-2",
      runId: "m-1:exp:2",
      agentId: "researcher@m-1:exp:2",
      rationale: "the validation split leakage is worth remembering",
      evidenceRefs: ["runs/exp-2/result.json"],
      findings: [{ findingId: "f-2", summary: "grouped split needed", ok: true }],
    });
    expect(Object.isFrozen(proposal)).toBe(true);
    expect(validateMemoryWriteProposal(JSON.parse(JSON.stringify(proposal)))).toEqual(proposal);
    expect(() => validateMemoryWriteProposal({ ...proposal, rationale: "changed" })).toThrow(/digest mismatch/);
    expect(() => createMemoryWriteProposal({
      proposalId: "p-2", missionId: "m-1", taskId: "t", runId: "r", agentId: "a",
      rationale: "x", credentials: "secret",
    } as never)).toThrow(/sensitive/);
  });
});

describe("AgentResult", () => {
  const result = {
    schema: AGENT_RESULT_SCHEMA,
    agentId: "researcher@m-1:exp:2",
    missionId: "m-1",
    taskId: "task-exp-2",
    runId: "m-1:exp:2",
    ok: true,
    summary: "produced the candidate artifact",
    artifactRefs: ["model.py"],
    evidenceRefs: ["runs/exp-2/snapshot"],
  };

  test("validates against the dispatched Run identity", () => {
    expect(validateAgentResult(result, { runId: "m-1:exp:2", agentId: "researcher@m-1:exp:2" }).ok).toBe(true);
    expect(() => validateAgentResult(result, { runId: "m-1:exp:3" })).toThrow(/does not match the dispatched runId/);
    expect(() => validateAgentResult(result, { agentId: "researcher@m-1:baseline:1" })).toThrow(/does not match the dispatched agentId/);
    expect(() => validateAgentResult({ ...result, ok: "yes" })).toThrow(/ok must be a boolean/);
    expect(() => validateAgentResult({ ...result, credentials: "x" })).toThrow(/sensitive/);
  });

  test("a carried write proposal must answer the same run", () => {
    const write = createMemoryWriteProposal({
      proposalId: "p-1", missionId: "m-1", taskId: "task-exp-2", runId: "m-1:exp:2", agentId: "researcher@m-1:exp:2",
      rationale: "remember the split defect",
    });
    expect(validateAgentResult({ ...result, memoryWrite: write }).memoryWrite?.digest).toBe(write.digest);
    expect(() => validateAgentResult({
      ...result,
      memoryWrite: createMemoryWriteProposal({
        proposalId: "p-2", missionId: "m-1", taskId: "task-exp-2", runId: "m-1:exp:9", agentId: "other",
        rationale: "x",
      }),
    })).toThrow(/memoryWrite must be bound to the same run/);
    expect(() => validateAgentResult({
      ...result,
      memoryWrite: createMemoryWriteProposal({
        proposalId: "p-3", missionId: "m-other", taskId: "task-exp-2", runId: "m-1:exp:2", agentId: "researcher@m-1:exp:2",
        rationale: "x",
      }),
    })).toThrow(/memoryWrite must be bound to the same missionId/);
  });
});

describe("delegated memory slice (M1-T8)", () => {
  const snapshot = projectResearchMemorySnapshot({
    missionId: "m-1",
    ledgerRevision: 2,
    runs: [{ runId: "m-1:baseline:1", ok: true, score: 0.5, evidenceRefs: ["runs/m-1:baseline:1/result.json"] }],
  });
  const parent = createResearchMemorySlice({
    sliceId: "slice-parent",
    missionId: "m-1",
    taskId: "task-exp-2",
    runId: "m-1:exp:2",
    targetAgentId: "researcher@m-1:exp:2",
    research: snapshot,
  });
  const child = () => deriveDelegatedMemorySlice({
    parent, missionId: "m-1", taskId: "task-exp-3", runId: "m-1:exp:3:sub:1", targetAgentId: "critic@m-1:exp:3:sub:1",
  });

  test("mints a new slice for the child from the parent's pinned packet", () => {
    const slice = child();
    expect(slice.schema).toBe("evok.memory-slice/v3");
    expect(slice.sliceId).not.toBe(parent.sliceId);
    expect(slice.digest).not.toBe(parent.digest);
    // Exactly the parent's already-published packet, never a wider one.
    expect(slice.research).toEqual(parent.research);
    expect(validateMemorySlice(JSON.parse(JSON.stringify(slice)))).toEqual(slice);
  });

  test("the child cannot reuse the parent's identity or Mission", () => {
    expect(() => deriveDelegatedMemorySlice({
      parent, missionId: "m-1", taskId: "task-exp-3", runId: parent.runId, targetAgentId: "critic@m-1:exp:3",
    })).toThrow(MemorySliceError);
    expect(() => deriveDelegatedMemorySlice({
      parent, missionId: "m-1", taskId: "task-exp-3", runId: "m-1:exp:3", targetAgentId: parent.targetAgentId,
    })).toThrow(/must not reuse/);
    expect(() => deriveDelegatedMemorySlice({
      parent, missionId: "m-2", taskId: "task-exp-3", runId: "m-1:exp:3", targetAgentId: "critic@m-1:exp:3",
    })).toThrow(/belongs to Mission/);
  });

  test("a legacy v2 parent keeps the v2 contract (no fabricated research packet)", () => {
    const v2 = createMemorySlice({
      sliceId: "slice-parent-v2", missionId: "m-1", taskId: "task-exp-2", runId: "m-1:exp:2",
      targetAgentId: "researcher@m-1:exp:2", findings: [{ findingId: "f-1", summary: "grouped split needed" }],
    });
    const slice = deriveDelegatedMemorySlice({
      parent: v2, missionId: "m-1", taskId: "task-exp-3", runId: "m-1:exp:3:sub:1", targetAgentId: "critic@m-1:exp:3:sub:1",
    });
    expect(slice.schema).toBe(MEMORY_SLICE_SCHEMA);
    expect(slice.research).toBeUndefined();
    expect(slice.findings).toEqual(v2.findings);
  });
});
