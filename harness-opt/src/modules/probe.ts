import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskRef } from "../types";

/**
 * Held-out tasks stay behind this seal.
 * Gap Finder and Innovator never receive the vault; only the evidence gate
 * calls `readForEvidenceGate`.
 */
export class HeldOutVault {
  #tasks: readonly TaskRef[];

  constructor(tasks: readonly TaskRef[]) {
    this.#tasks = tasks.filter((task) => task.split === "held-out");
  }

  get size(): number {
    return this.#tasks.length;
  }

  readForEvidenceGate(): readonly TaskRef[] {
    return this.#tasks;
  }
}

export interface TaskBank {
  readonly dev: readonly TaskRef[];
  readonly heldOut: HeldOutVault;
}

export function splitBank(tasks: readonly TaskRef[]): TaskBank {
  return {
    dev: tasks.filter((task) => task.split === "dev"),
    heldOut: new HeldOutVault(tasks),
  };
}

/**
 * Playground task list / download. This environment has no playground CLI,
 * so the call fails closed and names the missing command. `LocalJsonTaskSource`
 * is the offline reader the loop uses when a directory is given.
 */
export interface TaskSource {
  readonly name: string;
  list(): Promise<readonly TaskRef[]>;
  download(id: string): Promise<TaskRef>;
}

export class LocalJsonTaskSource implements TaskSource {
  readonly name: string;

  constructor(readonly directory: string) {
    this.name = `local-json:${directory}`;
  }

  async list(): Promise<readonly TaskRef[]> {
    return loadTaskBank(this.directory).dev;
  }

  async download(id: string): Promise<TaskRef> {
    const found = (await this.list()).find((task) => task.id === id);
    if (!found) throw new Error(`local task source has no dev task ${id}`);
    return found;
  }
}

export class PlaygroundTaskSource implements TaskSource {
  readonly name = "playground";

  async list(): Promise<readonly TaskRef[]> {
    throw new Error("playground task list is not available: the playground CLI is not installed; fail-closed");
  }

  async download(id: string): Promise<TaskRef> {
    throw new Error(`playground task download ${id} was not run: the playground CLI is not installed; fail-closed`);
  }
}

export function loadTaskBank(directory: string): TaskBank {
  const names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  const tasks = names.map((name) => parseTask(JSON.parse(readFileSync(join(directory, name), "utf8")), name));
  return splitBank(tasks);
}

function parseTask(value: unknown, fileName: string): TaskRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`task ${fileName} is not an object`);
  }
  const record = value as Record<string, unknown>;
  const id = record.id;
  const split = record.split;
  const path = record.path;
  if (typeof id !== "string" || id === "") throw new Error(`task ${fileName} needs an id`);
  if (split !== "dev" && split !== "held-out") throw new Error(`task ${fileName} split must be dev or held-out`);
  if (typeof path !== "string" || path === "" || path.includes("..") || path.startsWith("/") || path.startsWith("~")) {
    throw new Error(`task ${fileName} path must be a relative sandbox path`);
  }
  return { id, split, path };
}
