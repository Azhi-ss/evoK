#!/usr/bin/env bun
/**
 * Phase 2 entry point (#208): `bun src/cli/phase2-cli.ts <command>` or
 * `bun run phase2 <command>`. A running EvoK research Mission uses the same
 * classes programmatically (`src/mission/phase2-research.ts`).
 *
 * `demo` runs the whole normal path offline against the scripted fake
 * platform. Real commands use the operator's bohr/playground CLIs and fail
 * closed while the pinned kit, quota or credentials are unavailable.
 */
import { pathToFileURL } from "node:url";
import {
  Phase2PlaygroundAdapter,
  createPhase2JsonStore,
  type Phase2EvidenceKind,
  type Phase2Platform,
} from "../competition/phase2-playground";
import { CliPhase2Platform } from "../competition/phase2-cli-platform";
import { FakePhase2Platform, type FakePhase2Script } from "../competition/phase2-fake-platform";
import { Phase2Research, initPhase2Research } from "../mission/phase2-research";
import { createPhase2WorkspaceRunner } from "../mission/phase2-workspace-runner";
import { readFileSync } from "node:fs";

const USAGE = `phase2 commands:
  init --cap <n> [--units cny]
  propose --summary <text> --change <json>
  evidence --revision <id> --kind <screening|withheld-validation|noisy-repeat|source-check|public-smoke|cloud-self-test> [--score n] [--passed true|false] [--cost n] [--external-booking] [--ref s] [--note s]
  nominate
  release [--revision <id>]
  submit --model <model_name> [--real] [--estimated-cost n] [--confirm-quota n]
  reconcile [--bind <localAttemptRef>:<platformAttemptId>]
  next
  tick [--workspace <dir> --task <id> [--base-tree <path>] [--kind screening|withheld-validation|noisy-repeat]]
  status [--researcher]
  demo
common: --state <path> (default .phase2/state.json) --fake <script.json> for an offline platform
real platform: --kit-dir <dir> --source-dir <dir> --trace <file> --work-dir <dir>`;

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function makeResearch(statePath: string, platform: Phase2Platform): Phase2Research {
  const store = createPhase2JsonStore(statePath);
  return new Phase2Research({ store, adapter: new Phase2PlaygroundAdapter({ store, platform }) });
}

function makePlatform(argv: readonly string[]): Phase2Platform {
  const fake = flag(argv, "--fake");
  if (fake) return new FakePhase2Platform(JSON.parse(readFileSync(fake, "utf8")) as FakePhase2Script);
  const kitDir = flag(argv, "--kit-dir");
  const sourceDir = flag(argv, "--source-dir");
  const tracePath = flag(argv, "--trace");
  if (!kitDir || !sourceDir || !tracePath) {
    throw new Error("real platform needs --kit-dir, --source-dir and --trace (or pass --fake <script.json>)");
  }
  const confirmed = flag(argv, "--confirm-quota");
  if (confirmed !== undefined && (!Number.isSafeInteger(Number(confirmed)) || Number(confirmed) < 0)) {
    throw new Error("--confirm-quota must be a non-negative integer observed on the platform");
  }
  return new CliPhase2Platform({
    kitDir,
    sourceDir,
    tracePath,
    workDir: flag(argv, "--work-dir") ?? ".phase2",
    ...(confirmed !== undefined ? { confirmedQuotaToday: Number(confirmed) } : {}),
    ...(flag(argv, "--workspace") ? { workspaceDir: flag(argv, "--workspace") } : {}),
  });
}

/** Offline normal-path proof: two revisions, replacement, quota exhaustion,
 * timeout/restart, duplicate prevention and the eventual official result. */
