/**
 * Pre-run capability check: does a probed HostInventory satisfy a
 * competition's typed resource requirements? Physical home: `src/execution/`.
 *
 * Type-only coupled to the competition pack (`import type`) so there is no
 * runtime import cycle — competition already imports execution values.
 *
 * Checks CPU cores and memory always; storage only when the inventory carries
 * a disk reading; GPU count always; GPU backend/model/min-VRAM per device.
 * A device whose data cannot verify a requirement does not qualify (fail
 * closed). This is a pre-run gate only — no scheduling, no cloud.
 */
import type {
  CompetitionGpuBackend,
  CompetitionGpuRequirements,
  CompetitionResourceRequirements,
} from "../competition/competition-contract";
import type { GpuDevice, HostInventory } from "./host-inventory";
import { validateHostInventory } from "./host-inventory";
import { ResourceCapabilityError } from "./resource-lease";

/** Infers the GPU backend from a device name; undefined when unrecognizable. */
export function gpuBackendFromName(name: string): CompetitionGpuBackend | undefined {
  if (/nvidia|geforce|quadro|tesla|\b(?:rtx|gtx|a100|h100|v100|l40)\b/i.test(name)) return "cuda";
  if (/amd|radeon|instinct|\bmi\d+/i.test(name)) return "rocm";
  if (/apple|\bm[1-4]\b/i.test(name)) return "metal";
  return undefined;
}

/** A device qualifies only when every stated requirement can be verified against it. */
function deviceQualifies(device: GpuDevice, requirement: CompetitionGpuRequirements): boolean {
  if (gpuBackendFromName(device.name) !== requirement.backend) return false;
  if (requirement.model !== undefined && !device.name.toLowerCase().includes(requirement.model.toLowerCase())) return false;
  if (requirement.minMemoryBytes !== undefined
    && (device.memoryTotalBytes === undefined || device.memoryTotalBytes < requirement.minMemoryBytes)) return false;
  return true;
}

/**
 * Validates that the probed host satisfies the competition's resource
 * requirements. Returns the validated inventory; throws
 * ResourceCapabilityError with a clear mismatch kind otherwise.
 */
export function checkHostCapabilities(inventory: HostInventory, requirements: CompetitionResourceRequirements): HostInventory {
  const host = validateHostInventory(inventory);
  if (host.cpu.cores < requirements.cpus) {
    throw new ResourceCapabilityError("insufficient-cpus", `competition requires ${requirements.cpus} cpus but the host inventory lists ${host.cpu.cores}`);
  }
  if (host.memory.totalBytes < requirements.memoryBytes) {
    throw new ResourceCapabilityError("insufficient-memory", `competition requires ${requirements.memoryBytes} bytes but the host inventory lists ${host.memory.totalBytes}`);
  }
  if (requirements.storageBytes !== undefined && host.disk === undefined) {
    throw new ResourceCapabilityError("insufficient-storage", "competition requires storageBytes but the host inventory has no disk reading");
  }
  if (requirements.storageBytes !== undefined && host.disk !== undefined && host.disk.freeBytes < requirements.storageBytes) {
    throw new ResourceCapabilityError("insufficient-storage", `competition requires ${requirements.storageBytes} free bytes but ${host.disk.path} has ${host.disk.freeBytes}`);
  }
  const gpu = requirements.gpu;
  if (gpu !== undefined) {
    if (host.gpus.length < gpu.count) {
      throw new ResourceCapabilityError("insufficient-gpus", `competition requires ${gpu.count} gpus but the host inventory lists ${host.gpus.length}`);
    }
    const qualifying = host.gpus.filter((device) => deviceQualifies(device, gpu));
    if (qualifying.length < gpu.count) {
      const qualifiers = [
        `backend=${gpu.backend}`,
        gpu.model === undefined ? undefined : `model~${gpu.model}`,
        gpu.minMemoryBytes === undefined ? undefined : `minVram=${gpu.minMemoryBytes}`,
      ].filter((part) => part !== undefined).join(", ");
      throw new ResourceCapabilityError(
        "gpu-requirement-mismatch",
        `competition requires ${gpu.count} gpu(s) matching ${qualifiers} but only ${qualifying.length} of ${host.gpus.length} inventoried device(s) qualify`,
      );
    }
  }
  return host;
}
