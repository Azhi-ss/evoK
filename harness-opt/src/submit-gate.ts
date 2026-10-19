import { join } from "node:path";
import { readHostFile } from "./artifacts";
import { ensureRealDir } from "./containment";
import { listTraceFiles } from "./traces";
import { flag } from "./args";
import { Budget } from "./budget";
import { FIXED_MODEL_ID } from "./fixed-model";
import { readEvaluatedHeldOut } from "./heldout-file";
import { readMatchedBudgetTts } from "./tts-file";
import { Lineage } from "./lineage";
import { writeRunState } from "../bin/record";
import { probePlaygroundDryRun } from "./playground-dry-run";
import { Orchestrator, type SubmitGateRequest, type SubmitGateResult } from "./orchestrator";
import { GreedySelector } from "./modules/selector";
import { readThresholds, readTokensSpent } from "./thresholds";

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
  const result = await runDirectorySubmitGate(root);
  writeRunState(ensureRealDir(root, "state"), {
    phase: "gate",
    submit: result.submit,
    node: result.node,
    failed: result.checks.filter((check) => !check.ok).map((check) => check.id),
  });
  return result;
}

/** Gate inputs from the run directory. Missing files stay missing; nothing is filled in. */
export function buildDirectoryGateRequest(root: string): SubmitGateRequest {
  const state = ensureRealDir(root, "state");
  const lineage = new Lineage(state);
  const best = lineage.best();
  const modelId = readModelId(root, best.configPath);
  const thresholds = readThresholds(root);
  const usage = readTokensSpent(root);
  const missing = [
    ...(thresholds.ok ? [] : thresholds.missing),
    ...(usage.ok ? [] : [usage.missing]),
  ];
  return {
    heldoutEval: (configPath) => readEvaluatedHeldOut(root, configPath),
    ttsEval: () => readMatchedBudgetTts(root),
    ttsBaseline: thresholds.ok ? thresholds.value.ttsBaseline : Number.NaN,
    baseHeldout: thresholds.ok ? thresholds.value.heldOutFloor : Number.NaN,
    ...(thresholds.ok ? { minDelta: thresholds.value.minDelta } : {}),
    day: new Date().toISOString().slice(0, 10),
    modelId,
    tracePackComplete: tracePackComplete(root),
    changeNotePresent: changeNotePresent(root),
    tokenBudget: thresholds.ok ? thresholds.value.tokenBudget : Number.NaN,
    tokensSpent: usage.ok ? usage.tokensSpent : Number.NaN,
    maxSubmitsPerDay: thresholds.ok ? thresholds.value.maxOnlineSubmitsPerDay : Number.NaN,
    dryRun: () => probePlaygroundDryRun(join(root, "evidence_pack", "pack.json")),
    ...(missing.length > 0 ? { missingInputs: missing } : {}),
  };
}

export async function runDirectorySubmitGate(root: string): Promise<SubmitGateResult> {
  const state = ensureRealDir(root, "state");
  const lineage = new Lineage(state);
  const orchestrator = new Orchestrator(lineage, unusedRoles(), new GreedySelector(), new Budget());
  return orchestrator.submitGate(buildDirectoryGateRequest(root));
}

function readModelId(root: string, configPath: string): string {
  try {
    const parsed = JSON.parse(readHostFile(root, configPath)) as { modelId?: unknown };
    return typeof parsed.modelId === "string" ? parsed.modelId : "";
  } catch {
    return "";
  }
}

function tracePackComplete(root: string): boolean {
  try {
    return listTraceFiles(join(root, "traces")).length > 0;
  } catch {
    return false;
  }
}

function changeNotePresent(root: string): boolean {
  try {
    return readHostFile(root, "evidence_pack/change-note.md").trim() !== "";
  } catch {
    return false;
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
