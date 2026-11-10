# Subagent Fan-Out: Consolidation Spec v2

status: diagnosis + cleanup plan; A1–A7 delivered (#223–#229). §8 keeps the answered
        questions for reference; no ticket in this series remains open.
supersedes: `docs/subagent-fanout-consolidation.md` v1 (that file is superseded and
            should be replaced by this one)
reviewed: `pi-child-dispatch.ts`, `pi-child-work.ts`, `pi-child-owner.ts`,
          `pi-child-tools.ts`, `pi-child-protocol.ts`, `pi-child-recovery.ts`,
          `pi-child-recruit.ts`, `collaboration-scheduler.ts`, `subagents-adapter.ts`,
          `tests/e2e/pi-child-*.smoke.ts`

## 0. What changed from v1

v1 proposed deleting the whole "subprocess side" including `pi-child-tools.ts`
and `pi-child-recovery.ts`. That was wrong, for three reasons verified by reading
the files again:

E1 — **The metered provider is registered only on the worker side.**
`dispatchPiChild` states in its own header comment that the host must register
the unique `evok-meter-*` provider against a loopback relay *before* calling it.
At the time of writing `registerProvider` appeared only in `pi-child-tools.ts` and
`pi-child-owner.ts` — both were on v1's delete list — with
the only other live example in `tests/e2e/pi-child-dispatch.smoke.ts`, so deleting
per v1 would have left metering inside a test fixture. A2 (#224) answered this
instead of deleting it: the relay and provider registration now live in production
code, `src/execution/pi-child-metering.ts`, owned by the Mission controller
(`src/cli/pi-campaign-director.ts`).

E2 — **The version probe is a precondition, not an improvement.**
`dispatchPiChild` assumes 0.84 semantics (appends `:max` to the model identity);
the installed package is 0.79.1. After deleting the worker path, the one
remaining path is the one incompatible with the installed version.

E3 — **Recovery and tool installation are orthogonal to transport.**
`pi-child-tools.ts` is a provider/scoped-tool installer; `pi-child-recovery.ts`
is a receipt store with run-id and turn-budget validation. Both are needed
regardless of which transport survives.

This revision keeps the goal — one delegation seam, one native transport — and
fixes the deletion boundary.

## 1. Current state

| Artifact | Role | Production callers |
| --- | --- | --- |
| `subagents-adapter.ts` | `SubagentTransport` + authority guard | exported only; none in the Mission mainline |
| `pi-child-dispatch.ts` | event-bus transport (`prompt-template:subagent:*`) | only e2e smoke |
| `pi-child-work.ts` | spawns a `pi` subprocess and drives pi-subagents RPC | only e2e smoke |
| `pi-child-owner.ts` | owner-process extension: RPC, registration, provider | only from `pi-child-work.ts` |
| `pi-child-tools.ts` | provider + scoped-tool installer | from worker path **and required by dispatch's contract** |
| `pi-child-protocol.ts` | control-action schemas and validation | worker path only |
| `pi-child-recovery.ts` | receipt store, run-id and turn-budget checks | worker path only; conceptually transport-independent |
| `collaboration-scheduler.ts` | 578-line DAG scheduler | none outside its own test |

Both native paths drive pi-subagents. The worker path is not an alternative to
the plugin; it is a second, more complex way of doing the same thing.

## 2. Defects to fix

D1 — Version skew and hard-coded plugin path; no capability/version probe.
D2 — Dispatch cancellation rejects immediately and disposes the registration
while the child may still run; the "termination unconfirmed" timer never guards
the returned outcome.
D3 — Owner registration errors bypass error reporting; the caller sees only a
35-second timeout.
D4 — Worker drains and discards child stdout/stderr.
D5 — The worker's real deadline starts after launch; a hard-coded 35 s startup
loop overrides the caller's timeout.
D6 — Provider configs with API keys are written to `<round>.launch.json`, while
other records are stripped; this breaks the no-credentials-in-records boundary.
D7 — Tool-turn accounting is inconsistent: `tool_call` blocks on
`> remaining`, `turn_end` aborts on `>= remaining`, and whether the terminal
control action consumes budget is undefined.
D8 — `collaboration-scheduler.ts` has no production consumer.
D9 — Dispatch requires an empty workspace (`readdir(cwd).length !== 0` throws).
This blocks fork-with-workspace, which is the only form of fork consistent with
ADR-0001. Any fork design must either copy artifacts into a fresh workspace or
introduce an explicit read-only shared-workspace mode.
D10 — Dispatch registers `tools: []`, `toolBudget.hard = 0`, so the child can
only return text. It cannot read Evidence or use scoped tools. This is a real
capability gap, not a defect to preserve accidentally.

## 3. Decision

**One seam, one transport, shared support modules.**

- The only delegation seam is `SubagentTransport` behind
  `createPiSubagentsAdapter`. All authority checks stay in the guard before any
  native registration.
- `pi-child-dispatch.ts` is the single native transport, after the version probe
  and cancellation fixes below.
- `pi-child-tools.ts` is retained and reshaped as the provider/scoped-tool
  installer shared by the transport. It is not deleted with the worker path.
- `pi-child-recovery.ts` is retained as the receipt store used for cancellation
  reconciliation (C4).
- `pi-child-work.ts`, `pi-child-owner.ts`, `pi-child-recruit.ts`, and their e2e
  smoke are deleted. `PiWorkerRequest` is deleted with them.
- `pi-child-protocol.ts` is deleted unless a real requirement for child-issued
  control actions is demonstrated. If that requirement exists, it is designed as
  a separate capability, not preserved by default (answered by A5; see §8 Q1).
- `collaboration-scheduler.ts` is deleted. Concurrency needs are served by
  `Promise.all` over the guarded adapter until a real requirement exists.

The Mission mainline remains sequential by default. Nothing here adds fan-out to
`runMissionController`.

## 4. Required changes

C1 — Version and capability probe before dispatch. Negotiate once per host.
Unsupported protocol ⇒ distinct error naming the detected and required versions;
no child started, no dangling registration. Remove hard-coded bundle paths and
the `:max` identity assumption.

C2 — Metering ownership is explicit. A trusted host-side component creates and
owns the loopback relay and registers `evok-meter-*` before dispatch. Its
lifetime is at least the Mission controller's, not a single child call. The
component lives in production code, not in a test fixture.

C3 — Single request contract. The transport consumes `SubagentDelegation`
post-guard (child slice already derived by `withDelegatedMemory`). Model,
timeout, signal and progress callback are transport options. `PiWorkerRequest`
is removed.

C4 — Confirmed termination. Cancel/timeout resolves only after (a) a terminal
native state for this request id, (b) confirmation the child never started, or
(c) an explicit `termination_unconfirmed` result carrying the request id for
later reconciliation via the retained receipt store. Registration is never
disposed while a cancel is in flight and the child may still be running.

C5 — One deadline covers registration, launch and execution. No separate
hard-coded startup window.

C6 — No credentials in durable records. Provider configs, API keys and tool
tokens stay in memory. Every persisted launch/fence/receipt record is validated
to exclude them before writing; refusal records contain no secret payload.

C7 — Tool-turn rule. A tool turn is a model message containing tool calls. The
terminal control action is exempt from the budget but must be the only call in
its batch. Exhaustion aborts after the allowed calls execute, never before.

C8 — Observable failures. Registration, launch and native crashes produce
redacted diagnostic text. Streams are never drained and discarded.

C9 — Workspace semantics for fork. A delegated child may start with a fresh
empty workspace, or with artifacts copied from a parent snapshot. An explicit
read-only shared-workspace mode is out of scope for this cleanup. The empty-dir
check must not be the only supported path if fork is later enabled.

C10 — Scoped tools for children. If a Task Contract grants a child tools, the
installer exposes only those tools, validated by the same guard. Default remains
no tools. Evidence-reading is opt-in per Task Contract, not a transport default.

## 5. Proposed diff (structure)

```
src/execution/
  subagents-adapter.ts      keep; document as the only delegation seam
  pi-child-dispatch.ts      keep; C1, C3–C5, C8
  pi-child-tools.ts         KEEP + reshape as provider/tool installer (C2, C10)
  pi-child-recovery.ts      KEEP as receipt store (C4, C6)
  pi-child-work.ts          DELETE
  pi-child-owner.ts         DELETE
  pi-child-recruit.ts       DELETE
  pi-child-protocol.ts      KEEP; Q1 answered (§8)
  collaboration-scheduler.ts DELETE
  collaboration-*.test.ts   DELETE with it
  pi-child-*.test.ts        rewrite against the single transport
tests/e2e/
  pi-child-dispatch.smoke.ts keep; point at the installed pi-subagents
  pi-child-work.smoke.ts     DELETE
docs/
  multi-agent-architecture.md one seam, one transport, sequential mainline by default
```

Delivered: `pi-child-work.ts` and its e2e smoke went with #225. `pi-child-owner.ts`
and `collaboration-scheduler.ts` (with `collaboration-scheduler.test.ts` and
`collaboration-questions.test.ts`) went with #227. `pi-child-protocol.ts` stays for
its one live consumer, `src/cli/pi-campaign-director.ts`, which publishes the
Director hire schema (`directorCollaboratorBatch`, `CollaboratorSpec`) from it
(see §8 Q1); relocating that schema out of the Director path was declined, not
deferred. The `pi-child-*.test.ts` rewrite against the single transport
finished in #228 (installer/grant path) and #229 (diagnostics).

## 6. Acceptance tests (existing adapter seam)

T1. Forbidden authorities are rejected before any native registration.
T2. Missing or incompatible pi-subagents ⇒ distinct version error, no child
    started, no dangling registration.
T3. Metering provider is registered by production code before dispatch and
    outlives a single child call.
T4. Cancel after launch: the caller receives a terminal result only after the
    native run is terminal; the same request id reconciles later.
T5. Timeout before launch follows the same rule; no 35-second override.
T6. Parent/sibling/foreign-snapshot slices are refused before the child session
    starts (existing tests keep passing unchanged).
T7. No API key, provider config or tool token appears in any persisted file.
T8. With `remainingToolTurns = 1`, exactly one non-control batch executes and
    the terminal control action still runs, alone.
T9. A native crash produces a redacted diagnostic error, not a bare timeout.
T10. A child granted a scoped Evidence-read tool can use it; an ungranted child
     cannot; tool budget follows C7.
T11. Fork-style delegation from a parent snapshot either copies artifacts into a
     fresh workspace or is explicitly refused; no silent empty-dir assumption.
T12. `bun test --rerun-all-tests`, `bun run typecheck`, `git diff --check` stay at
     the known-failure baseline; no dangling imports of deleted modules.

## 7. Out of scope

- Wiring fan-out into the Mission mainline.
- Cross-Mission Research Memory (M2).
- Any change to evaluator, promotion, admission, budget or submission gates.
- A2A / Agent Card / cross-organisation agent protocols.
- Live paid calls; acceptance uses faux providers and offline smoke.
- Hard process isolation (cgroups, separate uid). Neither current path provides
  an untrusted-process boundary; that would be a separate design.

## 8. Open questions

Q1 — Does any Mission Task Contract actually need child-issued control actions?
If not, `pi-child-protocol.ts` is deleted.
Answered by A5 (#227): yes. `src/cli/pi-campaign-director.ts` is a registered Pi
extension that publishes the Director hire schema from it. Retained rather than
relocated because moving ~200 lines out of the Director path is not a
requirement: the Director path is the schema's only consumer. `pi-child-tools.ts`
has imported its schemas since A6 (#228) wired the installer into the transport,
so both retained modules now have a production importer;
`pi-child-recovery.ts` stays the receipt store (§3) and
`docs/memory-subsystem-prd.md` §9 owns its long-term disposition.
Q2 — Where should the metering relay live in production (CLI launch, Mission
controller, or a dedicated execution-broker component)? C2 requires this to be
answered before implementation, not after.
Q3 — Should fork copy artifacts into a fresh workspace (simpler, extra I/O) or
wait for an explicit read-only shared-workspace design?
