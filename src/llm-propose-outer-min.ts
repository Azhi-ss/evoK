/**
 * LLM.2 propose → Outer E2E assembly (control-plane).
 *
 * Wires L1 `runtime.propose` → proposal Artifact → T48 map →
 * `runOuterMinPathSetup` / E3 fixtures (Hypothesis + mapped evidence_refs +
 * KillTestPlan, hang-ready). Default runtime is the L1 mock.
 *
 * Explicit live product path (LP.1):
 * `createLlmCompetitionRuntime({ live: true, model: resolveDefaultNewapiModel() })`
 * → propose → T48 map → `assembleLlmCompArmSetup({ live: true, … })`.
 * `EVOK_NEWAPI_LIVE` alone does not enable live (L2 contract).
 *
 * Unmapped proposals and side-slot / MMD / near-dup scalars never enter the
 * ledger. Does not change gate semantics, thaw #40, or add L3 hang AC.
 *
 * ME-1: when the caller omits `methodologyEvidence`, optional proposal file
 * `methodology.json` (also `manifest.json` / `methodology`) is parsed through
 * `readMethodologyEvidence` and forwarded to hang. Explicit inject wins.
 */
import { createKillTestHangHook, type KillTestHangInput } from "./kill-test-hang";
import {
  T48MappedCatalog,
  type KillTestOutcome,
  type T48MappedRef,
} from "./hypothesis-ledger";
import {
  createLlmCompetitionRuntime,
  type LlmCompetitionRuntimeOptions,
} from "./llm-competition-runtime";
import {
  resolveDefaultNewapiModel,
  type FetchLike,
} from "./newapi-client";
import {
  readMethodologyEvidence,
  type MethodologyContracts,
  type MethodologyEvidence,
} from "./methodology";
import {
  OUTER_MIN_HOLD_OUT_EVIDENCE_ID,
  OUTER_MIN_KILL_EVIDENCE_ID,
  createOuterMinFixture,
  runOuterMinPathSetup,
  type OuterMinFixture,
  type OuterMinPathAssembly,
  type OuterMinSearchSpaceAttach,
} from "./outer-min-path";
import {
  buildOuterSearchSpaceFixtures,
  type OuterSearchSpaceFixtures,
} from "./outer-search-space-fixtures";
import { deepFreeze, digestValue } from "./security-boundary";
import type { ToyAgentRuntime } from "./toy-harness";
import type { VerificationHook } from "./verification-gates";

export const LLM_COMP_HYPOTHESIS_ID = "h-llm-comp";
export const LLM_COMP_PLAN_ID = "kt-llm-comp";

const DEFAULT_PROPOSE_INPUT = {
  missionId: "llm-comp-arm",
  branchId: "candidate",
  taskContract: { objective: "propose a competition-arm candidate" },
  workspace: {} as Record<string, string>,
};

export interface LlmProposalArtifact {
  readonly artifactId: string;
  readonly digest: string;
  readonly kind: "llm_proposal";
}

export interface AssembleLlmCompArmSetupInput {
  readonly runtime?: ToyAgentRuntime;
  readonly live?: boolean;
  readonly model?: string;
  readonly fetch?: FetchLike;
  readonly proposeInput?: Parameters<ToyAgentRuntime["propose"]>[0];
  readonly evidenceRefs?: readonly unknown[];
  readonly killEvidenceRefs?: readonly unknown[];
  readonly artifacts?: readonly unknown[];
  readonly contracts?: MethodologyContracts;
  readonly methodologyEvidence?: MethodologyEvidence;
  /** Mock-only: emit convention `methodology.json` from the OOF-present fixture. */
  readonly emitMethodologyManifest?: boolean;
  readonly outcome?: KillTestOutcome;
  readonly resultId?: string;
  readonly hypothesisId?: string;
  readonly planId?: string;
  readonly statement?: string;
}

export interface LlmCompArmSetup {
  readonly runtime: ToyAgentRuntime;
  readonly proposal: { readonly files: Record<string, string> };
  readonly proposalArtifact: LlmProposalArtifact;
  readonly proposalRef: T48MappedRef;
  readonly setup: OuterMinPathAssembly;
  readonly searchSpace: OuterSearchSpaceFixtures;
  readonly killTestHang: VerificationHook;
  readonly hypothesisId: string;
  readonly planId: string;
  readonly evidenceRefs: readonly T48MappedRef[];
  readonly methodologyEvidence?: MethodologyEvidence;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isProposeOutput(value: unknown): value is { readonly files: Record<string, string> } {
  if (!isPlainRecord(value) || !isPlainRecord(value.files)) return false;
  return Object.values(value.files).every((entry) => typeof entry === "string");
}

/**
 * Register propose `files` as a T48 Artifact. Raw scores, unmapped ids, and
 * side-slot / MMD / near-dup scalars are rejected and never catalogued.
 */
export function mapLlmProposalArtifact(input: {
  readonly catalog: T48MappedCatalog;
  readonly proposal: unknown;
}): {
  readonly catalog: T48MappedCatalog;
  readonly artifact: LlmProposalArtifact;
  readonly mapped: T48MappedRef;
} {
  if (!isPlainRecord(input) || !(input.catalog instanceof T48MappedCatalog)) {
    throw new TypeError("mapLlmProposalArtifact requires a T48MappedCatalog");
  }
  if (!isProposeOutput(input.proposal)) {
    input.catalog.map(input.proposal);
    throw new Error("unmapped proposal cannot enter evidence_refs");
  }
  const digest = digestValue(input.proposal.files);
  const artifact = deepFreeze({
    artifactId: `llm-proposal:${digest}`,
    digest,
    kind: "llm_proposal",
  }) as LlmProposalArtifact;
  const catalog = input.catalog.withArtifacts([artifact]);
  return deepFreeze({
    catalog,
    artifact,
    mapped: catalog.map(artifact.artifactId),
  });
}

function fixtureFromE3(
  searchSpace: OuterSearchSpaceFixtures,
  catalog: T48MappedCatalog,
  contracts?: MethodologyContracts,
): OuterMinFixture {
  const base = createOuterMinFixture({ contracts });
  const nearDup: OuterMinSearchSpaceAttach = {
    catalog,
    artifact: searchSpace.nearDupArtifact,
    mapped: [searchSpace.mappedNearDup],
  };
  const diversity: OuterMinSearchSpaceAttach = {
    catalog,
    artifact: searchSpace.diversityArtifact,
    mapped: [searchSpace.mappedDiversity],
  };
  return {
    memory: base.memory,
    catalog,
    contracts: contracts ?? base.contracts,
    nearDup,
    diversity,
  };
}

const METHODOLOGY_FILE_KEYS = ["methodology.json", "manifest.json", "methodology"] as const;

/**
 * Proposal `files` convention: optional `methodology.json` (also
 * `manifest.json` / `methodology`) as JSON text. Missing key returns
 * undefined (do not invent evidence). Present but unparsable / not a
 * plain object fails closed.
 */
export function readProposalMethodologyEvidence(
  files: Record<string, string>,
  contracts?: MethodologyContracts,
): MethodologyEvidence | undefined {
  const key = METHODOLOGY_FILE_KEYS.find((candidate) => (
    Object.prototype.hasOwnProperty.call(files, candidate)
  ));
  if (key === undefined) return undefined;
  const raw = files[key];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`proposal ${key} is not valid JSON`);
  }
  if (!isPlainRecord(parsed)) {
    throw new Error(`proposal ${key} must be a plain object`);
  }
  return readMethodologyEvidence(parsed, contracts);
}

