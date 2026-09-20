/**
 * ET-RSI-LIFT (#174): one authorized /research continue after a measured
 * suite-metric baseline. Public seam: continueResearch.
 * Score is independently measured pass_rate. Promotion hang is engaged.
 * Default stays fixed_uct. No Pi Run. No true submit.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_SUITE_RELATIVE_PATH } from "./start-hard-gates";
import {
  continueResearch,
  formatResearchStatus,
  readResearchStatus,
  type MissionControlEvent,
} from "./research-entry";
import { evaluateSuiteMetric, normalizeSuiteMetricContract } from "../competition/suite-metric";
import { DEFAULT_SEARCH_SELECTION_ID, SELECTION_POLICY_40 } from "../search/search-selection-port";

const MISSION_ID = "demo-suite";

function event(
  sequence: number,
  type: MissionControlEvent["type"],
  payload: Record<string, unknown> = {},
  extras: Partial<MissionControlEvent> = {},
): MissionControlEvent {
  return {
    eventId: extras.eventId ?? `evt-${sequence}`,
    sequence,
    type,
    at: extras.at ?? `2026-09-20T00:00:0${sequence}.000Z`,
    missionId: extras.missionId ?? MISSION_ID,
    ...(extras.action ? { action: extras.action } : {}),
    payload,
  };
}

async function seedDemoSuiteProject(): Promise<string> {
  const demo = join(process.cwd(), DEMO_SUITE_RELATIVE_PATH);
  const project = await mkdtemp(join(tmpdir(), "evok-rsi-lift-"));
  await mkdir(join(project, ".evok"), { recursive: true });
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(join(project, "suite"), { recursive: true });
  await writeFile(join(project, ".evok", "evaluation.json"), await readFile(join(demo, ".evok", "evaluation.json")));
  await writeFile(join(project, "suite", "cases.json"), await readFile(join(demo, "suite", "cases.json")));
  await writeFile(join(project, "src", "solve.js"), await readFile(join(demo, "src", "solve.js")));
  return project;
}

async function measureProject(project: string, snapshot: Readonly<Record<string, string>>) {
  const contract = normalizeSuiteMetricContract(
    JSON.parse(await readFile(join(project, ".evok", "evaluation.json"), "utf8")),
  );
  const suiteFiles = { "suite/cases.json": await readFile(join(project, "suite", "cases.json"), "utf8") };
  return evaluateSuiteMetric(snapshot, contract, { suiteFiles });
}

const userAuth = {
  requested: true as const,
  token: "/research continue",
  missionSelector: MISSION_ID,
  source: "user" as const,
};

describe("one authorized suite-metric continue circle (ET-RSI-LIFT / #174)", () => {
  test("measured baseline is 0.4 and one continue lifts independently measured pass_rate to at least 0.8", async () => {
    const projectRoot = await seedDemoSuiteProject();
    try {
      const baselineFiles = { "src/solve.js": await readFile(join(projectRoot, "src", "solve.js"), "utf8") };
      const before = await measureProject(projectRoot, baselineFiles);
      expect(before.score).toBe(0.4);
      expect(before.n_pass).toBe(2);
      expect(before.n_total).toBe(5);

      const view = await continueResearch({
        projectRoot,
        missionId: MISSION_ID,
        authorization: userAuth,
        seedEvents: [
          event(1, "MISSION_AUTHORIZED", { objective: "raise suite-metric pass_rate toward 0.8" }, { action: "authorize" }),
          event(2, "BASELINE_RECORDED", { runId: `${MISSION_ID}:baseline:1`, ok: true, score: before.score }),
        ],
        clock: () => "2026-09-20T01:00:00.000Z",
        nextId: () => "exp-lift-1",
      });

      expect(view.phase).toBe("experimenting");
      expect(view.lastAction).toBe("continue");
      expect(view.experiments).toHaveLength(1);
      expect(view.experiments[0]?.source).toBe("suite-lift");
      expect(view.experiments[0]?.experimentId).toBe("exp-lift-1");
      expect(view.circle?.kind).toBe("suite-lift");
      expect(view.circle?.verdict).toBe("lifted");
      expect(view.circle?.baselineScore).toBe(0.4);
      expect(view.circle?.measuredScore).toBeGreaterThan(0.4);
      expect(view.circle?.measuredScore).toBeGreaterThanOrEqual(0.8);
      expect(view.circle?.liftTarget).toBe(0.8);
      expect(view.circle?.promotionBlocked).toBe(false);
      expect(view.circle?.hangOutcome).toBe("pass");
      expect(view.circle?.selectionId).toBe(DEFAULT_SEARCH_SELECTION_ID);
      expect(view.circle?.selectionPolicy40).toBe(SELECTION_POLICY_40);
      expect(view.circle?.evidencePath).toMatch(/evidence\/research-continue\/demo-suite\/exp-lift-1\.json$/);

      const printed = formatResearchStatus(view);
      expect(printed).toMatch(/verdict lifted/);
      expect(printed).toMatch(/pass_rate/);
      expect(printed).not.toMatch(/true submit|DeployArena|#40 Progressive stays on/i);

      const archive = JSON.parse(await readFile(view.circle!.evidencePath, "utf8")) as {
        verdict: string;
        baselineScore: number;
        measuredScore: number;
        hang: { ok: boolean; blocksPromotion: boolean; outcome: string };
        selectionId: string;
        selectionPolicy40: string;
        submit: string;
        hypothesisId: string;
        planId: string;
        ledgerEvents: readonly { type: string }[];
      };
      expect(archive.verdict).toBe("lifted");
      expect(archive.baselineScore).toBe(0.4);
      expect(archive.measuredScore).toBeGreaterThanOrEqual(0.8);
      expect(archive.hang.ok).toBe(true);
      expect(archive.hang.blocksPromotion).toBe(false);
      expect(archive.hang.outcome).toBe("pass");
      expect(archive.selectionId).toBe("fixed_uct");
      expect(archive.selectionPolicy40).toBe("off");
      expect(archive.submit).toMatch(/frozen|not authorized/i);
      expect(archive.hypothesisId).toBe("exp-lift-1-h");
      expect(archive.planId).toBe("exp-lift-1-kt");
      expect(archive.ledgerEvents.some((event) => event.type === "kill_test.finished")).toBe(true);

      const recovered = await readResearchStatus(projectRoot, MISSION_ID);
      expect(recovered.experiments[0]?.source).toBe("suite-lift");
      expect(recovered.circle?.verdict).toBe("lifted");
      expect(recovered.circle?.measuredScore).toBe(view.circle?.measuredScore);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("an identity proposal is an honest kill with evidence; promotion stays blocked", async () => {
    const projectRoot = await seedDemoSuiteProject();
    try {
      const view = await continueResearch({
        projectRoot,
        missionId: MISSION_ID,
        authorization: userAuth,
        seedEvents: [
          event(1, "MISSION_AUTHORIZED", { objective: "honest kill when no lift" }, { action: "authorize" }),
          event(2, "BASELINE_RECORDED", { runId: `${MISSION_ID}:baseline:1`, ok: true, score: 0.4 }),
        ],
        lift: {
          propose: (files) => ({
            files: { ...files },
            note: "identity",
            selectionId: DEFAULT_SEARCH_SELECTION_ID,
            selectionPolicy40: SELECTION_POLICY_40,
          }),
        },
        clock: () => "2026-09-20T02:00:00.000Z",
        nextId: () => "exp-kill-1",
      });

      expect(view.circle?.verdict).toBe("killed");
      expect(view.circle?.measuredScore).toBe(0.4);
      expect(view.circle?.promotionBlocked).toBe(true);
      expect(view.circle?.hangOutcome).toBe("fail");
      expect(view.experiments[0]?.source).toBe("suite-lift");
      const printed = formatResearchStatus(view);
      expect(printed).toMatch(/verdict killed/);
      expect(printed).toMatch(/evidence\//);

      const archive = JSON.parse(await readFile(view.circle!.evidencePath, "utf8")) as {
        verdict: string;
        hang: { ok: boolean; blocksPromotion: boolean; outcome: string };
        submit: string;
        ledgerEvents: readonly { type: string }[];
      };
      expect(archive.verdict).toBe("killed");
      expect(archive.hang.ok).toBe(false);
      expect(archive.hang.blocksPromotion).toBe(true);
      expect(archive.hang.outcome).toBe("fail");
      expect(archive.submit).toMatch(/frozen|not authorized/i);
      expect(archive.ledgerEvents.some((event) => event.type === "kill_test.finished")).toBe(true);
      expect(archive.ledgerEvents.some((event) => event.type === "hypothesis.status_changed")).toBe(true);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("unmapped kill-test evidence blocks promotion even when the suite score would lift", async () => {
    const projectRoot = await seedDemoSuiteProject();
    try {
      const view = await continueResearch({
        projectRoot,
        missionId: MISSION_ID,
        authorization: userAuth,
        seedEvents: [
          event(1, "MISSION_AUTHORIZED", { objective: "hang cannot be bypassed" }, { action: "authorize" }),
          event(2, "BASELINE_RECORDED", { runId: `${MISSION_ID}:baseline:1`, ok: true, score: 0.4 }),
        ],
        lift: {
          hang: () => ({
            ok: false,
            outcome: "pass",
            objections: ["artifact lacks T48 mapping"],
            mappedEvidence: [],
            blocksPromotion: true,
            blocksBroker: true,
          }),
        },
        clock: () => "2026-09-20T03:00:00.000Z",
        nextId: () => "exp-hang-1",
      });

      expect(view.circle?.verdict).toBe("killed");
      expect(view.circle?.promotionBlocked).toBe(true);
      expect(view.circle?.measuredScore).toBeGreaterThanOrEqual(0.8);
      const archive = JSON.parse(await readFile(view.circle!.evidencePath, "utf8")) as {
        verdict: string;
        reason: string;
        hang: { blocksPromotion: boolean };
      };
      expect(archive.verdict).toBe("killed");
      expect(archive.reason).toMatch(/T48|promotion|hang/i);
      expect(archive.hang.blocksPromotion).toBe(true);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("explicit Mission Progressive opt-in is callable and does not weld the default", async () => {
    const projectRoot = await seedDemoSuiteProject();
    try {
      const view = await continueResearch({
        projectRoot,
        missionId: MISSION_ID,
        authorization: userAuth,
        seedEvents: [
          event(1, "MISSION_AUTHORIZED", { objective: "opt-in Progressive without welding default" }, { action: "authorize" }),
          event(2, "BASELINE_RECORDED", { runId: `${MISSION_ID}:baseline:1`, ok: true, score: 0.4 }),
        ],
        lift: {
          searchSelection: { progressive: true, topK: 1, tau: 8, seed: 7 },
        },
        clock: () => "2026-09-20T05:00:00.000Z",
        nextId: () => "exp-prog-1",
      });
      expect(view.circle?.selectionId).toBe("progressive_mcgs_optin");
      expect(view.circle?.selectionPolicy40).toBe("opt-in");
      expect(view.circle?.verdict).toBe("lifted");
      const archive = JSON.parse(await readFile(view.circle!.evidencePath, "utf8")) as {
        selectionId: string;
        selectionPolicy40: string;
        submit: string;
      };
      expect(archive.selectionId).toBe("progressive_mcgs_optin");
      expect(archive.selectionPolicy40).toBe("opt-in");
      expect(archive.submit).toMatch(/frozen|not authorized/i);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("how-to-use documents the suite-metric one-circle lift loop", async () => {
    const howTo = await readFile(join(process.cwd(), "docs", "how-to-use.md"), "utf8");
    expect(howTo).toMatch(/Suite-metric \+ one-circle lift/);
    expect(howTo).toMatch(/examples\/demo-suite/);
    expect(howTo).toMatch(/\/research continue/);
    expect(howTo).toMatch(/pass_rate/);
    expect(howTo).toMatch(/0\.8/);
    expect(howTo).toMatch(/evidence\/research-continue/);
    expect(howTo).toMatch(/fixed_uct/);
    expect(howTo).not.toMatch(/true submit authorized|#40 Progressive stays on/i);
  });

  test("file-metric or events-only continue stays the skeleton experiment and does not invent a second plane", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "evok-rsi-skeleton-"));
    try {
      const view = await continueResearch({
        projectRoot,
        missionId: "m-evt138demo01",
        authorization: {
          requested: true,
          token: "/research continue",
          missionSelector: "m-evt138demo01",
          source: "user",
        },
        seedEvents: [
          event(1, "MISSION_AUTHORIZED", { objective: "skeleton still works" }, { action: "authorize", missionId: "m-evt138demo01" }),
          event(2, "BASELINE_RECORDED", { runId: "run-b", ok: true, score: 0.2 }, { missionId: "m-evt138demo01" }),
        ],
        clock: () => "2026-09-20T04:00:00.000Z",
        nextId: () => "exp-skeleton-keep",
      });
      expect(view.experiments[0]?.source).toBe("skeleton");
      expect(view.circle).toBeUndefined();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
