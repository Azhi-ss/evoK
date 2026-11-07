import { describe, expect, test } from "bun:test";
import {
  SYNTHESIS_PROPOSAL_SCHEMA,
  validateSynthesisProposal,
  type SynthesisProposalContext,
} from "./synthesis-proposal";

const context: SynthesisProposalContext = {
  missionId: "m-synth",
  taskIds: ["task-1", "task-exp-2"],
  runIds: ["m-synth:baseline:1", "m-synth:exp:2"],
  negativeEvidenceRunIds: ["m-synth:exp:2"],
  evidenceRefs: ["runs/m-synth:baseline:1/result.json", "runs/m-synth:exp:2/result.json"],
  accepted: [],
};

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: SYNTHESIS_PROPOSAL_SCHEMA,
    proposalId: "p-1",
    operationId: "op-1",
    missionId: "m-synth",
    agentId: "researcher@m-synth:exp:2",
    taskId: "task-exp-2",
    runId: "m-synth:exp:2",
    kind: "hypothesis",
    statement: "a smaller fold count lowers rmse under the declared split",
    rationale: "the baseline and the second Run point the same way",
    supportingRefs: [{ kind: "run", ref: "m-synth:baseline:1" }],
    contradictingRefs: [{ kind: "negative-evidence", ref: "m-synth:exp:2" }],
    competingRefs: [],
    unknowns: ["holdout behaviour is still unknown"],
    applicability: ["dataset:train-v1", "evaluation:kfold-5"],
    visibility: "mission",
    limitations: ["only two measured Runs"],
    conditions: [],
    nextValidation: { objective: "ablate the fold count in one fresh Experiment", advisory: true },
    ...overrides,
  };
}

function rejectedReason(input: unknown, ctx: SynthesisProposalContext = context): string {
  const decision = validateSynthesisProposal(input, ctx);
  if (decision.outcome !== "rejected") throw new Error(`expected a rejection, got ${decision.outcome}`);
  return decision.reason;
}

