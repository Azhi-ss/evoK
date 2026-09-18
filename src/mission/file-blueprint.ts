import { deepFreeze, digestValue } from "../security-boundary";

/** Minimal Ravi-style workspace file set. Optional kinds are documented but not required to Stop. */
export const BLUEPRINT_FILE_KINDS = ["GOAL", "RULES", "EXPERIMENTS", "SCOREBOARD"] as const;
export type BlueprintFileKind = (typeof BLUEPRINT_FILE_KINDS)[number];

export const REQUIRED_STOP_FILES = ["GOAL", "SCOREBOARD"] as const satisfies readonly BlueprintFileKind[];

export interface GoalFile {
  readonly kind: "GOAL";
  readonly objective: string;
  readonly successCriteria: readonly string[];
  readonly constraints?: readonly string[];
}

export interface RulesFile {
  readonly kind: "RULES";
  readonly competitionId?: string;
  readonly allowed: readonly string[];
  readonly forbidden: readonly string[];
  readonly evaluationContractRef?: string;
}

export interface ExperimentLogEntry {
  readonly experimentId: string;
  readonly hypothesis: string;
  readonly candidateRef?: string;
  readonly evidenceRefs: readonly string[];
  readonly outcome: string;
  readonly recordedAt?: number;
}

export interface ExperimentsFile {
  readonly kind: "EXPERIMENTS";
  readonly entries: readonly ExperimentLogEntry[];
}

export interface ScoreboardRow {
  readonly candidateId: string;
  readonly metric: string;
  readonly value: number;
  readonly evaluationRef: string;
  readonly evidenceRefs: readonly string[];
}

export interface ScoreboardFile {
  readonly kind: "SCOREBOARD";
  readonly rows: readonly ScoreboardRow[];
  readonly championRef?: string;
}

export type BlueprintFile = GoalFile | RulesFile | ExperimentsFile | ScoreboardFile;

export interface BlueprintFileRef {
  readonly kind: BlueprintFileKind;
  readonly artifactId: string;
  readonly digest: string;
  readonly address?: string;
  readonly evidenceRefs: readonly string[];
}

export type CrossReviewPhase = "author" | "reviewer";

export interface CrossReviewRecord {
  readonly reviewId: string;
  readonly phase: CrossReviewPhase;
  readonly artifactId: string;
  readonly digest: string;
  readonly address?: string;
  readonly subjectRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly findings: readonly string[];
  /** Cross-review is advisory Evidence. It never scores, promotes, or stops a Mission. */
  readonly authoritative: false;
}

export interface MissionBlueprint {
  readonly files: Readonly<Partial<Record<BlueprintFileKind, BlueprintFileRef>>>;
  readonly crossReviews: readonly CrossReviewRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function strings(name: string, value: readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "") || new Set(value).size !== value.length) {
    throw new TypeError(`${name} must contain unique, non-empty strings`);
  }
  return [...value];
}

export function emptyBlueprint(): MissionBlueprint {
  return deepFreeze({ files: {}, crossReviews: [] }) as MissionBlueprint;
}

export function missingStopFiles(blueprint: MissionBlueprint | undefined): readonly BlueprintFileKind[] {
  const files = blueprint?.files ?? {};
  return REQUIRED_STOP_FILES.filter((kind) => files[kind] === undefined);
}

export function assertBlueprintAllowsStop(blueprint: MissionBlueprint | undefined): void {
  const missing = missingStopFiles(blueprint);
  if (missing.length > 0) {
    throw new Error(`Stop requires committed ${missing.join(" and ")} files`);
  }
}

export function blueprintFileDigest(file: BlueprintFile): string {
  return digestValue(file);
}

export function blueprintArtifactId(kind: BlueprintFileKind): string {
  return `blueprint:${kind}`;
}

export function toBlueprintArtifact(ref: { readonly artifactId: string; readonly digest: string; readonly address?: string }): { readonly artifactId: string; readonly digest: string; readonly address?: string } {
  return deepFreeze({
    artifactId: ref.artifactId,
    digest: ref.digest,
    ...(ref.address === undefined ? {} : { address: ref.address }),
  });
}

export function normalizeGoalFile(value: unknown): GoalFile {
  if (!isRecord(value)) throw new TypeError("GOAL must be an ordinary object");
  if (value.kind !== "GOAL") throw new RangeError("GOAL kind must be GOAL");
  nonEmpty("GOAL objective", value.objective);
  const successCriteria = strings("GOAL successCriteria", value.successCriteria as string[] | undefined);
  if (successCriteria.length === 0) throw new Error("GOAL requires successCriteria");
  const constraints = strings("GOAL constraints", value.constraints as string[] | undefined);
  return deepFreeze({
    kind: "GOAL",
    objective: value.objective,
    successCriteria,
    ...(constraints.length === 0 ? {} : { constraints }),
  }) as GoalFile;
}

