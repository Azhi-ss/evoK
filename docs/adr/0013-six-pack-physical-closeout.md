---
status: accepted
---

# 0013 — Six-pack physical closeout (ET-A6 / #132)

Thin P6 closeout after the six physical cuts. Logical ownership stays the
six-pack map in [ADR-0007](0007-six-pack-ownership.md). No second package
move. No gate, T48, hang, `#40`, or C-thicken change.

## Decision

Physical packages are **in place** under `src/`:

| Package | Directory | 物理就位 |
|---|---|---|
| **mission** | `src/mission/` | 勾 |
| **evidence** | `src/evidence/` | 勾 |
| **execution** | `src/execution/` | 勾 |
| **search** | `src/search/` | 勾 |
| **competition** | `src/competition/` | 勾 |
| **cli** | `src/cli/` | 勾 |

Each pack has a barrel `index.ts`. `src/evidence/index.ts` is the missing
P6 barrel: curated gate-authority surface (`HypothesisLedger`, T48/hang,
`auditMethodology` / `oofEnsembleGate`, verification roles, Broker
simulation). It does not swallow Mission, search, execution, or
competition APIs. `methodology-contracts.ts` stays a sibling module —
same names as `methodology.ts`, different contract shape.

`ToyHarness` stays fixtures/tests only under `src/search/fixtures/`.
It is not re-exported from `src/search/` and is not a second control
plane.

## Residual flat `src/*.ts` shims

**Deleted (dead — no remaining in-repo consumer besides the old compat test):**

- `src/file-blueprint.ts`
- `src/evok-cli.ts`
- `src/second-toy-adapter.ts`

**Kept as migration-period re-exports for one more release.** Production
modules, integration tests, examples, the recovery driver, or the
ToyHarness fixture barrel still import these flat paths. Retargeting
every `../foo` import is a second big move and is out of P6.

| Pack | Flat shim |
|---|---|
| mission | `baseline-track`, `branch-recovery`, `llm-propose-outer-min`, `mission-director`, `mission-draft`, `mission-intake`, `mission-resume`, `mission-start`, `outer-e2e-min-path`, `outer-min-path`, `research-loop`, `v1-golden-path` |
| evidence | `hypothesis-ledger`, `kill-test-hang`, `ledger-kinds`, `methodology-acceptance`, `methodology-contracts`, `methodology`, `submission-broker`, `validation-ladder`, `verification-gates` |
| execution | `dag-scheduler`, `model-orchestra`, `pi-agent-runtime`, `security-boundary`, `team-execution` |
| search | `outer-search-space-fixtures`, `search-selection-port`, `search-space-profile`, `toy-harness` |
| competition | `llm-comp-arm-before-promotion`, `llm-competition-runtime` |

Shared non-pack modules stay at `src/` (`evok-model`, `evok-resources`,
`newapi-client`, `idea-types`, `local-file-evaluator`, `evaluation-noise`,
`data-honesty`, `predict-reconcile`). They were never part of a cut.

## Out of scope / freezes

- No change to gate three-state, T48, hang, or Broker predicates.
- No weld of `#40` / Progressive as product default.
- No real contest submit path enabled.
- No second big move of already-landed packages.
- No C thicken of the execution roster.
- No Elite / side-slot / Team Fan-Out as Promotion keys.
