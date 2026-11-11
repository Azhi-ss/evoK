/**
 * The harness's shared contracts (PRD §3 B1–B3, §4 Stage 3; #253/#256).
 *
 * `src/harness/` is the capability that executes: it freezes the execution
 * environment (B1), collects and content-addresses artifacts (B2) and measures
 * raw usage (B3). It makes no research decision — no score, evaluation,
 * promotion, admission, budget settlement, continue or stop — and it never
 * imports `src/mission/` (enforced by `scripts/import-boundaries.ts`).
 *
 * Only `index.ts` is public. These are the shapes the rest of the system may
 * name; the functions that use them live in `snapshot.ts`, `artifacts.ts`,
 * `metering.ts` and `execution.ts`.
 */
import type { ArtifactProvenance, ExecutionBackend, RawUsage } from "../execution/execution-protocol";

/**
 * Raw usage as a backend measured it (B3): the protocol's shared shape, never
 * the attributed `ExecutionUsage`. Choosing whose number it is stays with the
 * caller.
 */
export type { RawUsage };

/** The collected bytes of one workspace, keyed by POSIX-relative path. */
export type ArtifactFiles = Record<string, string>;

/** What one collection produced, plus the receipt the Mission may adopt (B2). */
export interface ArtifactCollection {
  readonly files: ArtifactFiles;
  /** The artifact's content address lives in the receipt, where it is addressed. */
  readonly receipt: ArtifactProvenance;
}

/**
 * What the environment a Run executes in IS (B1): runtime, model, tools,
 * sandbox image, filesystem. The Mission's authorization snapshot — plan
 * version, authorization digest, budget reservation, memory pin — is the
 * other half of B1 and is deliberately absent here.
 */
export interface EnvironmentSnapshotInput {
  readonly backend: ExecutionBackend;
  /** Absolute workspace the execution is confined to. */
  readonly workspace: string;
  /** Frozen capability grant: the tools this environment offers. */
  readonly tools: readonly string[];
  /** Model identity the execution is configured with. */
  readonly model?: string;
  /** Which runtime executes: the main Pi session or a delegated child. */
  readonly runtime?: string;
  /** Sandbox or container image, when the backend runs inside one. */
  readonly sandboxImage?: string;
  /** Read-only roots outside the workspace; writes stay inside it. */
  readonly filesystem?: { readonly readRoots?: readonly string[] };
}

/** A frozen environment plus its content address. */
export interface EnvironmentSnapshot extends EnvironmentSnapshotInput {
  readonly digest: string;
}
