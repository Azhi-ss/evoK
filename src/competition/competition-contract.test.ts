/**
 * CompetitionContract: versioned, content-addressed rules/split/scoring/
 * submission/limits. A persisted contract that drifts from its digest fails
 * validation; a version is always required.
 */
import { describe, expect, test } from "bun:test";
import {
  COMPETITION_CONTRACT_SCHEMA,
  CompetitionContractError,
  competitionContractDigest,
  createCompetitionContract,
  validateCompetitionContract,
  type CompetitionContractInput,
} from "./competition-contract";

const INPUT: CompetitionContractInput = {
  version: "2026.1",
  competitionId: "toy-challenge",
  title: "Toy challenge",
  objective: "Predict the target within the split discipline.",
  scoring: { metric: "rmse", direction: "minimize" },
  dataSplit: { kind: "kfold", folds: 5, holdout: "protected" },
  submission: { format: "csv:id,prediction", maxPerDay: 5, quota: 50 },
  limits: { timeLimitMs: 3_600_000, network: "none", allowedResources: ["cpu"] },
};

describe("competition contract", () => {
  test("create computes a stable digest over the full contract", () => {
    const a = createCompetitionContract(INPUT);
    const b = createCompetitionContract({ ...INPUT });
    expect(a.schema).toBe(COMPETITION_CONTRACT_SCHEMA);
    expect(a.digest).toBe(competitionContractDigest(INPUT));
    expect(a.digest).toBe(b.digest);
    expect(Object.isFrozen(a)).toBe(true);
  });

  test("digest changes when any rule or limit changes", () => {
    const a = createCompetitionContract(INPUT);
    const changedLimit = createCompetitionContract({ ...INPUT, limits: { ...INPUT.limits, network: "open" } });
    const changedSplit = createCompetitionContract({ ...INPUT, dataSplit: { ...INPUT.dataSplit, folds: 10 } });
    expect(changedLimit.digest).not.toBe(a.digest);
    expect(changedSplit.digest).not.toBe(a.digest);
  });

  test("validate round-trips a persisted contract", () => {
    const contract = createCompetitionContract(INPUT);
    const restored = validateCompetitionContract(JSON.parse(JSON.stringify(contract)));
    expect(restored).toEqual(contract);
  });

  test("validate rejects a tampered contract (digest mismatch)", () => {
    const contract = createCompetitionContract(INPUT);
    const tampered = { ...contract, submission: { ...contract.submission, quota: 500 } };
    expect(() => validateCompetitionContract(tampered)).toThrow(CompetitionContractError);
    expect(() => validateCompetitionContract(tampered)).toThrow(/digest mismatch/);
  });

  test("version is required and must be non-empty", () => {
    expect(() => createCompetitionContract({ ...INPUT, version: "" })).toThrow(CompetitionContractError);
    expect(() => createCompetitionContract({ ...INPUT, version: "  " })).toThrow(/version is required/);
  });

  test("typed resource requirements validate and are covered by the digest", () => {
    const resources = {
      cpus: 8,
      memoryBytes: 32 * 1024 ** 3,
      gpu: { backend: "cuda" as const, count: 2, model: "A100", minMemoryBytes: 40 * 1024 ** 3 },
      storageBytes: 100 * 1024 ** 3,
      maxConcurrency: 4,
    };
    const withResources = createCompetitionContract({ ...INPUT, resources });
    expect(withResources.resources).toEqual(resources);
    // The digest covers the typed requirements: adding, dropping, or mutating them changes it.
    const without = createCompetitionContract(INPUT);
    expect(withResources.digest).not.toBe(without.digest);
    const moreVram = createCompetitionContract({ ...INPUT, resources: { ...resources, gpu: { ...resources.gpu, minMemoryBytes: 80 * 1024 ** 3 } } });
    expect(moreVram.digest).not.toBe(withResources.digest);
    const restored = validateCompetitionContract(JSON.parse(JSON.stringify(withResources)));
    expect(restored).toEqual(withResources);
    const tampered = { ...withResources, resources: { ...resources, maxConcurrency: 400 } };
    expect(() => validateCompetitionContract(tampered)).toThrow(/digest mismatch/);
  });

  test("resource requirements stay optional for backward compatibility", () => {
    const contract = createCompetitionContract(INPUT);
    expect(contract.resources).toBeUndefined();
    expect(validateCompetitionContract(JSON.parse(JSON.stringify(contract)))).toEqual(contract);
  });

  test("malformed resource requirements fail validation", () => {
    const base = { cpus: 8, memoryBytes: 1024 };
    expect(() => createCompetitionContract({ ...INPUT, resources: { ...base, cpus: 0 } })).toThrow(/resources.cpus/);
    expect(() => createCompetitionContract({ ...INPUT, resources: { ...base, memoryBytes: -1 } })).toThrow(/resources.memoryBytes/);
    expect(() => createCompetitionContract({ ...INPUT, resources: { ...base, gpu: { backend: "tpu" as never, count: 1 } } })).toThrow(/gpu.backend/);
    expect(() => createCompetitionContract({ ...INPUT, resources: { ...base, gpu: { backend: "cuda" as const, count: 0 } } })).toThrow(/gpu.count/);
    expect(() => createCompetitionContract({ ...INPUT, resources: { ...base, gpu: { backend: "cuda" as const, count: 1, minMemoryBytes: 0 } } })).toThrow(/minMemoryBytes/);
    expect(() => createCompetitionContract({ ...INPUT, resources: { ...base, maxConcurrency: 0 } })).toThrow(/maxConcurrency/);
    expect(() => createCompetitionContract({ ...INPUT, resources: { ...base, storageBytes: 1.5 } })).toThrow(/storageBytes/);
  });

  test("rejects malformed split, scoring, and network fields", () => {
    expect(() => createCompetitionContract({ ...INPUT, dataSplit: { ...INPUT.dataSplit, kind: "random" as never } })).toThrow(/dataSplit.kind/);
    expect(() => createCompetitionContract({ ...INPUT, scoring: { ...INPUT.scoring, direction: "up" as never } })).toThrow(/scoring.direction/);
    expect(() => createCompetitionContract({ ...INPUT, limits: { ...INPUT.limits, network: "vpn" as never } })).toThrow(/limits.network/);
    expect(() => validateCompetitionContract({ ...createCompetitionContract(INPUT), schema: "other" })).toThrow(/schema/);
  });
});
