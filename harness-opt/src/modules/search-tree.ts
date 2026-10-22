import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { attestationJsonMacOk, signedAttestationJson } from "./attestation";
import { appendContained } from "../containment";
import { Lineage, Node, type NodeJson } from "../lineage";
import { backprop, DEFAULT_SELECTOR_ID, getSelector } from "./selector";

const ABSENT = "absent in source";

/**
 * Wiring of the existing lineage into one signed file beside campaign.json.
 * Parent pick is `getSelector(DEFAULT_SELECTOR_ID)` (GreedySelector).
 * The tried list is the selected parent's children, the same map as
 * `orchestrator.ts`. This file does not add a selector or a score formula.
 *
 * Gate pass/fail rows are copied onto the role log as well as `gate.jsonl`,
 * so the gap-finder and innovator view can read them. Held-out scores stay out.
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

/**
 * Control node, always evaluated, so a parent exists.
 * A reward in [0, 1] is stored. Without one, `devScores` is [0]. That 0 is
 * not a measured reward and is not what selects the parent: `selectParent`
 * returns this node by id when the baseline reward is missing.
 */
export function ensureRoot(lin: Lineage, reward: number | null): string {
  const existing = [...lin.nodes.values()].find((node) => node.parentId === null);
  if (existing) return existing.id;
  const score = unitReward(reward);
  const root = new Node({
    id: "root",
    parentId: null,
    configPath: score === null ? "control/config.json" : "baseline/config.json",
    patchSummary: "",
    status: "evaluated",
    devScores: [score === null ? 0 : score],
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

/**
 * With a measured baseline reward, the parent is `GreedySelector.pick`.
 * With none, the parent is the control node (`id` `root`). That choice does
 * not depend on dev-score order, so an imported candidate with a higher
 * mean cannot take the root's place.
 */
export function selectParent(lin: Lineage, baselineReward: number | null): Node {
  if (unitReward(baselineReward) !== null) return pickParent(lin);
  const root = [...lin.nodes.values()].find((node) => node.id === "root" && node.parentId === null);
  if (!root) throw new Error("lineage has no root node");
  return root;
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
  const gates = publicGates(review.gates);
  lin.log("review", {
    seq: nextSeq(lin),
    group: `live-r${review.round}`,
    node: node.id,
    accept: review.accept,
    reason: review.reason,
    reasonLabel: "commentary",
    knob: review.knob,
    round: review.round,
    reward: score === null ? ABSENT : score,
    gates,
    ...(node.devMean !== null ? { dev: node.devMean } : {}),
    ...(review.patch !== "" ? { patch: review.patch } : {}),
  });
  if (node.devMean !== null) backprop(lin, node, node.devMean);
  if (Array.isArray(gates)) lin.gateLog({ node: node.id, round: review.round, gates });
}

export interface ImportJob {
  readonly dir: string;
  readonly prefix: string;
  readonly beforeRound?: number;
}

/**
 * Read finished loop directories. Does not write into them.
 * A round's parent is the node whose config bytes match that loop's
 * `baseline/config.json`. A match to one of the round's own candidates is
 * ignored (an accept overwrites baseline with that candidate). Otherwise the
 * parent is the control root, so unrelated rounds are siblings.
 * `beforeRound` skips that directory's later rounds.
 */
export function importLoopHistories(
  lin: Lineage,
  jobs: readonly ImportJob[],
  configs: Map<string, string>,
  rootId: string,
): void {
  const built: BuiltRound[] = [];
  for (const job of jobs) {
    if (!existsSync(job.dir)) throw new Error("search tree import missing");
    remember(configs, rootId, join(job.dir, "control", "config.json"));
    const loop = readRecord(join(job.dir, "loop-result.json"));
    for (const round of roundDirs(job.dir)) {
      if (job.beforeRound !== undefined && round >= job.beforeRound) continue;
      const roundDir = join(job.dir, `round${round}`);
      const closure = readRecord(join(roundDir, "closure.json"));
      const patch = readText(join(roundDir, "patch.diff"));
      const notes = join(roundDir, "run-notes.md");
      const score = existsSync(notes) ? notesReward(readText(notes)) : null;
      const candidates = readCandidates(lin, roundDir, job.prefix, round, closure, loop, score, patch);
      if (candidates.length === 0 && !closure && patch === "" && score === null) continue;
      for (const candidate of candidates) {
        if (lin.nodes.has(candidate.id)) continue;
        lin.put(candidate.node);
        const prior = lin.nodes.get(rootId);
        if (prior && !prior.children.includes(candidate.id)) {
          prior.children.push(candidate.id);
          lin.put(prior);
        }
        if (candidate.configFile !== "") remember(configs, candidate.id, candidate.configFile);
      }
      const winnerFile = join(roundDir, "candidate", "config.json");
      const winner = candidates.find((item) => item.winner);
      if (winner && existsSync(winnerFile)) remember(configs, winner.id, winnerFile);
      built.push({
        prefix: job.prefix,
        round,
        dir: job.dir,
        roundDir,
        candidates,
        patch,
        accept: readAccept(closure, loop, round),
        reason: readReason(closure, roundDir),
        knob: readKnob(roundDir, loop, round),
        reward: score === null ? ABSENT : score,
        gates: readGates(closure, roundDir),
        critic: readCritic(roundDir),
        ranker: readRanker(closure, roundDir),
      });
    }
  }
  for (const round of built) {
    const own = new Set(round.candidates.map((item) => item.id));
    const baseline = shaFile(join(round.dir, "baseline", "config.json"));
    const matched = baseline ? configs.get(baseline) : undefined;
    const parentId = matched && !own.has(matched) ? matched : rootId;
    for (const candidate of round.candidates) {
      const node = lin.nodes.get(candidate.id);
      if (!node || node.parentId === parentId) continue;
      reparent(lin, node, parentId);
    }
    const gates = round.gates;
    lin.log("round", {
      seq: nextSeq(lin),
      group: `${round.prefix}-r${round.round}`,
      source: round.prefix,
      round: round.round,
      parentId,
      accept: round.accept,
      reason: round.reason,
      reasonLabel: "commentary",
      knob: round.knob,
      reward: round.reward,
      gates,
      critic: round.critic,
      ranker: round.ranker,
      ...(round.patch !== "" ? { patch: round.patch } : {}),
      candidates: round.candidates.map((item) => ({
        id: item.id,
        parentId,
        summary: item.node.patchSummary,
        invalid: item.invalid,
        ...(item.invalidReason !== "" ? { invalidReason: item.invalidReason } : {}),
        reward: item.winner && typeof round.reward === "number" ? round.reward : ABSENT,
      })),
    });
    if (Array.isArray(gates)) lin.gateLog({ round: round.round, source: round.prefix, gates });
    for (const candidate of round.candidates) {
      const node = lin.nodes.get(candidate.id);
      if (node?.devMean !== null && node?.devMean !== undefined) backprop(lin, node, node.devMean);
    }
  }
}

interface BuiltCandidate {
  readonly id: string;
  readonly node: Node;
  readonly invalid: boolean;
  readonly invalidReason: string;
  readonly winner: boolean;
  readonly configFile: string;
}

interface BuiltRound {
  readonly prefix: string;
  readonly round: number;
  readonly dir: string;
  readonly roundDir: string;
  readonly candidates: readonly BuiltCandidate[];
  readonly patch: string;
  readonly accept: boolean | typeof ABSENT;
  readonly reason: string;
  readonly knob: string;
  readonly reward: number | typeof ABSENT;
  readonly gates: unknown;
  readonly critic: unknown;
  readonly ranker: unknown;
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

function nextSeq(lin: Lineage): number {
  let max = 0;
  for (const event of lin.events()) {
    if (typeof event.seq === "number" && event.seq > max) max = event.seq;
  }
  return max + 1;
}

function shaFile(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

function remember(configs: Map<string, string>, nodeId: string, file: string): void {
  const sha = shaFile(file);
  if (sha) configs.set(sha, nodeId);
}

function reparent(lin: Lineage, node: Node, parentId: string): void {
  const previous = node.parentId === null ? undefined : lin.nodes.get(node.parentId);
  if (previous) {
    previous.children = previous.children.filter((id) => id !== node.id);
    lin.put(previous);
  }
  node.parentId = parentId;
  const parent = lin.nodes.get(parentId);
  if (parent && !parent.children.includes(node.id)) {
    parent.children.push(node.id);
    lin.put(parent);
  }
  lin.put(node);
}

function publicGates(value: readonly unknown[] | undefined): Record<string, unknown>[] | typeof ABSENT {
  if (!value) return ABSENT;
  const rows = value.map(publicGate).filter((row): row is Record<string, unknown> => row !== null);
  return rows.length === 0 ? ABSENT : rows;
}

function publicGate(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (typeof source.id !== "string" || typeof source.pass !== "boolean") return null;
  const row: Record<string, unknown> = { id: source.id, pass: source.pass };
  if (typeof source.code === "string" && source.code !== "") row.code = source.code;
  const reason = gateReason(source);
  if (reason !== "") row.reason = reason;
  return row;
}

function gateReason(source: Record<string, unknown>): string {
  const direct = reasonText(source.reason);
  if (direct !== "") return direct;
  const extras = Object.entries(source).filter(([key, value]) => {
    if (key === "id" || key === "pass" || key === "code") return false;
    return typeof value === "string" && value !== "";
  });
  const named = extras.find(([key]) => key.toLowerCase().includes("reason"));
  if (named && typeof named[1] === "string") return named[1];
  if (extras.length === 1 && typeof extras[0]?.[1] === "string") return extras[0][1];
  return "";
}

function reasonText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  for (const key of ["text", "message", "reason"]) {
    if (typeof record[key] === "string" && record[key] !== "") return record[key];
  }
  return "";
}

function readGates(closure: Record<string, unknown> | null, roundDir: string): Record<string, unknown>[] | typeof ABSENT {
  const merged = new Map<string, Record<string, unknown>>();
  const absorb = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      const row = publicGate(item);
      if (!row || typeof row.id !== "string") continue;
      const existing = merged.get(row.id);
      if (!existing) {
        merged.set(row.id, row);
        continue;
      }
      if (existing.code === undefined && row.code !== undefined) existing.code = row.code;
      if (existing.reason === undefined && row.reason !== undefined) existing.reason = row.reason;
    }
  };
  absorb(closure?.gates);
  const record = readRecord(join(roundDir, "roles", "reviewer-gate", "state", "nodes", "gates.json"));
  if (record) absorb(record.gates);
  if (record?.reasons && typeof record.reasons === "object" && !Array.isArray(record.reasons)) {
    for (const [id, reason] of Object.entries(record.reasons as Record<string, unknown>)) {
      if (typeof reason !== "string" || reason === "") continue;
      const row = merged.get(id);
      if (row && row.reason === undefined) row.reason = reason;
    }
  }
  return merged.size === 0 ? ABSENT : [...merged.values()];
}

function readKnob(roundDir: string, loop: Record<string, unknown> | null, round: number): string {
  const gap = stringField(readRecord(join(roundDir, "roles", "reviewer-gate", "candidates", "gap.json")), "knob");
  if (gap !== "") return gap;
  const review = stringField(readRecord(join(roundDir, "review-input.json")), "knob");
  if (review !== "") return review;
  const accepted = loop?.accepted;
  if (accepted && typeof accepted === "object" && !Array.isArray(accepted)) {
    const row = accepted as Record<string, unknown>;
    if (row.round === round && typeof row.knob === "string" && row.knob !== "") return row.knob;
  }
  return ABSENT;
}

function readReason(closure: Record<string, unknown> | null, roundDir: string): string {
  const written = stringField(closure, "reviewReason");
  if (written !== "") return written;
  for (const text of assistantTexts(join(roundDir, "sessions", "reviewer-gate.jsonl"))) {
    const parsed = jsonObject(text);
    if (parsed && typeof parsed.reason === "string" && parsed.reason !== "") return parsed.reason;
    if (!parsed && text.trim() !== "" && text.trim() !== "reviewer-gate") return text.trim();
  }
  return ABSENT;
}

function readAccept(closure: Record<string, unknown> | null, loop: Record<string, unknown> | null, round: number): boolean | typeof ABSENT {
  if (closure && typeof closure.accepted === "boolean") return closure.accepted;
  if (Array.isArray(loop?.rounds)) {
    for (const item of loop.rounds) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      if (row.round === round && typeof row.accepted === "boolean") return row.accepted;
    }
  }
  const accepted = loop?.accepted;
  if (accepted && typeof accepted === "object" && !Array.isArray(accepted) && (accepted as Record<string, unknown>).round === round) {
    return true;
  }
  return ABSENT;
}

function readCritic(roundDir: string): { readonly excluded: readonly string[] } | typeof ABSENT {
  const input = readRecord(join(roundDir, "ranker-input.json"));
  if (input && Array.isArray(input.excluded) && input.excluded.every((id) => typeof id === "string")) {
    return { excluded: input.excluded as string[] };
  }
  for (const text of assistantTexts(join(roundDir, "sessions", "critic.jsonl"))) {
    const parsed = jsonObject(text);
    if (parsed && Array.isArray(parsed.excluded) && parsed.excluded.every((id) => typeof id === "string")) {
      return { excluded: parsed.excluded as string[] };
    }
  }
  return ABSENT;
}

function readRanker(closure: Record<string, unknown> | null, roundDir: string): Record<string, unknown> | typeof ABSENT {
  const ranking = readRecord(join(roundDir, "ranking.json"));
  const winner = stringField(ranking, "rankerWinnerId");
  if (winner !== "" || ranking) {
    return {
      ...(winner !== "" ? { winnerId: winner } : {}),
      ...(ranking && "codeWinner" in ranking ? { codeWinner: ranking.codeWinner ?? null } : {}),
      ...(closure?.codeRank && typeof closure.codeRank === "object" ? { codeRank: closure.codeRank } : {}),
    };
  }
  for (const text of assistantTexts(join(roundDir, "sessions", "ranker.jsonl"))) {
    const parsed = jsonObject(text);
    if (parsed && typeof parsed.winnerId === "string") return { winnerId: parsed.winnerId };
    if (!parsed && /^c\d+$/.test(text.trim())) return { winnerId: text.trim() };
  }
  return ABSENT;
}

function readCandidates(
  lin: Lineage,
  roundDir: string,
  prefix: string,
  round: number,
  closure: Record<string, unknown> | null,
  loop: Record<string, unknown> | null,
  score: number | null,
  patch: string,
): BuiltCandidate[] {
  const invalid = invalidById(closure, loop, round);
  const slots = new Set<number>();
  for (let slot = 0; slot < 6; slot += 1) {
    if (
      existsSync(join(roundDir, "roles", `innovator-${slot}`))
      || existsSync(join(roundDir, "sessions", `innovator-${slot}.jsonl`))
      || existsSync(join(roundDir, `innovator-${slot}-input.json`))
    ) slots.add(slot);
  }
  for (const id of invalid.keys()) {
    const match = /^c(\d+)$/.exec(id);
    if (match?.[1]) slots.add(Number(match[1]));
  }
  const ranking = readRecord(join(roundDir, "ranking.json"));
  const named = stringField(ranking, "rankerWinnerId");
  const winnerSlot = /^c(\d+)$/.exec(named)?.[1];
  if (slots.size === 0 && (existsSync(join(roundDir, "candidate", "config.json")) || patch !== "")) slots.add(winnerSlot ? Number(winnerSlot) : 0);
  const accept = readAccept(closure, loop, round);
  const out: BuiltCandidate[] = [];
  for (const slot of [...slots].sort((left, right) => left - right)) {
    const id = `${prefix}-r${round}-c${slot}`;
    if (lin.nodes.has(id)) continue;
    const key = `c${slot}`;
    const reason = invalid.get(key) ?? "";
    const marked = reason !== "";
    const found = candidateSummary(roundDir, slot, marked, reason);
    const summary = found.summary;
    const configFile = found.configFile;
    const winner = named !== "" ? key === named : !marked && slot === (winnerSlot ? Number(winnerSlot) : 0);
    const scored = winner && accept === true && score !== null;
    const node = new Node({
      id,
      parentId: "root",
      configPath: configLabel(round, slot, configFile, roundDir, winner && existsSync(join(roundDir, "candidate", "config.json"))),
      patchSummary: summary,
      status: marked ? "failed" : scored ? "evaluated" : accept === false && winner ? "rejected" : "pending",
      ...(scored ? { devScores: [score] } : {}),
    });
    out.push({
      id,
      node,
      invalid: marked,
      invalidReason: reason,
      winner,
      configFile,
    });
  }
  return out;
}

function configLabel(round: number, slot: number, configFile: string, roundDir: string, winnerConfig: boolean): string {
  if (winnerConfig) return `round${round}/candidate/config.json`;
  if (configFile !== "") {
    const rel = relative(roundDir, configFile).split("\\").join("/");
    if (rel !== "" && !rel.startsWith("..")) return `round${round}/${rel}`;
  }
  return `round${round}/roles/innovator-${slot}/config.json`;
}

function candidateSummary(roundDir: string, slot: number, invalid: boolean, reason: string): { summary: string; configFile: string } {
  const located = locateCandidatePatch(roundDir, slot);
  const decorate = (summary: string): string => (invalid ? `${summary} invalid ${reason}` : summary);
  if (located.summary !== "") return { summary: decorate(located.summary), configFile: located.configFile };
  for (const text of assistantTexts(join(roundDir, "sessions", `innovator-${slot}.jsonl`))) {
    const parsed = jsonObject(text);
    const summary = parsed && typeof parsed.summary === "string" ? parsed.summary : !parsed ? text.trim() : "";
    if (summary !== "" && summary !== "innovator") return { summary: decorate(summary), configFile: located.configFile };
  }
  if (invalid) return { summary: `invalid ${reason}`, configFile: located.configFile };
  return { summary: ABSENT, configFile: located.configFile };
}

/** Role `patch.json` wins. Otherwise the innovator's real `candidates/<dir>/patch.json`. */
function locateCandidatePatch(roundDir: string, slot: number): { summary: string; configFile: string } {
  const roleDir = join(roundDir, "roles", `innovator-${slot}`);
  const topSummary = stringField(readRecord(join(roleDir, "patch.json")), "summary");
  const roleConfig = join(roleDir, "config.json");
  if (topSummary !== "") return { summary: topSummary, configFile: existsSync(roleConfig) ? roleConfig : "" };
  const named = namedPatch(join(roleDir, "candidates"), slot, false);
  if (named) return named;
  const shared = namedPatch(join(roundDir, "candidates"), slot, true);
  if (shared) return shared;
  return { summary: "", configFile: existsSync(roleConfig) ? roleConfig : "" };
}

function namedPatch(dir: string, slot: number, requireMatch: boolean): { summary: string; configFile: string } | null {
  if (!existsSync(dir)) return null;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const hits: { summary: string; configFile: string; matched: boolean }[] = [];
  for (const name of names.sort()) {
    if (name === "base") continue;
    const patch = readRecord(join(dir, name, "patch.json"));
    const summary = stringField(patch, "summary");
    if (summary === "") continue;
    const label = stringField(patch, "id") || stringField(patch, "candidateId") || stringField(patch, "slot");
    const matched = label === `c${slot}` || label === `innovator-${slot}` || name === `c${slot}` || name === `innovator-${slot}`;
    const config = join(dir, name, "config.json");
    hits.push({ summary, configFile: existsSync(config) ? config : "", matched });
  }
  const matched = hits.find((hit) => hit.matched);
  if (matched) return { summary: matched.summary, configFile: matched.configFile };
  if (!requireMatch && hits.length === 1) return { summary: hits[0]?.summary ?? "", configFile: hits[0]?.configFile ?? "" };
  return null;
}

function invalidById(closure: Record<string, unknown> | null, loop: Record<string, unknown> | null, round: number): Map<string, string> {
  const out = new Map<string, string>();
  const lists = [closure?.invalidCandidates];
  if (Array.isArray(loop?.rounds)) {
    for (const item of loop.rounds) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      if (row.round === round) lists.push(row.invalidCandidates);
    }
  }
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      if (typeof row.id !== "string" || row.id === "") continue;
      const reason = typeof row.reason === "string" && row.reason !== "" ? row.reason : "invalid";
      out.set(row.id, reason);
    }
  }
  return out;
}

function assistantTexts(file: string): string[] {
  const texts: string[] = [];
  for (const line of readText(file).split("\n")) {
    if (line.trim() === "") continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (record.type === "message" && record.role === "assistant" && typeof record.text === "string") texts.push(record.text);
    const message = record.message;
    if (!message || typeof message !== "object") continue;
    const body = message as Record<string, unknown>;
    if (body.role !== "assistant") continue;
    if (typeof body.text === "string") texts.push(body.text);
    if (!Array.isArray(body.content)) continue;
    for (const block of body.content) {
      if (!block || typeof block !== "object") continue;
      const text = (block as Record<string, unknown>).text;
      if (typeof text === "string") texts.push(text);
    }
  }
  return texts;
}

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