export async function runPhase2Demo(statePath: string): Promise<Record<string, unknown>> {
  const platform = new FakePhase2Platform({
    quota: [0, 0, 1, 1],
    submitOutcomes: ["timeout"],
    officialScore: 0.62,
    officialCost: 7.5,
    evaluationSteps: 1,
  });
  const store = createPhase2JsonStore(statePath);
  if (store.exists()) throw new Error("demo needs a fresh --state path; the normal path is not resettable in place");
  initPhase2Research(store, { cap: 100, units: "cny" });
  let research = makeResearch(statePath, platform);
  const steps: Record<string, unknown>[] = [];

  const a = research.proposeRevision({ summary: "runtime: baseline planning", change: { runtime: "agent.py@v1", prompts: { system: "plan-first" } } });
  const b = research.proposeRevision({ summary: "runtime + skills: checked execution", change: { runtime: "agent.py@v2", skills: ["result-check@v1"] } });
  const evidence = (id: string, kind: Phase2EvidenceKind, score: number | undefined, cost: number): void => {
    research.recordEvidence(id, { kind, ...(score === undefined ? {} : { score }), cost, note: `demo ${kind}` });
  };
  for (const [id, screening, withheld, repeat, cloud] of [[a.id, 0.4, 0.41, 0.4, 0.42], [b.id, 0.55, 0.58, 0.57, 0.56]] as const) {
    evidence(id, "screening", screening, 1);
    evidence(id, "withheld-validation", withheld, 2);
    evidence(id, "noisy-repeat", repeat, 2);
    research.recordEvidence(id, { kind: "public-smoke", passed: true, cost: 0 });
    research.recordEvidence(id, { kind: "source-check", passed: true, cost: 0 });
    evidence(id, "cloud-self-test", cloud, 5);
  }
  steps.push({ step: "two-competing-revisions", a: a.id, b: b.id });

  const first = research.nominate();
  const second = research.nominate();
  if (first.nomineeId !== b.id || second.replaced) throw new Error(`nomination should pick the strongest eligible revision, got ${JSON.stringify({ first, second })}`);
  steps.push({ step: "nominate-strongest", nomineeId: second.nomineeId });

  const release = await research.release();
  if (!release.ready) throw new Error(`release should be ready: ${JSON.stringify(release.checks)}`);
  const dryRun = await research.submit({ modelName: "deepseek-v4.1-flash" });
  if (dryRun.kind !== "dry-run") throw new Error(`expected dry-run, got ${dryRun.kind}`);
  steps.push({ step: "dry-run", kind: dryRun.kind, releaseReady: release.ready });

  const quotaOut = await research.submit({ modelName: "deepseek-v4.1-flash", real: true, estimatedCost: 10 });
  if (quotaOut.kind !== "waiting") throw new Error(`expected quota waiting, got ${quotaOut.kind}`);
  const afterQuota = await research.nextAction();
  if (afterQuota.action !== "research") throw new Error("research must continue while quota is exhausted");
  steps.push({ step: "quota-exhausted", kind: quotaOut.kind, next: afterQuota.action });

  const timedOut = await research.submit({ modelName: "deepseek-v4.1-flash", real: true, estimatedCost: 10 });
  if (timedOut.kind !== "uncertain") throw new Error(`expected uncertain submit, got ${timedOut.kind}`);
  // Restart: fresh objects over the same persisted state. No blind resubmit.
  research = makeResearch(statePath, platform);
  const duplicate = await research.submit({ modelName: "deepseek-v4.1-flash", real: true, estimatedCost: 10 });
  if (duplicate.kind !== "uncertain") throw new Error("an unconfirmed attempt must reconcile, never resubmit");
  const pending = await research.reconcile();
  if (pending[0]?.state !== "evaluating") throw new Error(`expected evaluating after reconcile, got ${pending[0]?.state}`);
  steps.push({ step: "timeout-restart", state: pending[0]?.state, submitCalls: platform.submitCalls });

  const final = await research.reconcile();
  const view = research.directorView();
  const official = view.revisions.find((entry) => entry.revisionId === b.id)?.official;
  if (final[0]?.state !== "scored" || official !== 0.62) throw new Error(`expected verified official 0.62, got ${JSON.stringify(final[0])}`);
  const researcher = research.researcherView();
  if (JSON.stringify(researcher).includes("fake-source") || JSON.stringify(researcher).includes("attempt-")) {
    throw new Error("researcher view must not leak source datasets or attempt internals");
  }
  const next = await research.nextAction();
  steps.push({ step: "official-result", state: final[0]?.state, official, cost: final[0]?.official?.cost, next: next.action, budget: view.budget });
  if (platform.submitCalls !== 1) throw new Error(`exactly one real platform submit is allowed, got ${platform.submitCalls}`);
  return { ok: true, state: statePath, steps, director: view, researcher };
}

