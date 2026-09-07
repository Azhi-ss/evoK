import { describe, expect, test } from "bun:test";
import { createTrustedSnapshot } from "./security-boundary";
import { ToyCompetitionHarness, type ToyCompetitionAdapter, type ToyAgentRuntime } from "./toy-harness";

const prediction = {
  predictionId: "toy-prediction",
  hypothesis: "the candidate improves the score",
  expectedObservation: "the evaluator returns the candidate score",
  expectedObservations: ["the evaluator returns the candidate score"],
  failureModes: ["the score does not improve"],
} as const;
import {
  InMemorySubmissionLedger,
  SubmissionBroker,
  SubmissionRejected,
  type SubmissionChampion,
  type SubmissionCredential,
  type SubmissionDestination,
} from "./submission-broker";

const snapshot = createTrustedSnapshot({
  missionId: "submission-test",
  branchId: "a",
  attempt: 1,
  files: { score: "9" },
  contract: { objective: "maximize" },
  provenance: { runId: "submission-test:a:1", candidateId: "a:1", fencingToken: 1 },
});

const champion: SubmissionChampion = {
  missionId: "submission-test",
  competition: "score-file",
  branchId: "a",
  championDigest: snapshot.digest,
  artifactDigest: snapshot.digest,
  snapshot,
  evaluatorSucceeded: true,
  successAuditorPassed: true,
  promotionApproved: true,
};

const credential: SubmissionCredential = {
  id: "credential-1",
  scopes: ["submit:score-file"],
  expiresAt: 100,
};

function destination(calls: unknown[]): SubmissionDestination {
  return {
    submit(input) {
      calls.push(input);
      return { submissionId: "external-1", accepted: true };
    },
  };
}

function makeBroker(now: { value: number }, calls: unknown[] = [], ledger = new InMemorySubmissionLedger()) {
  return new SubmissionBroker({
    allowedCompetitions: ["score-file"],
    allowedTargets: ["fake://score-file"],
    allowedCredentialScopes: ["submit:score-file"],
    rateLimit: { maxSubmissions: 1, windowMs: 10 },
    destination: destination(calls),
    clock: () => now.value,
    ledger,
    champion,
  });
}

function requestInput(overrides: Record<string, unknown> = {}) {
  return {
    missionId: champion.missionId,
    competition: "score-file",
    target: "fake://score-file",
    champion,
    artifactDigest: snapshot.digest,
    credential,
    dryRun: false,
    ...overrides,
  };
}

