/**
 * ET-PROMPT-MODE / #150 — Explore / Intake / Mission three-mode prompts.
 *
 * Session assembly, not a second control plane. Overlay text does not
 * authorize start / continue / External Submission.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverEvokResources } from "../evok-resources";
import { loadMissionDraft } from "../mission/mission-draft";
import { listUnfinishedMissions } from "../mission/mission-resume";
import { loadMissionRecord } from "../mission/mission-start";
import {
  discloseSkill,
  listSkillsDirectory,
  type SkillPointer,
} from "../mission/skills-routing";

export const PROMPT_MODE_STATUS_KEY = "evok-mode";

export const PROMPT_MODES = ["explore", "intake", "mission"] as const;
export type PromptMode = (typeof PROMPT_MODES)[number];

/** Optional Explore footnote. Must not carry Mission / intake interview wording. */
export const EXPLORE_FOOTNOTE = "This directory can be managed by evoK `--project`.";

export const DRAFT_NOT_AUTHORIZATION =
  "A Mission draft is not authorization to start, continue, or submit.";

export const NO_EXTERNAL_SUBMISSION = "External Submission is frozen — do not submit.";

export const DRAFT_FIELD_CONSTRAINTS = [
  "Research Objective and concrete success criteria",
  "data (and where it lives) and evaluation method/metric",
  "hard constraints / permissions and budget with explicit units",
  "intended outputs and stop conditions",
  "unresolved execution prerequisites",
  "settled decisions and cited sources",
  "initial plan: baseline/hypothesis and first Task Contracts only",
].join("\n");

export interface ResolvePromptModeInput {
  readonly projectRoot: string;
  /** User triggered intake / is writing a draft this session. */
  readonly intakeActive?: boolean;
}

export interface AssemblePromptOverlayInput {
  readonly mode: PromptMode;
  readonly projectRoot: string;
  readonly missionId?: string;
}

export function formatPromptModeBanner(mode: PromptMode): string {
  return `mode=${mode}`;
}

export async function resolvePromptMode(input: ResolvePromptModeInput): Promise<PromptMode> {
  if (input.intakeActive) return "intake";
  const listing = await listUnfinishedMissions(input.projectRoot);
  if (listing.missions.some((entry) => entry.resumable)) return "mission";
  if (listing.drafts.length > 0) return "intake";
  return "explore";
}

export async function assemblePromptOverlay(input: AssemblePromptOverlayInput): Promise<string> {
  if (input.mode === "explore") return EXPLORE_FOOTNOTE;
  if (input.mode === "intake") return assembleIntakeOverlay(input.projectRoot);
  return assembleMissionOverlay(input.projectRoot, input.missionId);
}

async function loadSkills(projectRoot: string) {
  const resources = await discoverEvokResources({ projectRoot });
  return listSkillsDirectory({ projectRoot, discovered: resources.skills });
}

function formatL0Skills(pointers: readonly SkillPointer[]): string {
  const lines = ["L0 evoK skills (accepted name + description; not authorization):"];
  if (pointers.length === 0) {
    lines.push("- (none)");
    return lines.join("\n");
  }
  for (const pointer of pointers) {
    const cat = pointer.category ? ` [${pointer.category}]` : "";
    lines.push(`- ${pointer.name}${cat}: ${pointer.description}`);
  }
  return lines.join("\n");
}

async function assembleIntakeOverlay(projectRoot: string): Promise<string> {
  const directory = await loadSkills(projectRoot);
  const intake = directory.skills.find((entry) => entry.name === "mission-intake");
  const l1 = intake ? await discloseSkill(intake, "l1-body") : undefined;
  const listing = await listUnfinishedMissions(projectRoot);
  const draftId = listing.drafts[0]?.id;
  const draft = draftId ? await loadMissionDraft(projectRoot, draftId).catch(() => undefined) : undefined;
  const parts = [
    "evoK Intake overlay. Follow mission-intake. This session writes a reviewable Mission draft.",
    DRAFT_NOT_AUTHORIZATION,
    "Draft field constraints:",
    DRAFT_FIELD_CONSTRAINTS,
  ];
  if (draft) {
    parts.push(`Current draft ${draft.id} (status=draft). Objective: ${draft.objective}`);
  }
  if (l1?.body) {
    parts.push("mission-intake L1:", l1.body);
  }
  return parts.join("\n\n");
}

async function assembleMissionOverlay(projectRoot: string, missionId?: string): Promise<string> {
  const listing = await listUnfinishedMissions(projectRoot);
  const selected = missionId
    ?? listing.missions.find((entry) => entry.resumable)?.id
    ?? listing.missions[0]?.id;
  const directory = await loadSkills(projectRoot);
  const lines = [
    "evoK Mission overlay. Chat is not Mission authority.",
    NO_EXTERNAL_SUBMISSION,
  ];
  if (selected) {
    const record = await loadMissionRecord(projectRoot, selected).catch(() => undefined);
    if (record) {
      const hardRules = record.contract.hardRules ?? [];
      const permissions = record.permissions ?? [];
      lines.push(`objective: ${record.objective}`);
      lines.push(`constraints: ${[...hardRules, ...permissions].join("; ") || "(none)"}`);
      lines.push(
        `budget: ${record.budget.consumed.toFixed(6)} / ${record.budget.total} ${record.budget.units} consumed · ${record.budget.remaining.toFixed(6)} remaining`,
      );
      const stop = record.stopConditions?.length
        ? record.stopConditions.join("; ")
        : record.stopReason ?? "(none)";
      lines.push(`stop: ${stop}`);
      lines.push(`baseline: ${record.baselineRunId ?? record.baseline?.runId ?? "(none)"}`);
    } else {
      const view = listing.missions.find((entry) => entry.id === selected);
      if (view) {
        lines.push(`objective: (see Mission ${view.id})`);
        lines.push(`budget: ${view.consumedBudget} / ${view.totalBudget} ${view.units}`);
        if (view.stopReason) lines.push(`stop: ${view.stopReason}`);
      }
    }
  }
  lines.push(formatL0Skills(directory.defaultContext));
  return lines.join("\n");
}

export interface PromptModeExtensionOptions {
  readonly projectRoot: string;
  readonly intakeActive?: boolean;
}

export function createEvokPromptModeExtension(
  options: PromptModeExtensionOptions,
): (pi: Pick<ExtensionAPI, "on">) => void {
  const resolve = () => resolvePromptMode({
    projectRoot: options.projectRoot,
    ...(options.intakeActive ? { intakeActive: true } : {}),
  });
  const paint = async (ctx: { ui: { setStatus(key: string, text: string | undefined): void } }, mode: PromptMode) => {
    ctx.ui.setStatus(PROMPT_MODE_STATUS_KEY, formatPromptModeBanner(mode));
  };
  return (pi) => {
    pi.on("session_start", async (_event, ctx) => {
      await paint(ctx, await resolve());
    });
    pi.on("before_agent_start", async (event, ctx) => {
      const mode = await resolve();
      await paint(ctx, mode);
      const overlay = await assemblePromptOverlay({
        mode,
        projectRoot: options.projectRoot,
      });
      if (!overlay) return;
      return { systemPrompt: `${event.systemPrompt}\n\n${overlay}` };
    });
  };
}
