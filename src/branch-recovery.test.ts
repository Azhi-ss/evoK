import { describe, expect, test } from "bun:test";
import { BranchRecoveryControlPlane, InMemoryEventLedger, type BranchRunIdentity, type EventLedger, type JoinPolicy, type LedgerEvent } from "./branch-recovery";

describe("branch recovery control plane", () => {
  test("recovers a completed branch without rerunning it and retries with fresh identity", () => {
    const ledger = new InMemoryEventLedger();
    const policy: JoinPolicy = { required: ["a"], optional: ["b"], quorum: 1, timeoutMs: 1000, terminalFailure: true };
    const first = new BranchRecoveryControlPlane({ missionId: "m", branchIds: ["a", "b"], maxAttempts: 2, budget: 2, joinPolicy: policy, clock: () => 0 }, ledger);
    const run = first.startRun("a")!;
    first.complete(run, { artifactId: "a-1" });
    const restarted = new BranchRecoveryControlPlane({ missionId: "m", branchIds: ["a", "b"], maxAttempts: 2, budget: 2, joinPolicy: policy, clock: () => 0 }, ledger);
    expect(restarted.startRun("a")).toBeUndefined();
    expect(restarted.state().branches.a.status).toBe("COMPLETED");
    const retry = restarted.startRun("b")!;
    expect(retry).toMatchObject({ attempt: 1 });
    expect(retry.runId).not.toBe(run.runId);
    expect(retry.workspaceId).not.toBe(run.workspaceId);
    expect(retry.fencingToken).not.toBe(run.fencingToken);
  });

  test("fences duplicate, stale, out-of-order and non-finite events and audits rejection", () => {
    const control = new BranchRecoveryControlPlane({ missionId: "m", branchIds: ["a"], maxAttempts: 2, budget: 2 });
    const first = control.startRun("a")!;
    const retry = control.retry(first, "infrastructure")!;
    expect(control.state().budget.remainingUnits).toBe(0);
    expect(retry.runId).not.toBe(first.runId);
    expect(control.complete(retry, { artifactId: "new" }, { eventId: "done", sequence: 1 })).toBe(true);
    expect(control.complete(retry, { artifactId: "duplicate" }, { eventId: "done", sequence: 1 })).toBe(false);
    expect(control.complete(first, { artifactId: "stale" })).toBe(false);
    expect(control.complete(retry, { artifactId: "out-of-order" }, { sequence: 0 })).toBe(false);
    expect(control.complete({ ...retry, fencingToken: Number.NaN }, { artifactId: "bad" })).toBe(false);
    expect(control.state().branches.a.artifact?.artifactId).toBe("new");
    expect(control.audit().length).toBeGreaterThanOrEqual(4);
  });

  test("required artifacts, quorum, terminal failures and duplicate promotion are explicit", () => {
    const control = new BranchRecoveryControlPlane({ missionId: "m", branchIds: ["a", "b"], maxAttempts: 1, budget: 2, joinPolicy: { required: ["a"], optional: ["b"], quorum: 2, timeoutMs: 10, terminalFailure: true }, clock: () => 0 });
    const a = control.startRun("a")!;
    const b = control.startRun("b")!;
    control.complete(b, { artifactId: "b-1" });
    expect(control.promote(b)).toBe(true);
    expect(control.promote(b)).toBe(false);
    control.complete(a);
    expect(control.join()).toMatchObject({ released: false, closed: true });
    expect(control.cancel(a)).toBe(false);
  });

  test("cancel, quarantine and watchdog do not auto-retry", () => {
    let now = 0;
    const control = new BranchRecoveryControlPlane({ missionId: "m", branchIds: ["a", "b", "c"], maxAttempts: 2, budget: 3, joinPolicy: { required: ["a"], optional: ["b", "c"], quorum: 1, timeoutMs: 5, terminalFailure: false }, clock: () => now });
    const a = control.startRun("a")!;
    expect(control.cancel(a)).toBe(true);
    expect(control.complete(a, { artifactId: "late-cancel" })).toBe(false);
    expect(control.retry(a, "infrastructure")).toBeUndefined();
    const b = control.startRun("b")!;
    expect(control.quarantine(b)).toBe(true);
    expect(control.retry(b, "infrastructure")).toBeUndefined();
    const c = control.startRun("c")!;
    now = 5;
    expect(control.watchdog()).toBe(1);
    expect(control.retry(c, "infrastructure")).toBeUndefined();
  });

  test("validates join policy bounds", () => {
    expect(() => new BranchRecoveryControlPlane({ missionId: "m", branchIds: ["a"], joinPolicy: { required: [], optional: [], quorum: 0, timeoutMs: 1, terminalFailure: true } })).toThrow();
    expect(() => new BranchRecoveryControlPlane({ missionId: "m", branchIds: ["a"], joinPolicy: { required: ["x"], optional: [], quorum: 1, timeoutMs: 1, terminalFailure: true } })).toThrow();
    expect(() => new BranchRecoveryControlPlane({ missionId: "m", branchIds: ["a"], joinPolicy: { required: ["a"], optional: [], quorum: 2, timeoutMs: 1, terminalFailure: true } })).toThrow();
    expect(() => new BranchRecoveryControlPlane({ missionId: "m", branchIds: ["a"], joinPolicy: { required: ["a"], optional: ["a"], quorum: 1, timeoutMs: 1, terminalFailure: true } })).toThrow();
    expect(() => new BranchRecoveryControlPlane({ missionId: "m", branchIds: ["a", "b"], joinPolicy: { required: ["a"], optional: [], quorum: 1, timeoutMs: 1, terminalFailure: true } })).toThrow();
  });

  test("replays an unstarted reservation exactly once after a partial start", () => {
    const ledger = new InMemoryEventLedger();
    const identity = {
      branchId: "a",
      runId: "partial:a:run-1",
      attempt: 1,
      workspaceId: "partial:a:workspace-1",
      fencingToken: 1,
    } as const;
    ledger.append({ type: "BUDGET_RESERVED", payload: { identity, units: 1 } });
    ledger.append({ type: "BUDGET_RESERVED", payload: { identity, units: 1 } });
    const control = new BranchRecoveryControlPlane({ missionId: "partial", branchIds: ["a"], maxAttempts: 1, budget: 1, joinPolicy: { required: ["a"], optional: [], quorum: 1, timeoutMs: 100, terminalFailure: true }, clock: () => 0 }, ledger);
    expect(control.startRun("a")).toEqual(identity);
    expect(control.startRun("a")).toEqual(identity);
    expect(control.state().budget.remainingUnits).toBe(0);
    expect(control.join().closed).toBe(false);
    expect(control.events().filter((event) => event.type === "BUDGET_RESERVED")).toHaveLength(2);
    expect(control.events().filter((event) => event.type === "RUN_STARTED")).toHaveLength(1);
  });

  test("closes when budget exhaustion makes required and quorum artifacts impossible", () => {
    const ledger = new InMemoryEventLedger();
    const options = { missionId: "budget-exhausted", branchIds: ["a", "b"], maxAttempts: 2, budget: 1, joinPolicy: { required: ["a"], optional: ["b"], quorum: 2, timeoutMs: 100, terminalFailure: true } } as const;
    const control = new BranchRecoveryControlPlane(options, ledger);
    const a = control.startRun("a")!;
    expect(control.state().budget.remainingUnits).toBe(0);
    expect(control.retry(a, "infrastructure")).toBeUndefined();
    expect(control.state().branches.b.status).toBe("QUEUED");
    expect(control.join()).toMatchObject({ released: false, closed: true, reason: "join terminal failure" });
  });

  test("closes when an exhausted required branch fails even if quorum is met by optional output", () => {
    const ledger = new InMemoryEventLedger();
    const options = { missionId: "failed-required", branchIds: ["a", "b"], maxAttempts: 1, budget: 2, joinPolicy: { required: ["a"], optional: ["b"], quorum: 1, timeoutMs: 100, terminalFailure: true } } as const;
    const control = new BranchRecoveryControlPlane(options, ledger);
    const a = control.startRun("a")!;
    expect(control.retry(a, "infrastructure")).toBeUndefined();
    const b = control.startRun("b")!;
    control.complete(b, { artifactId: "b-1" });
    expect(control.join().closed).toBe(true);
    expect(control.releaseDownstream()).toBe(false);
    expect(new BranchRecoveryControlPlane(options, ledger).join().closed).toBe(true);
  });

  test("keeps quorum open when an available optional artifact still needs a queued required branch", () => {
    const control = new BranchRecoveryControlPlane({ missionId: "queued-required", branchIds: ["a", "b"], maxAttempts: 1, budget: 2, joinPolicy: { required: ["a"], optional: ["b"], quorum: 2, timeoutMs: 100, terminalFailure: true } });
    const b = control.startRun("b")!;
    control.complete(b, { artifactId: "b-1" });
    control.promote(b);
    expect(control.join().closed).toBe(false);
    expect(control.join().released).toBe(false);
  });

  test("replays an in-flight run and preserves budget and event sequence fences", () => {
    const ledger = new InMemoryEventLedger();
    const options = { missionId: "restart", branchIds: ["a"], maxAttempts: 1, budget: 1, joinPolicy: { required: ["a"], optional: [], quorum: 1, timeoutMs: 100, terminalFailure: true } } as const;
    const first = new BranchRecoveryControlPlane(options, ledger);
    const run = first.startRun("a")!;
    const restarted = new BranchRecoveryControlPlane(options, ledger);
    expect(restarted.state().branches.a.run).toEqual(run);
    expect(restarted.state().budget.remainingUnits).toBe(0);
    expect(restarted.complete(run, { artifactId: "a-1" }, { eventId: "complete", sequence: 1 })).toBe(true);
    expect(restarted.complete(run, { artifactId: "a-2" }, { eventId: "another", sequence: 1 })).toBe(false);
    expect(restarted.audit().at(-1)?.payload.reason).toBe("out-of-order event sequence");
    expect(restarted.events().filter((event) => event.type === "BUDGET_RESERVED")).toHaveLength(1);
  });

  test("enforces one-unit budget and one attempt without implicit retry", () => {
    const control = new BranchRecoveryControlPlane({ missionId: "limits", branchIds: ["a", "b"], maxAttempts: 1, budget: 1 });
    const run = control.startRun("a")!;
    expect(control.startRun("b")).toBeUndefined();
    expect(control.retry(run, "infrastructure")).toBeUndefined();
    expect(control.state().branches.a.status).toBe("FAILED");
    expect(control.events().filter((event) => event.type === "BUDGET_RESERVED")).toHaveLength(1);
  });

  test("closes a timed-out join and records the watchdog expiry", () => {
    let now = 0;
    const control = new BranchRecoveryControlPlane({ missionId: "timeout", branchIds: ["a"], maxAttempts: 1, budget: 1, joinPolicy: { required: ["a"], optional: [], quorum: 1, timeoutMs: 5, terminalFailure: true }, clock: () => now });
    const run = control.startRun("a")!;
    now = 5;
    expect(control.join().closed).toBe(true);
    expect(control.watchdog()).toBe(1);
    expect(control.complete(run, { artifactId: "late-watchdog" })).toBe(false);
    expect(control.state().branches.a.status).toBe("EXPIRED");
    expect(control.retry(run, "infrastructure")).toBeUndefined();
    expect(control.audit().some((event) => event.payload.reason === "join is closed")).toBe(true);
  });

  test("releases a completed required artifact with the default policy", () => {
    const control = new BranchRecoveryControlPlane({ missionId: "default-release", branchIds: ["a"], budget: 1 });
    const run = control.startRun("a")!;
    control.complete(run, { artifactId: "a-1" });

    expect(control.releaseDownstream()).toBe(true);
  });

  test("persists a successful join release and replays it without duplicate release events", () => {
    const ledger = new InMemoryEventLedger();
    const options = { missionId: "release", branchIds: ["a"], maxAttempts: 1, budget: 1, joinPolicy: { required: ["a"], optional: [], quorum: 1, timeoutMs: 100, terminalFailure: true } } as const;
    const control = new BranchRecoveryControlPlane(options, ledger);
    const run = control.startRun("a")!;
    control.complete(run, { artifactId: "a-1" });

    expect(control.releaseDownstream()).toBe(true);
    expect(control.join()).toMatchObject({ released: true, closed: false });
    expect(control.events().filter((event) => event.type === "JOIN_RELEASED")).toHaveLength(1);

    const restarted = new BranchRecoveryControlPlane(options, ledger);
    expect(restarted.state().join).toMatchObject({ released: true, closed: false });
    expect(restarted.releaseDownstream()).toBe(true);
    expect(restarted.events().filter((event) => event.type === "JOIN_RELEASED")).toHaveLength(1);
  });

  test("does not replay an unreserved start or let it supersede a live run", () => {
    const identity = (attempt: number, fencingToken: number): BranchRunIdentity => ({
      branchId: "a",
      runId: `forged:a:run-${attempt}`,
      attempt,
      workspaceId: `forged:a:workspace-${attempt}`,
      fencingToken,
    });
    const ledger = new InMemoryEventLedger();
    const first = identity(1, 1);
    const second = identity(2, 2);
    ledger.append({ type: "RUN_STARTED", payload: { identity: first, startedAt: 0 } });
    ledger.append({ type: "BUDGET_RESERVED", payload: { identity: second, units: 1 } });
    ledger.append({ type: "RUN_STARTED", payload: { identity: second, startedAt: 1 } });

    const control = new BranchRecoveryControlPlane({ missionId: "forged", branchIds: ["a"], maxAttempts: 2, budget: 2, joinPolicy: { required: ["a"], optional: [], quorum: 1, timeoutMs: 100, terminalFailure: true }, clock: () => 0 }, ledger);

    expect(control.state().branches.a.status).toBe("QUEUED");
    expect(control.state().branches.a.run).toBeUndefined();
    expect(control.state().budget.remainingUnits).toBe(2);
    const legitimate = control.startRun("a")!;
    expect(legitimate.attempt).toBe(1);
    expect(legitimate.fencingToken).toBe(1);
  });

  test("persists derived terminal join closure before a restart", () => {
    const ledger = new InMemoryEventLedger();
    const options = { missionId: "durable-close", branchIds: ["a", "b"], maxAttempts: 1, budget: 1, joinPolicy: { required: ["a"], optional: ["b"], quorum: 2, timeoutMs: 100, terminalFailure: true } } as const;
    const control = new BranchRecoveryControlPlane(options, ledger);
    const run = control.startRun("a")!;
    expect(control.complete(run)).toBe(true);
    expect(control.events().filter((event) => event.type === "JOIN_CLOSED")).toHaveLength(1);

    const restarted = new BranchRecoveryControlPlane(options, ledger);
    expect(restarted.state().join).toMatchObject({ released: false, closed: true, reason: "join terminal failure" });
    expect(restarted.events().filter((event) => event.type === "JOIN_CLOSED")).toHaveLength(1);
  });

  test("does not replay skipped attempts or reservations beyond the available budget", () => {
    const ledger = new InMemoryEventLedger();
    const identity = (branchId: string, attempt: number, fencingToken: number): BranchRunIdentity => ({
      branchId,
      runId: `limits:${branchId}:run-${attempt}`,
      attempt,
      workspaceId: `limits:${branchId}:workspace-${attempt}`,
      fencingToken,
    });
    const a1 = identity("a", 1, 1);
    const a2 = identity("a", 2, 2);
    const b1 = identity("b", 1, 3);
    ledger.append({ type: "BUDGET_RESERVED", payload: { identity: a1, units: 1 } });
    ledger.append({ type: "RUN_STARTED", payload: { identity: a1, startedAt: 0 } });
    ledger.append({ type: "RUN_FAILED", payload: { identity: a1, reason: "infrastructure" } });
    ledger.append({ type: "BUDGET_RESERVED", payload: { identity: a2, units: 1 } });
    ledger.append({ type: "RUN_STARTED", payload: { identity: a2, startedAt: 1 } });
    ledger.append({ type: "BUDGET_RESERVED", payload: { identity: b1, units: 1 } });
    ledger.append({ type: "RUN_STARTED", payload: { identity: b1, startedAt: 2 } });

    const control = new BranchRecoveryControlPlane({ missionId: "limits", branchIds: ["a", "b"], maxAttempts: 1, budget: 1, joinPolicy: { required: ["a", "b"], optional: [], quorum: 2, timeoutMs: 100, terminalFailure: true }, clock: () => 0 }, ledger);

    expect(control.state().branches.a).toMatchObject({ status: "FAILED", attempt: 1 });
    expect(control.state().branches.b).toMatchObject({ status: "QUEUED", attempt: 0 });
    expect(control.state().budget.remainingUnits).toBe(0);
  });

  test("replay enforces monotonic event sequences and legal source states", () => {
    const ledger = new InMemoryEventLedger();
    const control = new BranchRecoveryControlPlane({ missionId: "ordering", branchIds: ["a"], maxAttempts: 1, budget: 1, joinPolicy: { required: ["a"], optional: [], quorum: 1, timeoutMs: 100, terminalFailure: true }, clock: () => 0 }, ledger);
    const run = control.startRun("a")!;
    ledger.append({ type: "RUN_COMPLETED", payload: { identity: run, eventSequence: 2, artifact: { artifactId: "a-1" } } });
    ledger.append({ type: "RUN_FAILED", payload: { identity: run, eventSequence: 1, reason: "late failure" } });
    ledger.append({ type: "RUN_CANCELLED", payload: { identity: run, eventSequence: 3, reason: "late cancel" } });

    const replayed = new BranchRecoveryControlPlane({ missionId: "ordering", branchIds: ["a"], maxAttempts: 1, budget: 1, joinPolicy: { required: ["a"], optional: [], quorum: 1, timeoutMs: 100, terminalFailure: true }, clock: () => 0 }, ledger);

    expect(replayed.state().branches.a.status).toBe("COMPLETED");
    expect(replayed.state().branches.a.artifact?.artifactId).toBe("a-1");
  });

  test("does not accept a malformed start timestamp and allows durable start repair", () => {
    const ledger = new InMemoryEventLedger();
    const identity: BranchRunIdentity = { branchId: "a", runId: "timestamp:a:run-1", attempt: 1, workspaceId: "timestamp:a:workspace-1", fencingToken: 1 };
    ledger.append({ type: "BUDGET_RESERVED", payload: { identity, units: 1 } });
    ledger.append({ type: "RUN_STARTED", payload: { identity, startedAt: Number.NaN } });
    const control = new BranchRecoveryControlPlane({ missionId: "timestamp", branchIds: ["a"], maxAttempts: 1, budget: 1, joinPolicy: { required: ["a"], optional: [], quorum: 1, timeoutMs: 10, terminalFailure: true }, clock: () => 0 }, ledger);

    expect(control.state().branches.a.status).toBe("QUEUED");
    expect(control.startRun("a")).toEqual(identity);
    expect(control.state().branches.a.status).toBe("RUNNING");
  });

  test("does not honor a forged release without the required artifacts", () => {
    const ledger = new InMemoryEventLedger();
    ledger.append({ type: "JOIN_RELEASED", payload: { requiredArtifacts: ["a"], optionalArtifacts: [] } });
    const options = { missionId: "forged-release", branchIds: ["a"], maxAttempts: 1, budget: 1, joinPolicy: { required: ["a"], optional: [], quorum: 1, timeoutMs: 100, terminalFailure: true } } as const;
    const control = new BranchRecoveryControlPlane(options, ledger);

    expect(control.state().join.released).toBe(false);
    expect(control.releaseDownstream()).toBe(false);
    expect(control.state().branches.a.status).toBe("QUEUED");
  });

  test("caps quorum feasibility by the remaining reservation budget", () => {
    const control = new BranchRecoveryControlPlane({ missionId: "capacity", branchIds: ["a", "b"], maxAttempts: 2, budget: 1, joinPolicy: { required: ["a", "b"], optional: [], quorum: 2, timeoutMs: 100, terminalFailure: true } });

    expect(control.join()).toMatchObject({ released: false, closed: true, reason: "join terminal failure" });
    expect(control.events().filter((event) => event.type === "JOIN_CLOSED")).toHaveLength(1);
  });

  test("rejects a forged join closure and keeps recovery open", () => {
    const ledger = new InMemoryEventLedger();
    ledger.append({ type: "JOIN_CLOSED", payload: { reason: "join terminal failure", closedAt: 0 } });
    const options = { missionId: "forged-close", branchIds: ["a"], maxAttempts: 1, budget: 1, joinPolicy: { required: ["a"], optional: [], quorum: 1, timeoutMs: 100, terminalFailure: true } } as const;
    const control = new BranchRecoveryControlPlane(options, ledger);

    expect(control.state().join.closed).toBe(false);
    expect(control.audit().some((event) => event.payload.sourceType === "JOIN_CLOSED")).toBe(true);
    const restarted = new BranchRecoveryControlPlane(options, ledger);
    expect(restarted.state().join.closed).toBe(false);
    expect(restarted.events().filter((event) => event.type === "EVENT_REJECTED")).toHaveLength(1);
  });

  test("audits a stale replayed completion after an infrastructure retry", () => {
    const ledger = new InMemoryEventLedger();
    const options = { missionId: "stale-replay", branchIds: ["a"], maxAttempts: 2, budget: 2, joinPolicy: { required: ["a"], optional: [], quorum: 1, timeoutMs: 100, terminalFailure: true } } as const;
    const control = new BranchRecoveryControlPlane(options, ledger);
    const first = control.startRun("a")!;
    const retry = control.retry(first, "infrastructure")!;
    ledger.append({ type: "RUN_COMPLETED", payload: { identity: first, artifact: { artifactId: "old" } } });

    const restarted = new BranchRecoveryControlPlane(options, ledger);
    expect(restarted.state().branches.a.run).toEqual(retry);
    expect(restarted.state().branches.a.artifact).toBeUndefined();
    expect(restarted.audit().some((event) => event.payload.sourceType === "RUN_COMPLETED")).toBe(true);
  });

  test("replays a persisted timeout closure", () => {
    let now = 0;
    const ledger = new InMemoryEventLedger();
    const options = { missionId: "timeout-replay", branchIds: ["a"], maxAttempts: 1, budget: 1, joinPolicy: { required: ["a"], optional: [], quorum: 1, timeoutMs: 5, terminalFailure: true } } as const;
    const control = new BranchRecoveryControlPlane({ ...options, clock: () => now }, ledger);
    control.startRun("a");
    now = 5;
    expect(control.join().closed).toBe(true);

    now = 0;
    const restarted = new BranchRecoveryControlPlane({ ...options, clock: () => now }, ledger);
    expect(restarted.state().join.closed).toBe(true);
  });

  test("replays watchdog expiry after the recovery clock resets", () => {
    let now = 0;
    const ledger = new InMemoryEventLedger();
    const options = { missionId: "watchdog-replay", branchIds: ["a"], budget: 1, joinPolicy: { required: ["a"], optional: [], quorum: 1, timeoutMs: 5, terminalFailure: true } } as const;
    const control = new BranchRecoveryControlPlane({ ...options, clock: () => now }, ledger);
    control.startRun("a");
    now = 5;
    expect(control.watchdog()).toBe(1);

    now = 0;
    const restarted = new BranchRecoveryControlPlane({ ...options, clock: () => now }, ledger);
    expect(restarted.state().branches.a.status).toBe("EXPIRED");
    expect(restarted.state().join.closed).toBe(true);
  });

  test("does not replay timeout closure when terminal failure is disabled", () => {
    let now = 0;
    const ledger = new InMemoryEventLedger();
    const options = { missionId: "nonterminal-timeout", branchIds: ["a"], budget: 1, joinPolicy: { required: ["a"], optional: [], quorum: 1, timeoutMs: 5, terminalFailure: false } } as const;
    const control = new BranchRecoveryControlPlane({ ...options, clock: () => now }, ledger);
    const run = control.startRun("a")!;
    const scopeId = ledger.events()[0]!.payload.scopeId;
    now = 5;
    ledger.append({ type: "JOIN_TIMEOUT_OBSERVED", payload: { missionId: "nonterminal-timeout", scopeId, observedAt: 5, identities: [run] } });
    ledger.append({ type: "JOIN_CLOSED", payload: { missionId: "nonterminal-timeout", scopeId, reason: "join terminal failure", closedAt: 5, requiredArtifacts: [], optionalArtifacts: [] } });

    expect(control.state().join.closed).toBe(false);
    expect(control.audit().some((event) => event.payload.sourceType === "JOIN_CLOSED")).toBe(true);
  });

  test("does not trust a future timeout timestamp in a replayed closure", () => {
    const ledger = new InMemoryEventLedger();
    const options = { missionId: "future-close", branchIds: ["a"], maxAttempts: 1, budget: 1, joinPolicy: { required: ["a"], optional: [], quorum: 1, timeoutMs: 100, terminalFailure: true }, clock: () => 0 } as const;
    const control = new BranchRecoveryControlPlane(options, ledger);
    const run = control.startRun("a")!;
    ledger.append({ type: "JOIN_CLOSED", payload: { reason: "join terminal failure", closedAt: 1000, requiredArtifacts: [], optionalArtifacts: [] } });

    expect(control.state().branches.a.run).toEqual(run);
    expect(control.state().join.closed).toBe(false);
    expect(control.audit().some((event) => event.payload.sourceType === "JOIN_CLOSED")).toBe(true);
  });

  test("does not replay a non-infrastructure failure as retryable", () => {
    const ledger = new InMemoryEventLedger();
    const options = { missionId: "failure-reason", branchIds: ["a"], maxAttempts: 2, budget: 2, joinPolicy: { required: ["a"], optional: [], quorum: 1, timeoutMs: 100, terminalFailure: true }, clock: () => 0 } as const;
    const control = new BranchRecoveryControlPlane(options, ledger);
    const run = control.startRun("a")!;
    ledger.append({ type: "RUN_FAILED", payload: { identity: run, reason: "cancel" } });

    expect(control.state().branches.a.status).toBe("RUNNING");
    expect(control.startRun("a")).toEqual(run);
    expect(control.audit().some((event) => event.payload.sourceType === "RUN_FAILED")).toBe(true);
  });

  test("audits conflicting duplicate reservation and start payloads", () => {
    const ledger = new InMemoryEventLedger();
    const options = { missionId: "duplicate-payload", branchIds: ["a"], maxAttempts: 1, budget: 1, joinPolicy: { required: ["a"], optional: [], quorum: 1, timeoutMs: 100, terminalFailure: true }, clock: () => 0 } as const;
    const control = new BranchRecoveryControlPlane(options, ledger);
    const run = control.startRun("a")!;
    ledger.append({ type: "BUDGET_RESERVED", payload: { identity: run, units: 999 } });
    ledger.append({ type: "RUN_STARTED", payload: { identity: run, startedAt: 999 } });

    expect(control.state().branches.a.status).toBe("RUNNING");
    expect(control.audit().filter((event) => event.payload.sourceType === "BUDGET_RESERVED" || event.payload.sourceType === "RUN_STARTED")).toHaveLength(2);
  });

  test("keeps missions isolated when a ledger is reused", () => {
    const ledger = new InMemoryEventLedger();
    const base = { branchIds: ["a"], maxAttempts: 1, budget: 1, joinPolicy: { required: ["a"], optional: [], quorum: 1, timeoutMs: 100, terminalFailure: true }, clock: () => 0 } as const;
    const first = new BranchRecoveryControlPlane({ missionId: "mission-a", ...base }, ledger);
    const run = first.startRun("a")!;
    first.complete(run, { artifactId: "a-1" });
    expect(first.releaseDownstream()).toBe(true);

    const second = new BranchRecoveryControlPlane({ missionId: "mission-b", ...base }, ledger);
    expect(second.state().branches.a.status).toBe("QUEUED");
    expect(second.state().join.released).toBe(false);
    expect(second.audit().some((event) => event.payload.reason === "event belongs to another mission or ledger scope")).toBe(true);
  });

  test("rejects unsafe fencing values and never returns an unstarted retry", () => {
    const unsafeLedger = new InMemoryEventLedger();
    const unsafeIdentity = { branchId: "a", runId: "unsafe", attempt: 1, workspaceId: "unsafe", fencingToken: Number.MAX_SAFE_INTEGER + 1 };
    unsafeLedger.append({ type: "BUDGET_RESERVED", payload: { identity: unsafeIdentity, units: 1 } });
    unsafeLedger.append({ type: "RUN_STARTED", payload: { identity: unsafeIdentity, startedAt: 0 } });
    const options = { missionId: "unsafe-fence", branchIds: ["a"], maxAttempts: 2, budget: 2, joinPolicy: { required: ["a"], optional: [], quorum: 1, timeoutMs: 100, terminalFailure: true }, clock: () => 0 } as const;
    const unsafe = new BranchRecoveryControlPlane(options, unsafeLedger);
    expect(unsafe.state().branches.a.status).toBe("QUEUED");
    expect(unsafe.startRun("a")?.fencingToken).toBe(1);

    const retryLedger = new InMemoryEventLedger();
    const nearLimit: BranchRunIdentity = { branchId: "a", runId: "unsafe-fence:a:run-1", attempt: 1, workspaceId: "unsafe-fence:a:workspace-1", fencingToken: Number.MAX_SAFE_INTEGER - 1 };
    retryLedger.append({ type: "BUDGET_RESERVED", payload: { identity: nearLimit, units: 1 } });
    retryLedger.append({ type: "RUN_STARTED", payload: { identity: nearLimit, startedAt: 0 } });
    const retryControl = new BranchRecoveryControlPlane(options, retryLedger);
    expect(retryControl.retry(nearLimit, "infrastructure")).toBeUndefined();
    expect(retryControl.state().branches.a.status).toBe("FAILED");
    expect(retryControl.events().filter((event) => event.type === "RUN_STARTED")).toHaveLength(1);
  });

  test("binds scoped run identities to their mission", () => {
    const options = { missionId: "scope", branchIds: ["a"], budget: 1, joinPolicy: { required: ["a"], optional: [], quorum: 1, timeoutMs: 100, terminalFailure: true }, clock: () => 0 } as const;
    const seedLedger = new InMemoryEventLedger();
    new BranchRecoveryControlPlane(options, seedLedger).startRun("a");
    const scopeId = seedLedger.events()[0]!.payload.scopeId;
    const foreign: BranchRunIdentity = { branchId: "a", runId: "other:a:run-1", attempt: 1, workspaceId: "other:a:workspace-1", fencingToken: 1 };
    const ledger = new InMemoryEventLedger();
    ledger.append({ type: "BUDGET_RESERVED", payload: { missionId: "scope", scopeId, identity: foreign, units: 1 } });
    ledger.append({ type: "RUN_STARTED", payload: { missionId: "scope", scopeId, identity: foreign, startedAt: 0 } });

    const control = new BranchRecoveryControlPlane(options, ledger);
    expect(control.state().branches.a.status).toBe("QUEUED");
    expect(control.state().budget.remainingUnits).toBe(1);
    expect(control.audit().filter((event) => event.payload.reason === "event belongs to another mission or ledger scope")).toHaveLength(2);
  });

  test("terminal join closure fences later starts and run events", () => {
    let now = 0;
    const ledger = new InMemoryEventLedger();
    const options = { missionId: "closed", branchIds: ["a", "b"], budget: 2, joinPolicy: { required: ["a"], optional: ["b"], quorum: 1, timeoutMs: 5, terminalFailure: true } } as const;
    const control = new BranchRecoveryControlPlane({ ...options, clock: () => now }, ledger);
    const run = control.startRun("a")!;
    now = 5;
    expect(control.join().closed).toBe(true);
    expect(control.startRun("a")).toBeUndefined();
    expect(control.startRun("b")).toBeUndefined();
    expect(control.complete(run, { artifactId: "late" })).toBe(false);
    ledger.append({ type: "RUN_COMPLETED", payload: { identity: run, artifact: { artifactId: "forged-late" } } });

    const restarted = new BranchRecoveryControlPlane({ ...options, clock: () => now }, ledger);
    expect(restarted.state().branches.a).toMatchObject({ status: "RUNNING", artifact: undefined });
    expect(restarted.state().branches.b.status).toBe("QUEUED");
    expect(restarted.audit().some((event) => event.payload.sourceType === "RUN_COMPLETED" && event.payload.reason === "join is closed")).toBe(true);
  });

  test("rejects inherited identity and artifact fields", () => {
    const control = new BranchRecoveryControlPlane({ missionId: "own-fields", branchIds: ["a"], budget: 1, joinPolicy: { required: ["a"], optional: [], quorum: 1, timeoutMs: 100, terminalFailure: true } });
    const run = control.startRun("a")!;
    const inheritedIdentity = Object.create(run) as BranchRunIdentity;
    const inheritedArtifact = Object.create({ artifactId: "inherited" }) as { artifactId: string };

    expect(control.complete(inheritedIdentity, { artifactId: "bad" })).toBe(false);
    expect(control.complete(run, inheritedArtifact)).toBe(false);
    expect(control.state().branches.a.status).toBe("RUNNING");
  });

  test("audits unknown ledger event types", () => {
    const ledger = new InMemoryEventLedger();
    const control = new BranchRecoveryControlPlane({ missionId: "unknown-event", branchIds: ["a"], budget: 1 }, ledger);
    ledger.append({ type: "RUN_COMPELTED" as never, payload: {} });

    expect(control.audit().some((event) => event.payload.reason === "unknown ledger event type")).toBe(true);
  });

  test("keeps released artifact evidence fixed", () => {
    const ledger = new InMemoryEventLedger();
    const options = { missionId: "release-evidence", branchIds: ["a", "b"], budget: 2, joinPolicy: { required: ["a"], optional: ["b"], quorum: 1, timeoutMs: 100, terminalFailure: true } } as const;
    const control = new BranchRecoveryControlPlane(options, ledger);
    const a = control.startRun("a")!;
    control.complete(a, { artifactId: "a-1" });
    expect(control.join()).toMatchObject({ released: true, requiredArtifacts: ["a"], optionalArtifacts: [] });
    const b = control.startRun("b")!;
    control.complete(b, { artifactId: "b-1" });

    expect(control.state().join).toMatchObject({ released: true, requiredArtifacts: ["a"], optionalArtifacts: [] });
    expect(new BranchRecoveryControlPlane(options, ledger).state().join).toMatchObject({ released: true, requiredArtifacts: ["a"], optionalArtifacts: [] });
  });

  test("reports failure when a ledger rejects an accepted completion", () => {
    const entries: LedgerEvent[] = [];
    const ledger: EventLedger = {
      append(event) {
        const payload = event.type === "RUN_COMPLETED"
          ? { ...event.payload, identity: { ...(event.payload.identity as BranchRunIdentity), fencingToken: 999 } }
          : event.payload;
        const entry = { ...event, payload, sequence: entries.length + 1 } as LedgerEvent;
        entries.push(entry);
        return entry;
      },
      events: () => entries,
    };
    const control = new BranchRecoveryControlPlane({ missionId: "mutating-ledger", branchIds: ["a"], budget: 1, joinPolicy: { required: ["a"], optional: [], quorum: 1, timeoutMs: 100, terminalFailure: true } }, ledger);
    const run = control.startRun("a")!;

    expect(control.complete(run, { artifactId: "a-1" })).toBe(false);
    expect(control.state().branches.a.status).toBe("RUNNING");
  });

  test("audits duplicate ledger sequences instead of collapsing distinct events", () => {
    const entries: LedgerEvent[] = [];
    const ledger: EventLedger = {
      append(event) {
        const entry = { ...event, sequence: entries.length + 1 } as LedgerEvent;
        entries.push(entry);
        return entry;
      },
      events: () => entries,
    };
    const a: BranchRunIdentity = { branchId: "a", runId: "sequence:a:run-1", attempt: 1, workspaceId: "sequence:a:workspace-1", fencingToken: 1 };
    const b: BranchRunIdentity = { branchId: "b", runId: "sequence:b:run-1", attempt: 1, workspaceId: "sequence:b:workspace-1", fencingToken: 2 };
    entries.push(
      { sequence: 1, type: "BUDGET_RESERVED", payload: { identity: a, units: 1 } },
      { sequence: 1, type: "BUDGET_RESERVED", payload: { identity: b, units: 1 } },
    );
    const control = new BranchRecoveryControlPlane({ missionId: "sequence", branchIds: ["a", "b"], budget: 2, joinPolicy: { required: ["a", "b"], optional: [], quorum: 2, timeoutMs: 100, terminalFailure: true } }, ledger);

    expect(control.state().budget.remainingUnits).toBe(1);
    expect(control.state().branches.a.status).toBe("QUEUED");
    expect(control.state().branches.b.status).toBe("QUEUED");
    expect(control.audit().some((event) => event.payload.reason === "duplicate ledger sequence")).toBe(true);
  });
});
