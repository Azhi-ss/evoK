/**
 * Offline scripted Phase 2 platform. Exercises the normal adapter path with
 * no network, no credentials and no real submission: two competing revisions,
 * quota exhaustion, timeout/restart and an eventual official result.
 */
import {
  Phase2AmbiguousSubmitError,
  type Phase2Revision,
  type Phase2AttemptStatus,
  type Phase2BundleCheck,
  type Phase2KitStatus,
  type Phase2Platform,
  type Phase2QuotaStatus,
  type Phase2Receipt,
  type Phase2SourceRef,
} from "./phase2-playground";

export interface FakePhase2Script {
  readonly kitStatus?: "verified" | "missing" | "mismatch";
  /** Consumed one per quota() call; the last value repeats. */
  readonly quota?: readonly (number | null)[];
  /** Consumed one per real submit call; the last value repeats. */
  readonly submitOutcomes?: readonly ("ok" | "timeout")[];
  readonly officialScore?: number;
  readonly officialCost?: number;
  /** attemptStatus polls before the official result is final. Default 1. */
  readonly evaluationSteps?: number;
  readonly failDownload?: boolean;
  /** Upload a tree that differs from the local one while echoing a
   * self-consistent digest. The adapter must catch this against the locally
   * nominated digest, not against the echo. */
  readonly tamperUpload?: boolean;
}

export class FakePhase2Platform implements Phase2Platform {
  readonly script: FakePhase2Script;
  submitCalls = 0;
  createSourceCalls = 0;
  grants: string[] = [];
  private quotaCalls = 0;
  private polls = 0;
  private attempts = new Map<string, { attemptId: string; polls: number }>();
  private uploadedDigest = "";

  constructor(script: FakePhase2Script = {}) {
    this.script = script;
  }

  async kit(): Promise<Phase2KitStatus> {
    const status = this.script.kitStatus ?? "verified";
    return {
      status,
      detail: status === "verified" ? "fake pinned kit verified" : `fake kit ${status}`,
      ...(status === "verified" ? {} : { action: "download harness-phase2-public-kit v3 and verify the tarball sha256" }),
    };
  }

  async quota(): Promise<Phase2QuotaStatus> {
    const sequence = this.script.quota ?? [1];
    const value = sequence[Math.min(this.quotaCalls, sequence.length - 1)];
    this.quotaCalls += 1;
    return { remainingToday: value, detail: value === null ? "fake platform cannot confirm quota" : `fake platform reports ${value} slot(s) today` };
  }

  async localTreeDigest(revision: Phase2Revision): Promise<string> {
    return `local-tree-${revision.id}`;
  }

  async createSource(input: { revision: Phase2Revision; treeDigest: string }): Promise<Phase2SourceRef> {
    this.createSourceCalls += 1;
    this.uploadedDigest = this.script.tamperUpload ? `tampered-${input.treeDigest}` : input.treeDigest;
    return { datasetId: `fake-source-${input.revision.id.slice(4, 12)}`, version: "1", treeDigest: this.uploadedDigest };
  }

  async grantOrganizerRead(datasetId: string): Promise<void> {
    this.grants.push(datasetId);
  }

  async verifyDownloadedTree(input: { datasetId: string; version: string; treeDigest: string }): Promise<{ ok: boolean; detail: string }> {
    if (this.script.failDownload) return { ok: false, detail: `fake downloaded tree differs for ${input.datasetId}` };
    if (input.treeDigest !== this.uploadedDigest) return { ok: false, detail: `fake downloaded tree ${this.uploadedDigest} != local ${input.treeDigest}` };
    return { ok: true, detail: "fake downloaded tree matches file by file" };
  }

  async validateBundle(input: { revisionId: string; submissionJson: string; treeDigest: string }): Promise<Phase2BundleCheck> {
    const parsed = JSON.parse(input.submissionJson) as { source_url?: string };
    if (!parsed.source_url) return { ok: false, bundleDigest: "", detail: "submission.json missing source_url" };
    return { ok: true, bundleDigest: `bundle-${input.treeDigest.slice(0, 16)}`, detail: "fake playground submit --dry-run passed" };
  }

  async submit(input: { revisionId: string; bundleDigest: string; idempotencyKey: string }): Promise<Phase2Receipt> {
    this.submitCalls += 1;
    const outcomes = this.script.submitOutcomes ?? ["ok"];
    const outcome = outcomes[Math.min(this.submitCalls - 1, outcomes.length - 1)];
    const existing = this.attempts.get(input.idempotencyKey);
    const attemptId = existing?.attemptId ?? `fake-attempt-${this.attempts.size + 1}`;
    this.attempts.set(input.idempotencyKey, { attemptId, polls: existing?.polls ?? 0 });
    if (outcome === "timeout") throw new Phase2AmbiguousSubmitError("fake platform timeout after the request was sent");
    return { attemptId, status: "accepted", raw: { attemptId, status: "accepted" } };
  }

  async attemptStatus(attemptId: string): Promise<Phase2AttemptStatus> {
    this.polls += 1;
    const steps = this.script.evaluationSteps ?? 1;
    if (this.polls <= steps) return { state: "evaluating", detail: `fake official evaluation pending (poll ${this.polls})` };
    return {
      state: "scored",
      score: this.script.officialScore ?? 0.5,
      cost: this.script.officialCost ?? 0,
      detail: "fake official result verified",
    };
  }

  async findAttempt(idempotencyKey: string): Promise<{ attemptId: string } | null> {
    const found = this.attempts.get(idempotencyKey);
    return found ? { attemptId: found.attemptId } : null;
  }
}