describe("SubmissionBroker", () => {
  test("creates and records a dry-run without calling the destination", async () => {
    const now = { value: 1 };
    const calls: unknown[] = [];
    const broker = makeBroker(now, calls);
    const request = broker.createDryRun({
      missionId: champion.missionId,
      competition: "score-file",
      target: "fake://score-file",
      champion,
      artifactDigest: snapshot.digest,
      credentialScopes: credential.scopes,
    });

    expect(request.dryRun).toBe(true);
    expect(request.artifactDigest).toBe(snapshot.digest);
    const result = await broker.submit(request);

    expect(result.status).toBe("DRY_RUN");
    expect(calls).toHaveLength(0);
    expect(broker.events().map((event) => event.type)).toEqual([
      "SUBMISSION_REQUESTED",
      "SUBMISSION_RESULT",
    ]);
  });

  test("rejects non-allowlisted competition, target, artifact, and credential scope before any destination call", () => {
    const now = { value: 1 };
    const calls: unknown[] = [];
    const cases = [
      { name: "competition", overrides: { competition: "other" }, code: "competition-not-allowlisted" },
      { name: "target", overrides: { target: "fake://other" }, code: "target-not-allowlisted" },
      { name: "artifact", overrides: { artifactDigest: "wrong-digest" }, code: "artifact-digest-mismatch" },
      { name: "scope", overrides: { credentialScopes: ["submit:other"] }, code: "credential-scope-denied" },
    ] as const;

    for (const current of cases) {
      const broker = makeBroker(now, calls);
      expect(() => broker.createRequest(requestInput(current.overrides))).toThrow(SubmissionRejected);
      try {
        broker.createRequest(requestInput(current.overrides));
      } catch (error) {
        expect(error).toMatchObject({ code: current.code });
      }
    }
    expect(calls).toHaveLength(0);
    expect(makeBroker(now, calls).events()).toHaveLength(0);
  });

  test("rejects conflicting competition and target aliases", () => {
    const now = { value: 1 };
    const broker = new SubmissionBroker({
      allowedCompetitions: ["score-file"],
      allowedTargets: ["fake://score-file"],
      allowedCredentialScopes: ["submit:score-file"],
      clock: () => now.value,
      champion,
    });
    expect(() => broker.createDryRun(requestInput({ competitionId: "other" }))).toThrow(SubmissionRejected);
    expect(broker.events().at(-1)).toMatchObject({ type: "SUBMISSION_REJECTED", payload: { code: "competition-not-allowlisted" } });
    expect(() => broker.createDryRun(requestInput({ competition: "other", competitionId: "score-file" }))).toThrow(SubmissionRejected);
    expect(broker.events().at(-1)).toMatchObject({ type: "SUBMISSION_REJECTED", payload: { code: "competition-not-allowlisted" } });
    expect(() => broker.createDryRun(requestInput({ destinationTarget: "fake://other" }))).toThrow(SubmissionRejected);
    expect(broker.events().at(-1)).toMatchObject({ type: "SUBMISSION_REJECTED", payload: { code: "target-not-allowlisted" } });
  });

  test("requires a trusted champion source instead of request flags alone", () => {
    const now = { value: 1 };
    const broker = new SubmissionBroker({
      allowedCompetitions: ["score-file"],
      allowedTargets: ["fake://score-file"],
      allowedCredentialScopes: ["submit:score-file"],
      clock: () => now.value,
    });
    expect(() => broker.createDryRun(requestInput())).toThrow(/trusted champion provider/);
  });

  test("rejects a champion digest outside an optional artifact allowlist", () => {
    const now = { value: 1 };
    const broker = new SubmissionBroker({
      allowedCompetitions: ["score-file"],
      allowedTargets: ["fake://score-file"],
      allowedCredentialScopes: ["submit:score-file"],
      allowedArtifactDigests: ["another-artifact"],
      clock: () => now.value,
      champion,
    });
    expect(() => broker.createDryRun(requestInput({ requestId: "artifact-policy" }))).toThrow(/not allowlisted/);
    expect(broker.events().at(-1)).toMatchObject({ type: "SUBMISSION_REJECTED", payload: { code: "artifact-not-allowlisted" } });
  });

  test("requires explicit human acceptance and records the approval before external submission", async () => {
    const now = { value: 1 };
    const calls: unknown[] = [];
    const broker = makeBroker(now, calls);
    const request = broker.createRequest(requestInput());

    await expect(broker.submit(request)).rejects.toMatchObject({ code: "human-acceptance-required" });
    expect(() => broker.approve(request, { acceptedBy: "operator", acceptedAt: Number.NaN })).toThrow(SubmissionRejected);
    expect(broker.events().at(-1)?.type).toBe("SUBMISSION_REJECTED");
    const approval = broker.approve(request, { acceptedBy: "operator", decisionId: "decision-1" });
    expect(broker.approve(request, { acceptedBy: "operator" })).toEqual(approval);
    const result = await broker.submit(request);

    expect(approval).toMatchObject({ requestId: request.requestId, championDigest: snapshot.digest, acceptedBy: "operator" });
    expect(result).toMatchObject({ status: "SUCCEEDED", submissionId: "external-1" });
    expect(calls).toHaveLength(1);
    expect(broker.events().map((event) => event.type)).toEqual([
      "SUBMISSION_REQUESTED",
      "SUBMISSION_REJECTED",
      "SUBMISSION_REJECTED",
      "HUMAN_ACCEPTED",
      "SUBMISSION_APPROVED",
      "SUBMISSION_RESULT",
    ]);
  });

  test("can defer credential material until the gated external execution", async () => {
    const now = { value: 1 };
    const calls: unknown[] = [];
    const broker = makeBroker(now, calls);
    const request = broker.createRequest(requestInput({ requestId: "deferred-credential", credential: undefined }));
    broker.approve(request, { acceptedBy: "operator" });
    const result = await broker.submit(request, { dryRun: false, credential });
    expect(result.status).toBe("SUCCEEDED");
    expect(calls).toHaveLength(1);
  });

  test("does not let the compatibility auto-submit flag bypass human acceptance", async () => {
    const now = { value: 1 };
    const calls: unknown[] = [];
    const broker = new SubmissionBroker({
      allowedCompetitions: ["score-file"],
      allowedTargets: ["fake://score-file"],
      allowedCredentialScopes: ["submit:score-file"],
      destination: destination(calls),
      clock: () => now.value,
      autoSubmit: true,
      champion,
    });
    const request = broker.createRequest(requestInput());

    await expect(broker.submit(request, { dryRun: false })).rejects.toMatchObject({ code: "human-acceptance-required" });
    expect(calls).toHaveLength(0);
  });

  test("does not let a caller replace the trusted artifact behind an approved digest", async () => {
    const now = { value: 1 };
    const calls: unknown[] = [];
    const trustedArtifact = {
      artifactId: "trusted-artifact",
      address: "artifact://trusted",
      digest: snapshot.digest,
      payload: snapshot,
    };
    const trustedChampion = { ...champion, artifact: trustedArtifact };
    const broker = new SubmissionBroker({
      allowedCompetitions: ["score-file"],
      allowedTargets: ["fake://score-file"],
      allowedCredentialScopes: ["submit:score-file"],
      destination: destination(calls),
      clock: () => now.value,
      champion: trustedChampion,
    });
    const request = broker.createRequest(requestInput({ champion: trustedChampion, requestId: "artifact-ownership" }));
    broker.approve(request, { acceptedBy: "operator" });
    await expect(broker.submit(request, {
      dryRun: false,
      artifact: { ...trustedArtifact, address: "artifact://attacker" },
    })).rejects.toMatchObject({ code: "artifact-digest-mismatch" });
    await expect(broker.submit(request, {
      dryRun: false,
      artifact: { ...trustedArtifact, payload: { ...snapshot, files: { score: "attacker" } } },
    })).rejects.toMatchObject({ code: "artifact-digest-mismatch" });
    expect(calls).toHaveLength(0);
    await expect(broker.submit(request, { dryRun: false })).resolves.toMatchObject({ status: "SUCCEEDED" });
    expect(calls).toHaveLength(1);
    expect((calls[0] as { artifact: { address: string } }).artifact.address).toBe("artifact://trusted");
  });

  test("rejects replacement of an arbitrary trusted artifact payload", async () => {
    const now = { value: 1 };
    const calls: unknown[] = [];
    const trustedArtifact = {
      artifactId: "generic-artifact",
      address: "artifact://generic",
      digest: "generic-digest",
      payload: { trusted: true },
    };
    const trustedChampion = { ...champion, artifactDigest: "generic-digest", artifact: trustedArtifact };
    const broker = new SubmissionBroker({
      allowedCompetitions: ["score-file"],
      allowedTargets: ["fake://score-file"],
      allowedCredentialScopes: ["submit:score-file"],
      destination: destination(calls),
      clock: () => now.value,
      champion: trustedChampion,
    });
    const request = broker.createRequest(requestInput({ champion: trustedChampion, artifactDigest: "generic-digest", requestId: "generic-artifact-ownership" }));
    broker.approve(request, { acceptedBy: "operator" });
    await expect(broker.submit(request, {
      dryRun: false,
      artifact: { ...trustedArtifact, payload: { attacker: true } },
    })).rejects.toMatchObject({ code: "artifact-digest-mismatch" });
    expect(calls).toHaveLength(0);
  });

  test("records rejection and never calls the destination for expired or digest-stale requests", async () => {
    const now = { value: 1 };
    const calls: unknown[] = [];
    let currentChampion = champion;
    const broker = new SubmissionBroker({
      allowedCompetitions: ["score-file"],
      allowedTargets: ["fake://score-file"],
      allowedCredentialScopes: ["submit:score-file"],
      rateLimit: { maxSubmissions: 1, windowMs: 10 },
      destination: destination(calls),
      clock: () => now.value,
      championProvider: () => currentChampion,
    });
    const request = broker.createRequest(requestInput({ expiresAt: 5 }));
    broker.approve(request, { acceptedBy: "operator", acceptedAt: 1, expiresAt: 4 });
    now.value = 6;
    await expect(broker.submit(request, { dryRun: false })).rejects.toMatchObject({ code: "request-expired" });

    now.value = 1;
    const fresh = broker.createRequest(requestInput({ requestId: "fresh-request", expiresAt: 20 }));
    broker.approve(fresh, { acceptedBy: "operator", acceptedAt: 1, expiresAt: 10 });
    currentChampion = { ...champion, championDigest: "new-champion", artifactDigest: "new-artifact" };
    await expect(broker.submit(fresh, { dryRun: false })).rejects.toMatchObject({ code: "artifact-digest-mismatch" });

    expect(calls).toHaveLength(0);
    expect(broker.events().filter((event) => event.type === "SUBMISSION_REJECTED")).toHaveLength(2);
  });

  test("enforces the rolling rate limit and keeps destination ownership inside the broker", async () => {
    const now = { value: 1 };
    const calls: unknown[] = [];
    const broker = makeBroker(now, calls);
    const first = broker.createRequest(requestInput({ requestId: "first" }));
    broker.approve(first, { acceptedBy: "operator" });
    await broker.submit(first, { dryRun: false });

    const second = broker.createRequest(requestInput({ requestId: "second" }));
    broker.approve(second, { acceptedBy: "operator" });
    await expect(broker.submit(second, { dryRun: false })).rejects.toMatchObject({ code: "rate-limit-exceeded" });
    expect(calls).toHaveLength(1);

    now.value = 12;
    const result = await broker.submit(second, { dryRun: false });
    expect(result.status).toBe("SUCCEEDED");
    expect(calls).toHaveLength(2);
  });

  test("rejects expired human acceptance and credentials without invoking the destination", async () => {
    const now = { value: 1 };
    const calls: unknown[] = [];
    const broker = makeBroker(now, calls);
    const request = broker.createRequest(requestInput({ requestId: "expired-approval", expiresAt: 50 }));
    broker.approve(request, { acceptedBy: "operator", acceptedAt: 1, expiresAt: 2 });
    now.value = 2;
    await expect(broker.submit(request, { dryRun: false })).rejects.toMatchObject({ code: "human-acceptance-expired" });

    now.value = 1;
    expect(() => broker.createRequest(requestInput({
      requestId: "expired-credential",
      credential: { ...credential, expiresAt: 1 },
    }))).toThrow(/credential is missing or expired/);
    expect(calls).toHaveLength(0);
  });

  test("records a failed destination result and does not retry the external side effect", async () => {
    const now = { value: 1 };
    let calls = 0;
    const token = "failed-destination-secret";
    const broker = new SubmissionBroker({
      allowedCompetitions: ["score-file"],
      allowedTargets: ["fake://score-file"],
      allowedCredentialScopes: ["submit:score-file"],
      rateLimit: { maxSubmissions: 1, windowMs: 10 },
      destination: { submit: () => { calls += 1; throw new Error(`remote unavailable: ${token}`); } },
      clock: () => now.value,
      champion,
    });
    const request = broker.createRequest(requestInput({ requestId: "failed-destination", credential: { ...credential, token } }));
    broker.approve(request, { acceptedBy: "operator" });
    const result = await broker.submit(request, { dryRun: false });

    expect(result).toMatchObject({ status: "FAILED" });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(calls).toBe(1);
    expect(await broker.submit(request, { dryRun: false })).toEqual(result);
    expect(calls).toBe(1);
    expect(broker.events().at(-1)?.type).toBe("SUBMISSION_RESULT");
  });

  test("does not treat an unverified provider result as a submission champion", () => {
    const now = { value: 1 };
    const calls: unknown[] = [];
    const broker = new SubmissionBroker({
      allowedCompetitions: ["score-file"],
      allowedTargets: ["fake://score-file"],
      allowedCredentialScopes: ["submit:score-file"],
      destination: destination(calls),
      clock: () => now.value,
      championProvider: () => ({ ...champion, successAuditorPassed: false }),
    });
    expect(() => broker.createDryRun(requestInput())).toThrow("champion has not passed");
    expect(calls).toHaveLength(0);
  });

  test("routes a verified harness champion through the broker and not through candidate, adapter, or role hooks", async () => {
    const now = { value: 1 };
    const bypassCalls: string[] = [];
    const destinationCalls: unknown[] = [];
    const adapter: ToyCompetitionAdapter & { submit(): void } = {
      name: "score-file",
      evaluate: (candidate) => ({ score: Number(candidate.files.score) }),
      collectArtifacts: () => [{ artifactId: "score-artifact", address: "artifact://score-artifact", digest: "artifact-digest" }],
      submit: () => { bypassCalls.push("adapter"); },
    };
    const runtime: ToyAgentRuntime = {
      selfVerify: () => ({ ok: true }),
      propose: () => { adapter.submit(); bypassCalls.push("candidate"); return { files: { score: "9" } }; },
      falsify: () => ({ ok: true, objections: [] }),
      successAuditor: () => { adapter.submit(); bypassCalls.push("agent-role"); return { ok: true, objections: [] }; },
    };
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "broker-harness",
      taskContract: { objective: "maximize" },
      branchIds: ["a"],
      runtime: {
        ...runtime,
        critic: () => ({ ok: true, objections: [] }),
        challenger: () => ({ ok: true, objections: [] }),
        auditor: () => ({ ok: true, objections: [] }),
      },
      adapter,
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    });
    await harness.run();
    adapter.submit();
    expect(destinationCalls).toHaveLength(0);
    expect(bypassCalls).toEqual(["adapter", "candidate", "adapter", "agent-role", "adapter"]);

    const broker = harness.createSubmissionBroker({
      allowedCompetitions: ["score-file"],
      allowedTargets: ["fake://score-file"],
      allowedCredentialScopes: ["submit:score-file"],
      rateLimit: { maxSubmissions: 1, windowMs: 10 },
      destination: {
        submit: (input) => { destinationCalls.push(input); return { submissionId: "broker-only" }; },
      },
      clock: () => now.value,
    });
    const request = broker.createDryRun({
      missionId: "broker-harness",
      competition: "score-file",
      target: "fake://score-file",
      credentialScopes: ["submit:score-file"],
    });
    expect(request.dryRun).toBe(true);
    expect(destinationCalls).toHaveLength(0);
    expect(harness.events().some((event) => event.type === "SUBMISSION_REQUESTED")).toBe(true);

    const external = broker.createRequest({
      missionId: "broker-harness",
      competition: "score-file",
      target: "fake://score-file",
      dryRun: false,
      credential,
    });
    const hostileAttempts = await Promise.all(["candidate", "adapter", "agent-role"].map(async () => {
      try {
        await broker.submit(external, { dryRun: false });
        return "submitted";
      } catch (error) {
        return error instanceof SubmissionRejected ? error.code : "unexpected-error";
      }
    }));
    expect(hostileAttempts).toEqual(["human-acceptance-required", "human-acceptance-required", "human-acceptance-required"]);
    expect(destinationCalls).toHaveLength(0);

    const acceptance = harness.acceptChampion({
      requestId: external.requestId,
      championDigest: external.championDigest,
      acceptedBy: "operator",
      decisionId: "broker-approval",
      acceptedAt: now.value,
      expiresAt: 10,
    });
    expect(acceptance.artifactDigest).toBe("artifact-digest");
    const result = await broker.submit(external, { dryRun: false });

    expect(result.status).toBe("SUCCEEDED");
    expect(destinationCalls).toHaveLength(1);
    expect((destinationCalls[0] as { artifact: { digest: string } }).artifact.digest).toBe("artifact-digest");
    expect(bypassCalls).toEqual(["adapter", "candidate", "adapter", "agent-role", "adapter"]);
    expect(harness.events().map((event) => event.type)).toEqual(expect.arrayContaining([
      "SUBMISSION_REQUESTED", "HUMAN_ACCEPTED", "SUBMISSION_APPROVED", "SUBMISSION_RESULT",
    ]));

    const replayDestinationCalls: unknown[] = [];
    const restarted = harness.createSubmissionBroker({
      allowedCompetitions: ["score-file"],
      allowedTargets: ["fake://score-file"],
      allowedCredentialScopes: ["submit:score-file"],
      rateLimit: { maxSubmissions: 1, windowMs: 10 },
      destination: destination(replayDestinationCalls),
      clock: () => now.value,
    });
    await expect(restarted.submit(external, { dryRun: false, credential })).resolves.toEqual(result);
    expect(replayDestinationCalls).toHaveLength(0);
  });

  test("replays request and approval provenance without exposing credential material", () => {
    const now = { value: 1 };
    const ledger = new InMemorySubmissionLedger();
    const token = "top-secret-token";
    const broker = new SubmissionBroker({
      allowedCompetitions: ["score-file"],
      allowedTargets: ["fake://score-file"],
      allowedCredentialScopes: ["submit:score-file"],
      destination: destination([]),
      clock: () => now.value,
      ledger,
      secrets: [token],
      champion,
    });
    const request = broker.createRequest(requestInput({ credential: { ...credential, token } }));
    broker.approve(request, { acceptedBy: "operator" });

    const restarted = new SubmissionBroker({
      allowedCompetitions: ["score-file"],
      allowedTargets: ["fake://score-file"],
      allowedCredentialScopes: ["submit:score-file"],
      destination: destination([]),
      clock: () => now.value,
      ledger,
      secrets: [token],
      champion,
    });
    expect(restarted.getRequest(request.requestId)).toMatchObject({ requestId: request.requestId, status: "APPROVED" });
    expect(JSON.stringify(ledger.events())).not.toContain(token);
  });

  test("does not treat a standalone approval event as human acceptance", async () => {
    const now = { value: 1 };
    const ledger = new InMemorySubmissionLedger();
    const first = new SubmissionBroker({
      allowedCompetitions: ["score-file"],
      allowedTargets: ["fake://score-file"],
      allowedCredentialScopes: ["submit:score-file"],
      destination: destination([]),
      clock: () => now.value,
      ledger,
      champion,
    });
    const request = first.createRequest(requestInput({ requestId: "forged-approval" }));
    ledger.append({ type: "SUBMISSION_APPROVED", payload: {
      requestId: request.requestId,
      decisionId: "forged",
      championDigest: request.championDigest,
      artifactDigest: request.artifactDigest,
      acceptedBy: "not-a-human-event",
      acceptedAt: now.value,
      expiresAt: request.expiresAt,
    } });
    const calls: unknown[] = [];
    const restarted = new SubmissionBroker({
      allowedCompetitions: ["score-file"],
      allowedTargets: ["fake://score-file"],
      allowedCredentialScopes: ["submit:score-file"],
      destination: destination(calls),
      clock: () => now.value,
      ledger,
      champion,
    });
    await expect(restarted.submit(request, { dryRun: false, credential })).rejects.toMatchObject({ code: "human-acceptance-required" });
    expect(calls).toHaveLength(0);
  });

  test("hydrates a request-scoped human event before an external result", async () => {
    const now = { value: 1 };
    const ledger = new InMemorySubmissionLedger();
    const first = new SubmissionBroker({
      allowedCompetitions: ["score-file"],
      allowedTargets: ["fake://score-file"],
      allowedCredentialScopes: ["submit:score-file"],
      destination: destination([]),
      clock: () => now.value,
      ledger,
      champion,
    });
    const request = first.createRequest(requestInput({ requestId: "human-event-replay" }));
    ledger.append({ type: "HUMAN_ACCEPTED", payload: {
      requestId: request.requestId,
      decisionId: "human-event-1",
      championDigest: request.championDigest,
      acceptedBy: "operator",
      acceptedAt: now.value,
      expiresAt: request.expiresAt,
    } });
    ledger.append({ type: "SUBMISSION_RESULT", payload: {
      requestId: request.requestId,
      mode: "external",
      status: "SUCCEEDED",
      submittedAt: now.value,
      submissionId: "already-submitted",
    } });

    const calls: unknown[] = [];
    const restarted = new SubmissionBroker({
      allowedCompetitions: ["score-file"],
      allowedTargets: ["fake://score-file"],
      allowedCredentialScopes: ["submit:score-file"],
      destination: destination(calls),
      clock: () => now.value,
      ledger,
      champion,
    });
    await expect(restarted.submit(request, { dryRun: false, credential })).resolves.toMatchObject({
      status: "SUCCEEDED", submissionId: "already-submitted",
    });
    expect(calls).toHaveLength(0);
  });

  test("uses the allowlisted scope for a dry run and never upgrades its mode", async () => {
    const now = { value: 1 };
    const calls: unknown[] = [];
    const broker = makeBroker(now, calls);
    const request = broker.createDryRun({
      missionId: champion.missionId,
      competition: "score-file",
      target: "fake://score-file",
      champion,
    });

    expect(request.credentialScopes).toEqual(["submit:score-file"]);
    await expect(broker.submit(request, { dryRun: false })).rejects.toMatchObject({ code: "request-id-conflict" });
    expect(calls).toHaveLength(0);
  });

  test("replays an approved request for one external call and redacts its response", async () => {
    const now = { value: 1 };
    const ledger = new InMemorySubmissionLedger();
    const token = "replay-secret";
    const first = new SubmissionBroker({
      allowedCompetitions: ["score-file"],
      allowedTargets: ["fake://score-file"],
      allowedCredentialScopes: ["submit:score-file"],
      destination: destination([]),
      clock: () => now.value,
      ledger,
      secrets: [token],
      champion,
    });
    const request = first.createRequest(requestInput({ requestId: "replay-submit", credential: { ...credential, token } }));
    first.approve(request, { acceptedBy: "operator" });

    const calls: unknown[] = [];
    const restarted = new SubmissionBroker({
      allowedCompetitions: ["score-file"],
      allowedTargets: ["fake://score-file"],
      allowedCredentialScopes: ["submit:score-file"],
      destination: { submit: () => { calls.push(true); return { echoed: token }; } },
      clock: () => now.value,
      ledger,
      secrets: [token],
      champion,
    });
    const result = await restarted.submit(request, { credential: { ...credential, token }, dryRun: false });

    expect(result.status).toBe("SUCCEEDED");
    expect(result.response?.echoed).toBe("[REDACTED]");
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(ledger.events())).not.toContain(token);
  });

  describe("T42 submission quota + gain threshold", () => {
    /** Champion with an evaluator score; the broker compares gains against it. */
    function scoredChampion(score: number, digest = snapshot.digest): SubmissionChampion {
      const { snapshot: _snapshot, ...eligible } = champion;
      return { ...eligible, championDigest: digest, artifactDigest: digest, score };
    }

    function quotaBroker(
      options: {
        quota?: number;
        gainThreshold?: number;
        champion?: SubmissionChampion;
        ledger?: InMemorySubmissionLedger;
        now?: { value: number };
        calls?: unknown[];
      } = {},
    ) {
      const calls = options.calls ?? [];
      let current = options.champion ?? scoredChampion(10);
      const broker = new SubmissionBroker({
        allowedCompetitions: ["score-file"],
        allowedTargets: ["fake://score-file"],
        allowedCredentialScopes: ["submit:score-file"],
        rateLimit: { maxSubmissions: 100, windowMs: 10 },
        submissionQuota: options.quota,
        gainThreshold: options.gainThreshold,
        destination: destination(calls),
        clock: () => (options.now ?? { value: 1 }).value,
        ledger: options.ledger,
        championProvider: () => current,
      });
      return { broker, calls, setChampion: (next: SubmissionChampion) => { current = next; }, input: (overrides: Record<string, unknown> = {}) => requestInput({ champion: undefined, artifactDigest: undefined, ...overrides }) };
    }

    test("dry-run never consumes submission quota; external results do", async () => {
      const { broker, calls } = quotaBroker({ quota: 1 });
      expect(broker.quotaBalance()).toMatchObject({ limit: 1, used: 0, remaining: 1 });

      const dry = broker.createDryRun({ missionId: champion.missionId, competition: "score-file", target: "fake://score-file", credentialScopes: credential.scopes });
      await broker.submit(dry);
      expect(broker.quotaBalance()).toMatchObject({ limit: 1, used: 0, remaining: 1 });
      expect(calls).toHaveLength(0);

      const request = broker.createRequest(requestInput());
      broker.approve(request, { acceptedBy: "operator" });
      const result = await broker.submit(request, { dryRun: false });
      expect(result.status).toBe("SUCCEEDED");
      expect(calls).toHaveLength(1);
      expect(broker.quotaBalance()).toMatchObject({ limit: 1, used: 1, remaining: 0 });

      const third = broker.createRequest(requestInput({ requestId: "third" }));
      broker.approve(third, { acceptedBy: "operator" });
      await expect(broker.submit(third, { dryRun: false })).rejects.toMatchObject({ code: "submission-quota-exhausted" });
      expect(calls).toHaveLength(1);
      expect(broker.events().at(-1)).toMatchObject({ type: "SUBMISSION_REJECTED", payload: { code: "submission-quota-exhausted" } });
    });

    test("zero configured quota refuses every external submission", async () => {
      const { broker, calls, input } = quotaBroker({ quota: 0 });
      const request = broker.createRequest(input());
      broker.approve(request, { acceptedBy: "operator" });
      await expect(broker.submit(request, { dryRun: false })).rejects.toMatchObject({ code: "submission-quota-exhausted" });
      expect(calls).toHaveLength(0);
    });

    test("passes when the champion gain meets the threshold and refuses below-threshold gains", async () => {
      const ledger = new InMemorySubmissionLedger();
      const { broker, calls, setChampion, input } = quotaBroker({ quota: 10, gainThreshold: 1, champion: scoredChampion(5), ledger });

      // First external submission has no baseline → treated as unlimited gain.
      const first = broker.createRequest(input());
      broker.approve(first, { acceptedBy: "operator" });
      await broker.submit(first, { dryRun: false });
      expect(calls).toHaveLength(1);

      // Same champion, score unchanged → gain 0 < threshold.
      const same = broker.createRequest(input({ requestId: "same" }));
      broker.approve(same, { acceptedBy: "operator" });
      await expect(broker.submit(same, { dryRun: false })).rejects.toMatchObject({ code: "gain-below-threshold" });
      expect(calls).toHaveLength(1);
      expect(broker.events().at(-1)?.payload).toMatchObject({ code: "gain-below-threshold" });

      // +0.4 gain still below threshold 1.
      setChampion(scoredChampion(5.4, "digest-54"));
      const small = broker.createRequest(input({ requestId: "small" }));
      broker.approve(small, { acceptedBy: "operator" });
      await expect(broker.submit(small, { dryRun: false })).rejects.toMatchObject({ code: "gain-below-threshold" });
      expect(calls).toHaveLength(1);

      // +1 gain meets the threshold.
      setChampion(scoredChampion(6, "digest-60"));
      const better = broker.createRequest(input({ requestId: "better" }));
      broker.approve(better, { acceptedBy: "operator" });
      const result = await broker.submit(better, { dryRun: false });
      expect(result.status).toBe("SUCCEEDED");
      expect(calls).toHaveLength(2);
    });

    test("a below-threshold refusal does not consume quota", async () => {
      const { broker, calls, setChampion, input } = quotaBroker({ quota: 2, gainThreshold: 2, champion: scoredChampion(5) });
      const first = broker.createRequest(input());
      broker.approve(first, { acceptedBy: "operator" });
      await broker.submit(first, { dryRun: false });

      setChampion(scoredChampion(5.1, "digest-51"));
      const tiny = broker.createRequest(input({ requestId: "tiny" }));
      broker.approve(tiny, { acceptedBy: "operator" });
      await expect(broker.submit(tiny, { dryRun: false })).rejects.toMatchObject({ code: "gain-below-threshold" });
      expect(broker.quotaBalance()).toMatchObject({ limit: 2, used: 1, remaining: 1 });
      expect(calls).toHaveLength(1);
    });

    test("rehydrates quota balance and gain baseline from the ledger", async () => {
      const ledger = new InMemorySubmissionLedger();
      const first = quotaBroker({ quota: 3, gainThreshold: 1, champion: scoredChampion(5), ledger, calls: [] });
      const request = first.broker.createRequest(first.input());
      first.broker.approve(request, { acceptedBy: "operator" });
      await first.broker.submit(request, { dryRun: false });

      const calls: unknown[] = [];
      const restarted = quotaBroker({ quota: 3, gainThreshold: 1, champion: scoredChampion(5.5, "digest-55"), ledger, calls });
      expect(restarted.broker.quotaBalance()).toMatchObject({ limit: 3, used: 1, remaining: 2 });

      // Baseline 5 → 5.5 is +0.5 < 1: rehydrated baseline must gate the restarted broker.
      const below = restarted.broker.createRequest(restarted.input({ requestId: "restarted-below" }));
      restarted.broker.approve(below, { acceptedBy: "operator" });
      await expect(restarted.broker.submit(below, { dryRun: false })).rejects.toMatchObject({ code: "gain-below-threshold" });
      expect(calls).toHaveLength(0);
    });
    test("never overspends quota under concurrent external submits", async () => {
      const entered: string[] = [];
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const broker = new SubmissionBroker({
        allowedCompetitions: ["score-file"],
        allowedTargets: ["fake://score-file"],
        allowedCredentialScopes: ["submit:score-file"],
        rateLimit: { maxSubmissions: 100, windowMs: 10 },
        submissionQuota: 1,
        gainThreshold: 1,
        championProvider: () => scoredChampion(5),
        clock: () => 1,
        destination: { submit: async (input) => { entered.push(input.request.requestId); await gate; return { submissionId: `ext-${entered.length}` }; } },
      });
      const a = broker.createRequest(requestInput({ champion: undefined, artifactDigest: undefined, requestId: "conc-a" }));
      const b = broker.createRequest(requestInput({ champion: undefined, artifactDigest: undefined, requestId: "conc-b" }));
      broker.approve(a, { acceptedBy: "operator" });
      broker.approve(b, { acceptedBy: "operator" });

      const first = broker.submit(a, { dryRun: false });
      // Wait until the first destination call has actually entered (quota reserved + side effect in flight).
      for (let i = 0; entered.length === 0 && i < 100; i += 1) await Promise.resolve();
      expect(entered).toEqual(["conc-a"]);
      // The second call is refused synchronously against the live reservation; attach the assertion immediately.
      const second = expect(broker.submit(b, { dryRun: false })).rejects.toMatchObject({ code: "submission-quota-exhausted" });
      release!();
      await expect(first).resolves.toMatchObject({ status: "SUCCEEDED" });
      await second;
      expect(entered).toEqual(["conc-a"]);
      expect(broker.quotaBalance()).toMatchObject({ limit: 1, used: 1, remaining: 0 });
    });

    test("refuses to consume real quota when the gain threshold is set but the champion carries no score", async () => {
      const calls: unknown[] = [];
      const { score: _score, ...scoreless } = scoredChampion(6, "digest-60");
      // A scoreless current champion cannot have its gain evaluated.
      const broker = new SubmissionBroker({
        allowedCompetitions: ["score-file"],
        allowedTargets: ["fake://score-file"],
        allowedCredentialScopes: ["submit:score-file"],
        rateLimit: { maxSubmissions: 100, windowMs: 10 },
        submissionQuota: 5,
        gainThreshold: 1,
        championProvider: () => scoreless,
        clock: () => 1,
        destination: destination(calls),
      });
      const request = broker.createRequest(requestInput({ champion: undefined, artifactDigest: undefined }));
      broker.approve(request, { acceptedBy: "operator" });
      await expect(broker.submit(request, { dryRun: false })).rejects.toMatchObject({ code: "gain-below-threshold" });
      expect(calls).toHaveLength(0);
      expect(broker.quotaBalance()).toMatchObject({ limit: 5, used: 0, remaining: 5 });
    });

    test("a FAILED external submission consumes quota but never sets the gain baseline", async () => {
      const calls: unknown[] = [];
      let fail = true;
      const broker = new SubmissionBroker({
        allowedCompetitions: ["score-file"],
        allowedTargets: ["fake://score-file"],
        allowedCredentialScopes: ["submit:score-file"],
        rateLimit: { maxSubmissions: 100, windowMs: 10 },
        submissionQuota: 3,
        gainThreshold: 1,
        championProvider: () => scoredChampion(5),
        clock: () => 1,
        destination: { submit: () => { calls.push(true); if (fail) throw new Error("remote down"); return { submissionId: "ok" }; } },
      });
      const first = broker.createRequest(requestInput({ champion: undefined, artifactDigest: undefined, requestId: "will-fail" }));
      broker.approve(first, { acceptedBy: "operator" });
      const failed = await broker.submit(first, { dryRun: false });
      expect(failed.status).toBe("FAILED");
      expect(broker.quotaBalance()).toMatchObject({ limit: 3, used: 1, remaining: 2 });

      // Same champion score (5) has no successful baseline yet → the gain gate passes.
      fail = false;
      const retry = broker.createRequest(requestInput({ champion: undefined, artifactDigest: undefined, requestId: "will-succeed" }));
      broker.approve(retry, { acceptedBy: "operator" });
      const result = await broker.submit(retry, { dryRun: false });
      expect(result.status).toBe("SUCCEEDED");
      expect(calls).toHaveLength(2);

      // Now baseline 5 is set: the same champion again is below threshold.
      const again = broker.createRequest(requestInput({ champion: undefined, artifactDigest: undefined, requestId: "no-gain" }));
      broker.approve(again, { acceptedBy: "operator" });
      await expect(broker.submit(again, { dryRun: false })).rejects.toMatchObject({ code: "gain-below-threshold" });
    });
  });
});