export function normalizeRulesFile(value: unknown): RulesFile {
  if (!isRecord(value)) throw new TypeError("RULES must be an ordinary object");
  if (value.kind !== "RULES") throw new RangeError("RULES kind must be RULES");
  if (value.competitionId !== undefined) nonEmpty("RULES competitionId", value.competitionId);
  const allowed = strings("RULES allowed", value.allowed as string[] | undefined);
  const forbidden = strings("RULES forbidden", value.forbidden as string[] | undefined);
  if (value.evaluationContractRef !== undefined) nonEmpty("RULES evaluationContractRef", value.evaluationContractRef);
  return deepFreeze({
    kind: "RULES",
    allowed,
    forbidden,
    ...(value.competitionId === undefined ? {} : { competitionId: value.competitionId }),
    ...(value.evaluationContractRef === undefined ? {} : { evaluationContractRef: value.evaluationContractRef }),
  }) as RulesFile;
}

export function normalizeExperimentsFile(value: unknown): ExperimentsFile {
  if (!isRecord(value)) throw new TypeError("EXPERIMENTS must be an ordinary object");
  if (value.kind !== "EXPERIMENTS") throw new RangeError("EXPERIMENTS kind must be EXPERIMENTS");
  if (!Array.isArray(value.entries)) throw new TypeError("EXPERIMENTS entries must be an array");
  const ids = new Set<string>();
  const entries = value.entries.map((entry) => {
    if (!isRecord(entry)) throw new TypeError("experiment log entry must be an ordinary object");
    nonEmpty("experimentId", entry.experimentId);
    if (ids.has(entry.experimentId)) throw new RangeError(`duplicate experimentId: ${entry.experimentId}`);
    ids.add(entry.experimentId);
    nonEmpty("experiment hypothesis", entry.hypothesis);
    nonEmpty("experiment outcome", entry.outcome);
    if (entry.candidateRef !== undefined) nonEmpty("experiment candidateRef", entry.candidateRef);
    const evidenceRefs = strings("experiment evidenceRefs", entry.evidenceRefs as string[] | undefined);
    if (entry.recordedAt !== undefined && (typeof entry.recordedAt !== "number" || !Number.isFinite(entry.recordedAt))) {
      throw new TypeError("experiment recordedAt must be a finite number");
    }
    return deepFreeze({
      experimentId: entry.experimentId,
      hypothesis: entry.hypothesis,
      evidenceRefs,
      outcome: entry.outcome,
      ...(entry.candidateRef === undefined ? {} : { candidateRef: entry.candidateRef }),
      ...(entry.recordedAt === undefined ? {} : { recordedAt: entry.recordedAt }),
    }) as ExperimentLogEntry;
  });
  return deepFreeze({ kind: "EXPERIMENTS", entries }) as ExperimentsFile;
}

export function normalizeScoreboardFile(value: unknown): ScoreboardFile {
  if (!isRecord(value)) throw new TypeError("SCOREBOARD must be an ordinary object");
  if (value.kind !== "SCOREBOARD") throw new RangeError("SCOREBOARD kind must be SCOREBOARD");
  if (!Array.isArray(value.rows)) throw new TypeError("SCOREBOARD rows must be an array");
  if (value.championRef !== undefined) nonEmpty("SCOREBOARD championRef", value.championRef);
  const rows = value.rows.map((row) => {
    if (!isRecord(row)) throw new TypeError("SCOREBOARD row must be an ordinary object");
    nonEmpty("SCOREBOARD candidateId", row.candidateId);
    nonEmpty("SCOREBOARD metric", row.metric);
    if (typeof row.value !== "number" || !Number.isFinite(row.value)) throw new TypeError("SCOREBOARD value must be a finite number");
    nonEmpty("SCOREBOARD evaluationRef", row.evaluationRef);
    const evidenceRefs = strings("SCOREBOARD evidenceRefs", row.evidenceRefs as string[] | undefined);
    return deepFreeze({
      candidateId: row.candidateId,
      metric: row.metric,
      value: row.value,
      evaluationRef: row.evaluationRef,
      evidenceRefs,
    }) as ScoreboardRow;
  });
  return deepFreeze({
    kind: "SCOREBOARD",
    rows,
    ...(value.championRef === undefined ? {} : { championRef: value.championRef }),
  }) as ScoreboardFile;
}

export function normalizeBlueprintFile(value: unknown): BlueprintFile {
  if (!isRecord(value)) throw new TypeError("blueprint file must be an ordinary object");
  switch (value.kind) {
    case "GOAL": return normalizeGoalFile(value);
    case "RULES": return normalizeRulesFile(value);
    case "EXPERIMENTS": return normalizeExperimentsFile(value);
    case "SCOREBOARD": return normalizeScoreboardFile(value);
    default: throw new RangeError(`unknown blueprint file kind: ${String(value.kind)}`);
  }
}

