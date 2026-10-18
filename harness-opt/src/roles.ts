/**
 * Role declarations for PRD §5.3 and setup §6.
 *
 * Orchestrator is deterministic code, not an agent file. Runner is the
 * host command `bin/eval.ts`, so there is no `agents/runner.md` for Pi to
 * scan. Reviewer is named `reviewer-gate` so it does not replace the
 * built-in `reviewer` agent. Report Writer and Submitter stay as write
 * contracts; their prompts are not mounted under `agents/`.
 */

export const LLM_ROLES = ["gap-finder", "innovator", "reviewer-gate", "report-writer"] as const;
export const TOOL_ROLES = ["runner", "submitter"] as const;
export const CONTROL_ROLES = ["orchestrator"] as const;

export const ROLE_IDS = [...CONTROL_ROLES, ...LLM_ROLES, ...TOOL_ROLES] as const;
export type RoleId = (typeof ROLE_IDS)[number];

export interface RoleContract {
  readonly id: RoleId;
  readonly kind: "control" | "llm" | "tool";
  readonly writes: readonly string[];
  readonly forbids: readonly string[];
  /** Prompt file. Only the three files under `agents/` are Pi subagent defs. */
  readonly prompt: string;
}

export const ROLE_CONTRACTS: Readonly<Record<RoleId, RoleContract>> = {
  orchestrator: {
    id: "orchestrator",
    kind: "control",
    writes: ["state/"],
    forbids: ["edit harness", "score", "submit"],
    prompt: "src/orchestrator.ts",
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
    writes: ["candidates/"],
    forbids: ["sandbox", "held-out", "submit", "eval"],
    prompt: "agents/innovator.md",
  },
  runner: {
    id: "runner",
    kind: "tool",
    writes: ["traces/"],
    forbids: ["edit config", "submit", "held-out"],
    prompt: "bin/eval.ts",
  },
  "reviewer-gate": {
    id: "reviewer-gate",
    kind: "llm",
    writes: ["review.json"],
    forbids: ["write patch", "contact_supervisor"],
    prompt: "agents/reviewer-gate.md",
  },
  "report-writer": {
    id: "report-writer",
    kind: "llm",
    writes: ["evidence_pack/"],
    forbids: ["change score", "bypass gate"],
    prompt: "not-mounted",
  },
  submitter: {
    id: "submitter",
    kind: "tool",
    writes: ["submit-receipt.json"],
    forbids: ["submit without evidence"],
    prompt: "not-mounted",
  },
};

/** Product machine owned by deterministic code. */
export const ROUND_PHASES = ["gap-finder", "innovator", "runner", "reviewer-gate"] as const;
export type RoundPhase = (typeof ROUND_PHASES)[number];
