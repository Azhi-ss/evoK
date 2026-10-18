import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { flag } from "./args";
import { Budget } from "./budget";
import { FIXED_MODEL_ID } from "./fixed-model";
import { Lineage } from "./lineage";
import { runEval } from "../bin/eval";
import { writeRunState } from "../bin/record";
import { Orchestrator, type SubmitGateResult } from "./orchestrator";
import { GreedySelector } from "./modules/selector";

/**
 * `harnessopt_submit_gate` entry. Reads the run directory, then calls
 * `Orchestrator.submitGate`, which ANDs the evidence checklist, the held-out
 * floor, the TTS baseline, and dry-run. The numeric score stays in
 * `state/gate.jsonl` and in the return value. `run_state.json` does not
 * carry it. Live playground submit is not called.
 */

export async function handleSubmitGate(args: string): Promise<SubmitGateResult> {
  const argv = args.trim() === "" ? [] : args.trim().split(/\s+/);
  const root = flag(argv, "--root");
  if (!root) throw new Error("harnessopt_submit_gate requires --root");
  const result = runDirectorySubmitGate(root);
  writeRunState(join(root, "state"), {
    phase: "gate",
    submit: result.submit,
    node: result.node,
    failed: result.checks.filter((check) => !check.ok).map((check) => check.id),
  });
  return result;
}

export function runDirectorySubmitGate(root: string): SubmitGateResult {
  const state = join(root, "state");
  const lineage = new Lineage(state);
  const orchestrator = new Orchestrator(lineage, unusedRoles(), new GreedySelector(), new Budget());
  const best = lineage.best();
  const modelId = readModelId(root, best.configPath);
  return orchestrator.submitGate({
    heldoutEval: () => {
      const scored = runEval({ root, cand: "heldout", split: "heldout", gate: true });
      return scored.scores[0] ?? Number.NaN;
    },
    ttsBaseline: readNumber(join(state, "tts-baseline.json"), "score", 0.5),
    baseHeldout: readNumber(join(state, "heldout-floor.json"), "score", 0.4),
    day: new Date().toISOString().slice(0, 10),
    modelId,
    tracePackComplete: tracePackComplete(root),
    changeNotePresent: changeNotePresent(root),
    tokenBudget: 5_000_000,
    tokensSpent: 0,
  });
}

function readModelId(root: string, configPath: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(root, configPath), "utf8")) as { modelId?: unknown };
    return typeof parsed.modelId === "string" ? parsed.modelId : "";
  } catch {
    return "";
  }
}

function tracePackComplete(root: string): boolean {
  const dir = join(root, "traces");
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((name) => name.endsWith(".json"));
}

function changeNotePresent(root: string): boolean {
  const note = join(root, "evidence_pack", "change-note.md");
  if (!existsSync(note)) return false;
  return readFileSync(note, "utf8").trim() !== "";
}

function readNumber(path: string, key: string, fallback: number): number {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const value = parsed[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function unusedRoles() {
  const refuse = () => {
    throw new Error("submit gate does not run gap finder, innovator, runner, or reviewer");
  };
  return {
    gapFinder: refuse,
    innovator: refuse,
    runner: refuse,
    reviewer: refuse,
    submitter: () => ({
      ok: true,
      submitted: false,
      mode: "dry-run" as const,
      detail: `evidence gate is green for ${FIXED_MODEL_ID}; live playground submit is off`,
    }),
  };
}