export function collectBlueprintEvidenceRefs(file: BlueprintFile): readonly string[] {
  if (file.kind === "EXPERIMENTS") return [...new Set(file.entries.flatMap((entry) => entry.evidenceRefs))];
  if (file.kind === "SCOREBOARD") {
    return [...new Set(file.rows.flatMap((row) => [row.evaluationRef, ...row.evidenceRefs]))];
  }
  if (file.kind === "RULES" && file.evaluationContractRef !== undefined) return [file.evaluationContractRef];
  return [];
}

export function normalizeBlueprintFileRef(value: unknown): BlueprintFileRef {
  if (!isRecord(value)) throw new TypeError("blueprint file ref must be an ordinary object");
  if (!BLUEPRINT_FILE_KINDS.includes(value.kind as BlueprintFileKind)) throw new RangeError(`unknown blueprint file kind: ${String(value.kind)}`);
  nonEmpty("blueprint artifactId", value.artifactId);
  nonEmpty("blueprint digest", value.digest);
  if (value.address !== undefined) nonEmpty("blueprint address", value.address);
  const evidenceRefs = strings("blueprint evidenceRefs", value.evidenceRefs as string[] | undefined);
  return deepFreeze({
    kind: value.kind,
    artifactId: value.artifactId,
    digest: value.digest,
    evidenceRefs,
    ...(value.address === undefined ? {} : { address: value.address }),
  }) as BlueprintFileRef;
}

export function normalizeCrossReview(value: unknown): CrossReviewRecord {
  if (!isRecord(value)) throw new TypeError("cross-review must be an ordinary object");
  nonEmpty("cross-review reviewId", value.reviewId);
  if (value.phase !== "author" && value.phase !== "reviewer") throw new RangeError("cross-review phase must be author or reviewer");
  nonEmpty("cross-review artifactId", value.artifactId);
  nonEmpty("cross-review digest", value.digest);
  if (value.address !== undefined) nonEmpty("cross-review address", value.address);
  const subjectRefs = strings("cross-review subjectRefs", value.subjectRefs as string[] | undefined);
  if (subjectRefs.length === 0) throw new Error("cross-review requires subjectRefs");
  const evidenceRefs = strings("cross-review evidenceRefs", value.evidenceRefs as string[] | undefined);
  const findings = strings("cross-review findings", value.findings as string[] | undefined);
  if (findings.length === 0) throw new Error("cross-review requires findings");
  if (value.authoritative !== false && value.authoritative !== undefined) {
    throw new Error("cross-review cannot be authoritative");
  }
  return deepFreeze({
    reviewId: value.reviewId,
    phase: value.phase,
    artifactId: value.artifactId,
    digest: value.digest,
    subjectRefs,
    evidenceRefs,
    findings,
    authoritative: false,
  }) as CrossReviewRecord;
}

export interface BlueprintConsistencyInput {
  readonly hasEvidence: (id: string) => boolean;
  readonly artifactDigest?: (artifactId: string) => string | undefined;
}

export function assertBlueprintRefsConsistent(
  blueprint: MissionBlueprint,
  input: BlueprintConsistencyInput,
): void {
  for (const ref of Object.values(blueprint.files)) {
    if (ref === undefined) continue;
    for (const evidenceId of ref.evidenceRefs) {
      if (!input.hasEvidence(evidenceId)) throw new Error(`blueprint ${ref.kind} references unknown evidence: ${evidenceId}`);
    }
    const registered = input.artifactDigest?.(ref.artifactId);
    if (registered !== undefined && registered !== ref.digest) {
      throw new Error(`blueprint ${ref.kind} digest does not match its artifact registry`);
    }
  }
  for (const review of blueprint.crossReviews) {
    for (const evidenceId of review.evidenceRefs) {
      if (!input.hasEvidence(evidenceId)) throw new Error(`cross-review ${review.reviewId} references unknown evidence: ${evidenceId}`);
    }
    const registered = input.artifactDigest?.(review.artifactId);
    if (registered !== undefined && registered !== review.digest) {
      throw new Error(`cross-review ${review.reviewId} digest does not match its artifact registry`);
    }
  }
}

export function isBlueprintArtifactId(id: string): boolean {
  return id.startsWith("blueprint:") || id.startsWith("cross-review:");
}

export function isEvaluatorObservation(metadata: Readonly<Record<string, unknown>> | undefined): boolean {
  return typeof metadata?.evaluationDigest === "string" && metadata.evaluationDigest.trim() !== "";
}
