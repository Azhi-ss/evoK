---
status: accepted
---

# 0014 — Product baseline is the task-internal RSI PRD (ET-ADR-PRD / #136)

Docs-only pin after ET-TUI1 (#134 / PR #135 @`f148960`). The v1 product
baseline is the task-internal RSI PRD v1.0 (2026-09-18), compatible with
the existing six-pack, Graph Engineering, and competition arms. No
runtime semantics change.

## Decision

evoK's product is **one Mission** that conducts autonomous research and
verifiable Method Improvement (task-internal RSI). Method Improvement is
an action *inside* a Mission — not a second RSI project, workstream, or
control plane.

Authority is the approved 2026-09-19 decision card (user oral lock:
baseline + compatibility + Pi boundary + Skills on + team autonomy with
red lights + Deploy Arena orthogonal). This ADR is the in-repo pin; it
does not implement W1.

### Pins

1. **Mission is the only mainline.** Research progress and Method
   Improvement are different action types on the same Mission; they are
   recorded separately and do not substitute for each other.
2. **Pi boundary.** Reuse Pi CLI / runtime / extensions / **native TUI**.
   Do not self-build an Agent Loop. Do not keep a custom readline REPL
   shell. #134 (ET-TUI1) **landed**: tty `evok` launches SDK
   `InteractiveMode`; `/model` and `/new` stay on Pi. The TUI is not
   Mission authority.
3. **Skills on.** Eight categories with progressive disclosure.
   Lifecycle states are candidate / accepted / demoted (detail = W1).
   Routing and version gates belong to mission / evidence; pack content
   is engineering-owned.
4. **Search is pluggable.** Default remains `fixed_uct`. Strong search /
   MCTS is explicit opt-in. Promotion and hang / T48 / Broker gates live
   in evidence. `#40` stays off.
5. **Red lights still ask the user.** Real External Submission; expanding
   budget or permissions past the authorized Mission Policy; changing
   formal Human Acceptance; unfreezing AtCoder true-submit / `#40`
   welded semantics. Yellow-light engineering detail is autonomous.
6. **Deploy Arena is orthogonal standby.** Competition-serving (Bohrium
   and kin) stays a competition-arm adapter. Do not weld it into the
   RSI / Mission research mainline. This ADR does not advance it.

### Six-pack mapping

| PRD / product concern | Package | Notes |
|---|---|---|
| Mission lifecycle; authorize / continue / repair / stop; thin `/research` entry | **mission** | Sole product control plane |
| Evidence, lineage, admission / promotion gates | **evidence** | Gates stay here |
| Pi Run runtime, Team, Policy Guard | **execution** | Thin default B; no C thicken |
| Pluggable selection; default `fixed_uct` | **search** | Strong search opt-in; ToyHarness = fixtures only |
| Contest / local Evaluator adapters; Deploy Arena standby | **competition** | True submit frozen |
| Thin argv / resource shell; Pi native TUI | **cli** | Not a second control plane |

Agents remain replaceable Run execution ([ADR-0005](0005-pi-sdk-execution-path.md)).
The chat transcript and ToyHarness are not authority. ToyHarness stays
fixtures/tests only under `src/search/fixtures/`.

W1 (EVT / Skills / EXP / BUD / SEA) is not authorized by this ADR.

## Amendment to prior ADRs

- [ADR-0004](0004-evok-autonomous-research-entrypoint.md): the interactive
  surface is Pi native TUI (#134), not a custom readline REPL. Foreground
  `evok` still hosts the process; the TUI does not drive each research
  iteration.
- [ADR-0005](0005-pi-sdk-execution-path.md): the no-second-Agent-Loop pin
  extends to the interactive path. Headless `PiAgentRuntime` and
  `InteractiveMode` share Pi; evoK does not add a forwarding-only Agent
  layer.
- [ADR-0007](0007-six-pack-ownership.md): logical six-pack ownership is
  unchanged.

## Amendment (ET-M1-EVT / #138)

W1 first slice landed a Mission control-event / recovery skeleton and a
thin evoK `/research` status/continue entry in
`src/mission/research-entry.ts`. The CLI parses `/research` / `--research`
and calls that mission API. Pi native TUI is unchanged; `/model` and
`/new` stay on Pi. Chat transcript is not authority.

This amendment does not open Skills, EXP validity gates, BUD, SEA, or
Deploy Arena. Gate / `#40` / true-submit / Pattern C / default
`fixed_uct` pins are unchanged.

## Out of scope / freezes

- No change to gate three-state, T48, hang, or Broker predicates.
- No weld of `#40` / Progressive as product default.
- No real contest External Submission; AtCoder true-submit stays frozen.
- No C thicken of the execution roster.
- No Elite / side-slot / Team Fan-Out as Promotion keys.
- No Deploy Arena implementation.
- No W1 Skills / EXP / BUD / SEA implementation.
