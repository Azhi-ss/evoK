import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type CollaborationRole = "director" | "researcher" | "collaborator" | "reviewer";
export interface CollaborationChild {
  role: Exclude<CollaborationRole, "director">;
  objective: string;
  codePackage?: boolean;
  payload?: Record<string, unknown>;
  capCNY?: number;
  maxToolTurns?: number;
}
export type CollaborationState = "queued" | "running" | "suspended" | "completed" | "failed" | "retired";
export interface CollaborationReceipt {
  nodeId: string;
  status: "completed" | "failed" | "timeout" | "retired";
  summary: string;
  requestId?: string;
}
interface Attempt {
  runId: string;
  toolTurns: number;
  outcome?: "yielded" | "finished";
  nativeRunId?: string;
  terminalAction?: {name:string;args:Record<string,unknown>};
  receipt?: CollaborationReceipt;
}
export interface CollaborationNode {
  nodeId: string;
  rootId: string;
  parentId?: string;
  depth: number;
  role: CollaborationRole;
  objective: string;
  payload?: Record<string, unknown>;
  codePackage: boolean;
  state: CollaborationState;
  capCNY?: number;
  maxToolTurns: number;
  attempts: Attempt[];
  runId?: string;
  sessionRef?: string;
  summary?: string;
  waitId?: string;
  resume: boolean;
  receipts: CollaborationReceipt[];
  result?: CollaborationReceipt;
  /** Approved top-level handoff. This never becomes another node's injected receipt. */
  delivery?: Record<string, unknown>;
}
interface Dependency {
  nodeId: string;
  receipt?: CollaborationReceipt;
}
interface Batch {
  id: string;
  from: string;
  requestId: string;
  signature: string;
  dependencies: Dependency[];
  deadlineMs?: number;
  delivered: boolean;
}
interface Tree {
  nodes: CollaborationNode[];
  batches: Batch[];
}
export interface CollaborationLease {
  nodeId: string;
  runId: string;
  role: CollaborationRole;
  depth: number;
  task: string;
  kind: "work" | "answer";
  question?: string;
  payload?: Record<string, unknown>;
  receipts: CollaborationReceipt[];
  sessionRef?: string;
  summary?: string;
  remainingToolTurns: number;
  capCNY?: number;
}
export interface RecruitInput {
  fromNodeId: string;
  runId?: string;
  requestId: string;
  children: CollaborationChild[];
  deadlineMs?: number;
}
export interface CollaborationCheckpoint {
  nativeRunId?: string;
  terminalAction?: {name:string;args:Record<string,unknown>};
  nodeId: string;
  runId: string;
  sessionRef?: string;
  summary?: string;
  /** Total consumed in this attempt, never the delta since the previous checkpoint. */
  toolTurns?: number;
}
function lookup(tree: Tree, id: string) {
  const node = tree.nodes.find((n) => n.nodeId === id);
  if (!node) throw Error("unknown collaboration node");
  return node;
}
function attempt(node: CollaborationNode, runId: string) {
  const a = node.attempts.find((a) => a.runId === runId);
  if (!a) throw Error("unknown or foreign collaboration attempt");
  return a;
}
function turnsLeft(n: CollaborationNode) {
  return n.maxToolTurns - n.attempts.reduce((sum, a) => sum + a.toolTurns, 0);
}
function checkpoint(n: CollaborationNode, input: CollaborationCheckpoint) {
  if (input.runId !== n.runId) throw Error("stale collaboration attempt");
  if (input.toolTurns !== undefined) {
    const a = attempt(n, input.runId);
    if (
      !Number.isInteger(input.toolTurns) ||
      input.toolTurns < a.toolTurns ||
      input.toolTurns - a.toolTurns > turnsLeft(n)
    )
      throw Error("invalid cumulative tool usage or exhausted node allowance");
    a.toolTurns = input.toolTurns;
  }
  const current = attempt(n,input.runId);
  if (input.nativeRunId !== undefined) current.nativeRunId = input.nativeRunId;
  if (input.terminalAction) {
    if(current.terminalAction && JSON.stringify(current.terminalAction)!==JSON.stringify(input.terminalAction)) throw Error("conflicting native terminal action");
    current.terminalAction = input.terminalAction;
  }
  if (input.sessionRef !== undefined) n.sessionRef = input.sessionRef;
  if (input.summary !== undefined) n.summary = input.summary;
}
function verifySender(n: CollaborationNode, runId?: string) {
  if (n.state !== "running" || n.runId !== runId) throw Error("sender does not own an active turn");
}
function resumeReady(tree: Tree) {
  for (const b of tree.batches) {
    if (b.delivered || b.dependencies.some((d) => !d.receipt)) continue;
    const n = lookup(tree, b.from);
    if (n.runId || n.waitId !== b.id || n.state !== "suspended") continue;
    n.state = "queued";
    n.resume = true;
    n.receipts = b.dependencies.map((d) => d.receipt!);
    delete n.waitId;
    b.delivered = true;
  }
}
function deliver(tree: Tree, receipt: CollaborationReceipt) {
  for (const b of tree.batches) {
    for (const d of b.dependencies) {
      if (!d.receipt && d.nodeId === receipt.nodeId) d.receipt = { ...receipt, requestId: b.requestId };
    }
  }
  resumeReady(tree);
}
function begin(n: CollaborationNode): CollaborationLease {
  const runId = randomUUID();
  n.attempts.push({ runId, toolTurns: 0 });
  n.runId = runId;
  n.state = "running";
  n.resume = false;
  return projectLease(n,runId);
}
function projectLease(n: CollaborationNode,runId:string): CollaborationLease {
  return {
    nodeId: n.nodeId,
    runId,
    role: n.role,
    depth: n.depth,
    task: n.objective,
    kind: "work",
    payload: n.payload,
    receipts: n.receipts,
    sessionRef: n.sessionRef,
    summary: n.summary,
    remainingToolTurns: turnsLeft(n),
    capCNY: n.capCNY,
  };
}
function priority(n: CollaborationNode) {
  return n.resume ? -1 : n.depth === 1 ? 4 : 3 - n.depth;
}

