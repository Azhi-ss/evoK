/**
 * Pluggable parent-selection port (V1-S / Spec #99).
 *
 * Default inner A stays tree + `fixed_uct` (constant exploration √2), aligned
 * with algorithm-evolve `select_node`. Progressive MCGS-minded selection
 * (`progressive_mcgs_optin` / `StrongSearchAdapter`) is constructed only when
 * explicitly selected — it is not the product default and does not weld #40
 * SelectionPolicy open.
 *
 * This port picks a parent. It is not `ToyCompetitionAdapter` (eval), does
 * not call HypothesisLedger / Kill-test hang / Broker, and does not let
 * outer `expand_requested` drive UCT. Elite / MMD / near-dup / side-slot
 * scores never become promotion keys. Failure memory is parent lineage plus
 * an optional short `fail_note` only (no FAISS transplant).
 */
import { deepFreeze } from "./security-boundary";

export const SEARCH_SELECTION_SCHEMA_VERSION = "1" as const;
export const DEFAULT_SEARCH_SELECTION_ID = "fixed_uct" as const;
export const PROGRESSIVE_MCGS_OPT_IN_ID = "progressive_mcgs_optin" as const;
export const DEFAULT_UCT_EXPLORATION = Math.SQRT2;
export const SELECTION_POLICY_40 = "off" as const;
export const DEFAULT_PROGRESSIVE_TAU = 8;
export const DEFAULT_PROGRESSIVE_TOP_K = 2;
const MAX_FAIL_NOTE = 280;

export type SearchSelectionAdapterId =
  | typeof DEFAULT_SEARCH_SELECTION_ID
  | typeof PROGRESSIVE_MCGS_OPT_IN_ID;

export type SearchSelectionRole = "parent-selection";

export interface SearchParentCandidate {
  readonly nodeId: string;
  readonly visits: number;
  readonly value: number;
  readonly parentVisits?: number;
  readonly parentId?: string;
  readonly lineage?: readonly string[];
  readonly failNote?: string;
}

export interface SearchSelectionContext {
  readonly nodes: readonly SearchParentCandidate[];
  readonly t?: number;
  readonly seed?: number;
  readonly expandRequested?: unknown;
}

export interface SearchParentSelection {
  readonly parentId: string;
  readonly adapterId: SearchSelectionAdapterId;
  readonly schema_version: typeof SEARCH_SELECTION_SCHEMA_VERSION;
  readonly exploration: number;
  readonly lineage?: readonly string[];
  readonly failNote?: string;
}

export interface SearchSelectionSchedule {
  readonly exploration: number;
  readonly eliteWeight: number;
}

export interface SearchSelectionFinalize {
  readonly parentId?: string;
}

export interface SearchSelectionDescription {
  readonly id: SearchSelectionAdapterId;
  readonly schema_version: typeof SEARCH_SELECTION_SCHEMA_VERSION;
  readonly kind: SearchSelectionAdapterId;
  readonly role: SearchSelectionRole;
  readonly productDefault: boolean;
  readonly selectionPolicy40: typeof SELECTION_POLICY_40;
  readonly exploration: number;
  readonly explorationMode: "constant" | "c(t) decay";
  readonly topK?: number;
  readonly tau?: number;
}

export interface SearchSelectionPort {
  readonly id: SearchSelectionAdapterId;
  readonly schema_version: typeof SEARCH_SELECTION_SCHEMA_VERSION;
  selectParent(ctx: SearchSelectionContext): SearchParentSelection;
  schedule?(t?: number): SearchSelectionSchedule;
  onFinalize?(result?: SearchSelectionFinalize): void;
  describe(): SearchSelectionDescription;
}

export interface FixedUctSelectionOptions {
  readonly exploration?: number;
}

export interface ProgressiveMcgsOptions extends FixedUctSelectionOptions {
  readonly seed?: number;
  readonly topK?: number;
  readonly tau?: number;
}

export type SearchSelectionPortOptions = FixedUctSelectionOptions | ProgressiveMcgsOptions;

