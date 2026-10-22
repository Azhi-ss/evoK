import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { attestationJsonMacOk, signedAttestationJson } from "./attestation";
import { appendContained } from "../containment";
import { Lineage, Node, type NodeJson } from "../lineage";
import { backprop, DEFAULT_SELECTOR_ID, getSelector } from "./selector";

/**
 * Wiring of the existing lineage into one signed file beside campaign.json.
 * Parent pick is `getSelector(DEFAULT_SELECTOR_ID)` (GreedySelector).
 * The tried list is the selected parent's children, the same map as
 * `orchestrator.ts`. This file does not add a selector or a score formula.
 *
 * `gates` is the lineage gate log. `roleView` does not include it.
 */

export const SEARCH_TREE_FILE = "search-tree.json";

export interface SearchTreeBody {
  nonce: string;
  outRel: string;
  searchTreeFromRound: number;
  nodes: NodeJson[];
  events: Record<string, unknown>[];
  gates: Record<string, unknown>[];
  tried: string[];
}

/** Contest rewards are already in [0, 1]. `scoreTraces` ×100 is display, not a node score. */
export function unitReward(value: number | null): number | null {
  if (value === null || typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

export function triedIndex(nodes: readonly NodeJson[]): string[] {
  return nodes.map((node) => node.patchSummary).filter((summary) => summary !== "").sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function writeSearchTree(
  file: string,
  key: Buffer,
  lin: Lineage,
  meta: { readonly nonce: string; readonly outRel: string; readonly searchTreeFromRound: number },
): void {
  const nodes = [...lin.nodes.values()].map((node) => node.toJSON()).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const body: SearchTreeBody = {
    nonce: meta.nonce,
    outRel: meta.outRel,
    searchTreeFromRound: meta.searchTreeFromRound,
    nodes,
    events: [...lin.events()],
    gates: [...lin.gateEvents()],
    tried: triedIndex(nodes),
  };
  const text = signedAttestationJson(key, body);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

export function readSearchTree(file: string, key: Buffer): SearchTreeBody {
  const text = readFileSync(file, "utf8");
  if (!attestationJsonMacOk(key, text)) throw new Error("search tree signature rejected");
  let parsed: Partial<SearchTreeBody>;
  try {
    parsed = JSON.parse(text) as Partial<SearchTreeBody>;
  } catch {
    throw new Error("search tree signature rejected");
  }
  if (!parsed || !isBody(parsed)) throw new Error("search tree signature rejected");
  const expected = triedIndex(parsed.nodes);
  const got = [...parsed.tried].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (got.length !== expected.length || got.some((item, index) => item !== expected[index])) {
    throw new Error("search tree signature rejected");
  }
  return parsed;
}

export function openLineage(dir: string, snapshot: SearchTreeBody | null): Lineage {
  mkdirSync(dir, { recursive: true });
  const lin = new Lineage(dir);
  if (!snapshot) return lin;
  for (const node of snapshot.nodes) lin.put(new Node(node));
  const events = snapshot.events.map((event) => `${JSON.stringify(event)}\n`).join("");
  if (events !== "") appendContained(lin.root, "lineage.jsonl", events);
  const gates = snapshot.gates.map((event) => `${JSON.stringify(event)}\n`).join("");
  if (gates !== "") appendContained(lin.root, "gate.jsonl", gates);
  return lin;
}

export function ensureRoot(lin: Lineage, reward: number | null): string | null {
  const existing = [...lin.nodes.values()].find((node) => node.parentId === null);
  if (existing) return existing.id;
  const score = unitReward(reward);
  if (score === null) return null;
  const root = new Node({
    id: "root",
    parentId: null,
    configPath: "baseline/config.json",
    patchSummary: "",
    status: "evaluated",
    devScores: [score],
  });
  lin.put(root);
  return root.id;
}

export function importIdPrefix(dir: string): string {
  const name = basename(dir).replace(/[^A-Za-z0-9._-]/g, "");
  if (name === "" || name === "." || name === "..") return "import";
  return name;
}

export function pickParent(lin: Lineage): Node {
  return getSelector(DEFAULT_SELECTOR_ID).pick(lin);
}

/** Selected parent's children. Same expression as `orchestrator.ts`. */
export function parentTried(lin: Lineage, parent: Node): string[] {
  return parent.children.map((id) => lin.nodes.get(id)?.patchSummary ?? "");
}

export function attachChild(lin: Lineage, parent: Node, id: string, configPath: string, patchSummary: string): Node {
  if (lin.nodes.has(id) || id === parent.id) throw new Error(`lineage id ${id} already exists`);
  const child = new Node({ id, parentId: parent.id, configPath, patchSummary });
  parent.children.push(child.id);
  lin.put(parent);
  lin.put(child);
  return child;
}

export function noteReview(
  lin: Lineage,
  node: Node,
  review: {
    readonly accept: boolean;
    readonly reason: string;
    readonly reward: number | null;
    readonly knob: string;
    readonly round: number;
    readonly patch: string;
    readonly gates?: readonly unknown[];
  },
): void {
  const score = unitReward(review.reward);
  if (score !== null) node.devScores = [score];
  node.status = review.accept && score !== null ? "evaluated" : review.accept ? "pending" : "rejected";
  lin.put(node);
  lin.log("review", {
    node: node.id,
    accept: review.accept,
    reason: review.reason,
    knob: review.knob,
    round: review.round,
    ...(node.devMean !== null ? { dev: node.devMean } : {}),
    ...(review.patch !== "" ? { patch: review.patch } : {}),
  });
  if (node.devMean !== null) backprop(lin, node, node.devMean);
  if (review.gates) lin.gateLog({ node: node.id, round: review.round, gates: review.gates });
}

/**
 * Read a finished loop directory into nodes. Does not write into `dir`.
 * `beforeRound` skips that directory's later rounds (the live loop records those).
 * Returns the last imported id, or `parentId` when the directory adds nothing.
 */
export function importLoopHistory(lin: Lineage, dir: string, parentId: string | null, prefix: string, beforeRound?: number): string | null {
  if (!existsSync(dir)) throw new Error("search tree import missing");
  let parent = parentId;
  for (const round of roundDirs(dir)) {
    if (beforeRound !== undefined && round >= beforeRound) continue;
    const id = `${prefix}-r${round}`;
    if (lin.nodes.has(id)) {
      parent = id;
      continue;
    }
    const roundDir = join(dir, `round${round}`);
    const closure = readRecord(join(roundDir, "closure.json"));
    const patch = readText(join(roundDir, "patch.diff"));
    const notes = join(roundDir, "run-notes.md");
    const score = existsSync(notes) ? notesReward(readText(notes)) : null;
    if (!closure && patch === "" && score === null) continue;
    const accepted = closure?.accepted === true;
    const reason = stringField(closure, "reviewReason") || stringField(closure, "reason");
    const knob = stringField(readRecord(join(roundDir, "roles", "reviewer-gate", "candidates", "gap.json")), "knob");
    const node = new Node({
      id,
      parentId: parent,
      configPath: `round${round}/candidate/config.json`,
      patchSummary: `round${round}`,
      status: score !== null && accepted ? "evaluated" : closure && !accepted ? "rejected" : "pending",
      ...(score !== null ? { devScores: [score] } : {}),
    });
    if (parent) {
      const prior = lin.nodes.get(parent);
      if (prior && !prior.children.includes(node.id)) {
        prior.children.push(node.id);
        lin.put(prior);
      }
    }
    lin.put(node);
    lin.log("review", {
      node: id,
      accept: accepted,
      reason,
      round,
      ...(knob ? { knob } : {}),
      ...(score !== null ? { dev: score } : {}),
      ...(patch !== "" ? { patch } : {}),
    });
    const gates = closure?.gates;
    if (Array.isArray(gates)) lin.gateLog({ node: id, round, gates });
    if (node.devMean !== null) backprop(lin, node, node.devMean);
    parent = id;
  }
  return parent;
}

function isBody(value: Partial<SearchTreeBody>): value is SearchTreeBody {
  if (typeof value.nonce !== "string" || !/^[0-9a-f]{32}$/.test(value.nonce)) return false;
  if (typeof value.outRel !== "string" || value.outRel === "" || value.outRel.includes("/") || value.outRel.includes("\\")) return false;
  if (typeof value.searchTreeFromRound !== "number" || !Number.isInteger(value.searchTreeFromRound) || value.searchTreeFromRound < 1) return false;
  if (!Array.isArray(value.nodes) || !Array.isArray(value.events) || !Array.isArray(value.gates) || !Array.isArray(value.tried)) return false;
  if (value.tried.some((item) => typeof item !== "string")) return false;
  if (value.events.some((event) => !event || typeof event !== "object" || Array.isArray(event))) return false;
  if (value.gates.some((event) => !event || typeof event !== "object" || Array.isArray(event))) return false;
  return value.nodes.every((node) => node && typeof node === "object" && typeof node.id === "string" && typeof node.patchSummary === "string");
}

function roundDirs(dir: string): number[] {
  const nums: number[] = [];
  for (const name of readdirSync(dir)) {
    const match = /^round(\d+)$/.exec(name);
    if (match?.[1]) nums.push(Number(match[1]));
  }
  return nums.sort((left, right) => left - right);
}

function readRecord(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readText(file: string): string {
  if (!existsSync(file)) return "";
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function stringField(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function notesReward(text: string): number | null {
  for (const line of text.split("\n")) {
    if (!line.startsWith("reward:")) continue;
    const raw = line.slice("reward:".length).trim();
    if (raw === "") return null;
    return unitReward(Number(raw));
  }
  return null;
}
