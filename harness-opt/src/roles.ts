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
  /** Tool allowlist. Anything else is refused, including bash. */
  readonly tools: readonly string[];
  /** Read scope. `sealed/` is held-out and is not on the LLM roles. */
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly forbids: readonly string[];
  /** Prompt file. Only the three files under `agents/` are Pi subagent defs. */
  readonly prompt: string;
}

export const ROLE_CONTRACTS: Readonly<Record<RoleId, RoleContract>> = {
  orchestrator: {
    id: "orchestrator",
    kind: "control",
    tools: [],
    reads: ["state/", "sealed/", "candidates/", "evidence_pack/", "traces/"],
    writes: ["state/"],
    forbids: ["edit harness", "score", "submit"],
    prompt: "src/orchestrator.ts",
  },
  "gap-finder": {
    id: "gap-finder",
    kind: "llm",
    tools: ["read", "grep", "find", "ls", "contact_supervisor"],
    reads: ["traces/"],
    writes: ["gaps.json", "gaps.md"],
    forbids: ["patch", "submit", "bash", "write"],
    prompt: "agents/gap-finder.md",
  },
  innovator: {
    id: "innovator",
    kind: "llm",
    tools: ["read", "grep", "find", "ls", "write", "contact_supervisor"],
    reads: ["gaps.json", "gaps.md", "candidates/", "state/nodes/"],
    writes: ["candidates/", "patch.json"],
    forbids: ["sandbox", "held-out", "submit", "eval", "bash"],
    prompt: "agents/innovator.md",
  },
  runner: {
    id: "runner",
    kind: "tool",
    tools: ["read"],
    reads: ["candidates/", "sealed/", "dev/"],
    writes: ["traces/"],
    forbids: ["edit config", "submit"],
    prompt: "bin/eval.ts",
  },
  "reviewer-gate": {
    id: "reviewer-gate",
    kind: "llm",
    tools: ["read", "grep", "find", "ls"],
    reads: ["traces/", "candidates/", "state/nodes/"],
    writes: ["review.json"],
    forbids: ["write patch", "contact_supervisor", "bash", "write"],
    prompt: "agents/reviewer-gate.md",
  },
  "report-writer": {
    id: "report-writer",
    kind: "llm",
    tools: ["read", "write"],
    reads: ["candidates/", "traces/", "review.json"],
    writes: ["evidence_pack/"],
    forbids: ["change score", "bypass gate", "bash"],
    prompt: "not-mounted",
  },
  submitter: {
    id: "submitter",
    kind: "tool",
    tools: ["read", "write"],
    reads: ["evidence_pack/"],
    writes: ["submit-receipt.json"],
    forbids: ["submit without evidence", "bash"],
    prompt: "not-mounted",
  },
};

/** Product machine. Report Writer then Submitter run only after accept; Submitter still waits for a green gate. */
export const ROUND_PHASES = ["gap-finder", "innovator", "runner", "reviewer-gate", "report-writer", "submitter"] as const;
export type RoundPhase = (typeof ROUND_PHASES)[number];
