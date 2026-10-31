/**
 * HostInventory: pre-run hardware probe snapshot. GPUs are structured
 * devices; absence of nvidia-smi records an empty list, not an error.
 */
import { describe, expect, test } from "bun:test";
import {
  HostInventoryError,
  parseNvidiaSmiGpuRows,
  probeHostInventory,
  validateHostInventory,
} from "./host-inventory";

const NVIDIA_SMI_OUTPUT = [
  "0, NVIDIA A100-SXM4-80GB, GPU-4f8e2c1a-1111-2222-3333-444455556666, 81920",
  "1, NVIDIA A100-SXM4-80GB, GPU-4f8e2c1a-7777-8888-9999-0000aaaabbbb, 81920",
  "",
].join("\n");

function execWith(output: string, code = 0) {
  return async () => ({ code, stdout: output });
}

describe("host inventory", () => {
  test("parses nvidia-smi rows into structured devices with uuid and memory", () => {
    const gpus = parseNvidiaSmiGpuRows(NVIDIA_SMI_OUTPUT);
    expect(gpus).toHaveLength(2);
    expect(gpus[0]).toEqual({
      index: 0,
      name: "NVIDIA A100-SXM4-80GB",
      uuid: "GPU-4f8e2c1a-1111-2222-3333-444455556666",
      memoryTotalBytes: 81920 * 1024 * 1024,
    });
  });

  test("probe records cpu/memory/platform and structured gpus", async () => {
    const inventory = await probeHostInventory({ exec: execWith(NVIDIA_SMI_OUTPUT), now: () => new Date("2026-10-24T00:00:00Z") });
    expect(inventory.cpu.cores).toBeGreaterThan(0);
    expect(inventory.memory.totalBytes).toBeGreaterThan(0);
    expect(inventory.gpus).toHaveLength(2);
    expect(inventory.probedAt).toBe("2026-10-24T00:00:00.000Z");
    expect(typeof inventory.digest).toBe("string");
    expect(Object.isFrozen(inventory)).toBe(true);
  });

  test("missing nvidia-smi records gpus: [] rather than failing", async () => {
    const inventory = await probeHostInventory({ exec: execWith("", 1) });
    expect(inventory.gpus).toEqual([]);
  });

  test("validate round-trips and rejects digest tampering", async () => {
    const inventory = await probeHostInventory({ exec: execWith(NVIDIA_SMI_OUTPUT), now: () => new Date("2026-10-24T00:00:00Z") });
    const restored = validateHostInventory(JSON.parse(JSON.stringify(inventory)));
    expect(restored).toEqual(inventory);
    const tampered = { ...inventory, gpus: [] };
    expect(() => validateHostInventory(tampered)).toThrow(HostInventoryError);
    expect(() => validateHostInventory(tampered)).toThrow(/digest mismatch/);
  });

  test("validate rejects malformed device entries", async () => {
    const inventory = await probeHostInventory({ exec: execWith(NVIDIA_SMI_OUTPUT), now: () => new Date("2026-10-24T00:00:00Z") });
    expect(() => validateHostInventory({ ...inventory, gpus: ["cuda:0"], digest: inventory.digest })).toThrow(HostInventoryError);
  });
});
