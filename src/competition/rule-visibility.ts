/**
 * RuleVisibilityPolicy: per-competition "which rules go to whom". Physical
 * home: `src/competition/` — the policy is competition-defined and bound to a
 * CompetitionContract by digest.
 *
 * The policy lists, per short-lived agent role, which safe rule-summary
 * fields may be injected into that role's context. The catalog
 * (RULE_SUMMARY_FIELDS) is closed: a field not in the catalog is rejected,
 * so credentials, hidden data, budgets, raw resource requirements, and full
 * rule bodies can never be allowlisted. A role absent from `allow` gets an
 * empty summary — rules are never broadcast.
 */
import { deepFreeze, digestValue } from "../execution/security-boundary";
import type { CompetitionContract } from "./competition-contract";
import { validateCompetitionContract } from "./competition-contract";

export const RULE_VISIBILITY_SCHEMA = "evok.rule-visibility/v1" as const;

/** Short-lived agent audiences. Executor/Evaluator are trusted and not governed here. */
export const RULE_AUDIENCE_ROLES = ["researcher", "critic", "reviewer"] as const;
export type RuleAudienceRole = (typeof RULE_AUDIENCE_ROLES)[number];

/**
 * Closed catalog of rule fields that may ever be summarized to an agent.
 * Deliberately excludes `resources.*` (typed requirements stay with the
 * broker/checkHostCapabilities), any credential, hidden/holdout data, budget,
 * or free-form rules body.
 */
export const RULE_SUMMARY_FIELDS = [
  "title",
  "objective",
  "scoring.metric",
  "scoring.direction",
  "dataSplit.kind",
  "dataSplit.folds",
  "dataSplit.purge",
  "dataSplit.embargo",
  "dataSplit.holdout",
  "submission.format",
  "submission.maxPerDay",
  "limits.timeLimitMs",
  "limits.network",
] as const;
export type RuleSummaryField = (typeof RULE_SUMMARY_FIELDS)[number];

export interface RuleVisibilityPolicyInput {
  readonly competitionId: string;
  /** Digest of the CompetitionContract this policy interprets. */
  readonly contractDigest: string;
  readonly allow: Partial<Record<RuleAudienceRole, readonly string[]>>;
}

export interface RuleVisibilityPolicy extends RuleVisibilityPolicyInput {
  readonly schema: typeof RULE_VISIBILITY_SCHEMA;
  readonly digest: string;
}

export class RuleVisibilityError extends Error {
  readonly kind = "rule-visibility" as const;
  constructor(message: string) {
    super(message);
    this.name = "RuleVisibilityError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const CATALOG = new Set<string>(RULE_SUMMARY_FIELDS);

function validateAllow(allow: unknown): asserts allow is Partial<Record<RuleAudienceRole, readonly string[]>> {
  if (!isRecord(allow)) throw new RuleVisibilityError("rule visibility allow must be an object");
  for (const [role, fields] of Object.entries(allow)) {
    if (!(RULE_AUDIENCE_ROLES as readonly string[]).includes(role)) {
      throw new RuleVisibilityError(`rule visibility role must be one of ${RULE_AUDIENCE_ROLES.join(", ")}`);
    }
    if (!Array.isArray(fields) || fields.some((field) => typeof field !== "string")) {
      throw new RuleVisibilityError(`rule visibility allow.${role} must be an array of field names`);
    }
    for (const field of fields) {
      if (!CATALOG.has(field)) {
        throw new RuleVisibilityError(`rule field "${field}" is not in the safe summary catalog and cannot be injected`);
      }
    }
  }
}

/** Creates a frozen, content-addressed policy. Unknown roles/fields fail closed. */
export function createRuleVisibilityPolicy(input: RuleVisibilityPolicyInput): RuleVisibilityPolicy {
  if (typeof input.competitionId !== "string" || input.competitionId.trim() === "") {
    throw new RuleVisibilityError("rule visibility competitionId is required");
  }
  if (typeof input.contractDigest !== "string" || input.contractDigest === "") {
    throw new RuleVisibilityError("rule visibility contractDigest is required");
  }
  validateAllow(input.allow);
  return deepFreeze({ schema: RULE_VISIBILITY_SCHEMA, ...input, digest: ruleVisibilityDigest(input) });
}

export function ruleVisibilityDigest(input: RuleVisibilityPolicyInput): string {
  return digestValue({ schema: RULE_VISIBILITY_SCHEMA, ...input });
}

/** Validates a persisted policy: shape, closed catalog, and content digest. */
export function validateRuleVisibilityPolicy(raw: unknown): RuleVisibilityPolicy {
  if (!isRecord(raw)) throw new RuleVisibilityError("rule visibility policy must be an object");
  if (raw.schema !== RULE_VISIBILITY_SCHEMA) throw new RuleVisibilityError(`rule visibility schema must be ${RULE_VISIBILITY_SCHEMA}`);
  if (typeof raw.digest !== "string" || raw.digest === "") throw new RuleVisibilityError("rule visibility digest is required");
  if (typeof raw.competitionId !== "string" || raw.competitionId.trim() === "") {
    throw new RuleVisibilityError("rule visibility competitionId is required");
  }
  if (typeof raw.contractDigest !== "string" || raw.contractDigest === "") {
    throw new RuleVisibilityError("rule visibility contractDigest is required");
  }
  validateAllow(raw.allow);
  const { digest, ...body } = raw;
  if (digestValue(body) !== digest) throw new RuleVisibilityError("rule visibility digest mismatch");
  return deepFreeze(raw as unknown as RuleVisibilityPolicy);
}

function pathValue(source: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = source;
  for (const segment of path.split(".")) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/**
 * Picks the rule summary for one role from a validated contract under a
 * validated policy. The policy must be bound to this exact contract
 * (competitionId + digest); a role without an entry gets an empty summary.
 * Only scalar values are picked; missing contract fields are skipped.
 */
export function summarizeRulesForRole(
  contract: CompetitionContract,
  policy: RuleVisibilityPolicy,
  role: RuleAudienceRole,
): Readonly<Record<string, unknown>> {
  const validatedContract = validateCompetitionContract(contract);
  const validatedPolicy = validateRuleVisibilityPolicy(policy);
  if (validatedPolicy.competitionId !== validatedContract.competitionId) {
    throw new RuleVisibilityError("rule visibility policy competitionId does not match the contract");
  }
  if (validatedPolicy.contractDigest !== validatedContract.digest) {
    throw new RuleVisibilityError("rule visibility policy contractDigest does not match the contract");
  }
  const fields = validatedPolicy.allow[role] ?? [];
  const summary: Record<string, unknown> = {};
  for (const field of fields) {
    const value = pathValue(validatedContract as unknown as Record<string, unknown>, field);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      summary[field] = value;
    }
  }
  return deepFreeze(summary);
}
