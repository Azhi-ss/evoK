# evoK architecture as-is (W0 PRD baseline)

In-repo as-is pointer after ET-A0…A6 and ET-TUI1. Authority for terms is
[`CONTEXT.md`](../CONTEXT.md). Logical ownership is
[ADR-0007](adr/0007-six-pack-ownership.md). Physical closeout is
[ADR-0013](adr/0013-six-pack-physical-closeout.md). Product baseline is
[ADR-0014](adr/0014-prd-rsi-baseline.md) (task-internal RSI PRD v1.0).

Tip is this W0 docs pin on `main` after P6 closeout and #134 / PR #135
(`f148960`: Pi native TUI via SDK `InteractiveMode`).

## Product baseline

- Mission is the only mainline; Method Improvement is an action *inside*
  a Mission (not a second RSI project or control plane).
- Pi boundary: reuse CLI / runtime / extensions / **native TUI**; no
  self-built Agent Loop; no custom readline REPL. #134 **landed**.
- Skills on (eight categories + progressive disclosure; candidate /
  accepted / demoted — detail = W1).
- Search pluggable; default `fixed_uct`; strong search / MCTS opt-in;
  gates live in evidence.
- Red lights still ask the user: real submit / expand authority / change
  acceptance / unfreeze AtCoder · `#40`.
- Deploy Arena is orthogonal standby — not welded into the RSI mainline.

## Physical layout

| Package | Directory | 物理就位 | Notes |
|---|---|---|---|
| **mission** | `src/mission/` | 勾 | Research Loop = product control plane |
| **evidence** | `src/evidence/` | 勾 | Ledger / T48 / hang / Broker simulation |
| **execution** | `src/execution/` | 勾 | Thin default B; C thicken still rejected |
| **search** | `src/search/` | 勾 | Default `fixed_uct`; `#40` off |
| **competition** | `src/competition/` | 勾 | Live explicit; no true submit; Deploy Arena standby |
| **cli** | `src/cli/` | 勾 | Thin shell + Pi native TUI (#134); not a second control plane |

`ToyHarness` lives under `src/search/fixtures/` (fixtures/tests only).

## Residual flat shims

Dead shims deleted in P6: `src/file-blueprint.ts`, `src/evok-cli.ts`,
`src/second-toy-adapter.ts`. Remaining pack-shim flat `src/*.ts`
re-exports are migration-period (one more release). Inventory: ADR-0013.

## Frozen (unchanged)

- Gate / T48 / hang three-state
- `#40` SelectionPolicy off
- No true External Submission
- Elite ≠ Promotion keys
- C thicken forbidden
- Deploy Arena not advanced (orthogonal standby)
- W1 EVT / Skills / EXP / BUD / SEA not started
