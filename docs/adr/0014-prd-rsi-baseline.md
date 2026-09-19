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
| Mission lifecycle; authorize / continue / repair / stop; thin `/research` entry; Skills routing shell | **mission** | Sole product control plane; Skills routing ≠ second control plane |
| Evidence, lineage, admission / promotion gates | **evidence** | Gates stay here |
| Pi Run runtime, Team, Policy Guard | **execution** | Thin default B; no C thicken |
| Pluggable selection; default `fixed_uct` | **search** | Strong search / MCTS opt-in; SEA mount/unmount skeleton; ToyHarness = fixtures only |
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

## Amendment (ET-M1-SKILL / #140)

W1 Skills slice landed an eight-category directory scaffold and a
progressive-disclosure routing shell in `src/mission/skills-routing.ts`.
Lifecycle states are candidate / accepted / demoted and are orthogonal
to L0 pointer / L1 body / L2 resources. Default context loads only
accepted name+description (or the L0 pointer). Writeback is not opened
— read-only shell. The thin evoK `/skills` entry is parse/print only.

Skills routing is not a second control plane: `/research` stays Mission
authority; chat is not the source of truth; `/model` and `/new` stay on
Pi. This amendment does not open EXP Admission, BUD, SEA, or Deploy
Arena. Gate / `#40` / true-submit / Pattern C / default `fixed_uct`
pins are unchanged.

## Amendment (ET-M1-EXP / #142)

W1 Admission slice landed experiment-validity and method Admission /
rollback in `src/evidence/experiment-validity.ts` and
`src/evidence/method-admission.ts`. Skills routing hooks accepted
Skill State through that gate: a candidate is never default-injected;
missing protected holdout refuses accepted; a validity hang is an
explicit hang point, not pass. Method Writeback shape is propose →
regression → admit / rollback, one slice at a time. File-body Skills
writeback stays not opened.

This amendment does not open BUD, SEA, or Deploy Arena. Existing
Kill-test / T48 / hang / Broker predicates, `#40`, true-submit,
Pattern C, and default `fixed_uct` are unchanged. Elite / Team
Fan-Out remain not Promotion or Admission keys.

## Amendment (ET-M1-BUD / #144)

W1 Budget Gate skeleton landed reserve → settle in
`src/evidence/budget-gate.ts`. Over-budget or unreserved refuses
continue and writeback. A thin Method Improvement sub-cap is
optional. Budget pass is not Admission pass. Mission
`/research continue` and Skills accepted writeback hook the
decision; they do not own the ledger. MissionRecord operational
accounting is unchanged.

This amendment does not open SEA or Deploy Arena. Existing
Kill-test / T48 / hang / Broker predicates, `#40`, true-submit,
Pattern C, default `fixed_uct`, and EXP Admission predicates are
unchanged. Elite / Team Fan-Out remain not Promotion, Admission,
or Budget Gate keys.

## Amendment (ET-M1-SEA / #146)

W1 SEA skeleton landed a removable Search Plugin mount/unmount
contract in `src/search/sea-plugin.ts` and method-version stats
isolation in `src/search/method-version-stats.ts`. The default
parent-selection path stays `fixed_uct` and does not depend on a
plugin. MCTS is mount-only; Progressive / StrongSearch remain
explicit opt-in. `#40` stays off. Old-version visit/value stats
are history and must not become the new version's authority.

This amendment does not open Deploy Arena, fill Skills bodies,
or weld Progressive / MCTS / `#40` as product default. Existing
Kill-test / T48 / hang / Broker predicates, true-submit,
Pattern C, EXP Admission predicates, and Budget Gate predicates
are unchanged. Elite / MMD / near-dup / side-slot remain not
Promotion, Admission, or Budget Gate keys. ToyHarness stays
fixtures/tests only.

## Amendment (ET-TUI-MIRROR / #148)

TUI registers evoK mirror slashes with CLI semantics. Pi keeps native
shorts (`/model`, `/new`, `/resume`, …). Mission resume is
`/mission-resume` or `/evok-resume`. Missing evaluation, unauthorized
continue, and over-budget start refuse through the same `runEvok` path
as CLI — gates are not diluted. `/skill <name>` discloses L1 from the
existing catalog; it is not a second skills root (ET-SKILL-NS) and not
authorization.

