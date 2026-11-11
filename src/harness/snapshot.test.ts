/**
 * B1: the harness freezes the EXECUTION ENVIRONMENT (runtime, model, tools,
 * sandbox image, filesystem) and nothing the Mission authorizes (plan version,
 * authorization digest, budget reservation, memory pin).
 */
import { describe, expect, test } from "bun:test";
import { assertEnvironmentRefs, createEnvironmentSnapshot, environmentRefsOf } from "./snapshot";

const ENVIRONMENT = {
  backend: "pi-agent-runtime",
  workspace: "/tmp/evok/harness/run-1",
  runtime: "pi-coding-agent",
  model: "anthropic/claude-sonnet",
  tools: ["read", "grep"],
  sandboxImage: "oven/bun:1.2",
  filesystem: { readRoots: ["/tmp/evok/project"] },
} as const;

describe("execution-environment snapshot (B1)", () => {
  test("freezes runtime, model, tools, sandbox image and filesystem", () => {
    const snapshot = createEnvironmentSnapshot(ENVIRONMENT);
    expect(snapshot).toMatchObject({ ...ENVIRONMENT });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.tools)).toBe(true);
    expect(Object.isFrozen(snapshot.filesystem?.readRoots)).toBe(true);
    expect(snapshot.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the same environment has one address; a changed field does not", () => {
    const first = createEnvironmentSnapshot(ENVIRONMENT);
    expect(createEnvironmentSnapshot({ ...ENVIRONMENT }).digest).toBe(first.digest);
    expect(createEnvironmentSnapshot({ ...ENVIRONMENT, tools: ["read"] }).digest).not.toBe(first.digest);
    expect(createEnvironmentSnapshot({ ...ENVIRONMENT, model: "other/model" }).digest).not.toBe(first.digest);
    expect(createEnvironmentSnapshot({ ...ENVIRONMENT, sandboxImage: "oven/bun:2" }).digest).not.toBe(first.digest);
    expect(createEnvironmentSnapshot({ ...ENVIRONMENT, runtime: "pi-subagents" }).digest).not.toBe(first.digest);
    expect(createEnvironmentSnapshot({ ...ENVIRONMENT, workspace: "/tmp/other" }).digest).not.toBe(first.digest);
  });

  test("the frozen address of one environment is pinned", () => {
    expect(createEnvironmentSnapshot(ENVIRONMENT).digest).toBe(
      "17bc708404ebf03b5123085b8c1281462bb50584f6130d8cf111f0c2fedde68d",
    );
  });

  test("refuses a Mission-owned authorization condition inside the environment", () => {
    for (const key of ["authorizationDigest", "planVersion", "budget", "memory", "objective"]) {
      expect(() => createEnvironmentSnapshot({ ...ENVIRONMENT, [key]: "x" } as never)).toThrow(
        /authorization|Mission|execution environment/i,
      );
    }
  });

  test("validates what a snapshot must state, and fails closed on the rest", () => {
    expect(() => createEnvironmentSnapshot({ ...ENVIRONMENT, workspace: "relative/path" })).toThrow(/workspace/);
    expect(() => createEnvironmentSnapshot({ ...ENVIRONMENT, backend: "unknown" as never })).toThrow(/backend/);
    expect(() => createEnvironmentSnapshot({ ...ENVIRONMENT, tools: ["read", ""] })).toThrow(/tool/);
    expect(() => createEnvironmentSnapshot({ ...ENVIRONMENT, runtime: "" })).toThrow(/runtime/);
    // A child with no granted tool is a real environment, not an invalid one.
    expect(createEnvironmentSnapshot({ ...ENVIRONMENT, tools: [] }).tools).toEqual([]);
  });

  test("gives the protocol the narrow refs it declares, including the address", () => {
    const snapshot = createEnvironmentSnapshot(ENVIRONMENT);
    expect(environmentRefsOf(snapshot)).toEqual({
      backend: "pi-agent-runtime",
      workspace: "/tmp/evok/harness/run-1",
      modelId: "anthropic/claude-sonnet",
      environmentDigest: snapshot.digest,
    });
    expect(environmentRefsOf(createEnvironmentSnapshot({ ...ENVIRONMENT }))).toEqual(environmentRefsOf(snapshot));
  });

  test("a declared environment that drifted from the frozen one is refused", () => {
    const snapshot = createEnvironmentSnapshot(ENVIRONMENT);
    const refs = environmentRefsOf(snapshot);
    expect(() => assertEnvironmentRefs(snapshot, refs)).not.toThrow();
    // B1's failure mode: the request says one environment, the harness froze another.
    expect(() => assertEnvironmentRefs(snapshot, { ...refs, environmentDigest: "0".repeat(64) })).toThrow(/environment/);
    expect(() => assertEnvironmentRefs(snapshot, { ...refs, workspace: "/tmp/elsewhere" })).toThrow(/environment/);
    expect(() => assertEnvironmentRefs(snapshot, { ...refs, modelId: "other/model" })).toThrow(/environment/);
  });

  test("an environment frozen before the run is unchanged at close", () => {
    const frozen = createEnvironmentSnapshot(ENVIRONMENT);
    const atClose = createEnvironmentSnapshot(ENVIRONMENT);
    expect(atClose.digest).toBe(frozen.digest);
    expect(() => assertEnvironmentRefs(frozen, environmentRefsOf(atClose))).not.toThrow();
  });
});
