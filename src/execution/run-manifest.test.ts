/**
 * RunManifest: durable record of contract version+digest, host inventory
 * digest, lease, usage, and exit reason for one Run. Validation fails closed
 * on any digest mismatch.
 */
import { describe, expect, test } from "bun:test";
import { probeHostInventory } from "./host-inventory";
import { grantResourceLease, recordResourceUsage } from "./resource-lease";
import {
  RunManifestError,
  completeRunManifest,
  createRunManifest,
  parseRunManifest,
  serializeRunManifest,
  validateRunManifest,
} from "./run-manifest";

async function fixtures() {
  const inventory = await probeHostInventory({
    exec: async () => ({ code: 0, stdout: "0, NVIDIA A100-SXM4-80GB, GPU-aaaa-0000, 81920\n" }),
    now: () => new Date("2026-10-24T00:00:00Z"),
  });
  const lease = grantResourceLease({
    inventory,
    taskId: "task-1",
    request: { cpus: 2, gpus: 1, timeLimitMs: 60_000 },
    now: () => new Date("2026-10-24T01:00:00Z"),
  });
  return { inventory, lease };
}

describe("run manifest", () => {
  test("records contract version+digest, inventory digest, and lease", async () => {
    const { inventory, lease } = await fixtures();
    const manifest = createRunManifest({
      runId: "run-1",
      taskId: "task-1",
      attempt: 1,
      contract: { version: "2026.1", digest: "abc123" },
      inventoryDigest: inventory.digest,
      lease,
      now: () => new Date("2026-10-24T01:00:01Z"),
    });
    expect(manifest.contract).toEqual({ version: "2026.1", digest: "abc123" });
    expect(manifest.inventoryDigest).toBe(inventory.digest);
    expect(manifest.lease).toEqual(lease);
    expect(manifest.usage).toBeUndefined();
    expect(Object.isFrozen(manifest)).toBe(true);
  });

  test("completes with usage + outcome and serializes/parses losslessly", async () => {
    const { inventory, lease } = await fixtures();
    const open = createRunManifest({
      runId: "run-2",
      taskId: "task-1",
      attempt: 1,
      contract: { version: "2026.1", digest: "abc123" },
      inventoryDigest: inventory.digest,
      lease,
    });
    const usage = recordResourceUsage(lease, { wallTimeMs: 9_000, peakMemoryBytes: 2048, exitReason: "completed" });
    const settled = completeRunManifest(open, usage, "completed");
    expect(settled.usage).toEqual(usage);
    expect(settled.outcome).toBe("completed");
    expect(settled.digest).not.toBe(open.digest);
    const restored = parseRunManifest(serializeRunManifest(settled));
    expect(restored).toEqual(settled);
  });

  test("rejects a usage record bound to another lease", async () => {
    const { inventory, lease } = await fixtures();
    const other = grantResourceLease({ inventory, taskId: "task-1", request: { cpus: 1 } });
    const open = createRunManifest({
      runId: "run-3",
      taskId: "task-1",
      attempt: 1,
      contract: { version: "2026.1", digest: "abc123" },
      inventoryDigest: inventory.digest,
      lease,
    });
    const foreignUsage = recordResourceUsage(other, { wallTimeMs: 1, exitReason: "error", detail: "boom" });
    expect(() => completeRunManifest(open, foreignUsage, "failed")).toThrow(RunManifestError);
    expect(() => completeRunManifest(open, foreignUsage, "failed")).toThrow(/leaseId/);
  });

  test("taskId must match the lease and digests fail closed on tampering", async () => {
    const { inventory, lease } = await fixtures();
    expect(() => createRunManifest({
      runId: "run-4",
      taskId: "other-task",
      attempt: 1,
      contract: { version: "2026.1", digest: "abc123" },
      inventoryDigest: inventory.digest,
      lease,
    })).toThrow(/taskId/);
    const manifest = createRunManifest({
      runId: "run-5",
      taskId: "task-1",
      attempt: 1,
      contract: { version: "2026.1", digest: "abc123" },
      inventoryDigest: inventory.digest,
      lease,
    });
    expect(() => validateRunManifest({ ...manifest, contract: { version: "2026.2", digest: "abc123" } })).toThrow(/digest mismatch/);
    expect(() => parseRunManifest("not json")).toThrow(RunManifestError);
  });
});
