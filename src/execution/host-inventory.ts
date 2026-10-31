/**
 * HostInventory: a pre-run hardware probe snapshot (CPU / memory / GPU / disk).
 * Physical home: `src/execution/`.
 *
 * The Execution Broker grants ResourceLeases against this snapshot, so a Task
 * can never be promised capacity the host does not have. GPUs are structured
 * devices (index + name + uuid + memory), never bare `cuda:0` label strings.
 * The snapshot is content-addressed; a Run manifest records its digest.
 */
import { execFile } from "node:child_process";
import { cpus, freemem, platform, arch, totalmem } from "node:os";
import { statfs } from "node:fs/promises";
import { deepFreeze, digestValue } from "./security-boundary";

export const HOST_INVENTORY_SCHEMA = "evok.host-inventory/v1" as const;

export interface HostCpu {
  readonly model: string;
  readonly cores: number;
}

export interface HostMemory {
  readonly totalBytes: number;
  readonly freeBytes: number;
}

/** A structured GPU device observed on the host — not a scheduler label. */
export interface GpuDevice {
  readonly index: number;
  readonly name: string;
  readonly uuid?: string;
  readonly memoryTotalBytes?: number;
}

export interface HostDisk {
  readonly path: string;
  readonly freeBytes: number;
  readonly totalBytes: number;
}

export interface HostInventory {
  readonly schema: typeof HOST_INVENTORY_SCHEMA;
  readonly probedAt: string;
  readonly platform: string;
  readonly arch: string;
  readonly cpu: HostCpu;
  readonly memory: HostMemory;
  readonly gpus: readonly GpuDevice[];
  readonly disk?: HostDisk;
  readonly digest: string;
}

export class HostInventoryError extends Error {
  readonly kind = "host-inventory" as const;
  constructor(message: string) {
    super(message);
    this.name = "HostInventoryError";
  }
}

export interface HostInventoryProbeOptions {
  /** Injectable command runner (tests); defaults to nvidia-smi via execFile. */
  readonly exec?: (argv: readonly string[]) => Promise<{ code: number; stdout: string }>;
  /** Disk path to probe; omit to skip disk. */
  readonly diskPath?: string;
  readonly now?: () => Date;
}

function defaultExec(argv: readonly string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolvePromise) => {
    const [command, ...args] = argv;
    execFile(command, args, { timeout: 5_000 }, (error, stdout) => {
      resolvePromise({ code: error ? 1 : 0, stdout: typeof stdout === "string" ? stdout : "" });
    });
  });
}

/** Parses `nvidia-smi --query-gpu=index,name,uuid,memory.total --format=csv,noheader,nounits`. */
export function parseNvidiaSmiGpuRows(output: string): GpuDevice[] {
  const devices: GpuDevice[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const [indexText, name, uuid, memoryText] = trimmed.split(",").map((part) => part.trim());
    const index = Number.parseInt(indexText, 10);
    if (!Number.isSafeInteger(index) || !name) continue;
    const memoryMiB = Number.parseFloat(memoryText);
    devices.push({
      index,
      name,
      ...(uuid && uuid !== "N/A" ? { uuid } : {}),
      ...(Number.isFinite(memoryMiB) ? { memoryTotalBytes: Math.round(memoryMiB * 1024 * 1024) } : {}),
    });
  }
  return devices;
}

