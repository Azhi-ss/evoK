import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EWI_THRESHOLD_SEC, measureEwi, measureRunEwi, roundTenth } from "./ewi";

describe("EWI metric", () => {
  test("rounds the first decimal the way Python 3 round does", () => {
    expect(roundTenth(1.25)).toBe(1.2);
    expect(roundTenth(1.35)).toBe(1.4);
    expect(roundTenth(-0.25)).toBe(-0.2);
    expect(roundTenth(-1.25)).toBe(-1.2);
    expect(roundTenth(5208.65)).toBe(5208.6);
    expect(roundTenth(5208.75)).toBe(5208.8);
  });

  test("i014 seed1 hits both clauses at the frozen thresholds", () => {
    const sample = {
      task: "i014",
      seed: "1",
      timedOut: true,
      tWrite: 1_000,
      tEnd: 1_000 + 5386.8,
      assistantTs: [1_000 + 178.1],
    };
    for (const threshold of [300, 600, 1200]) {
      const metrics = measureEwi(sample, threshold);
      expect(metrics.postWriteS).toBe(5386.8);
      expect(metrics.idleS).toBe(5208.7);
      expect(metrics.gapMaxS).toBe(5208.7);
      expect(metrics.clause1).toBe(true);
      expect(metrics.clause2).toBe(true);
      expect(metrics.ewi).toBe(true);
    }
  });

  test("a sub-second write after the log stamp is not EWI", () => {
    const metrics = measureEwi({
      task: "i006",
      seed: "0",
      timedOut: false,
      tWrite: 1_000.2,
      tEnd: 1_000,
      assistantTs: [],
    }, DEFAULT_EWI_THRESHOLD_SEC);
    expect(metrics.postWriteS).toBe(-0.2);
    expect(metrics.idleS).toBe(-0.2);
    expect(metrics.gapMaxS).toBe(-0.2);
    expect(metrics.clause1).toBe(false);
    expect(metrics.clause2).toBe(false);
    expect(metrics.ewi).toBe(false);
  });

  test("a long gap without a timeout is not clause 2", () => {
    const metrics = measureEwi({
      task: "hb008",
      seed: "0",
      timedOut: false,
      tWrite: 0,
      tEnd: 466,
      assistantTs: [315.5, 464.8],
    }, 300);
    expect(metrics.postWriteS).toBe(466);
    expect(metrics.idleS).toBe(1.2);
    expect(metrics.gapMaxS).toBe(315.5);
    expect(metrics.clause1).toBe(false);
    expect(metrics.clause2).toBe(false);
    expect(metrics.ewi).toBe(false);
  });

  test("clause 2 fires when the run timed out and the gap reaches the threshold", () => {
    const metrics = measureEwi({
      task: "i014",
      seed: "1",
      timedOut: true,
      tWrite: 0,
      tEnd: 700,
      assistantTs: [650],
    }, 600);
    expect(metrics.idleS).toBe(50);
    expect(metrics.gapMaxS).toBe(650);
    expect(metrics.clause1).toBe(false);
    expect(metrics.clause2).toBe(true);
    expect(metrics.ewi).toBe(true);
  });

  test("reads outputs mtime, assistant timestamps, and the batch.log done line", () => {
    const dir = mkdtempSync(join(tmpdir(), "ewi-run-"));
    const outputs = join(dir, "outputs");
    mkdirSync(outputs, { recursive: true });
    const written = join(outputs, "answer.txt");
    writeFileSync(written, "rs3847502\n");
    const tWrite = Date.parse("2026-10-21T06:27:47.200Z") / 1000;
    utimesSync(written, tWrite, tWrite);
    const tLast = Date.parse("2026-10-21T06:30:45.300Z") / 1000;
    writeFileSync(join(dir, "trace.jsonl"), `${JSON.stringify({
      type: "assistant_message",
      ts: tLast * 1000,
      text: "still going",
    })}\n`);
    const tEnd = Date.parse("2026-10-21T07:57:34.000Z") / 1000;
    writeFileSync(join(dir, "batch.log"), `2026-10-21T07:57:34.000Z run 1 done\n`);
    const metrics = measureRunEwi({
      task: "i014",
      seed: "1",
      timedOut: true,
      tracePath: join(dir, "trace.jsonl"),
      outputsDir: outputs,
      batchLogPath: join(dir, "batch.log"),
      runNumber: 1,
    }, 600);
    expect(metrics.postWriteS).toBe(roundTenth(tEnd - tWrite));
    expect(metrics.idleS).toBe(roundTenth(tEnd - tLast));
    expect(metrics.ewi).toBe(true);
  });
});
