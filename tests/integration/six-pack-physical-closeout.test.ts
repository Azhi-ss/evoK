/**
 * ET-A6 / P6 closeout seam: six physical packs are in place, barrels are
 * consistent, ToyHarness is fixtures/tests only, and leftover flat
 * `src/*.ts` shims are either gone or an explicit one-release re-export.
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
 * Migration-period re-exports that stay one more release: production modules,
 * integration tests, examples, the recovery driver, or the ToyHarness fixture
 * barrel still import these flat paths. Retargeting them is a second big move.
 */
const KEPT_MIGRATION_SHIMS = {
  mission: [
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
  ],
  evidence: [
    "hypothesis-ledger.ts",
    "kill-test-hang.ts",
    "ledger-kinds.ts",
    "methodology-acceptance.ts",
    "methodology-contracts.ts",
    "methodology.ts",
    "submission-broker.ts",
    "validation-ladder.ts",
    "verification-gates.ts",
  ],
  execution: [
    "dag-scheduler.ts",
    "model-orchestra.ts",
    "pi-agent-runtime.ts",
    "security-boundary.ts",
    "team-execution.ts",
  ],
  search: [
    "outer-search-space-fixtures.ts",
    "search-selection-port.ts",
    "search-space-profile.ts",
    "toy-harness.ts",
  ],
  competition: [
    "llm-comp-arm-before-promotion.ts",
    "llm-competition-runtime.ts",
  ],
} as const;

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
    expect(search.createDefaultSearchSelectionPort().id).toBe("fixed_uct");
    expect(typeof search.createSeaHost).toBe("function");
    expect(typeof search.createMethodVersionStats).toBe("function");
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
    expect(runtimeKeys(competition)).not.toContain("SubmissionBroker");
    expect(runtimeKeys(competition)).not.toContain("submitContest");
    expect(runtimeKeys(competition)).not.toContain("createKillTestHangHook");
  });

  test("dead flat shims are gone; remaining shims are re-export-only for one more release", () => {
    for (const name of DELETED_DEAD_SHIMS) {
      expect({ name, exists: existsSync(join(SRC, name)) }).toEqual({ name, exists: false });
    }

    const expectedKept = Object.entries(KEPT_MIGRATION_SHIMS).flatMap(([pack, files]) =>
      files.map((file) => ({ pack, file })),
    );

    for (const { pack, file } of expectedKept) {
      const path = join(SRC, file);
      expect({ file, exists: existsSync(path) }).toEqual({ file, exists: true });
      const body = readSrc(file);
      expect({ file, reexport: /Compatibility re-export/.test(body) }).toEqual({ file, reexport: true });
      expect({ file, target: body.includes(`export * from "./${pack}/`) }).toEqual({ file, target: true });
      expect(body.trim().split("\n").length).toBeLessThanOrEqual(3);
    }

    const leftoverFlatShims = readdirSync(SRC)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => {
        if (!existsSync(join(SRC, name)) || statSync(join(SRC, name)).isDirectory()) return false;
        const body = readSrc(name);
        return /export \* from "\.\//.test(body) && /Compatibility re-export/.test(body);
      })
      .sort();

    expect(leftoverFlatShims).toEqual(expectedKept.map(({ file }) => file).sort());
  });
});
