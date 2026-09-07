/**
 * E2 before-promotion outer AC glue.
 *
 * Consumes E1 `runOuterMinPathSetup` and E3 `buildOuterSearchSpaceFixtures`.
 * Wires the existing Kill-test hang into `ToyCompetitionHarness.verification.killTestHang`.
 * Does not wrap T48 / Broker, call UCT, or thaw #40.
 */
import { createKillTestHangHook, type KillTestHangInput } from "./kill-test-hang";
import type { KillTestOutcome } from "./hypothesis-ledger";
import type { MethodologyContracts, MethodologyEvidence } from "./methodology";
import {
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
import type { VerificationHook } from "./verification-gates";

export interface AssembleOuterE2eMinPathInput {
  readonly outcome?: KillTestOutcome;
  readonly contracts?: MethodologyContracts;
  readonly methodologyEvidence?: MethodologyEvidence;
  readonly evidenceRefs?: readonly unknown[];
  readonly killEvidenceRefs?: readonly unknown[];
  readonly artifacts?: readonly unknown[];
  readonly verdictBasis?: readonly unknown[];
  readonly resultId?: string;
  readonly hypothesisId?: string;
  readonly planId?: string;
  readonly statement?: string;
  readonly predicate?: string;
}

export interface OuterE2eMinPath {
  readonly setup: OuterMinPathAssembly;
  readonly searchSpace: OuterSearchSpaceFixtures;
  readonly killTestHang: VerificationHook;
}

function fixtureFromE3(
  searchSpace: OuterSearchSpaceFixtures,
  contracts?: MethodologyContracts,
): OuterMinFixture {
  const base = createOuterMinFixture({ contracts });
  const nearDup: OuterMinSearchSpaceAttach = {
    catalog: searchSpace.catalog,
    artifact: searchSpace.nearDupArtifact,
    mapped: [searchSpace.mappedNearDup],
  };
  const diversity: OuterMinSearchSpaceAttach = {
    catalog: searchSpace.catalog,
    artifact: searchSpace.diversityArtifact,
    mapped: [searchSpace.mappedDiversity],
  };
  return {
    memory: base.memory,
    catalog: searchSpace.catalog,
    contracts: contracts ?? base.contracts,
    nearDup,
    diversity,
  };
}

function hangInput(
  setup: OuterMinPathAssembly,
  input: AssembleOuterE2eMinPathInput,
): KillTestHangInput {
  return {
    outcome: input.outcome ?? "pass",
    evidenceRefs: input.killEvidenceRefs ?? [OUTER_MIN_KILL_EVIDENCE_ID],
    catalog: setup.fixture.catalog,
    ledger: setup.ledger,
    planId: setup.planId,
    ...(input.resultId === undefined ? {} : { resultId: input.resultId }),
    ...(input.contracts === undefined ? {} : { contracts: input.contracts }),
    ...(input.methodologyEvidence === undefined ? {} : { methodologyEvidence: input.methodologyEvidence }),
    ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
    ...(input.verdictBasis === undefined ? {} : { verdictBasis: input.verdictBasis }),
  };
}

/**
 * One-call glue: E3 mapped SearchSpace refs → E1 setup → Kill-test hang hook.
 * T48 gates sleep when no contract is injected.
 */
export function assembleOuterE2eMinPath(
  input: AssembleOuterE2eMinPathInput = {},
): OuterE2eMinPath {
  const searchSpace = buildOuterSearchSpaceFixtures();
  const fixture = fixtureFromE3(searchSpace, input.contracts);
  const setup = runOuterMinPathSetup({
    fixture,
    hypothesisId: input.hypothesisId,
    planId: input.planId,
    statement: input.statement,
    predicate: input.predicate,
    evidenceRefs: input.evidenceRefs,
  });
  return Object.freeze({
    setup,
    searchSpace,
    killTestHang: createKillTestHangHook(hangInput(setup, input)),
  }) as OuterE2eMinPath;
}
