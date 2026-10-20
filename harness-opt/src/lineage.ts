import { readdirSync } from "node:fs";
import { appendContained, ensureRealDir, openRealDirectory, readContained, renameContained, writeContained } from "./containment";
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
  /** dev_small sample. Not mixed into `devScores` once dev_full has run. */
  readonly devSmallScores: number[];
  /** dev_full sample. Same fixture as dev_small in this tree, so it replaces rather than extends the mean. */
  readonly devFullScores: number[];
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
  devSmallScores: number[] = [];
  devFullScores: number[] = [];
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
    if (init.devSmallScores !== undefined) this.devSmallScores = [...init.devSmallScores];
    if (init.devFullScores !== undefined) this.devFullScores = [...init.devFullScores];
    if (init.stage !== undefined) this.stage = init.stage;
    if (init.visits !== undefined) this.visits = init.visits;
    if (init.valueSum !== undefined) this.valueSum = init.valueSum;
    if (init.children !== undefined) this.children = [...init.children];
    if (init.locked !== undefined) this.locked = init.locked;
    if (init.tokensUsed !== undefined) this.tokensUsed = init.tokensUsed;
    if (init.createdAt !== undefined) this.createdAt = init.createdAt;
  }

  /**
   * Equal-weight mean of one subset. `dev_full` wins once it exists, because
   * in this tree that list already covers the small-set measurement.
   * Concatenating the two lists is not the mean.
   */
  get devMean(): number | null {
    const scores = this.devFullScores.length > 0
      ? this.devFullScores
      : this.devSmallScores.length > 0
        ? this.devSmallScores
        : this.devScores;
    if (scores.length === 0) return null;
    return scores.reduce((sum, score) => sum + score, 0) / scores.length;
  }

  toJSON(): NodeJson {
    return {
      id: this.id,
      parentId: this.parentId,
      configPath: this.configPath,
      patchSummary: this.patchSummary,
      status: this.status,
      devScores: [...this.devScores],
      devSmallScores: [...this.devSmallScores],
      devFullScores: [...this.devFullScores],
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
  private readonly realRoot: string;

  constructor(readonly root: string) {
    this.realRoot = openRealDirectory(root);
    const dir = ensureRealDir(this.realRoot, "nodes");
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const parsed = JSON.parse(readContained(this.realRoot, `nodes/${name}`)) as NodeJson;
      const node = new Node(parsed);
      this.nodes.set(node.id, node);
    }
  }

  put(node: Node): void {
    const body = JSON.stringify(node.toJSON(), null, 1);
    writeContained(this.realRoot, `nodes/.${node.id}.tmp`, body);
    renameContained(this.realRoot, `nodes/.${node.id}.tmp`, `nodes/${node.id}.json`);
    this.nodes.set(node.id, node);
  }

  /**
   * Search log. Held-out keys are dropped before the append, so a gate score
   * cannot land here even if a caller passes one.
   */
  log(kind: string, fields: Record<string, unknown> = {}): void {
    const safe = stripHeldOutFields(fields) as Record<string, unknown>;
    const line = JSON.stringify({ t: Date.now() / 1000, kind, ...safe });
    appendContained(this.realRoot, "lineage.jsonl", `${line}\n`);
  }

  /** Scores and dry-run details. Not part of `events()` and not a role read. */
  gateLog(fields: Record<string, unknown>): void {
    const line = JSON.stringify({ t: Date.now() / 1000, ...fields });
    appendContained(this.realRoot, "gate.jsonl", `${line}\n`);
  }

  events(): readonly Record<string, unknown>[] {
    return readJsonl(this.realRoot, "lineage.jsonl").map((event) => stripHeldOutFields(event) as Record<string, unknown>);
  }

  /** Unfiltered gate file. Callers that hand a lineage to a role must not use this. */
  gateEvents(): readonly Record<string, unknown>[] {
    return readJsonl(this.realRoot, "gate.jsonl");
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

function readJsonl(root: string, relativeName: string): Record<string, unknown>[] {
  try {
    return readContained(root, relativeName)
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