/** Probes the current host. GPU absence is not an error; it records `gpus: []`. */
export async function probeHostInventory(options: HostInventoryProbeOptions = {}): Promise<HostInventory> {
  const exec = options.exec ?? defaultExec;
  const cpuList = cpus();
  let gpus: GpuDevice[] = [];
  try {
    const result = await exec(["nvidia-smi", "--query-gpu=index,name,uuid,memory.total", "--format=csv,noheader,nounits"]);
    if (result.code === 0) gpus = parseNvidiaSmiGpuRows(result.stdout);
  } catch {
    gpus = [];
  }
  let disk: HostDisk | undefined;
  if (options.diskPath !== undefined) {
    try {
      const stats = await statfs(options.diskPath);
      disk = { path: options.diskPath, freeBytes: Number(stats.bavail) * Number(stats.bsize), totalBytes: Number(stats.blocks) * Number(stats.bsize) };
    } catch {
      disk = undefined;
    }
  }
  const body = {
    schema: HOST_INVENTORY_SCHEMA,
    probedAt: (options.now?.() ?? new Date()).toISOString(),
    platform: platform(),
    arch: arch(),
    cpu: { model: cpuList[0]?.model ?? "unknown", cores: cpuList.length },
    memory: { totalBytes: totalmem(), freeBytes: freemem() },
    gpus,
    ...(disk ? { disk } : {}),
  };
  return deepFreeze({ ...body, digest: digestValue(body) });
}

/** Digest over every inventory field except the digest itself. */
export function hostInventoryDigest(inventory: Omit<HostInventory, "digest">): string {
  return digestValue(inventory);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateGpuDevice(raw: unknown, label: string): void {
  if (!isRecord(raw)) throw new HostInventoryError(`${label} must be an object`);
  if (!Number.isSafeInteger(raw.index) || (raw.index as number) < 0) throw new HostInventoryError(`${label}.index must be an integer >= 0`);
  if (typeof raw.name !== "string" || raw.name.trim() === "") throw new HostInventoryError(`${label}.name is required`);
  if (raw.uuid !== undefined && (typeof raw.uuid !== "string" || raw.uuid === "")) throw new HostInventoryError(`${label}.uuid must be a non-empty string`);
  if (raw.memoryTotalBytes !== undefined && (!Number.isSafeInteger(raw.memoryTotalBytes) || (raw.memoryTotalBytes as number) < 0)) {
    throw new HostInventoryError(`${label}.memoryTotalBytes must be an integer >= 0`);
  }
}

/** Validates a persisted inventory snapshot, including its content digest. */
export function validateHostInventory(raw: unknown): HostInventory {
  if (!isRecord(raw)) throw new HostInventoryError("host inventory must be an object");
  if (raw.schema !== HOST_INVENTORY_SCHEMA) throw new HostInventoryError(`host inventory schema must be ${HOST_INVENTORY_SCHEMA}`);
  if (typeof raw.digest !== "string" || raw.digest === "") throw new HostInventoryError("host inventory digest is required");
  if (typeof raw.probedAt !== "string" || raw.probedAt === "") throw new HostInventoryError("host inventory probedAt is required");
  if (typeof raw.platform !== "string" || typeof raw.arch !== "string") throw new HostInventoryError("host inventory platform/arch are required");
  if (!isRecord(raw.cpu) || typeof raw.cpu.model !== "string" || !Number.isSafeInteger(raw.cpu.cores) || (raw.cpu.cores as number) < 1) {
    throw new HostInventoryError("host inventory cpu must have a model and cores >= 1");
  }
  if (!isRecord(raw.memory) || !Number.isSafeInteger(raw.memory.totalBytes) || !Number.isSafeInteger(raw.memory.freeBytes)) {
    throw new HostInventoryError("host inventory memory must have integer totalBytes/freeBytes");
  }
  if (!Array.isArray(raw.gpus)) throw new HostInventoryError("host inventory gpus must be an array");
  raw.gpus.forEach((gpu, index) => validateGpuDevice(gpu, `host inventory gpus[${index}]`));
  if (raw.disk !== undefined) {
    if (!isRecord(raw.disk) || !Number.isSafeInteger(raw.disk.freeBytes) || !Number.isSafeInteger(raw.disk.totalBytes)) {
      throw new HostInventoryError("host inventory disk must have integer freeBytes/totalBytes");
    }
  }
  const { digest, ...body } = raw;
  if (digestValue(body) !== digest) throw new HostInventoryError("host inventory digest mismatch");
  return deepFreeze(raw as unknown as HostInventory);
}
