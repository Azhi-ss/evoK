/**
 * Six-pack physical closeout & barrel contract seam:
 * - six physical packs (`mission`, `evidence`, `execution`, `search`,
 *   `competition`, `cli`) plus `memory` and `harness` are in place;
 * - pack barrels keep their safety locks (fail-closed gates, thin default B,
 *   mock-by-default LLM arms, GPT* ban, default `fixed_uct` / `#40` off,
 *   thin CLI shell);
 * - ToyHarness stays fixtures/tests only under `src/search/fixtures/`;
 * - all migration-period flat `src/*.ts` and memory forwarding shims are gone.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as cli from "../../src/cli";
import * as cliPacked from "../../src/cli/evok-cli";
import * as cliPlugin from "../../src/cli/evok-plugin";
import * as competition from "../../src/competition";
import * as evidence from "../../src/evidence";
import * as execution from "../../src/execution";
import * as mission from "../../src/mission";
import {
  LiveLlmKeyMissingError,
  NEWAPI_API_KEY_ENV,
  NEWAPI_DEFAULT_MODEL_ENV,
  NEWAPI_LIVE_ENV,
} from "../../src/newapi-client";
import * as search from "../../src/search";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = join(ROOT, "src");

const SIX_PACKS = ["mission", "evidence", "execution", "search", "competition", "cli"] as const;

const REMOVED_SHIMS = [
  "file-blueprint.ts",
  "evok-cli.ts",
  "second-toy-adapter.ts",
  "baseline-track.ts",
  "branch-recovery.ts",
  "llm-propose-outer-min.ts",
  "mission-director.ts",
  "mission-draft.ts",
  "mission-intake.ts",
  "mission-resume.ts",
  "mission-start.ts",
  "outer-e2e-min-path.ts",
  "outer-min-path.ts",
  "research-loop.ts",
  "v1-golden-path.ts",
  "hypothesis-ledger.ts",
  "kill-test-hang.ts",
  "ledger-kinds.ts",
  "methodology-acceptance.ts",
  "methodology-contracts.ts",
  "methodology.ts",
  "submission-broker.ts",
  "validation-ladder.ts",
  "verification-gates.ts",
  "dag-scheduler.ts",
  "model-orchestra.ts",
  "pi-agent-runtime.ts",
  "security-boundary.ts",
  "team-execution.ts",
  "outer-search-space-fixtures.ts",
  "search-selection-port.ts",
  "search-space-profile.ts",
  "toy-harness.ts",
  "llm-comp-arm-before-promotion.ts",
  "llm-competition-runtime.ts",
  "evidence/research-memory.ts",
  "execution/memory-slice.ts",
  "execution/research-memory-provider.ts",
] as const;

function runtimeKeys(mod: object): string[] {
  return Object.keys(mod).sort();
}

function ref(branchId: string, suffix = "1") {
  return Object.freeze({
    artifactId: `${branchId}-${suffix}`,
    branchId,
    address: `artifact://${branchId}/${suffix}`,
    digest: `${branchId}:${suffix}`,
  });
}

describe("P6 six-pack physical closeout", () => {
  test("six physical pack directories exist under src/ and each exposes index.ts", () => {
    for (const pack of SIX_PACKS) {
      const dir = join(SRC, pack);
      expect({ pack, exists: existsSync(dir) }).toEqual({ pack, exists: true });
      expect({ pack, directory: statSync(dir).isDirectory() }).toEqual({ pack, directory: true });
      expect({ pack, barrel: existsSync(join(dir, "index.ts")) }).toEqual({ pack, barrel: true });
    }
  });

  test("evidence barrel is the gate-authority surface, preserves three-state gates, and does not swallow other packs", () => {
    expect(typeof evidence.runKillTestHang).toBe("function");
    expect(typeof evidence.createKillTestHangHook).toBe("function");
    expect(typeof evidence.killTestHangHasLedgerPlan).toBe("function");
    expect(typeof evidence.auditMethodology).toBe("function");
    expect(typeof evidence.oofEnsembleGate).toBe("function");
    expect(typeof evidence.HypothesisLedger).toBe("function");
    expect(typeof evidence.verificationRoleContract).toBe("function");
    expect(typeof evidence.SubmissionBroker).toBe("function");
    expect(typeof evidence.attemptContestAutoSubmit).toBe("function");
    expect(typeof evidence.evaluateContestAutoSubmitGates).toBe("function");
    expect(typeof evidence.ledgerEventKind).toBe("function");

    const digest = "sha256:toy-split-ref-v1";
    const contracts = evidence.resolveMethodologyContracts({
      splitContract: { splitRef: { digest } },
      oofEnsemble: { required: true },
    });
    expect(evidence.auditMethodology({ splitDigestAgreement: "unknown", oofPresent: false }).ok).toBe(true);
    expect(evidence.oofEnsembleGate({ splitDigestAgreement: "unknown", oofPresent: false }).ok).toBe(true);
    expect(evidence.auditMethodology({ splitRefDigest: "sha256:other", splitDigestAgreement: "disagree", oofPresent: false }, contracts).ok).toBe(false);
    expect(evidence.oofEnsembleGate({ splitRefDigest: "sha256:other", splitDigestAgreement: "disagree", oofPresent: false }, contracts).ok).toBe(false);
    expect(evidence.auditMethodology({ splitRefDigest: digest, splitDigestAgreement: "agree", oofPresent: true }, contracts).ok).toBe(true);
    expect(evidence.oofEnsembleGate({ splitRefDigest: digest, splitDigestAgreement: "agree", oofPresent: true }, contracts).ok).toBe(true);

    const keys = runtimeKeys(evidence);
    expect(keys).not.toContain("startAuthorizedMission");
    expect(keys).not.toContain("runGoldenPath");
    expect(keys).not.toContain("ToyCompetitionHarness");
    expect(keys).not.toContain("createToyMission");
    expect(keys).not.toContain("Coordinator");
    expect(keys).not.toContain("createLlmCompetitionRuntime");
    expect(keys).not.toContain("submitContest");
    expect(keys).not.toContain("submitToCompetition");
    expect(keys).not.toContain("SELECTION_POLICY_40");
  });

  test("search barrel keeps fixed_uct / #40 off even when EVOK_SEARCH_SELECTION is set and does not re-export ToyHarness", () => {
    expect(search.DEFAULT_SEARCH_SELECTION_ID).toBe("fixed_uct");
    expect(search.SELECTION_POLICY_40).toBe("off");
    expect(search.STRONG_SEARCH_OPT_IN_ID).toBe("strong_search");
    expect(search.createDefaultSearchSelectionPort().id).toBe("fixed_uct");
    expect(typeof search.createSeaHost).toBe("function");
    expect(typeof search.createMethodVersionStats).toBe("function");
    expect(typeof search.optInStrongSearchPort).toBe("function");
    expect(search.createSeaHost().defaultSelection().id).toBe("fixed_uct");
    expect(search.createSeaHost().mounted()).toBeUndefined();

    const previous = process.env.EVOK_SEARCH_SELECTION;
    process.env.EVOK_SEARCH_SELECTION = "progressive_mcgs_optin";
    try {
      expect(search.createDefaultSearchSelectionPort().id).toBe("fixed_uct");
      expect(search.createSearchSelectionPort().id).toBe("fixed_uct");
    } finally {
      if (previous === undefined) delete process.env.EVOK_SEARCH_SELECTION;
      else process.env.EVOK_SEARCH_SELECTION = previous;
    }

    const keys = runtimeKeys(search);
    expect(keys).not.toContain("ToyCompetitionHarness");
    expect(keys).not.toContain("createToyMission");
    expect(keys).not.toContain("replayToyMission");
    expect(keys).not.toContain("startAuthorizedMission");
    expect(keys).not.toContain("resumeAuthorizedMission");
    expect(keys).not.toContain("runGoldenPath");
    expect(keys).not.toContain("MissionDirector");
  });

  test("ToyHarness stays fixtures/tests only under src/search/fixtures/", () => {
    expect(existsSync(join(SRC, "search", "fixtures", "toy-harness.ts"))).toBe(true);
    expect(existsSync(join(SRC, "search", "fixtures", "OWNERSHIP.md"))).toBe(true);
    const ownership = readFileSync(join(SRC, "search", "fixtures", "OWNERSHIP.md"), "utf8");
    expect(ownership).toMatch(/fixtures\/tests/i);
    expect(ownership).toMatch(/not a second control plane/i);

    const fixture = readFileSync(join(SRC, "search", "fixtures", "toy-harness.ts"), "utf8");
    expect(fixture).toMatch(/Not a product control plane/);
    expect(fixture).not.toMatch(/export function startAuthorizedMission/);
    expect(fixture).not.toMatch(/export function resumeAuthorizedMission/);
    expect(fixture).not.toMatch(/export async function startAuthorizedMission/);
    expect(fixture).not.toMatch(/export async function resumeAuthorizedMission/);
  });

  test("execution barrel keeps thin default B, non-promotion roster locks, and read-only pattern specs", async () => {
    expect(execution.DEFAULT_BRANCH_WIDTH).toBe(1);
    expect(execution.createThinExecutionPlan().branchWidth).toBe(1);
    expect(execution.createThinExecutionPlan().verificationGates).toEqual([]);
    expect(new execution.Coordinator().propose({}).branchWidth).toBe(1);

    const thinGuard = new execution.PolicyGuard({
      maxBranchWidth: 3,
      maxAttempts: 1,
      maxBranchBudget: 1,
      permissions: [],
      resources: [],
    });
    const scheduler = new execution.DeterministicScheduler(thinGuard);
    const completed = await scheduler.run(execution.createThinExecutionPlan(), {
      branchIds: ["a"],
      execute: (branch) => ref(branch.branchId),
    });
    expect(completed[0]?.status).toBe("COMPLETED");

    const rejected = await scheduler.run(execution.createThinExecutionPlan(), {
      branchIds: ["a"],
      execute: (branch) => ref(branch.branchId),
      falsifier: () => ({ ok: false, objections: ["counterexample"] }),
    });
    expect(rejected[0]?.status).toBe("REJECTED");

    const fanIn = new execution.ArtifactFanIn(
      () => ({ score: 1, elite: true, teamFanOutWidth: 8, roster: ["Falsifier", "Critic"] }),
      (_artifact, evaluation) => evaluation.score > 5,
      ["a"],
    );
    expect((await fanIn.reconcile([ref("a")])).promoted).toBeUndefined();

    for (const name of ["contest-loop.md", "dual-arm.md", "research-thin.md"] as const) {
      const patternPath = join(SRC, "execution", "patterns", name);
      expect(existsSync(patternPath)).toBe(true);
      const body = readFileSync(patternPath, "utf8");
      expect(body).not.toMatch(/```(?:ts|js|typescript|javascript)/i);
      expect(body.toLowerCase()).not.toContain("full roster present");
    }

    expect(runtimeKeys(execution)).not.toContain("selectExecutionPattern");
    expect(runtimeKeys(execution)).not.toContain("switchCoordinatorTrack");
    expect(runtimeKeys(execution)).not.toContain("requireFullRoster");
  });

  test("mission, competition, and cli barrels stay on their mock-default, allowlist, and thin-shell locks", async () => {
    expect(typeof mission.startAuthorizedMission).toBe("function");
    expect(typeof mission.runGoldenPath).toBe("function");
    expect(typeof mission.runOrchGap).toBe("function");
    expect(typeof mission.runDeployArenaOrch).toBe("function");
    expect(typeof mission.parseResearchCommand).toBe("function");
    expect(typeof mission.continueResearch).toBe("function");
    expect(typeof mission.parseSkillsCommand).toBe("function");
    expect(typeof mission.listSkillsDirectory).toBe("function");
    expect(runtimeKeys(mission)).not.toContain("ToyCompetitionHarness");

    expect(runtimeKeys({ ...cliPacked, ...cliPlugin })).toEqual(runtimeKeys(cli));
    expect(typeof cli.parseEvokArgs).toBe("function");
    expect(typeof cli.runEvok).toBe("function");
    expect(runtimeKeys(cli)).not.toContain("startAuthorizedMission");
    expect(runtimeKeys(cli)).not.toContain("runGoldenPath");
    expect(runtimeKeys(cli)).not.toContain("MissionDirector");
    expect(runtimeKeys(cli)).not.toContain("continueResearch");
    expect(runtimeKeys(cli)).not.toContain("recoverResearchStatus");
    expect(runtimeKeys(cli)).not.toContain("listSkillsDirectory");
    expect(runtimeKeys(cli)).not.toContain("proposeSkillWriteback");

    const savedKey = process.env[NEWAPI_API_KEY_ENV];
    const savedLive = process.env[NEWAPI_LIVE_ENV];
    const savedModel = process.env[NEWAPI_DEFAULT_MODEL_ENV];
    delete process.env[NEWAPI_API_KEY_ENV];
    delete process.env[NEWAPI_DEFAULT_MODEL_ENV];
    process.env[NEWAPI_LIVE_ENV] = "1";
    try {
      const golden = await mission.runGoldenPath({ statement: "mock default must ignore EVOK_NEWAPI_LIVE" });
      expect(golden.arm.runtime).toBeInstanceOf(competition.MockLlmCompetitionRuntime);
      await expect(mission.runGoldenPath({ live: true, statement: "live requires key" })).rejects.toBeInstanceOf(
        LiveLlmKeyMissingError,
      );

      const envOnly = await competition.runLlmCompArmBeforePromotion({ missionId: "env-must-not-open-live" });
      expect(envOnly.arm.runtime).toBeInstanceOf(competition.MockLlmCompetitionRuntime);
      await expect(
        competition.runLlmCompArmBeforePromotion({ live: true, missionId: "explicit-live-fail-closed" }),
      ).rejects.toBeInstanceOf(LiveLlmKeyMissingError);

      delete process.env[NEWAPI_LIVE_ENV];
      expect(() => competition.createLlmCompetitionRuntime({ model: "gpt-4" })).toThrow(/allowlist|not allowlisted/i);
      expect(() => competition.createLlmCompetitionRuntime({ model: "GPT-4o" })).toThrow(/allowlist|not allowlisted/i);
      expect(() => competition.createLlmCompetitionRuntime({ model: "DeepSeek-V3" })).not.toThrow();
      expect(() => competition.createLlmCompetitionRuntime({ model: "Gemini-2.5-pro" })).not.toThrow();
    } finally {
      if (savedKey === undefined) delete process.env[NEWAPI_API_KEY_ENV];
      else process.env[NEWAPI_API_KEY_ENV] = savedKey;
      if (savedLive === undefined) delete process.env[NEWAPI_LIVE_ENV];
      else process.env[NEWAPI_LIVE_ENV] = savedLive;
      if (savedModel === undefined) delete process.env[NEWAPI_DEFAULT_MODEL_ENV];
      else process.env[NEWAPI_DEFAULT_MODEL_ENV] = savedModel;
    }

    expect(typeof competition.runDeployArenaGraph).toBe("function");
    expect(typeof competition.assembleDeployArenaSubmission).toBe("function");
    expect(runtimeKeys(competition)).not.toContain("SubmissionBroker");
    expect(runtimeKeys(competition)).not.toContain("submitContest");
    expect(runtimeKeys(competition)).not.toContain("submitToCompetition");
    expect(runtimeKeys(competition)).not.toContain("createKillTestHangHook");
  });

  test("all migration-period flat src/*.ts and memory re-export shims are removed", () => {
    for (const rel of REMOVED_SHIMS) {
      expect({ rel, exists: existsSync(join(SRC, rel)) }).toEqual({ rel, exists: false });
    }

    const leftoverFlatShims = readdirSync(SRC)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
      .filter((name) => {
        const full = join(SRC, name);
        if (!existsSync(full) || statSync(full).isDirectory()) return false;
        const body = readFileSync(full, "utf8");
        return /^\s*(?:\/\*\*[\s\S]*?\*\/\s*)?export \* from "\.\//.test(body);
      });

    expect(leftoverFlatShims).toEqual([]);
  });
});
