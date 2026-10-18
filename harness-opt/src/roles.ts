/**
 * Role declarations for PRD §5.3.
 *
 * Orchestrator is not in the LLM roster: it is deterministic code.
 * Runner and Submitter are tool roles. Report Writer and Submitter may
 * stay stubs in the MVP, but their write permissions are already separate.
 */

export const LLM_ROLES = ["gap-finder", "innovator", "reviewer", "report-writer"] as const;
export const TOOL_ROLES = ["runner", "submitter"] as const;
export const CONTROL_ROLES = ["orchestrator"] as const;

export const ROLE_IDS = [...CONTROL_ROLES, ...LLM_ROLES, ...TOOL_ROLES] as const;
export type RoleId = (typeof ROLE_IDS)[number];

export interface RoleContract {
  readonly id: RoleId;
  readonly kind: "control" | "llm" | "tool";
  readonly writes: readonly string[];
  readonly forbids: readonly string[];
  /** Prompt file. Mounting it into pi-subagents is unverified. */
  readonly prompt: string;
}

export const ROLE_CONTRACTS: Readonly<Record<RoleId, RoleContract>> = {
  orchestrator: {
    id: "orchestrator",
    kind: "control",
    writes: ["run_state.json", "schedule.log", "history/"],
    forbids: ["edit harness", "score", "submit"],
    prompt: "agents/orchestrator.md",
  },
  "gap-finder": {
    id: "gap-finder",
    kind: "llm",
    writes: ["gaps.json", "gaps.md"],
    forbids: ["patch", "submit"],
    prompt: "agents/gap-finder.md",
  },
  innovator: {
    id: "innovator",
    kind: "llm",
    writes: ["patch.json"],
    forbids: ["sandbox", "held-out", "submit"],
    prompt: "agents/innovator.md",
  },
  runner: {
    id: "runner",
    kind: "tool",
    writes: ["traces/"],
    forbids: ["edit config", "submit"],
    prompt: "agents/runner.md",
  },
  reviewer: {
    id: "reviewer",
    kind: "llm",
    writes: ["review.json"],
    forbids: ["write patch"],
    prompt: "agents/reviewer.md",
  },
  "report-writer": {
    id: "report-writer",
    kind: "llm",
    writes: ["evidence_pack/"],
    forbids: ["change score", "bypass gate"],
    prompt: "agents/report-writer.md",
  },
  submitter: {
    id: "submitter",
    kind: "tool",
    writes: ["submit-receipt.json"],
    forbids: ["submit without evidence"],
    prompt: "agents/submitter.md",
  },
};

/** Product state machine. The orchestrator is the only thing that advances it. */
export const ROUND_PHASES = [
  "gap-finder",
  "innovator",
  "runner",
  "reviewer",
  "report-writer",
  "submitter",
] as const;

export type RoundPhase = (typeof ROUND_PHASES)[number];
