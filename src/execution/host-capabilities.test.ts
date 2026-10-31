/**
 * Pre-run capability check: typed competition resource requirements vs the
 * probed HostInventory. Fails closed with a clear mismatch; storage is
 * checked only when the inventory carries a disk reading; a GPU device that
 * cannot verify a requirement does not qualify.
 */
import { describe, expect, test } from "bun:test";
import type { CompetitionResourceRequirements } from "../competition/competition-contract";
import { HOST_INVENTORY_SCHEMA, HostInventoryError, hostInventoryDigest, type GpuDevice, type HostInventory } from "./host-inventory";
import { checkHostCapabilities, gpuBackendFromName } from "./host-capabilities";
import { ResourceCapabilityError } from "./resource-lease";

function makeInventory(overrides: {
  cores?: number;
  totalBytes?: number;
  gpus?: GpuDevice[];
  disk?: { path: string; freeBytes: number; totalBytes: number };
}): HostInventory {
  const body = {
    schema: HOST_INVENTORY_SCHEMA,
    probedAt: "2026-10-24T00:00:00.000Z",
    platform: "linux",
    arch: "x64",
    cpu: { model: "Test CPU", cores: overrides.cores ?? 16 },
    memory: { totalBytes: overrides.totalBytes ?? 64 * 1024 ** 3, freeBytes: 32 * 1024 ** 3 },
    gpus: overrides.gpus ?? [],
    ...(overrides.disk ? { disk: overrides.disk } : {}),
  };
  return Object.freeze({ ...body, digest: hostInventoryDigest(body) }) as HostInventory;
}

const A100: GpuDevice = { index: 0, name: "NVIDIA A100-SXM4-80GB", uuid: "GPU-aaaa", memoryTotalBytes: 80 * 1024 ** 3 };
const MI250: GpuDevice = { index: 0, name: "AMD Instinct MI250", uuid: "GPU-bbbb", memoryTotalBytes: 128 * 1024 ** 3 };

const REQUIREMENTS: CompetitionResourceRequirements = {
  cpus: 8,
  memoryBytes: 32 * 1024 ** 3,
  gpu: { backend: "cuda", count: 1, model: "A100", minMemoryBytes: 40 * 1024 ** 3 },
  storageBytes: 50 * 1024 ** 3,
  maxConcurrency: 4,
};

function mismatchOf(inventory: HostInventory, requirements: CompetitionResourceRequirements): string | undefined {
  try {
    checkHostCapabilities(inventory, requirements);
    return undefined;
  } catch (error) {
    return (error as ResourceCapabilityError).mismatch;
  }
}

describe("checkHostCapabilities", () => {
  test("passes when the host satisfies cpu/memory/gpu/storage requirements", () => {
    const host = makeInventory({ gpus: [A100], disk: { path: "/data", freeBytes: 100 * 1024 ** 3, totalBytes: 200 * 1024 ** 3 } });
    expect(checkHostCapabilities(host, REQUIREMENTS)).toEqual(host);
  });

  test("cpu and memory shortfalls fail closed with clear mismatches", () => {
    const host = makeInventory({ cores: 4, gpus: [A100] });
    expect(mismatchOf(host, REQUIREMENTS)).toBe("insufficient-cpus");
    const lowMemory = makeInventory({ totalBytes: 8 * 1024 ** 3, gpus: [A100] });
    expect(mismatchOf(lowMemory, REQUIREMENTS)).toBe("insufficient-memory");
  });

  test("storage is checked only when the inventory carries a disk reading", () => {
    const withDisk = makeInventory({ gpus: [A100], disk: { path: "/data", freeBytes: 1024, totalBytes: 200 * 1024 ** 3 } });
    expect(mismatchOf(withDisk, REQUIREMENTS)).toBe("insufficient-storage");
    // No disk reading: storage cannot be verified, so it is not a failure.
    const noDisk = makeInventory({ gpus: [A100] });
    expect(mismatchOf(noDisk, REQUIREMENTS)).toBeUndefined();
  });

  test("gpu count, backend, model, and min VRAM mismatches fail closed", () => {
    expect(mismatchOf(makeInventory({}), REQUIREMENTS)).toBe("insufficient-gpus");
    expect(mismatchOf(makeInventory({ gpus: [MI250] }), REQUIREMENTS)).toBe("gpu-requirement-mismatch");
    expect(mismatchOf(makeInventory({ gpus: [{ ...A100, name: "NVIDIA H100 80GB" }] }), REQUIREMENTS)).toBe("gpu-requirement-mismatch");
    expect(mismatchOf(makeInventory({ gpus: [{ ...A100, memoryTotalBytes: 20 * 1024 ** 3 }] }), REQUIREMENTS)).toBe("gpu-requirement-mismatch");
  });

  test("a device with unknown memory does not satisfy a min-VRAM requirement", () => {
    const unknownMemory: GpuDevice = { index: 0, name: "NVIDIA A100-SXM4-80GB" };
    expect(mismatchOf(makeInventory({ gpus: [unknownMemory] }), REQUIREMENTS)).toBe("gpu-requirement-mismatch");
  });

  test("requirements without a gpu or storage skip those checks", () => {
    const host = makeInventory({});
    const cpuOnly: CompetitionResourceRequirements = { cpus: 4, memoryBytes: 1024 };
    expect(checkHostCapabilities(host, cpuOnly)).toEqual(host);
  });

  test("an invalid inventory snapshot fails before any comparison", () => {
    const host = makeInventory({ gpus: [A100] });
    // Stale digest after mutation: the snapshot itself is rejected first.
    expect(() => checkHostCapabilities({ ...host, gpus: [] }, REQUIREMENTS)).toThrow(HostInventoryError);
    expect(() => checkHostCapabilities({ ...host, cpu: { model: "x", cores: 0 } }, REQUIREMENTS)).toThrow(HostInventoryError);
  });
});

describe("gpuBackendFromName", () => {
  test("maps vendor names to backends and stays undefined when unrecognizable", () => {
    expect(gpuBackendFromName("NVIDIA A100-SXM4-80GB")).toBe("cuda");
    expect(gpuBackendFromName("AMD Instinct MI250")).toBe("rocm");
    expect(gpuBackendFromName("Apple M4 Pro")).toBe("metal");
    expect(gpuBackendFromName("Mystery Accelerator 3000")).toBeUndefined();
  });
});
