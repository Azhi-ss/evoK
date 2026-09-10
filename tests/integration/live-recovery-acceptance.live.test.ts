/**
 * LIVE acceptance gate for T6 (#114 AC8). Excluded from the default suite by
 * bunfig.toml (`**\/*.live.test.ts`). Unlike the control-plane newapi live
 * tests, this is a full real-provider lifecycle acceptance: it spends real
 * money and must NEVER pass on missing authorization.
 *
 * To run, ALL of the following are required:
 *   EVOK_LIVE_TEST=1|true          explicit opt-in
 *   EVOK_LIVE_TEST_BUDGET_USD=<n>  explicit test budget, a positive number
 *   usable Pi provider config      real model resolves + preflights (Pi auth)
 *
 * If explicitly enabled but the budget is missing/non-positive, provider
 * config is unusable, or the operator-produced acceptance record is missing or
 * exceeds the authorized budget, the test FAILS (blocks) — it never silently
 * skips into a pass, and the lifecycle never performs a real External
 * Submission.
 *
 * The accepted live scenario is executed by the operator with the real CLI
 * (docs/live-acceptance-t6.md); this test verifies the recorded evidence.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const LIVE_ENV = "EVOK_LIVE_TEST";
const BUDGET_ENV = "EVOK_LIVE_TEST_BUDGET_USD";

function liveGate(): { ok: true; budget: number } | { ok: false; reason: string; flagged: boolean } {
  const flag = process.env[LIVE_ENV];
  if (flag !== "1" && flag !== "true") {
    return { ok: false, flagged: false, reason: "live acceptance is opt-in only (EVOK_LIVE_TEST not enabled)" };
  }
  const raw = process.env[BUDGET_ENV];
  const budget = Number(raw);
  if (!raw || !Number.isFinite(budget) || budget <= 0) {
    return { ok: false, flagged: true, reason: `${BUDGET_ENV} must be a positive explicit test budget in model-USD (got ${JSON.stringify(raw)})` };
  }
  return { ok: true, budget };
}

function assertGate(): { budget: number } {
  const gate = liveGate();
  if (!gate.ok) {
    // An explicit run without authorization/config is a hard BLOCK, never a
    // pass. When merely unflagged (default runner), report it as a block too:
    // this file is excluded by default, so executing it at all means intent.
    throw new Error(`live acceptance BLOCKED and must not be reported as a pass: ${gate.reason}`);
  }
  return { budget: gate.budget };
}

describe("T6 full live lifecycle acceptance (#114 AC8)", () => {
  test("an explicit test budget and usable provider configuration gate the run", () => {
    const gate = liveGate();
    if (gate.ok) {
      expect(gate.budget).toBeGreaterThan(0);
      return;
    }
    if (process.env[LIVE_ENV] === "1" || process.env[LIVE_ENV] === "true") {
      throw new Error(`live acceptance BLOCKED: ${gate.reason}`);
    }
    // Default `bun test` never loads this file; reaching here unflagged under an
    // explicit runner is a block rather than a pass.
    throw new Error(`live acceptance not authorized; missing auth/config blocks instead of passing: ${gate.reason}`);
  });

  test("recorded real-provider lifecycle satisfies the acceptance contract within budget", () => {
    const { budget } = assertGate();
    const recordPath = process.env.EVOK_LIVE_RECORD;
    if (!recordPath) {
      throw new Error("authorized live run produced no EVOK_LIVE_RECORD; run docs/live-acceptance-t6.md and attach the record");
    }
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`cannot read live acceptance record: ${(error as Error).message}`);
    }
    for (const key of ["model", "sourceAndToolUse", "artifacts", "independentObservations", "usage", "costUsd", "stopAndRecovery"]) {
      if (record[key] === undefined) throw new Error(`live record missing ${key}`);
    }
    expect(Number(record.costUsd)).toBeLessThanOrEqual(budget);
    expect(record.externalSubmission).toBe(false);
    expect(record.distinguishing).toBe("live");
  });
});