describe("synthesis proposal validation (#212)", () => {
  test("a structurally valid proposal is accepted for storage and stays unverified", () => {
    const decision = validateSynthesisProposal(raw(), context);
    expect(decision.outcome).toBe("accepted_for_storage");
    if (decision.outcome !== "accepted_for_storage") return;
    expect(decision.epistemicStatus).toBe("unverified");
    const proposal = decision.proposal;
    expect(Object.isFrozen(proposal)).toBe(true);
    expect(Object.isFrozen(proposal.supportingRefs)).toBe(true);
    expect(proposal.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(proposal.supportingRefs).toEqual([{ kind: "run", ref: "m-synth:baseline:1" }]);
    expect(proposal.contradictingRefs).toEqual([{ kind: "negative-evidence", ref: "m-synth:exp:2" }]);
    expect(proposal.unknowns).toEqual(["holdout behaviour is still unknown"]);
    // Refs alone never promote the proposal to a claim: no verified status exists.
    expect(JSON.stringify(proposal)).not.toContain("verified\"");
    expect(JSON.parse(JSON.stringify(proposal)).epistemicStatus).toBeUndefined();
  });

  test("the same payload always produces the same content address", () => {
    const first = accepted(raw());
    const second = accepted(JSON.parse(JSON.stringify(raw())));
    expect(second.digest).toBe(first.digest);
    expect(accepted(raw({ statement: "a different claim" })).digest).not.toBe(first.digest);
  });

  test("unknown fields, wrong schema, and model-declared status are refused", () => {
    expect(rejectedReason(raw({ schema: "evok.synthesis-proposal/v2" }))).toBe("schema");
    expect(rejectedReason(raw({ confidence: 0.9 }))).toBe("schema");
    expect(rejectedReason(raw({ epistemicStatus: "verified" }))).toBe("schema");
    expect(rejectedReason(raw({ dispatch: { task: "run this now" } }))).toBe("schema");
    expect(rejectedReason(raw({ kind: "claim" }))).toBe("schema");
    expect(rejectedReason("not an object")).toBe("schema");
  });

  test("identity must match the Mission, its Tasks/Runs, and the bound agent", () => {
    expect(rejectedReason(raw({ missionId: "m-other" }))).toBe("identity");
    expect(rejectedReason(raw({ runId: "m-synth:exp:99" }))).toBe("identity");
    expect(rejectedReason(raw({ taskId: "task-unknown" }))).toBe("identity");
    expect(rejectedReason(raw({ agentId: "intruder@m-synth:baseline:1" }))).toBe("identity");
    expect(rejectedReason(raw({ agentId: "" }))).toBe("identity");
    // A Director-level proposal carries an agent identity without a Run binding.
    expect(validateSynthesisProposal(raw({ agentId: "mission-director", runId: undefined, taskId: undefined }), context).outcome)
      .toBe("accepted_for_storage");
  });

  test("secret-like content is refused before storage", () => {
    expect(rejectedReason(raw({ statement: "the trick is api_key=sk-live-123456" }))).toBe("sensitive-content");
    expect(rejectedReason(raw({ rationale: "token: ghp_abcdef123456" }))).toBe("sensitive-content");
    expect(rejectedReason(raw({ unknowns: ["Bearer abc.def.ghi"] }))).toBe("sensitive-content");
    expect(rejectedReason(raw({ limitations: ["password: hunter2"] }))).toBe("sensitive-content");
  });

  test("refs must be typed and must resolve to authoritative Mission objects", () => {
    expect(rejectedReason(raw({ supportingRefs: [] }))).toBe("refs");
    expect(rejectedReason(raw({ supportingRefs: [{ kind: "run", ref: "m-other:baseline:1" }] }))).toBe("refs");
    expect(rejectedReason(raw({ supportingRefs: [{ kind: "evidence", ref: "runs/unknown/result.json" }] }))).toBe("refs");
    expect(rejectedReason(raw({ supportingRefs: [{ kind: "telepathy", ref: "m-synth:baseline:1" }] }))).toBe("refs");
    expect(rejectedReason(raw({ contradictingRefs: [{ kind: "negative-evidence", ref: "m-synth:baseline:1" }] }))).toBe("refs");
    expect(rejectedReason(raw({ supportingRefs: [{ kind: "run" }] }))).toBe("refs");
    // Counterevidence must be cited or explicitly unknown, never simply omitted.
    const noCounter = raw();
    delete noCounter.contradictingRefs;
    expect(rejectedReason(noCounter)).toBe("schema");
    const silentCounter = raw();
    delete silentCounter.contradictingRefs;
    expect(rejectedReason({ ...silentCounter, contradictions: [] })).toBe("schema");
    expect(rejectedReason(raw({ contradictingRefs: [], unknowns: [] }))).toBe("refs");
    expect(validateSynthesisProposal(raw({ contradictingRefs: [], unknowns: ["no counterevidence yet"] }), context).outcome)
      .toBe("accepted_for_storage");
    // A claim ref may only point at an already stored proposal.
    expect(rejectedReason(raw({ competingRefs: [{ kind: "claim", ref: "p-404" }] }))).toBe("refs");
    const withClaim = validateSynthesisProposal(raw({
      proposalId: "p-2",
      operationId: "op-2",
      competingRefs: [{ kind: "claim", ref: "p-1" }],
    }), { ...context, accepted: [accepted(raw())] });
    expect(withClaim.outcome).toBe("accepted_for_storage");
    expect(withClaim.outcome === "accepted_for_storage" && withClaim.proposal.competingRefs)
      .toEqual([{ kind: "claim", ref: "p-1" }]);
  });

  test("visibility can never exceed the source Mission", () => {
    expect(rejectedReason(raw({ visibility: "public" }))).toBe("visibility");
    expect(rejectedReason(raw({ visibility: undefined }))).toBe("visibility");
    expect(rejectedReason(raw({ visibility: "researcher" }))).toBe("visibility");
  });

  test("applicability is claim-specific with a known dimension and value shape", () => {
    expect(rejectedReason(raw({ applicability: ["dataset"] }))).toBe("applicability");
    expect(rejectedReason(raw({ applicability: [":train-v1"] }))).toBe("applicability");
    expect(rejectedReason(raw({ applicability: ["vibes:good"] }))).toBe("applicability");
    expect(rejectedReason(raw({ applicability: [] }))).toBe("applicability");
    expect(rejectedReason(raw({ applicability: "dataset:train-v1" }))).toBe("applicability");
    // A GPU Pitfall needs machine conditions, not an Objective.
    expect(validateSynthesisProposal(raw({
      kind: "pitfall",
      statement: "OOM on a single 24GB GPU",
      applicability: ["runtime:cuda-12"],
      conditions: ["batch size >= 32"],
    }), context).outcome).toBe("accepted_for_storage");
    expect(rejectedReason(raw({ kind: "pitfall", conditions: [] }))).toBe("applicability");
  });

  test("next-validation content can only be advisory", () => {
    expect(rejectedReason(raw({ nextValidation: { objective: "run it now", advisory: false } }))).toBe("schema");
    expect(rejectedReason(raw({ nextValidation: { objective: "run it now", advisory: true, taskId: "task-exp-2" } }))).toBe("schema");
    expect(rejectedReason(raw({ nextValidation: { objective: "run it now" } }))).toBe("schema");
  });

  test("a reused operation id is idempotent only for the identical payload", () => {
    const stored = accepted(raw());
    const same = validateSynthesisProposal(raw(), { ...context, accepted: [stored] });
    expect(same.outcome).toBe("accepted_for_storage");
    if (same.outcome === "accepted_for_storage") expect(same.proposal.digest).toBe(stored.digest);
    expect(rejectedReason(raw({ statement: "a different claim under the same operation" }), { ...context, accepted: [stored] }))
      .toBe("idempotency");
    // A reused proposal id is a distinct conflict from a reused operation id.
    expect(rejectedReason(raw({ operationId: "op-2" }), { ...context, accepted: [stored] })).toBe("idempotency");
  });
});

function accepted(input: unknown) {
  const decision = validateSynthesisProposal(input, { ...context, accepted: [] });
  if (decision.outcome !== "accepted_for_storage") throw new Error(`fixture must be valid, got ${decision.reason}`);
  return decision.proposal;
}
