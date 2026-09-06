import { TrustViolation, digestValue } from "./security-boundary";

/**
 * Data honesty gate (T40, spec #1 research gap G1): detects and prevents
 * training/label leakage and test-signal peeking (hill-climbing on test /
 * private / leaderboard feedback). This gate governs **data honesty only** —
 * it does NOT replace the #7 sandbox/evaluator trust boundary
 * (`security-boundary.ts`) nor the #11 evaluation noise protocol
 * (`evaluation-noise.ts`). See docs/data-honesty.md.
 */

/** A single confirmed data-honesty violation. Finding payloads never embed gold-label values. */
export interface LeakageFinding {
  readonly kind: "protected_path" | "gold_labels" | "test_signal";
  /** The matched declaration token (path or channel name); safe to record. */
  readonly token: string;
  /** Human-readable detail that never quotes protected label contents. */
  readonly detail: string;
}

/** Adapter/evaluation contract face: what a Competition must declare for leakage auditing. */
export interface LeakageAuditContract {
  /** Paths/tokens that must never appear in candidate code (test rows, private answers). */
  readonly protectedPaths: readonly string[];
  /**
   * The held-out gold labels. Only an *exact, verbatim* full-length match in a
   * candidate file is a finding — partial/short binary prefixes never are, so
   * legitimate 0/1 predictions do not false-positive. Values themselves are
   * never written to the ledger.
   */
  readonly goldLabels?: readonly (string | number | boolean)[];
}

/** Adapter/evaluation contract face: how test/private feedback may be used. */
export interface TestSignalPolicy {
  /**
   * - `forbid`: any confirmed test-signal/label leakage use → quarantine, terminal.
   * - `disclose_only`: leave an auditable LEAKAGE_DISCLOSURE event, continue;
   *   test feedback still never feeds grading or promotion (enforced by the
   *   trusted-score/feedback-view seam, T24).
   */
  readonly mode: "forbid" | "disclose_only";
  /** Tokens naming test/private feedback channels (leaderboard, private score, submission API). */
  readonly testSignals: readonly string[];
}

export interface DataHonestyContract {
  readonly leakage_audit: LeakageAuditContract;
  readonly test_signal_policy: TestSignalPolicy;
}

export type DataHonestyProvider = {
  readonly leakage_audit?: (() => LeakageAuditContract) | LeakageAuditContract;
  readonly leakageAudit?: (() => LeakageAuditContract) | LeakageAuditContract;
  readonly test_signal_policy?: (() => TestSignalPolicy) | TestSignalPolicy;
  readonly testSignalPolicy?: (() => TestSignalPolicy) | TestSignalPolicy;
};

function resolveField<T>(provider: unknown, snake: unknown, camel: unknown): T | undefined {
  const source = snake ?? camel;
  if (source === undefined) return undefined;
  return (typeof source === "function" ? (source as () => T).call(provider) : source) as T;
}

function nonEmptyStrings(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new RangeError(`${name} must be a non-empty array of non-empty strings`);
  }
  return Object.freeze([...value]);
}

/** Resolves and validates the data honesty contract from an adapter; absent → gate inactive. */
export function resolveDataHonestyContract(provider: unknown): DataHonestyContract | undefined {
  const source = (provider ?? {}) as Partial<DataHonestyProvider>;
  const audit = resolveField<LeakageAuditContract>(source, source.leakage_audit, source.leakageAudit);
  const policy = resolveField<TestSignalPolicy>(source, source.test_signal_policy, source.testSignalPolicy);
  if (audit === undefined && policy === undefined) return undefined;
  if (!audit || !policy) {
    throw new RangeError("data honesty requires both leakage_audit and test_signal_policy");
  }
  const normalizedAudit: LeakageAuditContract = Object.freeze({
    protectedPaths: nonEmptyStrings(audit.protectedPaths, "leakage_audit.protectedPaths"),
    ...(audit.goldLabels === undefined ? {} : {
      goldLabels: Object.freeze([...audit.goldLabels]),
    }),
  });
  if (policy.mode !== "forbid" && policy.mode !== "disclose_only") {
    throw new RangeError("test_signal_policy.mode must be 'forbid' or 'disclose_only'");
  }
  const normalizedPolicy: TestSignalPolicy = Object.freeze({
    mode: policy.mode,
    testSignals: nonEmptyStrings(policy.testSignals, "test_signal_policy.testSignals"),
  });
  return Object.freeze({ leakage_audit: normalizedAudit, test_signal_policy: normalizedPolicy });
}

