import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LineageNode } from "./types";

export interface LineageFile {
  readonly nodes: readonly LineageNode[];
}

export class LineageStore {
  private nodes: LineageNode[] = [];

  constructor(private readonly filePath: string) {}

  static open(root: string): LineageStore {
    return new LineageStore(join(root, "lineage.json"));
  }

  load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as LineageFile;
      this.nodes = Array.isArray(parsed.nodes) ? [...parsed.nodes] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.nodes = [];
        return;
      }
      throw error;
    }
  }

  append(node: LineageNode): LineageNode {
    this.nodes.push(node);
    this.save();
    return node;
  }

  all(): readonly LineageNode[] {
    return this.nodes;
  }

  latestAccepted(): LineageNode | null {
    for (let i = this.nodes.length - 1; i >= 0; i -= 1) {
      const node = this.nodes[i];
      if (node?.status === "accepted") return node;
    }
    return null;
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const body: LineageFile = { nodes: this.nodes };
    writeFileSync(this.filePath, `${JSON.stringify(body, null, 2)}\n`);
  }
}
