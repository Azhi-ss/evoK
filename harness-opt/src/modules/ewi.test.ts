import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EWI_THRESHOLD_SEC, EWI_IDLE_SHA, measureEwi, measureRunEwi, resolveEwiIdleScript, roundTenth } from "./ewi";

const EWI_SCRIPT = resolveEwiIdleScript();

describe("EWI metric", () => {
  test("the packaged ewi_idle.py sha is pinned", () => {
    expect(createHash("sha256").update(readFileSync(EWI_SCRIPT)).digest("hex")).toBe(EWI_IDLE_SHA);
  });

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
    expect(existsSync(join(dir, "summary.csv"))).toBe(false);
  });

  test("an env or argument override is rejected", () => {
    const previous = process.env.EWI_IDLE_SCRIPT;
    process.env.EWI_IDLE_SCRIPT = "/tmp/not-the-approved-ewi.py";
    try {
      expect(() => resolveEwiIdleScript()).toThrow(/EWI_IDLE_SCRIPT override is rejected/);
    } finally {
      if (previous === undefined) delete process.env.EWI_IDLE_SCRIPT;
      else process.env.EWI_IDLE_SCRIPT = previous;
    }
    expect(() => resolveEwiIdleScript("/tmp/other-ewi.py")).toThrow(/EWI_IDLE_SCRIPT override is rejected/);
  });

  test("a truncated trace line fails closed instead of scoring the prefix", () => {
    const dir = mkdtempSync(join(tmpdir(), "ewi-truncated-"));
    const outputs = join(dir, "outputs");
    mkdirSync(outputs, { recursive: true });
    const written = join(outputs, "answer.txt");
    writeFileSync(written, "x\n");
    utimesSync(written, 0, 0);
    writeFileSync(join(dir, "trace.jsonl"), `${JSON.stringify({ type: "assistant_message", ts: 10_000 })}\n{"type":"assistant_message","ts":\n`);
    writeFileSync(join(dir, "batch.log"), "1970-01-01T00:11:40.000Z run 1 done\n");
    expect(() => measureRunEwi({
      task: "i014",
      seed: "0",
      timedOut: false,
      tracePath: join(dir, "trace.jsonl"),
      outputsDir: outputs,
      batchLogPath: join(dir, "batch.log"),
    }, 600)).toThrow(/JSONDecodeError/);
  });

  test("an assistant_message without ts fails closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "ewi-missing-ts-"));
    const outputs = join(dir, "outputs");
    mkdirSync(outputs, { recursive: true });
    const written = join(outputs, "answer.txt");
    writeFileSync(written, "x\n");
    utimesSync(written, 0, 0);
    writeFileSync(join(dir, "trace.jsonl"), `${JSON.stringify({ type: "assistant_message", text: "hi" })}\n`);
    writeFileSync(join(dir, "batch.log"), "1970-01-01T00:11:40.000Z run 1 done\n");
    expect(() => measureRunEwi({
      task: "i014",
      seed: "0",
      timedOut: false,
      tracePath: join(dir, "trace.jsonl"),
      outputsDir: outputs,
      batchLogPath: join(dir, "batch.log"),
    }, 600)).toThrow(/missing ts/);
  });

  test("a symlinked output file is followed", () => {
    const dir = mkdtempSync(join(tmpdir(), "ewi-symlink-"));
    const outputs = join(dir, "outputs");
    mkdirSync(outputs, { recursive: true });
    const real = join(dir, "answer.txt");
    writeFileSync(real, "x\n");
    utimesSync(real, 0, 0);
    symlinkSync(real, join(outputs, "answer.txt"));
    const nested = join(dir, "nested");
    mkdirSync(nested, { recursive: true });
    const decoy = join(nested, "later.txt");
    writeFileSync(decoy, "later\n");
    utimesSync(decoy, 5_000, 5_000);
    symlinkSync(nested, join(outputs, "linked-dir"));
    writeFileSync(join(dir, "trace.jsonl"), "");
    writeFileSync(join(dir, "batch.log"), "1970-01-01T00:11:40.000Z run 1 done\n");
    const metrics = measureRunEwi({
      task: "i014",
      seed: "0",
      timedOut: false,
      tracePath: join(dir, "trace.jsonl"),
      outputsDir: outputs,
      batchLogPath: join(dir, "batch.log"),
    }, 600);
    expect(metrics.idleS).toBe(700);
    expect(metrics.postWriteS).toBe(700);
  });

  test("a blank line in the middle fails closed, and a trailing newline does not", () => {
    const dir = edgeDir("blank", `${JSON.stringify({ type: "assistant_message", ts: 1_000 })}\n\n${JSON.stringify({ type: "assistant_message", ts: 2_000 })}\n`);
    expect(() => measureCase(dir)).toThrow(/JSONDecodeError/);
    const trailing = edgeDir("trailing", `${JSON.stringify({ type: "assistant_message", ts: 1_000 })}\n`);
    expect(measureCase(trailing).idleS).toBe(699);
  });

  test("a non-finite assistant timestamp is a missing ts", () => {
    const dir = edgeDir("nan", "{\"type\":\"assistant_message\",\"ts\":NaN}\n");
    expect(() => measureCase(dir)).toThrow(/missing ts/);
    expect(() => measureCase(edgeDir("inf", "{\"type\":\"assistant_message\",\"ts\":Infinity}\n"))).toThrow(/missing ts/);
    expect(() => measureCase(edgeDir("true", "{\"type\":\"assistant_message\",\"ts\":true}\n"))).toThrow(/missing ts/);
  });

  test("the shared edge table matches ewi_idle.py", () => {
    const rows: { readonly name: string; readonly trace: string; readonly link: boolean; readonly idle?: number; readonly error?: RegExp }[] = [
      { name: "blank-middle", trace: "{\"type\":\"assistant_message\",\"ts\":1000}\n\n{\"type\":\"assistant_message\",\"ts\":2000}\n", link: false, error: /JSONDecodeError/ },
      { name: "ts-nan", trace: "{\"type\":\"assistant_message\",\"ts\":NaN}\n", link: false, error: /missing ts/ },
      { name: "ts-true", trace: "{\"type\":\"assistant_message\",\"ts\":true}\n", link: false, error: /missing ts/ },
      { name: "ts-false", trace: "{\"type\":\"assistant_message\",\"ts\":false}\n", link: false, error: /missing ts/ },
      { name: "ts-infinity", trace: "{\"type\":\"assistant_message\",\"ts\":Infinity}\n", link: false, error: /missing ts/ },
      { name: "ts-neginfinity", trace: "{\"type\":\"assistant_message\",\"ts\":-Infinity}\n", link: false, error: /missing ts/ },
      { name: "ts-string", trace: "{\"type\":\"assistant_message\",\"ts\":\"1\"}\n", link: false, error: /missing ts/ },
      { name: "truncated", trace: "{\"type\":\"assistant_message\",\"ts\":\n", link: false, error: /JSONDecodeError/ },
      { name: "missing-ts", trace: "{\"type\":\"assistant_message\"}\n", link: false, error: /missing ts/ },
      { name: "non-object", trace: "[1,2]\n", link: false, error: /'list' object has no attribute 'get'/ },
      { name: "non-object-null", trace: "null\n", link: false, error: /'NoneType' object has no attribute 'get'/ },
      { name: "lone-cr", trace: "{\"type\":\"assistant_message\",\"ts\":1000}\r{\"type\":\"assistant_message\",\"ts\":2000}\n", link: false, idle: 698 },
      { name: "symlink-output", trace: "", link: true, idle: 700 },
    ];
    for (const row of rows) {
      const dir = edgeDir(row.name, row.trace, row.link);
      if (row.idle === undefined) {
        expect(() => measureCase(dir)).toThrow(row.error ?? /missing ts|JSONDecodeError|has no attribute 'get'/);
        const proc = spawnSync("python3", [EWI_SCRIPT, dir], { encoding: "utf8" });
        expect(proc.status).not.toBe(0);
        continue;
      }
      expect(measureCase(dir).idleS).toBe(row.idle);
      expect(pythonIdle(dir)).toBe(row.idle);
    }
  });
});

