/**
 * Optional task-level SearchSpaceProfile + near-dup detection (S1 / #54).
 *
 * Binding is `diagnostic_only`: feature extraction and near-dup hits never
 * change select_node / default inner A (tree+fixed_uct) or #40 SelectionPolicy.
 * No profile is a no-op. Missing dims are inconclusive — never silent
 * "diversity ok". Diagnostic artifacts enter Hypothesis `evidence_refs` only
 * after T48 mapping. MMD (S2 / #58) and side-slot adapters (#59) are out of scope.
 */
import { deepFreeze, digestValue } from "./security-boundary";
import {
  T48MappedCatalog,
  type T48MappedRef,
} from "./hypothesis-ledger";

export const SEARCH_SPACE_BINDING = "diagnostic_only" as const;
export type SearchSpaceBindingMode = typeof SEARCH_SPACE_BINDING;

export interface FeatureDim {
  readonly name: string;
}

export interface NearDupRule {
  readonly maxDistance: number;
}

export interface SearchSpaceProfile {
  readonly featureDims: readonly FeatureDim[];
  readonly nearDup: NearDupRule;
}

export interface SearchSpaceCandidate {
  readonly candidateId: string;
  readonly features?: Readonly<Record<string, number | string | boolean | undefined>>;
}

export interface SearchSpaceBinding {
  readonly taskId: string;
  readonly mode: SearchSpaceBindingMode;
  readonly profile?: SearchSpaceProfile;
}

export interface ExtractedSearchFeatures {
  readonly values: Readonly<Record<string, number>>;
  readonly missing: readonly string[];
}

export interface NearDupHit {
  readonly leftId: string;
  readonly rightId: string;
  readonly distance: number;
  readonly dims: readonly string[];
}

export type NearDupStatus = "hits" | "clear" | "inconclusive" | "skipped";

export interface NearDupDiagnosis {
  readonly binding: SearchSpaceBindingMode;
  readonly taskId: string;
  readonly status: NearDupStatus;
  readonly hits: readonly NearDupHit[];
  readonly missingDims: readonly string[];
  readonly diversityOk?: false;
}

