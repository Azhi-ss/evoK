/**
 * W1 method-version search-stats isolation (ET-M1-SEA / #146).
 *
 * Visit / value rows are scoped to one method version. After a Method
 * Improvement version switch, old-version stats remain historical and must
 * not become the new version's search authority.
 *
 * Search owns structure. This module does not call ledger / hang / Broker,
 * does not change EXP Admission or Budget Gate predicates, and does not
 * treat Elite / MMD / near-dup / side-slot as Promotion keys.
 */
import { deepFreeze } from "../security-boundary";
import type { SearchParentCandidate } from "./search-selection-port";

const PROMOTION_KEY_FIELDS = [
  "mmd", "sideSlot", "side_slot", "sideSlotScore", "mmdScore", "score",
  "nearDup", "near_dup", "nearDupScore", "nearDuplicate", "diversity", "diversityScore",
  "eliteScore",
] as const;

export interface MethodVersionNodeStat {
  readonly nodeId: string;
  readonly visits: number;
  readonly value: number;
  readonly methodVersion: string;
  readonly parentVisits?: number;
}

export interface MethodVersionNodeStatInput {
  readonly nodeId: string;
  readonly visits: number;
  readonly value: number;
  readonly methodVersion?: string;
  readonly parentVisits?: number;
}

export interface MethodVersionSwitch {
  readonly from?: string;
  readonly to: string;
}

export type MethodVersionAdoptReason = "version_mismatch" | "no_active_version";

export interface MethodVersionAdoptDecision {
  readonly ok: boolean;
  readonly outcome: "pass" | "refuse";
  readonly reason?: MethodVersionAdoptReason;
  readonly objections: readonly string[];
  readonly authorityVersion?: string;
}

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

function assertNoPromotionKeys(value: object, label: string): void {
  for (const field of PROMOTION_KEY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      throw new TypeError(`${label} must not emit Elite / MMD / near-dup / side-slot promotion keys`);
    }
  }
}

function normalizeVersion(value: unknown): string {
  nonEmpty("methodVersion", value);
  return value.trim();
}

function freezeStat(stat: MethodVersionNodeStat): MethodVersionNodeStat {
  assertNoPromotionKeys(stat, "method-version stat");
  return deepFreeze(stat) as MethodVersionNodeStat;
}

function freezeRows(rows: readonly MethodVersionNodeStat[]): readonly MethodVersionNodeStat[] {
  return Object.freeze(rows.map((row) => freezeStat({ ...row })));
}

function freezeDecision(input: {
  readonly ok: boolean;
  readonly outcome: "pass" | "refuse";
  readonly reason?: MethodVersionAdoptReason;
  readonly objections?: readonly string[];
  readonly authorityVersion?: string;
}): MethodVersionAdoptDecision {
  const decision = {
    ok: input.ok,
    outcome: input.outcome,
    objections: Object.freeze([...(input.objections ?? [])]),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.authorityVersion === undefined ? {} : { authorityVersion: input.authorityVersion }),
  };
  assertNoPromotionKeys(decision, "method-version adopt");
  return deepFreeze(decision) as MethodVersionAdoptDecision;
}

export class MethodVersionStats {
  private active: string | undefined;
  private readonly byVersion = new Map<string, MethodVersionNodeStat[]>();

  switchTo(methodVersion: string): MethodVersionSwitch {
    const to = normalizeVersion(methodVersion);
    const from = this.active;
    this.active = to;
    if (!this.byVersion.has(to)) this.byVersion.set(to, []);
    return deepFreeze({
      ...(from === undefined ? {} : { from }),
      to,
    }) as MethodVersionSwitch;
  }

  record(input: MethodVersionNodeStatInput): MethodVersionNodeStat {
    if (this.active === undefined) {
      throw new RangeError("method-version stats have no active version; switchTo before record");
    }
    if (!isPlainRecord(input)) throw new TypeError("method-version stat must be an ordinary object");
    assertNoPromotionKeys(input, "method-version stat");
    nonEmpty("nodeId", input.nodeId);
    finiteNonNegative("visits", input.visits);
    finiteNumber("value", input.value);
    if (input.parentVisits !== undefined) finiteNonNegative("parentVisits", input.parentVisits);
    if (input.methodVersion !== undefined) {
      const declared = normalizeVersion(input.methodVersion);
      if (declared !== this.active) {
        throw new RangeError("cannot record another method@version as the active authority");
      }
    }
    const stat = freezeStat({
      nodeId: input.nodeId,
      visits: input.visits,
      value: input.value,
      methodVersion: this.active,
      ...(input.parentVisits === undefined ? {} : { parentVisits: input.parentVisits }),
    });
    const rows = this.byVersion.get(this.active) ?? [];
    const index = rows.findIndex((row) => row.nodeId === stat.nodeId);
    if (index === -1) rows.push(stat);
    else rows[index] = stat;
    this.byVersion.set(this.active, rows);
    return stat;
  }

  activeVersion(): string | undefined {
    return this.active;
  }

  authority(): readonly MethodVersionNodeStat[] {
    if (this.active === undefined) return Object.freeze([]);
    return freezeRows(this.byVersion.get(this.active) ?? []);
  }

  history(methodVersion: string): readonly MethodVersionNodeStat[] {
    return freezeRows(this.byVersion.get(normalizeVersion(methodVersion)) ?? []);
  }

  adoptAsAuthority(methodVersion: string): MethodVersionAdoptDecision {
    const requested = normalizeVersion(methodVersion);
    if (this.active === undefined) {
      return freezeDecision({
        ok: false,
        outcome: "refuse",
        reason: "no_active_version",
        objections: ["no active method version; old-version stats are not authority"],
      });
    }
    if (requested !== this.active) {
      return freezeDecision({
        ok: false,
        outcome: "refuse",
        reason: "version_mismatch",
        objections: [
          `old-version stats for ${requested} must not become ${this.active} authority`,
        ],
        authorityVersion: this.active,
      });
    }
    return freezeDecision({
      ok: true,
      outcome: "pass",
      authorityVersion: this.active,
    });
  }

  toParentCandidates(): readonly SearchParentCandidate[] {
    return Object.freeze(this.authority().map((row) => deepFreeze({
      nodeId: row.nodeId,
      visits: row.visits,
      value: row.value,
      ...(row.parentVisits === undefined ? {} : { parentVisits: row.parentVisits }),
    }) as SearchParentCandidate));
  }
}

export function createMethodVersionStats(): MethodVersionStats {
  return new MethodVersionStats();
}
