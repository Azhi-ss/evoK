import { deepFreeze } from "./security-boundary";

/**
 * Outer methodology contracts (T44 shape) and a one-way compile/read seam
 * for the inner plugin task `methodology` block (ADR 0003 / #42).
 *
 * Compile: resolved contracts → snake_case plugin block.
 * Read: candidate manifest → evidence mapping for T44
 * `auditMethodology` / `oofEnsembleGate`. Those gates consume evidence only;
 * they do not promote, and they sleep when no contract is injected.
 */

export interface SplitRef {
  readonly digest: string;
  readonly id?: string;
}

export interface SplitContract {
  readonly splitRef: SplitRef;
  readonly scheme?: string;
  readonly nSplits?: number;
  readonly seed?: number;
  readonly shuffle?: boolean;
}

export interface OofEnsembleContract {
  readonly required: boolean;
  readonly strategy?: string;
}

export interface FeaturePipelineContract {
  readonly fitScope?: string;
  readonly steps?: readonly string[];
  readonly forbidTargetLeak?: boolean;
}

export interface MethodologyContracts {
  readonly splitContract?: SplitContract;
  readonly oofEnsemble?: OofEnsembleContract;
  readonly featurePipeline?: FeaturePipelineContract;
}

/** Wire shape of the inner plugin task `methodology` block (snake_case / #42). */
export interface PluginMethodologyBlock {
  readonly split_contract?: {
    readonly split_ref: SplitRef;
    readonly scheme?: string;
    readonly n_splits?: number;
    readonly seed?: number;
    readonly shuffle?: boolean;
  };
  readonly oof_ensemble?: {
    readonly required: boolean;
    readonly strategy?: string;
  };
  readonly feature_pipeline?: {
    readonly fit_scope?: string;
    readonly steps?: readonly string[];
    readonly forbid_target_leak?: boolean;
  };
}

export type SplitDigestAgreement = "agree" | "disagree" | "unknown";

/** Evidence mapping consumed by existing T44 audit / OOF gates. */
export interface MethodologyEvidence {
  readonly splitRefDigest?: string;
  readonly splitDigestAgreement: SplitDigestAgreement;
  readonly oofPresent: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pick(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function nonEmpty(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function finiteInteger(name: string, value: unknown, minimum: number): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a finite integer >= ${minimum}`);
  }
}

function optionalBoolean(name: string, value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean`);
  return value;
}

function optionalString(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  nonEmpty(name, value);
  return value;
}

function stringList(name: string, value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new TypeError(`${name} must contain non-empty strings`);
  }
  return Object.freeze([...value]);
}

function resolveSplitRef(value: unknown, name: string): SplitRef {
  if (!isPlainRecord(value)) throw new TypeError(`${name} must be an ordinary object`);
  nonEmpty(`${name}.digest`, value.digest);
  const id = optionalString(`${name}.id`, value.id);
  return Object.freeze({ digest: value.digest, ...(id === undefined ? {} : { id }) });
}

function resolveSplitContract(value: unknown): SplitContract {
  if (!isPlainRecord(value)) throw new TypeError("split contract must be an ordinary object");
  const splitRef = resolveSplitRef(pick(value, "splitRef", "split_ref"), "splitRef");
  const scheme = optionalString("splitContract.scheme", pick(value, "scheme"));
  const nSplits = pick(value, "nSplits", "n_splits");
  const seed = pick(value, "seed");
  const shuffle = optionalBoolean("splitContract.shuffle", pick(value, "shuffle"));
  if (nSplits !== undefined) finiteInteger("splitContract.nSplits", nSplits, 1);
  if (seed !== undefined) finiteInteger("splitContract.seed", seed, 0);
  return Object.freeze({
    splitRef,
    ...(scheme === undefined ? {} : { scheme }),
    ...(nSplits === undefined ? {} : { nSplits }),
    ...(seed === undefined ? {} : { seed }),
    ...(shuffle === undefined ? {} : { shuffle }),
  });
}

function resolveOofEnsemble(value: unknown): OofEnsembleContract {
  if (!isPlainRecord(value)) throw new TypeError("oof ensemble contract must be an ordinary object");
  const required = pick(value, "required");
  if (typeof required !== "boolean") throw new TypeError("oofEnsemble.required must be boolean");
  const strategy = optionalString("oofEnsemble.strategy", pick(value, "strategy"));
  return Object.freeze({ required, ...(strategy === undefined ? {} : { strategy }) });
}

