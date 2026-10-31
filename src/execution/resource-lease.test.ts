/**
 * ResourceLease / ResourceUsage: the Execution Broker grants against a probed
 * inventory and fails closed on capability mismatch. GPU leases carry
 * structured devices — never a bare `cuda:0` label.
 */
import { describe, expect, test } from "bun:test";
import { probeHostInventory, type HostInventory } from "./host-inventory";
import {
  ResourceCapabilityError,
  grantResourceLease,
  recordResourceUsage,
  validateResourceLease,
  validateResourceUsage,
} from "./resource-lease";

const NVIDIA_SMI_OUTPUT = [
  "0, NVIDIA A100-SXM4-80GB, GPU-aaaa-0000, 81920",
  "1, NVIDIA A100-SXM4-80GB, GPU-bbbb-1111, 81920",
  "",
].join("\n");

async function inventory(): Promise<HostInventory> {
  return probeHostInventory({
    exec: async () => ({ code: 0, stdout: NVIDIA_SMI_OUTPUT }),
    now: () => new Date("2026-10-24T00:00:00Z"),
  });
}

describe("resource lease", () => {
  test("grants cpus/memory/gpus with a deadline derived from the time limit", async () => {
    const lease = grantResourceLease({
      inventory: await inventory(),
      taskId: "task-1",
      request: { cpus: 2, memoryBytes: 1024, gpus: 1, timeLimitMs: 60_000 },
      now: () => new Date("2026-10-24T01:00:00Z"),
    });
    expect(lease.cpus).toBe(2);
    expect(lease.memoryBytes).toBe(1024);
    expect(lease.deadlineAt).toBe("2026-10-24T01:01:00.000Z");
    expect(lease.inventoryDigest).not.toBe("");
  });

  test("a gpu lease is a structured device, not a cuda:N label", async () => {
    const lease = grantResourceLease({
      inventory: await inventory(),
      taskId: "task-2",
      request: { cpus: 1, gpus: 1 },
    });
    expect(lease.gpus).toHaveLength(1);
    const device = lease.gpus[0].device;
    expect(typeof device).toBe("object");
    expect(device.index).toBe(0);
    expect(device.name).toBe("NVIDIA A100-SXM4-80GB");
    expect(device.uuid).toBe("GPU-aaaa-0000");
    expect(device.memoryTotalBytes).toBe(81920 * 1024 * 1024);
    expect(JSON.stringify(lease.gpus)).not.toContain("cuda:0");
  });

  test("selects an explicit gpu by uuid", async () => {
    const lease = grantResourceLease({
      inventory: await inventory(),
      taskId: "task-3",
      request: { cpus: 1, gpus: ["GPU-bbbb-1111"] },
    });
    expect(lease.gpus[0].device.index).toBe(1);
  });

  test("capability mismatch fails closed: too many cpus / memory / gpus", async () => {
    const host = await inventory();
    expect(() => grantResourceLease({ inventory: host, taskId: "t", request: { cpus: 10_000 } }))
      .toThrow(ResourceCapabilityError);
    expect(() => grantResourceLease({ inventory: host, taskId: "t", request: { cpus: 10_000 } }))
      .toThrow(/insufficient|requested 10000 cpus/);
    expect(() => grantResourceLease({ inventory: host, taskId: "t", request: { memoryBytes: Number.MAX_SAFE_INTEGER } }))
      .toThrow(ResourceCapabilityError);
    let mismatch: string | undefined;
    try {
      grantResourceLease({ inventory: host, taskId: "t", request: { memoryBytes: Number.MAX_SAFE_INTEGER } });
    } catch (error) {
      mismatch = (error as ResourceCapabilityError).mismatch;
    }
    expect(mismatch).toBe("insufficient-memory");
    expect(() => grantResourceLease({ inventory: host, taskId: "t", request: { gpus: 3 } }))
      .toThrow(/insufficient|3 gpus/);
  });

  test("unknown gpu selector fails closed", async () => {
    const host = await inventory();
    expect(() => grantResourceLease({ inventory: host, taskId: "t", request: { gpus: ["GPU-zzzz"] } }))
      .toThrow(ResourceCapabilityError);
    expect(() => grantResourceLease({ inventory: host, taskId: "t", request: { gpus: [7] } }))
      .toThrow(/not in the host inventory/);
  });

  test("duplicate explicit gpu selectors cannot inflate a lease", async () => {
    const host = await inventory();
    expect(() => grantResourceLease({ inventory: host, taskId: "t", request: { gpus: [0, "GPU-aaaa-0000"] } }))
      .toThrow(/selected more than once/);
  });

  test("lease validate round-trips and rejects label-only gpus", async () => {
    const lease = grantResourceLease({ inventory: await inventory(), taskId: "task-4", request: { cpus: 1, gpus: 1 } });
    const restored = validateResourceLease(JSON.parse(JSON.stringify(lease)));
    expect(restored).toEqual(lease);
    expect(() => validateResourceLease({ ...lease, gpus: ["cuda:0"], digest: lease.digest })).toThrow(/structured devices/);
    expect(() => validateResourceLease({ ...lease, cpus: 99 })).toThrow(/digest mismatch/);
  });

  test("usage records real consumption and an exit reason", async () => {
    const lease = grantResourceLease({ inventory: await inventory(), taskId: "task-5", request: { cpus: 1 } });
    const usage = recordResourceUsage(lease, {
      wallTimeMs: 5_000,
      cpuTimeMs: 4_200,
      peakMemoryBytes: 512,
      exitReason: "completed",
    });
    expect(usage.leaseId).toBe(lease.leaseId);
    expect(usage.exitReason).toBe("completed");
  });

  test("usage rejects unknown exit reasons and bad shapes", () => {
    expect(() => validateResourceUsage({ schema: "evok.resource-usage/v1", leaseId: "l", wallTimeMs: 1, exitReason: "exploded" }))
      .toThrow(/exitReason/);
    expect(() => validateResourceUsage({ schema: "evok.resource-usage/v1", leaseId: "l", wallTimeMs: -1, exitReason: "completed" }))
      .toThrow(/wallTimeMs/);
    expect(() => validateResourceUsage({ schema: "evok.resource-usage/v1", leaseId: "l", wallTimeMs: 1, exitReason: "timeout", gpu: { utilizationPercent: 120 } }))
      .toThrow(/utilizationPercent/);
  });
});