/** One database per scheduling scope. Claims survive process exit until their exact native attempt is reconciled. */
export class CollaborationScheduler {
  private db: DatabaseSync;
  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(
      'PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS tree (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); INSERT OR IGNORE INTO tree VALUES(1, \'{"nodes":[],"batches":[]}\')',
    );
  }
  close() {
    this.db.close();
  }
  snapshot(): Tree {
    return JSON.parse(this.db.prepare("SELECT body FROM tree WHERE id=1").get()!.body as string);
  }
  private change<T>(mutate: (tree: Tree) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const tree = this.snapshot();
      const result = mutate(tree);
      this.db.prepare("UPDATE tree SET body=? WHERE id=1").run(JSON.stringify(tree));
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  root(nodeId: string, objective = ""): CollaborationNode {
    if (!nodeId) throw Error("root node ID required");
    return this.change((tree) => {
      const existing = tree.nodes.find((n) => n.nodeId === nodeId);
      if (existing) {
        if (existing.depth || (objective && existing.objective !== objective)) throw Error("conflicting root identity");
        return existing;
      }
      const n: CollaborationNode = {
        nodeId,
        rootId: nodeId,
        depth: 0,
        role: "director",
        objective,
        codePackage: false,
        state: "running",
        maxToolTurns: Number.MAX_SAFE_INTEGER,
        attempts: [],
        resume: false,
        receipts: [],
      };
      tree.nodes.push(n);
      return n;
    });
  }
  recruit(input: RecruitInput): string[] {
    return this.change((tree) => {
      const from = lookup(tree, input.fromNodeId);
      const signature = JSON.stringify([input.runId, input.children, input.deadlineMs]);
      const replay = tree.batches.find((b) => b.from === from.nodeId && b.requestId === input.requestId);
      if (replay) {
        if (signature !== replay.signature) throw Error("conflicting request ID");
        return replay.dependencies.map((d) => d.nodeId);
      }
      verifySender(from, input.runId);
      if (!input.requestId || input.children.length < 1 || input.children.length > 2)
        throw Error("recruit 1–2 nodes per request");
      if (from.depth >= 3 || from.codePackage) throw Error("this leaf cannot recruit");
      if (input.deadlineMs !== undefined && !Number.isSafeInteger(input.deadlineMs))
        throw Error("invalid absolute deadline");
      const depth = from.depth + 1;
      const dependencies = input.children.map((spec) => {
        if (!spec.objective.trim() || !["researcher", "collaborator", "reviewer"].includes(spec.role))
          throw Error("invalid child role or task");
        if ((spec.role === "researcher" && depth !== 1) || (spec.role === "reviewer" && depth > 2))
          throw Error("role not permitted at this depth");
        const cap = spec.capCNY ?? (spec.role === "collaborator" ? 5 : undefined);
        const maxToolTurns = spec.maxToolTurns ?? 8;
        if (
          (cap !== undefined && (!Number.isFinite(cap) || cap <= 0)) ||
          !Number.isSafeInteger(maxToolTurns) ||
          maxToolTurns < 1
        )
          throw Error("invalid node allowance");
        const n: CollaborationNode = {
          nodeId: randomUUID(),
          rootId: from.rootId,
          parentId: from.nodeId,
          depth,
          role: spec.role,
          objective: spec.objective,
          codePackage: !!spec.codePackage,
          payload: spec.payload,
          state: "queued",
          capCNY: cap,
          maxToolTurns,
          attempts: [],
          resume: false,
          receipts: [],
        };
        tree.nodes.push(n);
        return { nodeId: n.nodeId };
      });
      const id = randomUUID();
      tree.batches.push({
        id,
        from: from.nodeId,
        requestId: input.requestId,
        signature,
        dependencies,
        deadlineMs: input.deadlineMs,
        delivered: false,
      });
      from.state = "suspended";
      from.waitId = id;
      return dependencies.map((d) => d.nodeId);
    });
  }
  take(rootId?: string): CollaborationLease | null {
    return this.change((tree) => {
      if (tree.nodes.filter((n) => n.depth && n.runId).length >= 2) return null;
      const next = tree.nodes
        .filter((n) => n.depth && n.state === "queued" && !n.runId && (!rootId || n.rootId === rootId))
        .sort((a, b) => priority(a) - priority(b))[0];
      return next ? begin(next) : null;
    });
  }
  takeRoot(nodeId: string): CollaborationLease | null {
    return this.change((tree) => {
      const n = lookup(tree, nodeId);
      return n.depth === 0 && n.state === "queued" && !n.runId ? begin(n) : null;
    });
  }
  recoverable(rootId: string): {lease: CollaborationLease; action:{name:string;args:Record<string,unknown>}}[] {
    const tree=this.snapshot();
    return tree.nodes.flatMap(n=> {
      if(n.rootId!==rootId || !n.depth || !n.runId || n.state==="retired") return [];
      const action=attempt(n,n.runId).terminalAction;
      return action ? [{lease:projectLease(n,n.runId),action}] : [];
    });
  }
  checkpoint(input: CollaborationCheckpoint) {
    this.change((tree) => checkpoint(lookup(tree, input.nodeId), input));
  }
  /** A yielding native attempt must have actually stopped before this call. */
  release(nodeId: string, runId: string) {
    this.change((tree) => {
      const n = lookup(tree, nodeId),
        a = attempt(n, runId);
      if (a.outcome === "yielded") return;
      if (n.runId !== runId || (n.state !== "suspended" && n.state !== "retired"))
        throw Error("only the exact yielding or retired attempt can release its slot");
      a.outcome = "yielded";
      delete a.terminalAction;
      delete n.runId;
      resumeReady(tree);
    });
  }
  finish(
    input: CollaborationCheckpoint & { summary: string; ok?: boolean; delivery?: Record<string, unknown> },
  ): CollaborationReceipt {
    return this.change((tree) => {
      const n = lookup(tree, input.nodeId),
        a = attempt(n, input.runId);
      const receipt: CollaborationReceipt = {
        nodeId: n.nodeId,
        status: input.ok === false ? "failed" : "completed",
        summary: input.summary,
      };
      if (a.outcome === "finished" && a.receipt) {
        if (a.receipt.status !== receipt.status || a.receipt.summary !== receipt.summary)
          throw Error("conflicting completion");
        return a.receipt;
      }
      if (n.state !== "running") throw Error("node is not running");
      checkpoint(n, input);
      a.outcome = "finished";
      delete a.terminalAction;
      a.receipt = receipt;
      delete n.runId;
      n.result = receipt;
      if (n.depth === 1 && input.delivery) n.delivery = input.delivery;
      n.state = input.ok === false ? "failed" : "completed";
      deliver(tree, receipt);
      return receipt;
    });
  }
  expire(now = Date.now()) {
    this.change((tree) => {
      for (const b of tree.batches) {
        if (b.deadlineMs === undefined || b.deadlineMs > now || b.delivered) continue;
        for (const d of b.dependencies)
          d.receipt ??= {
            nodeId: d.nodeId,
            status: "timeout",
            summary: "dependency timed out",
            requestId: b.requestId,
          };
      }
      resumeReady(tree);
    });
  }
  retire(nodeId: string, reason: string) {
    this.change((tree) => {
      const n = lookup(tree, nodeId);
      if (n.state === "retired") return;
      n.state = "retired";
      delete n.waitId;
      const receipt: CollaborationReceipt = { nodeId, status: "retired", summary: reason };
      n.result ??= receipt;
      deliver(tree, receipt);
    });
  }
}