This amendment does not open ET-PROMPT-MODE, ET-SKILL-NS, Deploy Arena,
or weld Progressive / `#40`. Existing Kill-test / T48 / hang / Broker
predicates, true-submit, Pattern C, EXP Admission predicates, and
Budget Gate predicates are unchanged.

## Amendment (ET-PROMPT-MODE / #150)

TUI / launch assembly switches Explore / Intake / Mission prompts.
Explore keeps the Pi default system prompt (optional `--project`
footnote). Intake appends mission-intake L1 plus draft field
constraints and states that a draft is not authorization. Mission
appends objective / constraints / budget / stop / no External
Submission / baseline pointer and accepted L0 evoK skill names.
The status bar and launch banner show `mode=explore|intake|mission`.
Casual chat is not Mission wording. Overlay text is not start /
continue / submit authority.

This amendment does not open ET-SKILL-NS, fill Skills bodies,
Deploy Arena, or weld Progressive / `#40`. Existing Kill-test /
T48 / hang / Broker predicates, true-submit, Pattern C, EXP
Admission predicates, and Budget Gate predicates are unchanged.

## Amendment (ET-SKILL-NS / #152)

Skills live in the same Pi native skills root. evoK lists filter by
`owner`/`namespace: evok` plus `category` and `state`. Bundled
`resources/skills/` syncs or links into that Pi root with tags; the
bundled tree is packaging source, not a parallel runtime root.
`/skills` lists evoK-tagged skills only. Default disclosure is L0
(accepted + tagged name+description). `/skill <name>` loads L1 from
the tagged catalog and does not authorize start, continue, or
External Submission. Writeback remains Admission + Budget gated.

This amendment does not fill experiment / evidence / policy skill
bodies, unfreeze `#40`, implement Deploy Arena, or change gate /
Admission / Budget predicates.

## Amendment (ET-SKILL-EXP / #154)

The bundled packaging source ships a thin accepted `experiment`
skill (`owner`/`namespace: evok`, `category: experiment`). It is
discoverable on the same Pi root after sync, visible as L0 on
`/skills` and the Mission overlay, and loadable as L1 via
`/skill experiment`. The body is not authorization to start,
continue, or submit.

This amendment does not fill `evidence` / `policy` bodies, change
EXP Admission or Budget predicates, unfreeze `#40`, implement
Deploy Arena, or thaw true-submit.

## Amendment (ET-SKILL-EVID / #156)

The bundled packaging source ships a thin accepted `evidence`
skill (`owner`/`namespace: evok`, `category: evidence`). It is
discoverable on the same Pi root after sync, visible as L0 on
`/skills` and the Mission overlay, and loadable as L1 via
`/skill evidence`. The body frames Experiment Validity and
evidence lineage (effective ≠ optimal; inconclusive ≠ pass;
protected holdout; ledger refs). It is not authorization to
start, continue, or submit, and it does not relax gates.

This amendment does not fill the `policy` body, change EXP
Admission or Budget predicates, change hang / T48 predicates,
unfreeze `#40`, implement Deploy Arena, or thaw true-submit.

## Amendment (ET-SKILL-POL / #158)

The bundled packaging source ships a thin accepted `policy`
skill (`owner`/`namespace: evok`, `category: policy`). It is
discoverable on the same Pi root after sync, visible as L0 on
`/skills` and the Mission overlay, and loadable as L1 via
`/skill policy`. The body frames human-owned red lights
(AtCoder true-submit freeze, `#40` off, Elite ≠ Promotion,
budget overage asks a human). A Skill is not privilege
expansion and is not authorization to start, continue, or
submit. Red lights still ask a human.

This amendment does not change EXP Admission or Budget
predicates, change hang / T48 predicates, unfreeze `#40`,
implement Deploy Arena, or thaw true-submit.

## Amendment (ET-SKILL-SEA / #160)