export interface SearchSpaceArtifact {
  readonly artifactId: string;
  readonly digest: string;
  readonly kind: "near_dup_diagnosis";
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

function finiteNonNegative(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be finite and >= 0`);
  }
}

function normalizeProfile(value: SearchSpaceProfile): SearchSpaceProfile {
  if (!isPlainRecord(value) || !Array.isArray(value.featureDims) || !isPlainRecord(value.nearDup)) {
    throw new TypeError("SearchSpaceProfile must declare featureDims and nearDup");
  }
  finiteNonNegative("nearDup.maxDistance", value.nearDup.maxDistance);
  const names = new Set<string>();
  const featureDims = value.featureDims.map((dim) => {
    if (!isPlainRecord(dim)) throw new TypeError("feature dim must be an ordinary object");
    nonEmpty("feature dim name", dim.name);
    if (names.has(dim.name)) throw new RangeError(`duplicate feature dim: ${dim.name}`);
    names.add(dim.name);
    return Object.freeze({ name: dim.name });
  });
  if (featureDims.length === 0) throw new RangeError("SearchSpaceProfile requires at least one feature dim");
  return deepFreeze({
    featureDims,
    nearDup: { maxDistance: value.nearDup.maxDistance },
  }) as SearchSpaceProfile;
}

export function bindSearchSpace(input: {
  readonly taskId: string;
  readonly profile?: SearchSpaceProfile;
  readonly mode?: SearchSpaceBindingMode;
}): SearchSpaceBinding {
  if (!isPlainRecord(input)) throw new TypeError("search-space binding must be an ordinary object");
  nonEmpty("taskId", input.taskId);
  const mode = input.mode ?? SEARCH_SPACE_BINDING;
  if (mode !== SEARCH_SPACE_BINDING) {
    throw new RangeError("SearchSpaceProfile binding must be diagnostic_only");
  }
  const profile = input.profile === undefined ? undefined : normalizeProfile(input.profile);
  return deepFreeze({
    taskId: input.taskId,
    mode: SEARCH_SPACE_BINDING,
    ...(profile === undefined ? {} : { profile }),
  }) as SearchSpaceBinding;
}

export function extractSearchFeatures(
  profile: SearchSpaceProfile,
  candidate: SearchSpaceCandidate,
): ExtractedSearchFeatures {
  const normalized = normalizeProfile(profile);
  if (!isPlainRecord(candidate)) throw new TypeError("search candidate must be an ordinary object");
  nonEmpty("candidateId", candidate.candidateId);
  const source = isPlainRecord(candidate.features) ? candidate.features : {};
  const values: Record<string, number> = {};
  const missing: string[] = [];
  for (const dim of normalized.featureDims) {
    const raw = source[dim.name];
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      missing.push(dim.name);
      continue;
    }
    values[dim.name] = raw;
  }
  return deepFreeze({ values, missing }) as ExtractedSearchFeatures;
}

function l2(left: Readonly<Record<string, number>>, right: Readonly<Record<string, number>>, dims: readonly string[]): number {
  let sum = 0;
  for (const dim of dims) {
    const delta = left[dim]! - right[dim]!;
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

export function diagnoseNearDup(
  binding: SearchSpaceBinding,
  candidates: readonly SearchSpaceCandidate[],
): NearDupDiagnosis {
  if (!isPlainRecord(binding) || binding.mode !== SEARCH_SPACE_BINDING) {
    throw new RangeError("SearchSpaceProfile binding must be diagnostic_only");
  }
  nonEmpty("taskId", binding.taskId);
  if (!Array.isArray(candidates)) throw new TypeError("candidates must be an array");
  if (binding.profile === undefined) {
    return deepFreeze({
      binding: SEARCH_SPACE_BINDING,
      taskId: binding.taskId,
      status: "skipped",
      hits: [],
      missingDims: [],
    }) as NearDupDiagnosis;
  }
  const profile = normalizeProfile(binding.profile);
  const extracted = candidates.map((candidate) => {
    const features = extractSearchFeatures(profile, candidate);
    return { candidateId: candidate.candidateId, features };
  });
  const ids = new Set<string>();
  for (const entry of extracted) {
    if (ids.has(entry.candidateId)) throw new RangeError(`duplicate candidate: ${entry.candidateId}`);
    ids.add(entry.candidateId);
  }
  const missingDims = [...new Set(extracted.flatMap((entry) => [...entry.features.missing]))];
  if (missingDims.length > 0) {
    return deepFreeze({
      binding: SEARCH_SPACE_BINDING,
      taskId: binding.taskId,
      status: "inconclusive",
      hits: [],
      missingDims,
      diversityOk: false,
    }) as NearDupDiagnosis;
  }
  const dims = profile.featureDims.map((dim) => dim.name);
  const hits: NearDupHit[] = [];
  for (let i = 0; i < extracted.length; i += 1) {
    for (let j = i + 1; j < extracted.length; j += 1) {
      const distance = l2(extracted[i]!.features.values, extracted[j]!.features.values, dims);
      if (distance <= profile.nearDup.maxDistance) {
        hits.push({
          leftId: extracted[i]!.candidateId,
          rightId: extracted[j]!.candidateId,
          distance,
          dims,
        });
      }
    }
  }
  return deepFreeze({
    binding: SEARCH_SPACE_BINDING,
    taskId: binding.taskId,
    status: hits.length > 0 ? "hits" : "clear",
    hits,
    missingDims: [],
  }) as NearDupDiagnosis;
}

export function mapSearchSpaceEvidence(
  catalog: T48MappedCatalog,
  values: readonly unknown[],
): readonly T48MappedRef[] {
  return catalog.mapAll(values);
}

export function attachSearchSpaceDiagnosis(input: {
  readonly catalog: T48MappedCatalog;
  readonly diagnosis: NearDupDiagnosis;
}): {
  readonly catalog: T48MappedCatalog;
  readonly artifact: SearchSpaceArtifact;
  readonly mapped: readonly T48MappedRef[];
} {
  if (!isPlainRecord(input) || !(input.catalog instanceof T48MappedCatalog)) {
    throw new TypeError("attachSearchSpaceDiagnosis requires a T48MappedCatalog");
  }
  if (!isPlainRecord(input.diagnosis) || input.diagnosis.binding !== SEARCH_SPACE_BINDING) {
    throw new RangeError("diagnosis binding must be diagnostic_only");
  }
  const digest = digestValue({
    binding: input.diagnosis.binding,
    taskId: input.diagnosis.taskId,
    status: input.diagnosis.status,
    hits: input.diagnosis.hits,
    missingDims: input.diagnosis.missingDims,
  });
  const artifact = deepFreeze({
    artifactId: `near-dup:${input.diagnosis.taskId}:${digest}`,
    digest,
    kind: "near_dup_diagnosis",
  }) as SearchSpaceArtifact;
  const catalog = input.catalog.withArtifacts([artifact]);
  return deepFreeze({
    catalog,
    artifact,
    mapped: catalog.mapAll([artifact.artifactId]),
  });
}
