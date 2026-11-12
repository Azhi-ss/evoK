/**
 * ET-A6 / P6 closeout seam: six physical packs are in place, barrels are
 * consistent, ToyHarness is fixtures/tests only, and no flat `src/*.ts`
 * re-export shim is left (M-e / #246 removed the one-release migration set).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as cli from "../../src/cli";
import * as competition from "../../src/competition";
import * as evidence from "../../src/evidence";
import * as execution from "../../src/execution";
import * as mission from "../../src/mission";
import * as search from "../../src/search";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = join(ROOT, "src");

const SIX_PACKS = ["mission", "evidence", "execution", "search", "competition", "cli"] as const;

/** Flat shims with no remaining in-repo consumer besides the old compat test. */
const DELETED_DEAD_SHIMS = [
  "file-blueprint.ts",
  "evok-cli.ts",
  "second-toy-adapter.ts",
] as const;

/**
 * Flat modules that were never part of a six-pack cut and are not shims, so they
 * stay at `src/`; everything else that lived at `src/*.ts` as a re-export is
 * gone (#246).
 */
const SHARED_ROOT_MODULES = [
  "data-honesty.ts",
  "evaluation-noise.ts",
  "evok-model.ts",
  "evok-resources.ts",
  "idea-types.ts",
  "local-file-evaluator.ts",
  "newapi-client.ts",
  "predict-reconcile.ts",
  "project-evaluator.ts",
  "recovery-lifecycle-driver.ts",
] as const;

function runtimeKeys(mod: object): string[] {
  return Object.keys(mod).sort();
}

function readSrc(name: string): string {
  return readFileSync(join(SRC, name), "utf8");
}

describe("P6 six-pack physical closeout", () => {
  test("six physical pack directories exist under src/", () => {
    for (const pack of SIX_PACKS) {
      const dir = join(SRC, pack);
      expect({ pack, exists: existsSync(dir) }).toEqual({ pack, exists: true });
      expect({ pack, directory: statSync(dir).isDirectory() }).toEqual({ pack, directory: true });
    }
  });

  test("each pack exposes a barrel index.ts", () => {
    for (const pack of SIX_PACKS) {
      const barrel = join(SRC, pack, "index.ts");
      expect({ pack, barrel: existsSync(barrel) }).toEqual({ pack, barrel: true });
    }
  });

  test("evidence barrel is the gate-authority surface and does not swallow other packs", () => {
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

  test("search barrel keeps #40 off and does not re-export ToyHarness or Mission authority", () => {
    expect(search.DEFAULT_SEARCH_SELECTION_ID).toBe("fixed_uct");
    expect(search.SELECTION_POLICY_40).toBe("off");
    expect(search.STRONG_SEARCH_OPT_IN_ID).toBe("strong_search");
    expect(search.createDefaultSearchSelectionPort().id).toBe("fixed_uct");
    expect(typeof search.createSeaHost).toBe("function");
    expect(typeof search.createMethodVersionStats).toBe("function");
    expect(typeof search.optInStrongSearchPort).toBe("function");
    expect(search.createSeaHost().defaultSelection().id).toBe("fixed_uct");

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
    // Fixture barrel may re-export research-loop for tests; it must not
    // define Mission authorize / continue / repair / stop itself.
    expect(fixture).not.toMatch(/export function startAuthorizedMission/);
    expect(fixture).not.toMatch(/export function resumeAuthorizedMission/);
    expect(fixture).not.toMatch(/export async function startAuthorizedMission/);
    expect(fixture).not.toMatch(/export async function resumeAuthorizedMission/);
  });

  test("mission / cli / execution / competition barrels stay on their existing locks", () => {
    expect(typeof mission.startAuthorizedMission).toBe("function");
    expect(typeof mission.runGoldenPath).toBe("function");
    expect(typeof mission.runOrchGap).toBe("function");
    expect(typeof mission.runDeployArenaOrch).toBe("function");
    expect(typeof mission.parseResearchCommand).toBe("function");
    expect(typeof mission.continueResearch).toBe("function");
    expect(typeof mission.parseSkillsCommand).toBe("function");
    expect(typeof mission.listSkillsDirectory).toBe("function");
    expect(runtimeKeys(mission)).not.toContain("ToyCompetitionHarness");

    expect(typeof cli.parseEvokArgs).toBe("function");
    expect(typeof cli.runEvok).toBe("function");
    expect(runtimeKeys(cli)).not.toContain("startAuthorizedMission");
    expect(runtimeKeys(cli)).not.toContain("runGoldenPath");
    expect(runtimeKeys(cli)).not.toContain("MissionDirector");
    expect(runtimeKeys(cli)).not.toContain("continueResearch");
    expect(runtimeKeys(cli)).not.toContain("recoverResearchStatus");
    expect(runtimeKeys(cli)).not.toContain("listSkillsDirectory");
    expect(runtimeKeys(cli)).not.toContain("proposeSkillWriteback");

    expect(execution.DEFAULT_BRANCH_WIDTH).toBe(1);
    expect(execution.createThinExecutionPlan().branchWidth).toBe(1);
    expect(runtimeKeys(execution)).not.toContain("selectExecutionPattern");
    expect(runtimeKeys(execution)).not.toContain("requireFullRoster");

    expect(typeof competition.createLlmCompetitionRuntime).toBe("function");
    expect(typeof competition.runDeployArenaGraph).toBe("function");
    expect(typeof competition.assembleDeployArenaSubmission).toBe("function");
    expect(runtimeKeys(competition)).not.toContain("SubmissionBroker");
    expect(runtimeKeys(competition)).not.toContain("submitContest");
    expect(runtimeKeys(competition)).not.toContain("createKillTestHangHook");
  });

  test("no flat re-export shim is left at src/", () => {
    for (const name of DELETED_DEAD_SHIMS) {
      expect({ name, exists: existsSync(join(SRC, name)) }).toEqual({ name, exists: false });
    }

    const flatTs = readdirSync(SRC).filter((name) => name.endsWith(".ts")).sort();
    // Ambient declarations and shared non-pack modules are not shims.
    const allowed = new Set<string>([...SHARED_ROOT_MODULES, "bun-sqlite.d.ts", "bun-test.d.ts"]);
    const unexpected = flatTs.filter((name) => !allowed.has(name) && !name.endsWith(".test.ts"));
    expect(unexpected).toEqual([]);

    for (const name of flatTs.filter((entry) => !entry.endsWith(".d.ts") && !entry.endsWith(".test.ts"))) {
      const body = readSrc(name);
      expect({ name, shim: /Compatibility re-export/.test(body) }).toEqual({ name, shim: false });
      expect({ name, barrel: /^export \* from "\.\//m.test(body) }).toEqual({ name, barrel: false });
    }
  });
});
