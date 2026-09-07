/**
 * Optional task-level SearchSpaceProfile + near-dup (S1 / #54) and MMD
 * DiversityDiag (S2 / #58).
 *
 * Binding is `diagnostic_only`: feature extraction, near-dup hits, and MMD
 * windows never change select_node / default inner A (tree+fixed_uct) or #40
 * SelectionPolicy. Missing dims or unavailable MMD are inconclusive — never
 * silent "diversity ok". Diagnostic artifacts enter Hypothesis `evidence_refs`
 * only after T48 mapping. S3 is the outer read-only projection of those
 * already-mapped artifacts; it does not change gates or auto-kill.
 * Side-slot adapters remain out of scope.
 */
import { deepFreeze, digestValue } from "./security-boundary";
import {
  T48MappedCatalog,
  type Hypothesis,
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

export interface MmdKernel {
  readonly name: "rbf";
  readonly bandwidth: number;
  /** Fixed seed persisted on the dump so a run is reproducible; not an optimality claim. */
  readonly seed: number;
}

export interface MmdRule {
  readonly kernel: MmdKernel;
  readonly collapseThreshold: number;
  readonly windowSize?: number;
}

export interface SearchSpaceProfile {
  readonly featureDims: readonly FeatureDim[];
  readonly nearDup: NearDupRule;
  readonly mmd?: MmdRule;
}

export interface SearchSpaceCandidate {
  readonly candidateId: string;
  readonly features?: Readonly<Record<string, number | undefined>>;
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
  readonly kind: "near_dup_diagnosis" | "diversity_diag";
}

export type DiversityVerdict = "ok" | "collapse_suspected" | "inconclusive";

export interface DiversityDiag {
  readonly binding: SearchSpaceBindingMode;
  readonly taskId: string;
  readonly verdict: DiversityVerdict;
  readonly windowSize: number;
  readonly missingDims: readonly string[];
  readonly unavailable: readonly string[];
  readonly kernel?: MmdKernel;
  readonly mmd?: number;
  readonly collapseThreshold?: number;
  readonly diversityOk?: false;
}

export interface DiversityDiagDump extends DiversityDiag {
  readonly artifactId: string;
  readonly digest: string;
  readonly kind: "diversity_diag";
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

function finitePositive(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be finite and > 0`);
  }
}

function integerSeed(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new RangeError(`${name} must be an integer seed`);
  }
}

function normalizeMmd(value: unknown): MmdRule {
  if (!isPlainRecord(value) || !isPlainRecord(value.kernel)) {
    throw new TypeError("mmd must declare kernel and collapseThreshold");
  }
  if (value.kernel.name !== "rbf") {
    throw new RangeError("mmd.kernel.name must be rbf");
  }
  finitePositive("mmd.kernel.bandwidth", value.kernel.bandwidth);
  integerSeed("mmd.kernel.seed", value.kernel.seed);
  finiteNonNegative("mmd.collapseThreshold", value.collapseThreshold);
  const windowSize = value.windowSize;
  if (windowSize !== undefined) {
    if (typeof windowSize !== "number" || !Number.isInteger(windowSize) || windowSize < 2) {
      throw new RangeError("mmd.windowSize must be an integer >= 2");
    }
  }
  return deepFreeze({
    kernel: {
      name: "rbf" as const,
      bandwidth: value.kernel.bandwidth,
      seed: value.kernel.seed,
    },
    collapseThreshold: value.collapseThreshold,
    ...(windowSize === undefined ? {} : { windowSize }),
  }) as MmdRule;
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
  const mmd = value.mmd === undefined ? undefined : normalizeMmd(value.mmd);
  return deepFreeze({
    featureDims,
    nearDup: { maxDistance: value.nearDup.maxDistance },
    ...(mmd === undefined ? {} : { mmd }),
  }) as SearchSpaceProfile;
}

export function bindTaskSearchSpace(task: {
  readonly taskId: string;
  readonly searchSpaceProfile?: SearchSpaceProfile;
}): SearchSpaceBinding {
  if (!isPlainRecord(task)) throw new TypeError("task must be an ordinary object");
  return bindSearchSpace({ taskId: task.taskId, profile: task.searchSpaceProfile });
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

function vectorOf(values: Readonly<Record<string, number>>, dims: readonly string[]): number[] {
  return dims.map((dim) => values[dim]!);
}

function centroidOf(points: readonly number[][]): number[] {
  const dims = points[0]!.length;
  const out = Array<number>(dims).fill(0);
  for (const point of points) {
    for (let i = 0; i < dims; i += 1) out[i]! += point[i]!;
  }
  for (let i = 0; i < dims; i += 1) out[i]! /= points.length;
  return out;
}

function rbfKernel(left: readonly number[], right: readonly number[], bandwidth: number): number {
  let sum = 0;
  for (let i = 0; i < left.length; i += 1) {
    const delta = left[i]! - right[i]!;
    sum += delta * delta;
  }
  return Math.exp(-sum / (2 * bandwidth * bandwidth));
}

/** Unbiased Gretton MMD². Kernel/bandwidth are caller-configured; not claimed optimal. */
function mmd2Unbiased(left: readonly number[][], right: readonly number[][], bandwidth: number): number {
  const n = left.length;
  const m = right.length;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (i === j) continue;
      xx += rbfKernel(left[i]!, left[j]!, bandwidth);
    }
  }
  for (let i = 0; i < m; i += 1) {
    for (let j = 0; j < m; j += 1) {
      if (i === j) continue;
      yy += rbfKernel(right[i]!, right[j]!, bandwidth);
    }
  }
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < m; j += 1) {
      xy += rbfKernel(left[i]!, right[j]!, bandwidth);
    }
  }
  return xx / (n * (n - 1)) + yy / (m * (m - 1)) - 2 * xy / (n * m);
}

function inconclusiveDiversity(input: {
  readonly taskId: string;
  readonly windowSize: number;
  readonly missingDims?: readonly string[];
  readonly unavailable: readonly string[];
  readonly kernel?: MmdKernel;
  readonly collapseThreshold?: number;
}): DiversityDiag {
  return deepFreeze({
    binding: SEARCH_SPACE_BINDING,
    taskId: input.taskId,
    verdict: "inconclusive",
    windowSize: input.windowSize,
    missingDims: input.missingDims ?? [],
    unavailable: input.unavailable,
    diversityOk: false,
    ...(input.kernel === undefined ? {} : { kernel: input.kernel }),
    ...(input.collapseThreshold === undefined ? {} : { collapseThreshold: input.collapseThreshold }),
  }) as DiversityDiag;
}

export function diagnoseDiversity(
  binding: SearchSpaceBinding,
  window: readonly SearchSpaceCandidate[],
): DiversityDiag {
  if (!isPlainRecord(binding) || binding.mode !== SEARCH_SPACE_BINDING) {
    throw new RangeError("SearchSpaceProfile binding must be diagnostic_only");
  }
  nonEmpty("taskId", binding.taskId);
  if (!Array.isArray(window)) throw new TypeError("MMD window must be an array");
  if (binding.profile === undefined) {
    return inconclusiveDiversity({
      taskId: binding.taskId,
      windowSize: window.length,
      unavailable: ["profile"],
    });
  }
  const profile = normalizeProfile(binding.profile);
  if (profile.mmd === undefined) {
    return inconclusiveDiversity({
      taskId: binding.taskId,
      windowSize: window.length,
      unavailable: ["mmd"],
    });
  }
  const mmdRule = profile.mmd;
  const requiredSize = mmdRule.windowSize;
  const sliced = requiredSize === undefined ? window : window.slice(-requiredSize);
  if (sliced.length < 2 || (requiredSize !== undefined && sliced.length < requiredSize)) {
    return inconclusiveDiversity({
      taskId: binding.taskId,
      windowSize: sliced.length,
      unavailable: ["window"],
      kernel: mmdRule.kernel,
      collapseThreshold: mmdRule.collapseThreshold,
    });
  }
  const extracted = sliced.map((candidate) => {
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
    return inconclusiveDiversity({
      taskId: binding.taskId,
      windowSize: sliced.length,
      missingDims,
      unavailable: ["features"],
      kernel: mmdRule.kernel,
      collapseThreshold: mmdRule.collapseThreshold,
    });
  }
  const dims = profile.featureDims.map((dim) => dim.name);
  const points = extracted.map((entry) => vectorOf(entry.features.values, dims));
  const center = centroidOf(points);
  const reference = points.map(() => center);
  const raw = mmd2Unbiased(points, reference, mmdRule.kernel.bandwidth);
  if (!Number.isFinite(raw)) {
    return inconclusiveDiversity({
      taskId: binding.taskId,
      windowSize: sliced.length,
      unavailable: ["mmd"],
      kernel: mmdRule.kernel,
      collapseThreshold: mmdRule.collapseThreshold,
    });
  }
  const mmd = Math.max(0, raw);
  const verdict: DiversityVerdict = mmd <= mmdRule.collapseThreshold ? "collapse_suspected" : "ok";
  return deepFreeze({
    binding: SEARCH_SPACE_BINDING,
    taskId: binding.taskId,
    verdict,
    windowSize: sliced.length,
    missingDims: [],
    unavailable: [],
    kernel: mmdRule.kernel,
    mmd,
    collapseThreshold: mmdRule.collapseThreshold,
  }) as DiversityDiag;
}

function diversityPayload(diag: DiversityDiag): Record<string, unknown> {
  return {
    binding: diag.binding,
    taskId: diag.taskId,
    verdict: diag.verdict,
    windowSize: diag.windowSize,
    missingDims: diag.missingDims,
    unavailable: diag.unavailable,
    ...(diag.kernel === undefined ? {} : { kernel: diag.kernel }),
    ...(diag.mmd === undefined ? {} : { mmd: diag.mmd }),
    ...(diag.collapseThreshold === undefined ? {} : { collapseThreshold: diag.collapseThreshold }),
  };
}

export function dumpDiversityDiag(diag: DiversityDiag): DiversityDiagDump {
  if (!isPlainRecord(diag) || diag.binding !== SEARCH_SPACE_BINDING) {
    throw new RangeError("DiversityDiag binding must be diagnostic_only");
  }
  nonEmpty("taskId", diag.taskId);
  const digest = digestValue(diversityPayload(diag));
  return deepFreeze({
    ...diversityPayload(diag),
    artifactId: `diversity:${diag.taskId}:${digest}`,
    digest,
    kind: "diversity_diag",
    ...(diag.diversityOk === false ? { diversityOk: false } : {}),
  }) as DiversityDiagDump;
}

export function attachDiversityDiag(input: {
  readonly catalog: T48MappedCatalog;
  readonly diag: DiversityDiag;
}): {
  readonly catalog: T48MappedCatalog;
  readonly artifact: SearchSpaceArtifact;
  readonly mapped: readonly T48MappedRef[];
  readonly dump: DiversityDiagDump;
} {
  if (!isPlainRecord(input) || !(input.catalog instanceof T48MappedCatalog)) {
    throw new TypeError("attachDiversityDiag requires a T48MappedCatalog");
  }
  const dump = dumpDiversityDiag(input.diag);
  const artifact = deepFreeze({
    artifactId: dump.artifactId,
    digest: dump.digest,
    kind: "diversity_diag",
  }) as SearchSpaceArtifact;
  const catalog = input.catalog.withArtifacts([artifact]);
  return deepFreeze({
    catalog,
    artifact,
    dump,
    mapped: catalog.mapAll([artifact.artifactId]),
  });
}

export function mapSearchSpaceEvidence(
  catalog: T48MappedCatalog,
  values: readonly unknown[],
): readonly T48MappedRef[] {
  return catalog.mapAll(values);
}

function isSearchSpaceAttachResult(value: unknown): value is {
  readonly artifact: SearchSpaceArtifact;
} {
  return isPlainRecord(value) && isPlainRecord(value.artifact) && typeof value.artifact.artifactId === "string";
}

function isMappedSearchSpaceSource(value: unknown): value is { readonly artifactId: string } {
  return isPlainRecord(value) && typeof value.artifactId === "string" && value.artifactId.trim() !== "";
}

function isRawSearchSpaceDiagnosis(value: unknown): boolean {
  if (!isPlainRecord(value) || isMappedSearchSpaceSource(value) || isSearchSpaceAttachResult(value)) return false;
  if (typeof value.id === "string") return false;
  const statusLike = value.status === "hits" || value.status === "clear" || value.status === "inconclusive" || value.status === "skipped";
  const verdictLike = value.verdict === "ok" || value.verdict === "collapse_suspected" || value.verdict === "inconclusive";
  return value.binding === SEARCH_SPACE_BINDING && (statusLike || verdictLike);
}

function normalizeSearchSpaceSource(value: unknown): unknown {
  if (isRawSearchSpaceDiagnosis(value)) {
    throw new Error("unmapped DiversityDiag / near-dup diagnosis cannot enter evidence_refs");
  }
  if (isSearchSpaceAttachResult(value)) return value.artifact.artifactId;
  if (isPlainRecord(value) && isPlainRecord(value.dump) && typeof value.dump.artifactId === "string") {
    return value.dump.artifactId;
  }
  if (isMappedSearchSpaceSource(value)) return value.artifactId;
  return value;
}

/**
 * Outer read-only mapping of already T48-mapped DiversityDiag / near-dup
 * artifacts into Hypothesis `evidence_refs`. Raw diagnoses, unknown ids, and
 * side-slot / MMD scalars are rejected. Does not write gates or status.
 */
export function readSearchSpaceEvidenceRefs(
  catalog: T48MappedCatalog,
  sources: readonly unknown[],
): readonly T48MappedRef[] {
  if (!(catalog instanceof T48MappedCatalog)) {
    throw new TypeError("readSearchSpaceEvidenceRefs requires a T48MappedCatalog");
  }
  if (!Array.isArray(sources)) throw new TypeError("search-space evidence refs must be an array");
  return mapSearchSpaceEvidence(catalog, sources.map(normalizeSearchSpaceSource));
}

/**
 * Read-only Hypothesis projection: attach mapped search-space refs without
 * appending ledger events, changing status, or calling search ports.
 */
export function projectHypothesisSearchSpaceRefs(input: {
  readonly catalog: T48MappedCatalog;
  readonly hypothesis: Hypothesis;
  readonly sources: readonly unknown[];
}): Hypothesis {
  if (!isPlainRecord(input) || !(input.catalog instanceof T48MappedCatalog)) {
    throw new TypeError("projectHypothesisSearchSpaceRefs requires a T48MappedCatalog");
  }
  if (!isPlainRecord(input.hypothesis)) throw new TypeError("hypothesis must be an ordinary object");
  nonEmpty("hypothesisId", input.hypothesis.hypothesisId);
  const extra = readSearchSpaceEvidenceRefs(input.catalog, input.sources);
  const seen = new Set(input.hypothesis.evidenceRefs.map((ref) => `${ref.kind}:${ref.id}`));
  const merged = [...input.hypothesis.evidenceRefs];
  for (const ref of extra) {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(ref);
  }
  return deepFreeze({
    hypothesisId: input.hypothesis.hypothesisId,
    statement: input.hypothesis.statement,
    status: input.hypothesis.status,
    evidenceRefs: merged,
    killTestPlanIds: [...input.hypothesis.killTestPlanIds],
    ...(input.hypothesis.supersededBy === undefined ? {} : { supersededBy: input.hypothesis.supersededBy }),
  }) as Hypothesis;
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