const PROMOTION_KEY_FIELDS = [
  "mmd", "sideSlot", "side_slot", "sideSlotScore", "mmdScore", "score",
  "nearDup", "near_dup", "nearDupScore", "nearDuplicate", "diversity", "diversityScore",
  "eliteScore",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonEmpty(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function finiteNumber(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite number`);
  }
}

function finiteNonNegative(name: string, value: unknown): asserts value is number {
  finiteNumber(name, value);
  if (value < 0) throw new RangeError(`${name} must be finite and >= 0`);
}

function finitePositive(name: string, value: unknown): asserts value is number {
  finiteNumber(name, value);
  if (value <= 0) throw new RangeError(`${name} must be finite and > 0`);
}

function assertNoPromotionKeys(value: object, label: string): void {
  for (const field of PROMOTION_KEY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      throw new TypeError(`${label} must not emit Elite / MMD / near-dup / side-slot promotion keys`);
    }
  }
}

function normalizeFailNote(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError("failNote must be a string");
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (trimmed.length > MAX_FAIL_NOTE) throw new RangeError("failNote must be a short fail_note");
  return trimmed;
}

function normalizeLineage(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new TypeError("lineage must contain non-empty strings");
  }
  return Object.freeze([...value]);
}

function normalizeCandidate(value: unknown): SearchParentCandidate {
  if (!isPlainRecord(value)) throw new TypeError("search parent candidate must be an ordinary object");
  nonEmpty("nodeId", value.nodeId);
  finiteNonNegative("visits", value.visits);
  finiteNumber("value", value.value);
  if (value.parentVisits !== undefined) finiteNonNegative("parentVisits", value.parentVisits);
  if (value.parentId !== undefined) nonEmpty("parentId", value.parentId);
  const lineage = normalizeLineage(value.lineage);
  const failNote = normalizeFailNote(value.failNote);
  return deepFreeze({
    nodeId: value.nodeId,
    visits: value.visits,
    value: value.value,
    ...(value.parentVisits === undefined ? {} : { parentVisits: value.parentVisits }),
    ...(value.parentId === undefined ? {} : { parentId: value.parentId }),
    ...(lineage === undefined ? {} : { lineage }),
    ...(failNote === undefined ? {} : { failNote }),
  }) as SearchParentCandidate;
}

function normalizeNodes(value: unknown): readonly SearchParentCandidate[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RangeError("selectParent requires a non-empty nodes list");
  }
  const nodes = value.map(normalizeCandidate);
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.nodeId)) throw new RangeError(`duplicate search node: ${node.nodeId}`);
    seen.add(node.nodeId);
  }
  return nodes;
}

function normalizeT(value: unknown): number {
  if (value === undefined) return 0;
  finiteNonNegative("t", value);
  return value;
}

function normalizeExploration(value: unknown): number {
  if (value === undefined) return DEFAULT_UCT_EXPLORATION;
  finitePositive("exploration", value);
  return value;
}

function normalizeTau(value: unknown): number {
  if (value === undefined) return DEFAULT_PROGRESSIVE_TAU;
  finitePositive("tau", value);
  return value;
}

function normalizeTopK(value: unknown): number {
  if (value === undefined) return DEFAULT_PROGRESSIVE_TOP_K;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new RangeError("topK must be an integer >= 1");
  }
  return value;
}

function normalizeSeed(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new RangeError("seed must be an integer");
  }
  return value;
}

function parentVisitsOf(node: SearchParentCandidate, fallback: number): number {
  return node.parentVisits ?? fallback;
}

function uctScore(node: SearchParentCandidate, exploration: number, fallbackParentVisits: number): number {
  if (node.visits <= 0) return Number.POSITIVE_INFINITY;
  const parentVisits = Math.max(parentVisitsOf(node, fallbackParentVisits), 1);
  return node.value + exploration * Math.sqrt(Math.log(parentVisits) / node.visits);
}

function compareUct(left: SearchParentCandidate, right: SearchParentCandidate, exploration: number, fallbackParentVisits: number): number {
  const leftScore = uctScore(left, exploration, fallbackParentVisits);
  const rightScore = uctScore(right, exploration, fallbackParentVisits);
  if (leftScore !== rightScore) return rightScore > leftScore ? 1 : -1;
  return left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0;
}

function pickByUct(nodes: readonly SearchParentCandidate[], exploration: number): SearchParentCandidate {
  const fallback = nodes.reduce((sum, node) => sum + node.visits, 0);
  return nodes.reduce((best, node) => (
    compareUct(node, best, exploration, fallback) < 0 ? node : best
  ));
}

function compareElite(left: SearchParentCandidate, right: SearchParentCandidate): number {
  if (left.value !== right.value) return right.value > left.value ? 1 : -1;
  return left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0;
}

function elitePool(nodes: readonly SearchParentCandidate[], topK: number): readonly SearchParentCandidate[] {
  return [...nodes].sort(compareElite).slice(0, Math.min(topK, nodes.length));
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function pickElite(pool: readonly SearchParentCandidate[], rng: () => number): SearchParentCandidate {
  if (pool.length === 1) return pool[0]!;
  const index = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
  return pool[index]!;
}

function selectionFrom(node: SearchParentCandidate, adapterId: SearchSelectionAdapterId, exploration: number): SearchParentSelection {
  const selected = {
    parentId: node.nodeId,
    adapterId,
    schema_version: SEARCH_SELECTION_SCHEMA_VERSION,
    exploration,
    ...(node.lineage === undefined ? {} : { lineage: node.lineage }),
    ...(node.failNote === undefined ? {} : { failNote: node.failNote }),
  };
  assertNoPromotionKeys(selected, "SearchParentSelection");
  return deepFreeze(selected) as SearchParentSelection;
}

function finalizeGuard(result?: SearchSelectionFinalize): void {
  if (result === undefined) return;
  if (!isPlainRecord(result)) throw new TypeError("onFinalize payload must be an ordinary object");
  assertNoPromotionKeys(result, "onFinalize");
  if (result.parentId !== undefined) nonEmpty("parentId", result.parentId);
}

abstract class SearchSelectionAdapter implements SearchSelectionPort {
  abstract readonly id: SearchSelectionAdapterId;
  readonly schema_version = SEARCH_SELECTION_SCHEMA_VERSION;

  abstract selectParent(ctx: SearchSelectionContext): SearchParentSelection;
  abstract schedule(t: number): SearchSelectionSchedule;
  abstract describe(): SearchSelectionDescription;

  onFinalize(result?: SearchSelectionFinalize): void {
    finalizeGuard(result);
  }
}

export class FixedUctSelectionAdapter extends SearchSelectionAdapter {
  readonly id = DEFAULT_SEARCH_SELECTION_ID;
  readonly exploration: number;

  constructor(options: FixedUctSelectionOptions = {}) {
    super();
    if (!isPlainRecord(options)) throw new TypeError("fixed_uct options must be an ordinary object");
    this.exploration = normalizeExploration(options.exploration);
  }

  selectParent(ctx: SearchSelectionContext): SearchParentSelection {
    if (!isPlainRecord(ctx)) throw new TypeError("selectParent context must be an ordinary object");
    const nodes = normalizeNodes(ctx.nodes);
    return selectionFrom(pickByUct(nodes, this.exploration), this.id, this.exploration);
  }

  schedule(_t?: number): SearchSelectionSchedule {
    return deepFreeze({ exploration: this.exploration, eliteWeight: 0 });
  }

  describe(): SearchSelectionDescription {
    return deepFreeze({
      id: this.id,
      schema_version: SEARCH_SELECTION_SCHEMA_VERSION,
      kind: this.id,
      role: "parent-selection",
      productDefault: true,
      selectionPolicy40: SELECTION_POLICY_40,
      exploration: this.exploration,
      explorationMode: "constant",
    });
  }
}

/**
 * Opt-in Progressive MCGS-minded adapter: decaying c(t) plus Elite soft-switch
 * by w(t)/top-K. Not the product default.
 *
 *   c(t) = c0 / (1 + t / tau)
 *   w(t) = min(1, t / tau)
 */
export class ProgressiveMcgsOptInAdapter extends SearchSelectionAdapter {
  readonly id = PROGRESSIVE_MCGS_OPT_IN_ID;
  readonly exploration: number;
  readonly seed: number;
  readonly topK: number;
  readonly tau: number;

  constructor(options: ProgressiveMcgsOptions = {}) {
    super();
    if (!isPlainRecord(options)) throw new TypeError("progressive_mcgs_optin options must be an ordinary object");
    this.exploration = normalizeExploration(options.exploration);
    this.seed = normalizeSeed(options.seed);
    this.topK = normalizeTopK(options.topK);
    this.tau = normalizeTau(options.tau);
  }

  schedule(t?: number): SearchSelectionSchedule {
    const step = normalizeT(t);
    const exploration = this.exploration / (1 + step / this.tau);
    const eliteWeight = Math.min(1, step / this.tau);
    return deepFreeze({ exploration, eliteWeight });
  }

  selectParent(ctx: SearchSelectionContext): SearchParentSelection {
    if (!isPlainRecord(ctx)) throw new TypeError("selectParent context must be an ordinary object");
    const nodes = normalizeNodes(ctx.nodes);
    const planned = this.schedule(ctx.t);
    const seed = ctx.seed === undefined ? this.seed : normalizeSeed(ctx.seed);
    const rng = mulberry32(seed);
    const useElite = planned.eliteWeight >= 1 || (planned.eliteWeight > 0 && rng() < planned.eliteWeight);
    const chosen = useElite
      ? pickElite(elitePool(nodes, this.topK), rng)
      : pickByUct(nodes, planned.exploration);
    return selectionFrom(chosen, this.id, planned.exploration);
  }

  describe(): SearchSelectionDescription {
    return deepFreeze({
      id: this.id,
      schema_version: SEARCH_SELECTION_SCHEMA_VERSION,
      kind: this.id,
      role: "parent-selection",
      productDefault: false,
      selectionPolicy40: SELECTION_POLICY_40,
      exploration: this.exploration,
      explorationMode: "c(t) decay",
      topK: this.topK,
      tau: this.tau,
    });
  }
}

export const StrongSearchAdapter = ProgressiveMcgsOptInAdapter;

export function createDefaultSearchSelectionPort(options: FixedUctSelectionOptions = {}): SearchSelectionPort {
  return new FixedUctSelectionAdapter(options);
}

export function createSearchSelectionPort(
  id: SearchSelectionAdapterId = DEFAULT_SEARCH_SELECTION_ID,
  options: SearchSelectionPortOptions = {},
): SearchSelectionPort {
  if (id === DEFAULT_SEARCH_SELECTION_ID) return new FixedUctSelectionAdapter(options);
  if (id === PROGRESSIVE_MCGS_OPT_IN_ID) return new ProgressiveMcgsOptInAdapter(options);
  throw new RangeError(`unknown SearchSelectionPort id: ${String(id)}`);
}