function measureCase(dir: string) {
  return measureRunEwi({
    task: "i014",
    seed: "0",
    timedOut: false,
    tracePath: join(dir, "trace.jsonl"),
    outputsDir: join(dir, "outputs"),
    batchLogPath: join(dir, "batch.log"),
  }, 600);
}

function edgeDir(name: string, trace: string, link = false): string {
  const dir = mkdtempSync(join(tmpdir(), `ewi-${name}-`));
  const outputs = join(dir, "outputs");
  mkdirSync(outputs, { recursive: true });
  const real = join(dir, "answer.txt");
  writeFileSync(real, "x\n");
  utimesSync(real, 0, 0);
  if (link) {
    symlinkSync(real, join(outputs, "answer.txt"));
    const nested = join(dir, "nested");
    mkdirSync(nested, { recursive: true });
    const decoy = join(nested, "later.txt");
    writeFileSync(decoy, "later\n");
    utimesSync(decoy, 5_000, 5_000);
    symlinkSync(nested, join(outputs, "linked-dir"));
  } else {
    const written = join(outputs, "answer.txt");
    writeFileSync(written, "x\n");
    utimesSync(written, 0, 0);
  }
  const tracePath = join(dir, "trace.jsonl");
  writeFileSync(tracePath, trace);
  writeFileSync(join(dir, "batch.log"), "1970-01-01T00:11:40.000Z run 1 done\n");
  writeFileSync(join(dir, "summary.csv"), `task,seed,n,timed_out,trace\ni014,0,1,False,${tracePath}\n`);
  return dir;
}

function pythonIdle(dir: string): number {
  const proc = spawnSync("python3", [EWI_SCRIPT, dir], { encoding: "utf8" });
  if (proc.status !== 0) throw new Error(proc.stderr || proc.stdout || "ewi_idle.py failed");
  const line = proc.stdout.split("\n").find((item) => item.startsWith("{"));
  if (!line) throw new Error(proc.stdout || "ewi_idle.py printed nothing");
  return (JSON.parse(line) as { idle: number }).idle;
}
