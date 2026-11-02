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
  evidenceRefs?: string[];
}
interface Attempt {
  runId: string;
  toolTurns: number;
  outcome?: "yielded" | "finished";
  nativeRunId?: string;
  terminalAction?: { name: string; args: Record<string, unknown> };
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
  questionId?: string;
  resume: boolean;
  readyOrder?: number;
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
  question?: string;
  evidenceRefs?: string[];
  dependencies: Dependency[];
  deadlineMs?: number;
  delivered: boolean;
}
interface Tree {
  nextOrder?: number;
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
  questionId?: string;
  questionFrom?: string;
  questionEvidenceRefs?: string[];
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
export interface CommunicationInput {
  requestId: string;
  fromNodeId: string;
  runId?: string;
  targetNodeId: string;
  question: string;
  evidenceRefs?: string[];
  deadlineMs?: number;
}
export interface CollaborationCheckpoint {
  nativeRunId?: string;
  terminalAction?: { name: string; args: Record<string, unknown> };
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
  const current = attempt(n, input.runId);
  if (input.nativeRunId !== undefined) current.nativeRunId = input.nativeRunId;
  if (input.terminalAction) {
    if (
      current.terminalAction &&
      JSON.stringify(current.terminalAction) !== JSON.stringify(input.terminalAction)
    )
      throw Error("conflicting native terminal action");
    current.terminalAction = input.terminalAction;
  }
  if (input.sessionRef !== undefined) n.sessionRef = input.sessionRef;
  if (input.summary !== undefined) n.summary = input.summary;
}
function verifySender(n: CollaborationNode, runId?: string) {
  if (n.state !== "running" || n.runId !== runId) throw Error("sender does not own an active turn");
}
/** Follow outstanding recruitment and directed question edges before creating a new wait. */
function reaches(tree: Tree, start: string, target: string, seen = new Set<string>()): boolean {
  if (start === target) return true;
  if (seen.has(start)) return false;
  seen.add(start);
  const wait = tree.batches.find((b) => b.id === lookup(tree, start).waitId);
  return !!wait?.dependencies.some((d) => !d.receipt && reaches(tree, d.nodeId, target, seen));
}
function enqueue(tree: Tree, n: CollaborationNode, resume: boolean) {
  tree.nextOrder = (tree.nextOrder ?? tree.nodes.length) + 1;
  n.readyOrder = tree.nextOrder;
  n.state = "queued";
  n.resume = resume;
}
function queueQuestions(tree: Tree) {
  for (const n of tree.nodes) {
    if (n.runId || !n.result || n.state === "retired") continue;
    const previous = tree.batches.find((b) => b.id === n.questionId);
    if (previous?.dependencies[0].receipt) {
      // The caller timed out before this answer could run or resume.
      delete n.questionId;
      delete n.waitId;
      n.state = n.result.status === "failed" ? "failed" : "completed";
    }
    if (n.state !== "completed") continue;
    const next = tree.batches.find(
      (b) => b.question !== undefined && b.dependencies[0].nodeId === n.nodeId && !b.dependencies[0].receipt,
    );
    if (next) {
      n.questionId = next.id;
      enqueue(tree, n, true);
      n.receipts = [];
    }
  }
}
function resumeReady(tree: Tree) {
  for (const b of tree.batches) {
    if (b.delivered || b.dependencies.some((d) => !d.receipt)) continue;
    const n = lookup(tree, b.from);
    if (n.runId || n.waitId !== b.id || n.state !== "suspended") continue;
    enqueue(tree, n, true);
    n.receipts = b.dependencies.map((d) => d.receipt!);
    delete n.waitId;
    b.delivered = true;
  }
  queueQuestions(tree);
}
function deliver(tree: Tree, receipt: CollaborationReceipt, questionId?: string) {
  for (const b of tree.batches) {
    // A reply to one question never changes the primary work result or another caller's answer.
    if (questionId ? b.id !== questionId : b.question !== undefined && receipt.status === "completed")
      continue;
    for (const d of b.dependencies) {
      if (!d.receipt && d.nodeId === receipt.nodeId) d.receipt = { ...receipt, requestId: b.requestId };
    }
  }
  resumeReady(tree);
}
function retireBranch(tree: Tree, n: CollaborationNode, reason: string) {
  for (const child of tree.nodes.filter((child) => child.parentId === n.nodeId && child.state !== "retired"))
    retireBranch(tree, child, reason);
  if (n.state === "retired") return;
  const outgoing = tree.batches.find((b) => b.id === n.waitId);
  if (outgoing) {
    for (const d of outgoing.dependencies)
      d.receipt ??= {
        nodeId: d.nodeId,
        status: "retired",
        summary: "requester retired",
        requestId: outgoing.requestId,
      };
    outgoing.delivered = true;
  }
  n.state = "retired";
  delete n.waitId;
  delete n.questionId;
  const receipt: CollaborationReceipt = { nodeId: n.nodeId, status: "retired", summary: reason };
  n.result ??= receipt;
  deliver(tree, receipt);
}
function begin(tree: Tree, n: CollaborationNode): CollaborationLease {
  const runId = randomUUID();
  n.attempts.push({ runId, toolTurns: 0 });
  n.runId = runId;
  n.state = "running";
  n.resume = false;
  return projectLease(tree, n, runId);
}
function projectLease(tree: Tree, n: CollaborationNode, runId: string): CollaborationLease {
  const question = n.questionId ? tree.batches.find((b) => b.id === n.questionId) : undefined;
  return {
    nodeId: n.nodeId,
    runId,
    role: n.role,
    depth: n.depth,
    task: n.objective,
    kind: question ? "answer" : "work",
    ...(question
      ? {
          question: question.question,
          questionId: question.id,
          questionFrom: question.from,
          questionEvidenceRefs: question.evidenceRefs ?? [],
        }
      : {}),
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
  root(nodeId: string, objective = "", payload?: Record<string, unknown>): CollaborationNode {
    if (!nodeId) throw Error("root node ID required");
    return this.change((tree) => {
      const existing = tree.nodes.find((n) => n.nodeId === nodeId);
      if (existing) {
        if (existing.depth || (objective && existing.objective !== objective))
          throw Error("conflicting root identity");
        return existing;
      }
      const n: CollaborationNode = {
        nodeId,
        rootId: nodeId,
        depth: 0,
        role: "director",
        objective,
        ...(payload ? { payload } : {}),
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
        enqueue(tree, n, false);
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
  communicate(input: CommunicationInput): string {
    return this.change((tree) => {
      const from = lookup(tree, input.fromNodeId),
        target = lookup(tree, input.targetNodeId);
      const signature = JSON.stringify([
        "question",
        input.runId,
        input.targetNodeId,
        input.question,
        input.evidenceRefs,
        input.deadlineMs,
      ]);
      const replay = tree.batches.find((b) => b.from === from.nodeId && b.requestId === input.requestId);
      if (replay) {
        if (replay.signature !== signature) throw Error("conflicting request ID");
        return replay.id;
      }
      verifySender(from, input.runId);
      if (!input.requestId || !input.question.trim() || input.question.length > 4000)
        throw Error("short nonempty directed question required");
      if (input.deadlineMs !== undefined && !Number.isSafeInteger(input.deadlineMs))
        throw Error("invalid absolute deadline");
      if (target.rootId !== from.rootId) throw Error("question crosses collaboration tree boundary");
      if (target.state === "retired" || target.state === "failed") throw Error("target is retired or failed");
      if (reaches(tree, target.nodeId, from.nodeId)) throw Error("question would create a wait cycle");
      if (
        tree.batches.filter((b) => b.question !== undefined && b.dependencies[0].nodeId === target.nodeId)
          .length >= 2
      )
        throw Error("target follow-up limit reached");
      const id = randomUUID();
      tree.batches.push({
        id,
        from: from.nodeId,
        requestId: input.requestId,
        signature,
        question: input.question,
        evidenceRefs: input.evidenceRefs,
        dependencies: [{ nodeId: target.nodeId }],
        deadlineMs: input.deadlineMs,
        delivered: false,
      });
      from.state = "suspended";
      from.waitId = id;
      queueQuestions(tree);
      return id;
    });
  }
  take(rootId?: string): CollaborationLease | null {
    return this.change((tree) => {
      const free = 2 - tree.nodes.filter((n) => n.depth && n.runId).length;
      if (free <= 0) return null;
      const window = tree.nodes
        .filter((n) => n.depth && n.state === "queued" && !n.runId)
        .sort(
          (a, b) =>
            priority(a) - priority(b) ||
            (a.readyOrder ?? tree.nodes.indexOf(a)) - (b.readyOrder ?? tree.nodes.indexOf(b)),
        )
        .slice(0, free);
      const next = rootId ? window.find((n) => n.rootId === rootId) : window[0];
      return next ? begin(tree, next) : null;
    });
  }
  takeRoot(nodeId: string): CollaborationLease | null {
    return this.change((tree) => {
      const n = lookup(tree, nodeId);
      return n.depth === 0 && n.state === "queued" && !n.runId ? begin(tree, n) : null;
    });
  }
  unconfirmed(rootId: string): CollaborationLease[] {
    const tree = this.snapshot();
    return tree.nodes.flatMap((n) =>
      n.rootId === rootId && n.depth && n.runId && !attempt(n, n.runId).terminalAction
        ? [projectLease(tree, n, n.runId)]
        : [],
    );
  }
  recoverable(
    rootId: string,
  ): { lease: CollaborationLease; action: { name: string; args: Record<string, unknown> } }[] {
    const tree = this.snapshot();
    return tree.nodes.flatMap((n) => {
      if (n.rootId !== rootId || !n.depth || !n.runId) return [];
      const action = attempt(n, n.runId).terminalAction;
      return action ? [{ lease: projectLease(tree, n, n.runId), action }] : [];
    });
  }
  checkpoint(input: CollaborationCheckpoint) {
    this.change((tree) => checkpoint(lookup(tree, input.nodeId), input));
  }
  /** The native process is terminal. Deliver a rejected control action to that same node so it can finish its work. */
  rejectAction(nodeId: string, runId: string, reason: string) {
    this.change((tree) => {
      const n = lookup(tree, nodeId),
        a = attempt(n, runId);
      if (a.outcome === "yielded") return;
      verifySender(n, runId);
      a.outcome = "yielded";
      delete a.terminalAction;
      delete n.runId;
      enqueue(tree, n, true);
      n.receipts = [{ nodeId, status: "failed", requestId: runId, summary: reason }];
    });
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
    input: CollaborationCheckpoint & {
      summary: string;
      ok?: boolean;
      delivery?: Record<string, unknown>;
      evidenceRefs?: string[];
    },
  ): CollaborationReceipt {
    return this.change((tree) => {
      const n = lookup(tree, input.nodeId),
        a = attempt(n, input.runId);
      const receipt: CollaborationReceipt = {
        nodeId: n.nodeId,
        status: input.ok === false ? "failed" : "completed",
        summary: input.summary,
        ...(input.evidenceRefs ? { evidenceRefs: input.evidenceRefs } : {}),
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
      const questionId = n.questionId;
      delete n.questionId;
      if (!questionId) {
        n.result = receipt;
        if (n.depth === 1 && input.delivery) n.delivery = input.delivery;
      }
      n.state = n.result?.status === "failed" ? "failed" : "completed";
      for (const child of tree.nodes.filter(
        (child) => child.parentId === n.nodeId && child.state !== "retired",
      ))
        retireBranch(tree, child, "parent concluded its work");
      deliver(tree, receipt, questionId);
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
    this.change((tree) => retireBranch(tree, lookup(tree, nodeId), reason));
  }
}