function resolveFeaturePipeline(value: unknown): FeaturePipelineContract {
  if (!isPlainRecord(value)) throw new TypeError("feature pipeline contract must be an ordinary object");
  const fitScope = optionalString("featurePipeline.fitScope", pick(value, "fitScope", "fit_scope"));
  const steps = stringList("featurePipeline.steps", pick(value, "steps"));
  const forbidTargetLeak = optionalBoolean(
    "featurePipeline.forbidTargetLeak",
    pick(value, "forbidTargetLeak", "forbid_target_leak"),
  );
  return Object.freeze({
    ...(fitScope === undefined ? {} : { fitScope }),
    ...(steps === undefined ? {} : { steps }),
    ...(forbidTargetLeak === undefined ? {} : { forbidTargetLeak }),
  });
}

function hasContent(contracts: MethodologyContracts): boolean {
  return contracts.splitContract !== undefined
    || contracts.oofEnsemble !== undefined
    || contracts.featurePipeline !== undefined;
}

/** Normalize camel/snake input into the T44 MethodologyContracts surface. */
export function resolveMethodologyContracts(input: unknown): MethodologyContracts | undefined {
  if (input === undefined || input === null) return undefined;
  if (!isPlainRecord(input)) throw new TypeError("methodology contracts must be an ordinary object");
  const split = pick(input, "splitContract", "split_contract");
  const oof = pick(input, "oofEnsemble", "oof_ensemble");
  const pipeline = pick(input, "featurePipeline", "feature_pipeline");
  const contracts: MethodologyContracts = Object.freeze({
    ...(split === undefined ? {} : { splitContract: resolveSplitContract(split) }),
    ...(oof === undefined ? {} : { oofEnsemble: resolveOofEnsemble(oof) }),
    ...(pipeline === undefined ? {} : { featurePipeline: resolveFeaturePipeline(pipeline) }),
  });
  return hasContent(contracts) ? contracts : undefined;
}

function compileSplit(contract: SplitContract): NonNullable<PluginMethodologyBlock["split_contract"]> {
  return Object.freeze({
    ...(contract.scheme === undefined ? {} : { scheme: contract.scheme }),
    ...(contract.nSplits === undefined ? {} : { n_splits: contract.nSplits }),
    ...(contract.seed === undefined ? {} : { seed: contract.seed }),
    ...(contract.shuffle === undefined ? {} : { shuffle: contract.shuffle }),
    split_ref: Object.freeze({
      digest: contract.splitRef.digest,
      ...(contract.splitRef.id === undefined ? {} : { id: contract.splitRef.id }),
    }),
  });
}

function compileOof(contract: OofEnsembleContract): NonNullable<PluginMethodologyBlock["oof_ensemble"]> {
  return Object.freeze({
    required: contract.required,
    ...(contract.strategy === undefined ? {} : { strategy: contract.strategy }),
  });
}

function compilePipeline(contract: FeaturePipelineContract): NonNullable<PluginMethodologyBlock["feature_pipeline"]> {
  return Object.freeze({
    ...(contract.fitScope === undefined ? {} : { fit_scope: contract.fitScope }),
    ...(contract.steps === undefined ? {} : { steps: contract.steps }),
    ...(contract.forbidTargetLeak === undefined ? {} : { forbid_target_leak: contract.forbidTargetLeak }),
  });
}

/** One-way compile: resolved contracts → inner plugin task `methodology` block. */
export function compileMethodologyBlock(
  contracts: MethodologyContracts | undefined,
): PluginMethodologyBlock | undefined {
  if (contracts === undefined || !hasContent(contracts)) return undefined;
  return deepFreeze({
    ...(contracts.splitContract === undefined ? {} : { split_contract: compileSplit(contracts.splitContract) }),
    ...(contracts.oofEnsemble === undefined ? {} : { oof_ensemble: compileOof(contracts.oofEnsemble) }),
    ...(contracts.featurePipeline === undefined ? {} : { feature_pipeline: compilePipeline(contracts.featurePipeline) }),
  }) as PluginMethodologyBlock;
}

function observedSplitDigest(root: Record<string, unknown>): string | undefined {
  const direct = pick(root, "split_ref_digest", "splitRefDigest");
  if (typeof direct === "string" && direct.trim() !== "") return direct;
  const splitRef = pick(root, "split_ref", "splitRef");
  if (isPlainRecord(splitRef)) {
    const digest = pick(splitRef, "digest", "digest_summary", "digestSummary", "sha256");
    if (typeof digest === "string" && digest.trim() !== "") return digest;
  }
  return undefined;
}

