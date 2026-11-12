# Harness capability map

`src/harness/` is the capability that **executes** (PRD §3 B1–B4, §4 Stage 3;
#253/#256). It is the eighth physical directory, not a seventh logical owner: the
six-pack authority map in ADR-0007 is unchanged, and the harness owns no gate,
score, promotion, admission, budget, T48, hang or submission decision. It never
imports `src/mission/` or an evaluator (`scripts/import-boundaries.ts`).

`src/harness/index.ts` is the only public export surface: code outside the
directory imports from `src/harness`, never from a module in it, and the names
are listed explicitly (the `src/memory/` precedent) so a new file cannot become
public by existing.

Do not confuse it with **ToyHarness** (`src/toy-harness.ts`), which is offline
fixtures and tests. `src/harness/` is product execution.

## The seam, in order

| Step | Module | Symbols | Boundary |
|---|---|---|---|
| Shared shapes (environment, artifact collection) | `src/harness/contracts.ts` | `EnvironmentSnapshot`, `EnvironmentSnapshotInput`, `ArtifactFiles`, `ArtifactCollection`, and the protocol's `RawUsage` re-export | — |
| Freeze the execution environment | `src/harness/snapshot.ts` | `createEnvironmentSnapshot`, `environmentRefsOf`, `assertEnvironmentRefs` | B1: runtime, model, tools, sandbox image, filesystem. **Never** plan version, authorization digest, budget reservation or memory pin — those are the Mission's `PreparedRun.snapshot` (`src/mission/run-preparation.ts`) |
| Collect, validate, content-address, issue the receipt | `src/harness/artifacts.ts` | `collectArtifacts`, `digestArtifacts`, `collectArtifactCollection`, `assertArtifactReceipt` | B2: the Mission still decides whether an artifact enters the Ledger (`commitSnapshot` + the `SNAPSHOT_COMMITTED` event) |
| Measure raw usage | `src/harness/metering.ts` | `measureUsage`, `addUsage`, `measureResponseUsage` | B3: no attribution, no budget reserve/settle. `ExecutionUsage.attribution` is declared by the caller; `aggregateUsage` (protocol) counts each execution once |
| Drive the one protocol | `src/harness/execution.ts` | `closeHarnessExecution`, `HarnessObservation` | B4: both backends (`pi-agent-runtime`, `pi-child-dispatch`) close through it; no research decision is added |

## Why the boundaries are mechanical

| Boundary | Failure mode it prevents | Where it is enforced |
|---|---|---|
| B1 | authorize at T1, memory updates at T2, environment snapshotted at T3 → the Run executes in an environment the authorization never saw | `createEnvironmentSnapshot` refuses Mission conditions in the input; the environment digest is on the request (`ExecutionEnvironmentRefs.environmentDigest`); `assertEnvironmentRefs` refuses a close that reports another environment |
| B2 | the backend that ran a Run declares its own artifacts as Evidence | collection returns a receipt; only the Mission copies into durable storage and appends the ledger event |
| B3 | a parent aggregate that already contains a child's 3,000 tokens is summed again → 16,000 instead of 13,000 | `closeHarnessExecution` refuses usage without a declared attribution; `aggregateUsage` skips `included-in-parent` and refuses a duplicate execution id |
| B4 | two backends with two meanings for "success" | one `closeExecution` assembly and one `cancellationOutcome`: `unknown` is never success |

## Pins

- **Content addressing** (`src/harness/artifacts.test.ts`): the digest recipe —
  sha256 over sorted `path \0 bytes \0` — is pinned by literal addresses, because
  every stored Run snapshot address is computed with it.
- **Environment address** (`src/harness/snapshot.test.ts`): one pinned environment
  digest, so a changed environment shape is a deliberate change.
- **Behavioural equivalence**: `tests/integration/ledger-trace.test.ts` (review
  base trace, unchanged by the Stage 3 extraction) and `src/memory/digests.test.ts`
  (the 7 memory digests).

## Old paths

`RuntimeUsage` was public from `src/execution/pi-agent-runtime.ts` (and re-exported
by the `src/pi-agent-runtime.ts` and `src/mission/mission-start.ts` shims); it is
now the harness's measured shape and still exported under that name. The measuring
helpers it replaced (`usageFrom`, `usageFromSdk`, `usageFromStats`, `addUsage`,
`usageOf`, `countUsage`) were module-private and are now `metering.ts`.
