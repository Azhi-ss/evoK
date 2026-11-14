/**
 * The execution-environment snapshot (PRD §3 B1; #253/#256).
 *
 * Two snapshots exist and they are not one concept. The Mission freezes **under
 * what conditions** a Run may happen (`mission/run-preparation.ts`: plan
 * version, authorization digest, budget reservation, memory pin, input digests).
 * The harness freezes **in what environment** it runs: runtime, model, tools,
 * sandbox image, filesystem. This module owns the second one only; the digest
 * is what makes it verifiable instead of asserted.
 *
 * B1's failure mode is why the boundary is mechanical: if the environment is
 * read at T3 while the Mission authorized at T1, the Run executes in an
 * environment the authorization never saw. So the snapshot is frozen before the
 * execution is declared, its digest is what the request carries, and
 * `assertEnvironmentRefs` refuses a close that reports anything else.
 */
import { deepFreeze, digestValue } from "../execution/security-boundary";
import type { ExecutionEnvironmentRefs } from "../execution/execution-protocol";
import type { EnvironmentSnapshot, EnvironmentSnapshotInput } from "./contracts";

const BACKENDS = ["pi-agent-runtime", "pi-child-dispatch"] as const;

/**
 * Keys a Mission-owned authorization snapshot uses. Their presence in an
 * environment snapshot is the boundary collapsing, so it is refused rather than
 * ignored: a field that is silently dropped is a condition the Run did not run
 * under.
 */
const MISSION_CONDITIONS = ["authorization", "authorizationDigest", "planVersion", "budget", "reserved", "memory", "objective"] as const;

function text(label: string, value: unknown, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw Error(`execution environment ${label} must be a non-empty string`);
  return value;
}

function absolute(label: string, value: unknown): string {
  const path = text(label, value);
  if (!path!.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path!))
    throw Error(`execution environment ${label} must be an absolute path`);
  return path!;
}

/**
 * Freeze the environment an execution runs in, and address it. Validated up
 * front because an under-specified environment is exactly the thing that makes
 * a Run unreproducible.
 */
export function createEnvironmentSnapshot(input: EnvironmentSnapshotInput): EnvironmentSnapshot {
  for (const key of MISSION_CONDITIONS) {
    if (key in input)
      throw Error(`execution environment may not carry ${key}: authorization conditions are the Mission's (B1)`);
  }
  if (!BACKENDS.includes(input.backend)) throw Error(`execution environment backend must be one of ${BACKENDS.join(", ")}`);
  const workspace = absolute("workspace", input.workspace);
  const runtime = text("runtime", input.runtime, true);
  const model = text("model", input.model, true);
  const sandboxImage = text("sandboxImage", input.sandboxImage, true);
  if (!Array.isArray(input.tools)) throw Error("execution environment tools must be a list");
  const tools = input.tools.map((tool) => text("tool", tool)!);
  const readRoots = input.filesystem?.readRoots?.map((root) => absolute("filesystem.readRoots entry", root));
  const content = {
    backend: input.backend,
    workspace,
    tools: [...tools],
    ...(runtime === undefined ? {} : { runtime }),
    ...(model === undefined ? {} : { model }),
    ...(sandboxImage === undefined ? {} : { sandboxImage }),
    ...(readRoots === undefined ? {} : { filesystem: { readRoots: [...readRoots] } }),
  };
  return deepFreeze({ ...content, digest: digestValue(content) });
}

/**
 * The narrow view the execution protocol declares (B4): the request carries
 * these refs, and the digest is the address of the full environment above.
 */
export function environmentRefsOf(snapshot: EnvironmentSnapshot): ExecutionEnvironmentRefs {
  return {
    backend: snapshot.backend,
    workspace: snapshot.workspace,
    ...(snapshot.model === undefined ? {} : { modelId: snapshot.model }),
    environmentDigest: snapshot.digest,
  };
}

/** B1 at close: the request must declare the environment the harness froze. */
export function assertEnvironmentRefs(snapshot: EnvironmentSnapshot, declared: ExecutionEnvironmentRefs): void {
  const frozen = environmentRefsOf(snapshot);
  for (const key of ["backend", "workspace", "modelId", "environmentDigest"] as const) {
    if (frozen[key] !== declared[key])
      throw Error(
        `execution environment ${key} changed after the run was declared (${String(frozen[key])} != ${String(declared[key])})`,
      );
  }
}