The bundled packaging source ships a thin accepted `search`
skill (`owner`/`namespace: evok`, `category: search`). It is
discoverable on the same Pi root after sync, visible as L0 on
`/skills` and the Mission overlay, and loadable as L1 via
`/skill search`. The body states default parent selection
remains `fixed_uct`, strong search / Progressive is explicit
opt-in only, and `#40` stays off. Programmable exploration
heuristics may be recorded as docs or guidance; they do not
change default selection math. The body is not authorization
to start, continue, or submit, and it does not relax
Admission, Budget, hang, or T48 predicates.

This amendment does not change EXP Admission or Budget
predicates, change hang / T48 predicates, unfreeze `#40`,
weld Progressive as product default, implement Deploy Arena,
or thaw true-submit.

## Amendment (ET-SKILL-RSI / #162)

The bundled packaging source ships a thin accepted
`method-improvement` skill (`owner`/`namespace: evok`,
`category: method-improvement`). It is discoverable on the
same Pi root after sync, visible as L0 on `/skills` and the
Mission overlay, and loadable as L1 via
`/skill method-improvement`. The body is the in-Mission RSI
entry: validation-gated versioning is version id → verify
command / adversarial tags → enable record → rollbackable.
It is not automatic Promotion, and Elite is not an Admission
key. The body is not authorization to start, continue, or
submit, and it does not relax Admission, Budget, hang, or
T48 predicates.

This amendment does not open Continual Harness CRUD, weight
co-training, change EXP Admission or Budget predicates,
change hang / T48 predicates, unfreeze `#40`, implement
Deploy Arena, thaw true-submit, or fill `recovery` /
`pitfalls` skill bodies.

## Amendment (ET-SKILL-REC / #164)

The bundled packaging source ships a thin accepted
`recovery` skill (`owner`/`namespace: evok`,
`category: recovery`). It is discoverable on the
same Pi root after sync, visible as L0 on `/skills` and the
Mission overlay, and loadable as L1 via `/skill recovery`.
The body is program pointers to existing continue /
repair / hang paths (`continueResearch`,
`recoverResearchStatus`, `resumeAuthorizedMission` /
`reconcileInterruptedMission`, `runKillTestHang`).
`/research repair` stays reserved. The body is not a
second control plane, not authorization to start,
continue, or submit, and it does not relax Admission,
Budget, hang, or T48 predicates. It does not add a new
hang predicate.

This amendment does not change EXP Admission or Budget
predicates, change hang / T48 predicates, unfreeze `#40`,
implement Deploy Arena, thaw true-submit, auto-resume
without Mission gates, or fill the `pitfalls` skill body.

## Amendment (ET-SKILL-PIT / #166)

The bundled packaging source ships a thin accepted
`pitfalls` skill (`owner`/`namespace: evok`,
`category: pitfalls`). It is discoverable on the
same Pi root after sync, visible as L0 on `/skills` and the
Mission overlay, and loadable as L1 via `/skill pitfalls`.
The body is reusable, answer-agnostic failure signatures
(docs only): Goodhart on train, missing holdout, treating
inconclusive as pass, Elite-as-Promotion. It is not a
rejection library, not an auto-refuse blacklist, and not
authorization to start, continue, or submit. Named
signatures are instructional, not gate hooks. The body
does not relax Admission, Budget, hang, T48, or Broker
predicates.

This amendment does not change EXP Admission or Budget
predicates, change hang / T48 predicates, unfreeze `#40`,
implement Deploy Arena, thaw true-submit, or hard-code a
rejection blacklist.

## Out of scope / freezes

- No change to gate three-state, T48, hang, or Broker predicates.
- No weld of `#40` / Progressive as product default.
- No real contest External Submission; AtCoder true-submit stays frozen.
- No C thicken of the execution roster.
- No Elite / side-slot / Team Fan-Out as Promotion keys.
- No Deploy Arena implementation.
- SEA is a mount/unmount + stats-isolation skeleton only (MCTS
  selection math and Deploy Arena stay unopened). The eight
  category accepted skill bodies are shipped; `pitfalls` is
  the ET-SKILL-PIT accepted body (docs-only failure
  signatures, not a rejection library).