function resolveAssembledMethodologyEvidence(
  files: Record<string, string>,
  input: AssembleLlmCompArmSetupInput,
): MethodologyEvidence | undefined {
  if (input.methodologyEvidence !== undefined) return input.methodologyEvidence;
  return readProposalMethodologyEvidence(files, input.contracts);
}

function hangInput(
  setup: OuterMinPathAssembly,
  input: AssembleLlmCompArmSetupInput,
  methodologyEvidence?: MethodologyEvidence,
): KillTestHangInput {
  return {
    outcome: input.outcome ?? "pass",
    evidenceRefs: input.killEvidenceRefs ?? [OUTER_MIN_KILL_EVIDENCE_ID],
    catalog: setup.fixture.catalog,
    ledger: setup.ledger,
    planId: setup.planId,
    ...(input.resultId === undefined ? {} : { resultId: input.resultId }),
    ...(input.contracts === undefined ? {} : { contracts: input.contracts }),
    ...(methodologyEvidence === undefined ? {} : { methodologyEvidence }),
    ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
  };
}

function runtimeOptions(input: AssembleLlmCompArmSetupInput): LlmCompetitionRuntimeOptions {
  return {
    live: input.live === true,
    model: input.model ?? resolveDefaultNewapiModel(),
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    ...(input.emitMethodologyManifest === undefined
      ? {}
      : { emitMethodologyManifest: input.emitMethodologyManifest }),
  };
}

/**
 * One-call glue: L1 propose → T48-mapped proposal Artifact → Outer E2E min
 * path. SearchSpace attachments stay diagnostic_only extras.
 *
 * `live: true` builds `createLlmCompetitionRuntime({ live: true, model })`
 * with `resolveDefaultNewapiModel()` when model is omitted. Omit / `live:
 * false` stays Mock. Env `EVOK_NEWAPI_LIVE` is ignored here.
 */
export async function assembleLlmCompArmSetup(
  input: AssembleLlmCompArmSetupInput = {},
): Promise<LlmCompArmSetup> {
  const runtime = input.runtime ?? createLlmCompetitionRuntime(runtimeOptions(input));
  const proposal = await runtime.propose(input.proposeInput ?? DEFAULT_PROPOSE_INPUT);
  const searchSpace = buildOuterSearchSpaceFixtures();
  const attached = mapLlmProposalArtifact({
    catalog: searchSpace.catalog,
    proposal,
  });
  const sources = input.evidenceRefs ?? [
    attached.mapped,
    OUTER_MIN_HOLD_OUT_EVIDENCE_ID,
    searchSpace.mappedNearDup,
    searchSpace.mappedDiversity,
  ];
  const fixture = fixtureFromE3(searchSpace, attached.catalog, input.contracts);
  const setup = runOuterMinPathSetup({
    fixture,
    hypothesisId: input.hypothesisId ?? LLM_COMP_HYPOTHESIS_ID,
    planId: input.planId ?? LLM_COMP_PLAN_ID,
    statement: input.statement ?? "llm competition-arm: mapped proposal artifact and diagnostic search-space refs",
    evidenceRefs: sources,
  });
  const methodologyEvidence = resolveAssembledMethodologyEvidence(proposal.files, input);
  return Object.freeze({
    runtime,
    proposal: deepFreeze({ files: { ...proposal.files } }),
    proposalArtifact: attached.artifact,
    proposalRef: attached.mapped,
    setup,
    searchSpace,
    killTestHang: createKillTestHangHook(hangInput(setup, input, methodologyEvidence)),
    hypothesisId: setup.hypothesisId,
    planId: setup.planId,
    evidenceRefs: setup.evidenceRefs,
    ...(methodologyEvidence === undefined ? {} : { methodologyEvidence }),
  }) as LlmCompArmSetup;
}

export const runLlmProposeOuterMin = assembleLlmCompArmSetup;