function oofProtocolPresent(value: unknown): boolean | undefined {
  if (value === true) return true;
  if (value === false || value === null) return false;
  if (!isPlainRecord(value)) return undefined;
  if (typeof value.present === "boolean") return value.present;
  if (value.declared_equivalent === true || value.declaredEquivalent === true) return true;
  const protocol = pick(value, "oof", "oof_protocol", "oofProtocol", "protocol");
  if (protocol === true) return true;
  if (protocol === false || protocol === null) return false;
  if (isPlainRecord(protocol)) {
    if (typeof protocol.present === "boolean") return protocol.present;
    return Object.keys(protocol).length > 0;
  }
  if (value.required !== undefined || value.strategy !== undefined) return undefined;
  return Object.keys(value).length > 0 ? true : undefined;
}

function nestedOofPresent(record: Record<string, unknown>): boolean | undefined {
  if (record.declared_equivalent === true || record.declaredEquivalent === true) return true;
  const flag = oofProtocolPresent(pick(record, "oof", "oof_protocol", "oofProtocol"));
  if (flag !== undefined) return flag;
  for (const key of ["oof_ensemble", "oofEnsemble"] as const) {
    const nested = record[key];
    if (!isPlainRecord(nested)) continue;
    if (typeof nested.present === "boolean") return nested.present;
    if (nested.declared_equivalent === true || nested.declaredEquivalent === true) return true;
    const declared = oofProtocolPresent(pick(nested, "oof", "oof_protocol", "oofProtocol"));
    if (declared !== undefined) return declared;
  }
  return undefined;
}

function observedOofPresent(root: Record<string, unknown>): boolean {
  const flag = pick(root, "oof_present", "oofPresent");
  if (typeof flag === "boolean") return flag;
  return nestedOofPresent(root) ?? false;
}

function hasEvidenceFields(record: Record<string, unknown>): boolean {
  return pick(
    record,
    "split_ref",
    "splitRef",
    "split_ref_digest",
    "splitRefDigest",
    "oof_present",
    "oofPresent",
    "oof",
    "declared_equivalent",
    "declaredEquivalent",
  ) !== undefined
    || nestedOofPresent(record) !== undefined;
}

function evidenceRoot(manifest: unknown): Record<string, unknown> | undefined {
  if (!isPlainRecord(manifest)) return undefined;
  if (hasEvidenceFields(manifest)) return manifest;
  const nested = pick(manifest, "methodology");
  if (isPlainRecord(nested) && hasEvidenceFields(nested)) return nested;
  return manifest;
}

function digestAgreement(expected: string | undefined, observed: string | undefined): SplitDigestAgreement {
  if (expected === undefined || observed === undefined) return "unknown";
  return expected === observed ? "agree" : "disagree";
}

/**
 * One-way read: inner candidate manifest → outer evidence mapping.
 * Echoed task `methodology` blocks are not treated as used-split evidence.
 */
export function readMethodologyManifest(
  manifest: unknown,
  contracts?: MethodologyContracts,
): MethodologyEvidence {
  const root = evidenceRoot(manifest);
  const splitRefDigest = root === undefined ? undefined : observedSplitDigest(root);
  const oofPresent = root === undefined ? false : observedOofPresent(root);
  return deepFreeze({
    ...(splitRefDigest === undefined ? {} : { splitRefDigest }),
    splitDigestAgreement: digestAgreement(contracts?.splitContract?.splitRef.digest, splitRefDigest),
    oofPresent,
  }) as MethodologyEvidence;
}

export interface MethodologyGateResult {
  readonly ok: boolean;
  readonly objections: readonly string[];
}

function gateResult(ok: boolean, objections: readonly string[] = []): MethodologyGateResult {
  return deepFreeze({ ok, objections: Object.freeze([...objections]) }) as MethodologyGateResult;
}

/**
 * T44 split-contract audit. Sleeps when no split contract is injected.
 * A disagreeing used-split digest is a rule fail; a missing digest is not agree.
 */
export function auditMethodology(
  evidence: MethodologyEvidence,
  contracts?: MethodologyContracts,
): MethodologyGateResult {
  if (contracts?.splitContract === undefined) return gateResult(true);
  if (evidence.splitDigestAgreement === "agree") return gateResult(true);
  if (evidence.splitDigestAgreement === "disagree") {
    return gateResult(false, ["split_ref digest disagrees with task split_contract"]);
  }
  return gateResult(false, ["split_ref digest is missing; used-split evidence is required"]);
}

/**
 * T44 OOF ensemble gate. Sleeps when OOF is not required.
 * Ensemble candidates without OOF or declared_equivalent fail closed for leak/OOF.
 */
export function oofEnsembleGate(
  evidence: MethodologyEvidence,
  contracts?: MethodologyContracts,
): MethodologyGateResult {
  if (contracts?.oofEnsemble?.required !== true) return gateResult(true);
  if (evidence.oofPresent) return gateResult(true);
  return gateResult(false, [
    "OOF ensemble leak: manifest must declare an oof protocol or declared_equivalent",
  ]);
}