function normalize(token: string): string {
  return token.trim().toLowerCase().replace(/\\/g, "/");
}

/** File-content tokens match on normalized path substring; a declared path also matches by basename. */
function fileMentionsToken(content: string, token: string): boolean {
  const needle = normalize(token);
  if (needle === "") return false;
  const haystack = content.toLowerCase().replace(/\\/g, "/");
  if (haystack.includes(needle)) return true;
  // Declared 'private/solution.csv' also flags a bare 'solution.csv' read (the same held-out file).
  const slash = needle.lastIndexOf("/");
  return slash >= 0 && haystack.includes(needle.slice(slash + 1));
}

/**
 * Scans candidate files for confirmed leakage signals:
 * 1. reads of declared protected test/answer paths (`protected_path`),
 * 2. an exact verbatim copy of the full held-out gold-label row (`gold_labels`) —
 *    matched as a whitespace-insensitive substring, so embedding `gold = [0,1,1,0,1]`
 *    inside a code file is caught; a shorter/partial label row is never a match, so
 *    legitimate 0/1 predictions do not false-positive,
 * 3. references to declared test/private feedback channels (`test_signal`).
 *
 * Static text scan for the toy harness; findings are deterministic for replay.
 *
 * ponytail: deliberately naive — any mention of a declared token counts as a finding
 * (comments included; forbid mode fails closed), and obfuscated labels/URLs escape the
 * scan. Upgrade path: AST/dataflow analysis and adapter-provided probes when a real
 * adapter replaces the toy fixtures.
 */
export function auditCandidateFiles(contract: DataHonestyContract, files: Readonly<Record<string, string>>): readonly LeakageFinding[] {
  const findings: LeakageFinding[] = [];
  const seen = new Set<string>();
  const note = (kind: LeakageFinding["kind"], token: string, detail: string): void => {
    const key = `${kind}:${token}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(Object.freeze({ kind, token, detail }));
  };

  const goldValues = contract.leakage_audit.goldLabels;
  // Whitespace-free JSON row (with brackets/commas) always; bare joined values only for
  // longer rows, where a contiguous exact copy of the gold sequence is a real signal.
  const goldNeedles: string[] = goldValues !== undefined && goldValues.length > 0
    ? [
      JSON.stringify([...goldValues]).replace(/\s+/g, ""),
      ...(goldValues.length >= 6 ? [goldValues.map(String).join("").toLowerCase()] : []),
    ]
    : [];

  for (const [fileName, rawContent] of Object.entries(files)) {
    const content = typeof rawContent === "string" ? rawContent : String(rawContent ?? "");
    for (const path of contract.leakage_audit.protectedPaths) {
      if (fileMentionsToken(content, path) || fileMentionsToken(fileName, path)) {
        note("protected_path", path, `candidate reads or references protected test/answer data (${path})`);
      }
    }
    for (const signal of contract.test_signal_policy.testSignals) {
      if (fileMentionsToken(content, signal) || fileMentionsToken(fileName, signal)) {
        note("test_signal", signal, `candidate consults a test/private feedback channel (${signal}) for hill-climbing`);
      }
    }
    // A verbatim full copy of the gold row embedded anywhere in a file; never quotes values in the finding.
    const flattened = content.replace(/\s+/g, "").toLowerCase();
    if (goldNeedles.some((needle) => flattened.includes(needle))) {
      note("gold_labels", `gold-labels:${goldValues!.length}`, "candidate embeds the held-out gold labels verbatim");
    }
  }
  return Object.freeze(findings);
}

/** Trust violation carrying the confirmed findings; the harness quarantines on it. */
export class LeakageViolation extends TrustViolation {
  readonly findings: readonly LeakageFinding[];
  constructor(findings: readonly LeakageFinding[]) {
    super(`data honesty violation: ${findings.map((finding) => finding.kind).join(", ")}`);
    this.name = "LeakageViolation";
    this.findings = Object.freeze([...findings]);
  }
  /** Stable fingerprint of the violation kinds+tokens: repeated identical violations are never auto-retried. */
  fingerprint(): string {
    return digestValue(this.findings.map((finding) => `${finding.kind}:${finding.token}`).sort());
  }
}