export async function runPhase2Cli(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const statePath = flag(rest, "--state") ?? ".phase2/state.json";
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  try {
    if (command === "demo") {
      console.log(JSON.stringify(await runPhase2Demo(statePath), null, 2));
      return 0;
    }
    if (command === "init") {
      const cap = Number(flag(rest, "--cap"));
      const state = initPhase2Research(createPhase2JsonStore(statePath), { cap, units: flag(rest, "--units") ?? "cny" });
      console.log(JSON.stringify({ ok: true, budget: state.budget }));
      return 0;
    }
    const research = makeResearch(statePath, makePlatform(rest));
    switch (command) {
      case "propose": {
        const summary = flag(rest, "--summary");
        const change = flag(rest, "--change");
        if (!summary || !change) throw new Error("propose needs --summary and --change <json>");
        console.log(JSON.stringify(research.proposeRevision({ summary, change: JSON.parse(change) as Record<string, unknown> }), null, 2));
        return 0;
      }
      case "evidence": {
        const revision = flag(rest, "--revision");
        const kind = flag(rest, "--kind") as Phase2EvidenceKind | undefined;
        if (!revision || !kind) throw new Error("evidence needs --revision and --kind");
        const score = flag(rest, "--score");
        const passed = flag(rest, "--passed");
        const cost = flag(rest, "--cost");
        research.recordEvidence(revision, {
          kind,
          ...(score !== undefined ? { score: Number(score) } : {}),
          ...(passed !== undefined ? { passed: passed === "true" } : {}),
          ...(cost !== undefined ? { cost: Number(cost) } : {}),
          ...(rest.includes("--external-booking") ? { externalBooking: true } : {}),
          ...(flag(rest, "--ref") ? { ref: flag(rest, "--ref") } : {}),
          ...(flag(rest, "--note") ? { note: flag(rest, "--note") } : {}),
        });
        console.log(JSON.stringify({ ok: true }));
        return 0;
      }
      case "nominate":
        console.log(JSON.stringify(research.nominate()));
        return 0;
      case "release":
        console.log(JSON.stringify(await research.release(flag(rest, "--revision")), null, 2));
        return 0;
      case "submit": {
        const model = flag(rest, "--model");
        if (!model) throw new Error("submit needs --model <model_name>");
        const estimated = flag(rest, "--estimated-cost");
        console.log(JSON.stringify(await research.submit({
          modelName: model,
          real: rest.includes("--real"),
          ...(estimated !== undefined ? { estimatedCost: Number(estimated) } : {}),
        }), null, 2));
        return 0;
      }
      case "reconcile": {
        const bind = flag(rest, "--bind");
        if (bind) {
          const [ref, platformId] = bind.split(":");
          if (!ref || !platformId) throw new Error("--bind needs <localAttemptRef>:<platformAttemptId>");
          research.bindAttempt(ref, platformId);
        }
        console.log(JSON.stringify(await research.reconcile(), null, 2));
        return 0;
      }
      case "tick": {
        const workspace = flag(rest, "--workspace");
        const task = flag(rest, "--task");
        if ((workspace && !task) || (!workspace && task)) throw new Error("tick research hook needs both --workspace and --task");
        const runner = workspace && task ? createPhase2WorkspaceRunner({
          workspaceDir: workspace,
          taskId: task,
          ...(flag(rest, "--base-tree") ? { baseTree: flag(rest, "--base-tree") } : {}),
          ...(flag(rest, "--kind") ? { kind: flag(rest, "--kind") as "screening" | "withheld-validation" | "noisy-repeat" } : {}),
        }) : undefined;
        console.log(JSON.stringify(await research.tick(runner), null, 2));
        return 0;
      }
      case "next":
        console.log(JSON.stringify(await research.nextAction(), null, 2));
        return 0;
      case "status":
        console.log(JSON.stringify(rest.includes("--researcher") ? research.researcherView() : research.directorView(), null, 2));
        return 0;
      default:
        console.error(`unknown command ${command}\n${USAGE}`);
        return 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: (error as Error).message }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runPhase2Cli(process.argv.slice(2));
}
