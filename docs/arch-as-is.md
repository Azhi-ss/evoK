# evoK architecture as-is (P6 tip)

In-repo as-is pointer after ET-A0…A6. Authority for terms is
[`CONTEXT.md`](../CONTEXT.md). Logical ownership is
[ADR-0007](adr/0007-six-pack-ownership.md). Physical closeout is
[ADR-0013](adr/0013-six-pack-physical-closeout.md).

Tip is `main` after P1–P5 cuts (`src/{mission,evidence,execution,search,competition,cli}/`).

## Physical layout

| Package | Directory | 物理就位 | Notes |
|---|---|---|---|
| **mission** | `src/mission/` | 勾 | Research Loop = product control plane |
| **evidence** | `src/evidence/` | 勾 | Ledger / T48 / hang / Broker simulation |
| **execution** | `src/execution/` | 勾 | Thin default B; C thicken still rejected |
| **search** | `src/search/` | 勾 | Default `fixed_uct`; `#40` off |
| **competition** | `src/competition/` | 勾 | Live explicit; no true submit |
| **cli** | `src/cli/` | 勾 | Thin shell; not a second control plane |

`ToyHarness` lives under `src/search/fixtures/` (fixtures/tests only).

## Residual flat shims

Dead shims deleted in P6: `src/file-blueprint.ts`, `src/evok-cli.ts`,
`src/second-toy-adapter.ts`. Remaining flat `src/*.ts` re-exports are
migration-period (one more release). Inventory: ADR-0013.

## Frozen (unchanged)

- Gate / T48 / hang three-state
- `#40` SelectionPolicy off
- No true External Submission
- Elite ≠ Promotion keys
- C thicken forbidden
