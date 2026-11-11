/**
 * The harness: the single public export surface of `src/harness/` (PRD §3
 * B1–B4, §4 Stage 3; #253/#256).
 *
 * The harness executes in isolation and returns artifacts, raw usage and
 * execution health. It does **not** evaluate (S3): no score, no evaluation
 * fact, no Promotion, Admission, Budget, T48 or hang decision, and it never
 * imports `src/mission/`. Code outside this directory imports from here, never
 * from an individual module, so a new file cannot become public by existing.
 *
 * | Boundary | Owner here | Stays in Mission |
 * |---|---|---|
 * | B1 | `snapshot.ts` freezes the execution environment | the authorization snapshot, plan version, budget reservation, memory pin |
 * | B2 | `artifacts.ts` collects, validates, content-addresses, issues a receipt | whether the artifact enters the Ledger |
 * | B3 | `metering.ts` measures raw usage | attribution, budget reserve/settle/refund |
 * | B4 | `execution.ts` drives the one protocol for both backends | every research decision |
 *
 * Adding a name below is a public-surface change, not an implementation detail.
 */
export type { ArtifactCollection, ArtifactFiles, EnvironmentSnapshot, EnvironmentSnapshotInput, RawUsage } from "./contracts";
export { assertEnvironmentRefs, createEnvironmentSnapshot, environmentRefsOf } from "./snapshot";
export { assertArtifactReceipt, collectArtifactCollection, collectArtifacts, digestArtifacts } from "./artifacts";
export { addUsage, measureResponseUsage, measureUsage } from "./metering";
export { closeHarnessExecution } from "./execution";
export type { HarnessObservation } from "./execution";
