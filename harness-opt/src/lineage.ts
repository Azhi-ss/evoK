import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripHeldOutFields } from "./modules/proposer";

/**
 * Append-only lineage. One JSON file per node plus `lineage.jsonl`.
 * Reloading the directory rebuilds the tree. Writes are temp-file plus rename.
 *
 * Port of `design/orchestrator.py` `Lineage`. The event log uses the name
 * from setup §6 (`lineage.jsonl`), not the python file's `events.jsonl`.
 */

export type NodeStatus = "pending" | "running" | "evaluated" | "failed" | "rejected";
export type EvalStage = "none" | "small" | "full";

export interface NodeJson {
  readonly id: string;
  readonly parentId: string | null;
  readonly configPath: string;
  readonly patchSummary: string;
  readonly status: NodeStatus;
  readonly devScores: number[];
  readonly stage: EvalStage;
  readonly visits: number;
  readonly valueSum: number;
  readonly children: string[];
  readonly locked: boolean;
  readonly tokensUsed: number;
  readonly createdAt: number;
}

export class Node {
  id: string;
  parentId: string | null;
  configPath: string;
  patchSummary = "";
  status: NodeStatus = "pending";
  devScores: number[] = [];
  stage: EvalStage = "none";
  visits = 0;
  valueSum = 0;
  children: string[] = [];
  locked = false;
  tokensUsed = 0;
  createdAt = Date.now() / 1000;

  constructor(init: Pick<NodeJson, "id" | "parentId" | "configPath"> & Partial<Omit<NodeJson, "id" | "parentId" | "configPath">>) {
    this.id = init.id;
    this.parentId = init.parentId;
    this.configPath = init.configPath;
    if (init.patchSummary !== undefined) this.patchSummary = init.patchSummary;
    if (init.status !== undefined) this.status = init.status;
    if (init.devScores !== undefined) this.devScores = [...init.devScores];
    if (init.stage !== undefined) this.stage = init.stage;
    if (init.visits !== undefined) this.visits = init.visits;
    if (init.valueSum !== undefined) this.valueSum = init.valueSum;
    if (init.children !== undefined) this.children = [...init.children];
    if (init.locked !== undefined) this.locked = init.locked;
    if (init.tokensUsed !== undefined) this.tokensUsed = init.tokensUsed;
    if (init.createdAt !== undefined) this.createdAt = init.createdAt;
  }

  /** Mean of normalised [0, 1] repeats. Empty until the runner returns scores. */
  get devMean(): number | null {
    if (this.devScores.length === 0) return null;
    return this.devScores.reduce((sum, score) => sum + score, 0) / this.devScores.length;
  }

  toJSON(): NodeJson {
    return {
      id: this.id,
      parentId: this.parentId,
      configPath: this.configPath,
      patchSummary: this.patchSummary,
      status: this.status,
      devScores: [...this.devScores],
      stage: this.stage,
      visits: this.visits,
      valueSum: this.valueSum,
      children: [...this.children],
      locked: this.locked,
      tokensUsed: this.tokensUsed,
      createdAt: this.createdAt,
    };
  }
}

/** What Gap Finder and Innovator are allowed to see. No gate scores. */
export interface RoleLineage {
  events(): readonly Record<string, unknown>[];
  nodeSummaries(): readonly Record<string, unknown>[];
}

export class Lineage {
  readonly nodes = new Map<string, Node>();
  private readonly eventsPath: string;

  constructor(readonly root: string) {
    const dir = join(root, "nodes");
    mkdirSync(dir, { recursive: true });
    this.eventsPath = join(root, "lineage.jsonl");
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as NodeJson;
      const node = new Node(parsed);
      this.nodes.set(node.id, node);
    }
  }

  put(node: Node): void {
    const dir = join(this.root, "nodes");
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${node.id}.tmp`);
    writeFileSync(tmp, JSON.stringify(node.toJSON(), null, 1));
    renameSync(tmp, join(dir, `${node.id}.json`));
    this.nodes.set(node.id, node);
  }

  /**
   * Search log. Held-out keys are dropped before the append, so a gate score
   * cannot land here even if a caller passes one.
   */
  log(kind: string, fields: Record<string, unknown> = {}): void {
    const safe = stripHeldOutFields(fields) as Record<string, unknown>;
    const line = JSON.stringify({ t: Date.now() / 1000, kind, ...safe });
    appendFileSync(this.eventsPath, `${line}\n`);
  }

  /** Scores and dry-run details. Not part of `events()` and not a role read. */
  gateLog(fields: Record<string, unknown>): void {
    const line = JSON.stringify({ t: Date.now() / 1000, ...fields });
    appendFileSync(join(this.root, "gate.jsonl"), `${line}\n`);
  }

  events(): readonly Record<string, unknown>[] {
    return readJsonl(this.eventsPath).map((event) => stripHeldOutFields(event) as Record<string, unknown>);
  }

  /** Unfiltered gate file. Callers that hand a lineage to a role must not use this. */
  gateEvents(): readonly Record<string, unknown>[] {
    return readJsonl(join(this.root, "gate.jsonl"));
  }

  roleView(): RoleLineage {
    return {
      events: () => this.events(),
      nodeSummaries: () => [...this.nodes.values()].map((node) => stripHeldOutFields(node.toJSON()) as Record<string, unknown>),
    };
  }

  rootNode(): Node {
    const root = [...this.nodes.values()].find((node) => node.parentId === null);
    if (!root) throw new Error("lineage has no root node");
    return root;
  }

  evaluated(): Node[] {
    return [...this.nodes.values()].filter((node) => node.status === "evaluated" && node.devMean !== null);
  }

  /** Highest dev mean. Ties keep the earlier node, matching Python's stable max. */
  best(): Node {
    const pool = this.evaluated();
    const first = pool[0];
    if (!first) throw new Error("lineage has no evaluated node");
    let best = first;
    for (const node of pool.slice(1)) {
      if ((node.devMean ?? Number.NEGATIVE_INFINITY) > (best.devMean ?? Number.NEGATIVE_INFINITY)) best = node;
    }
    return best;
  }
}

function readJsonl(path: string): Record<string, unknown>[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
