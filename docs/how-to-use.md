# How to use evoK

Followable product path: **Explore → intake → review → start → research**.

This page documents **only shipped CLI / TUI behavior**. It does not invent
green, true submit, `#40` Progressive as default, Deploy Arena, or any other
unopened capability. Chat is not Mission authority. Loading a Skill is not
authorization to start, continue, or submit.

Product baseline: [ADR-0014](adr/0014-prd-rsi-baseline.md). Domain vocabulary:
[CONTEXT.md](../CONTEXT.md).

## Absolute paths

Always pass an **absolute** `--project`. A relative `--project` is resolved
from the current working directory and will miss
`<abs-project>/.evok/evaluation.json` if you invoked `evok` from another
directory.

Isolated Run workspaces are temp dirs created by the controller. Do **not**
point `--project` at a workspace.

```bash
# from the evoK repo root
PROJECT="$(pwd)/examples/demo-start"   # or a copy
bun run evok --help
bun run evok /skills --project "$PROJECT"
```

Equivalent entry: `bun bin/evok.ts`. Models and credentials come only from Pi
(`~/.pi/agent/models.json`, `auth.json`; honors `PI_CODING_AGENT_DIR`). evoK
never copies or displays credentials.

## CLI and TUI are mirrors

On a tty with no request and no Mission flag, `evok` launches the Pi native
TUI. The status bar / launch banner shows `mode=explore|intake|mission`.
evoK mirror slashes dispatch through the same `runEvok` shell as the CLI —
same semantics, same gates, no dilution.

Pi owns Pi shorts (`/model`, `/new`, `/resume`, `/settings`, …). evoK does
**not** intercept them. Where a name would collide, Mission uses a
`/mission-*` or `/evok-*` prefix.

| Want | CLI (one-shot) | TUI slash |
| --- | --- | --- |
| Explore / chat at project root | `evok --project <abs>` (tty, **empty** project) or `evok "inspect …" --project <abs>` | just type; `mode=explore` only when there is no draft and no accepted Mission |
| List unfinished Missions | `evok --missions --project <abs>` | `/missions` or `/evok-missions` |
| Intake (draft only) | `evok --intake "…" --project <abs>` or `evok /intake "…" --project <abs>` | `/intake …` or `/mission-intake …` or `/evok-intake …` |
| Review a draft | `evok --status --mission <id> --project <abs>` + read `draft.json` | no `/review` command — same `--status` / files |
| Start baseline | `evok --start --baseline-only --project <abs> --mission <id>` or `evok /start --baseline-only --project <abs> --mission <id>` | `/start` or `/evok-start` (same flags) |
| Mission resume after interrupt | `evok --resume --project <abs> --mission <id>` or one-shot `evok /resume --project <abs> --mission <id>` | **`/mission-resume`** or `/evok-resume` — **not** Pi `/resume` |
| Research status | `evok /research status --project <abs> --mission <id>` | `/research status` |
| One authorized continue | `evok /research continue --project <abs> --mission <id>` | `/research continue` |
| Skills L0 directory | `evok /skills --project <abs>` | `/skills` or `/evok-skills` |
| Skill L1 body | `evok /skill <name> --project <abs>` | `/skill <name>` or `/evok-skill <name>` |

TUI `/resume` stays Pi session restore. Mission resume in the TUI is
`/mission-resume`. One-shot CLI still accepts `evok /resume` as Mission
resume because that path is not InteractiveMode.

`/research repair` and `/research stop` are **reserved**. This slice exposes
status and one authorized continue only.

## Modes

Resolved from disk (and from an active intake flag), not from chat wording:

| Disk state | `mode=` | Overlay |
| --- | --- | --- |
| No draft, no accepted Mission | `explore` | Pi default prompt + optional footnote (`This directory can be managed by evoK --project.`). No Mission interview wording. |
| Unstarted draft under `.evok/missions/` | `intake` | mission-intake L1 + draft field constraints. **Draft ≠ authorization.** |
| Reviewed / active `mission.json` (resumable) | `mission` | objective / constraints / budget / stop / do not submit / baseline + accepted evoK **L0** skills |

Casual Explore chat is not hijacked by Mission wording. Overlay text does not
authorize start, continue, or External Submission.

---

## 1. Explore

Inspect a research project without writing a Mission.

```bash
# empty directory → mode=explore (a saved draft flips the TUI to intake)
PROJECT="$(pwd)/tmp-explore"
mkdir -p "$PROJECT"

# tty: Pi native TUI, mode=explore
bun run evok --project "$PROJECT"

# one-shot inspect (fresh Run; project is read-only to the model)
bun run evok --project "$PROJECT" "inspect this research project and summarize what you see"

# Skills directory — offline, no model (works on any abs project, including the demo)
bun run evok /skills --project "$(pwd)/examples/demo-start"
```

Explore can still see ordinary Pi skills in the TUI. `evok /skills` lists
**only** evoK-tagged skills (`owner: evok` or `namespace: evok`).

## 2. Intake

Turn a research intention into a **saved, reviewable Mission draft**. Intake
never starts or dispatches an Experiment.

```bash
PROJECT="$(pwd)/my-research-project"   # absolute
mkdir -p "$PROJECT/.evok"
cp "$(pwd)/templates/evaluation.json" "$PROJECT/.evok/evaluation.json"

bun run evok --intake --project "$PROJECT" \
  "raise the independent answer metric toward 0.9 without self-reporting a score"

# reopen the same draft
bun run evok --intake --mission <id> --project "$PROJECT" "where were we?"
```

CLI `--intake` needs request text (one-shot or piped). TUI equivalent:
`/intake …` / `/mission-intake …`.

A successful turn prints `status draft (unstarted; nothing dispatched)` and
`ready for review: true|false`. The durable file is:

```text
<abs-project>/.evok/missions/<id>/draft.json
```

Copyable evaluation contract: [`templates/evaluation.json`](../templates/evaluation.json)
(`id`, `version`, a **relative** `artifact`, optional `metric` / `min` / `max`).
The artifact is read from the immutable Candidate snapshot, never as an
absolute path and never from a model-supplied score.

A newcomer scaffold that already has the contract + a reviewable draft:

[`examples/demo-start/`](../examples/demo-start/README.md)

## 3. Review

There is **no** `/review` slash. Review is you reading the saved draft (and
`--status`) before an explicit start.

```bash
PROJECT="$(pwd)/examples/demo-start"

bun run evok --status --mission demo-start --project "$PROJECT"
# unstarted draft → status draft; nothing consumed by an Experiment

# also read the files
#   $PROJECT/.evok/missions/demo-start/draft.json
#   $PROJECT/.evok/evaluation.json
```

A draft is ready to start only when all of these are present and
`unresolvedPrerequisites` is empty:

- Research Objective and at least one success criterion
- data description and evaluation method
- positive enforceable budget in **`model-USD`**
- declared outputs and stop conditions
- at least one initial baseline Task Contract

`--missions --project <abs>` lists unfinished accepted Missions and shows
unstarted drafts separately. Listing never resumes anything.

A draft is **not** authorization. Discussing the draft does not dispatch work.

## 4. Start

One explicit user start (`--start`, `/start`, or a clear natural-language
start that names the Mission / baseline) runs the validated start action.
Model-authored approval cannot dispatch.

```bash
# from the evoK repo root — resolve the demo to an absolute path first
DEMO="$(pwd)/examples/demo-start"

bun run evok --start --baseline-only --project "$DEMO" --mission demo-start
# equivalent:
bun run evok /start --baseline-only --project "$DEMO" --mission demo-start
```

`--baseline-only` runs only the measured baseline (no autonomous
continuation). Omit it only when you intend the **Mission Director** to
propose further Experiments after the baseline (`--max-experiments`,
default 3).

Without an injected test runner, `--start` first runs
`inspectStartHardGates`. If any **blocking** start-path gate is closed it
prints **remaining hard gates**, dispatches **nothing**, and exits `3`
(`configError`). That listing is **not** a product-green and not Admission /
submit.

Typical **blocking** start-path checks on a new machine (these can later
pass; they are not the in-force block):

- **Pi model/auth** — `~/.pi/agent` must resolve and preflight the requested
  tier. Missing configuration **blocks** this start. On the `--start`
  inventory path that is still exit `3`. Exit `4` (`authError`) is the later
  general preflight when a live Run is about to be constructed — not a
  claimed pass.
- **evaluation contract** — `<abs-project>/.evok/evaluation.json`
- **reviewed Mission draft** — ready-for-review `draft.json`; name `--mission`
  when more than one exists
- **explicit start authorization** — `/start` or `--start` from the user
- **enforceable `model-USD` budget** and **supported permissions**
- **controller lock** / **already-started** — start is not idempotent

When every blocking gate is clear, the accepted Mission is persisted
(`mission.json`, controller lock, history) **before** dispatch. The bounded
baseline runs in an approved isolated workspace. The independent evaluator
measures the frozen Candidate snapshot. A model-supplied score cannot replace
measurement.

`--start` is not Skill-authorization and does not authorize true submit.

## 5. Research

Thin product entry. Status is readable from durable events / Mission records
with **no model**. Continue is one authorized circle. Events-only / file-metric
Missions still record a visible skeleton experiment. After a **measured**
`suite-metric` baseline, the same `/research continue` verb runs the
search-owned one-circle lift harness (default parent selection stays
`fixed_uct`). It does **not** dispatch a Pi Run, does **not** open EXP gates,
and does **not** authorize true submit.

```bash
PROJECT="$(pwd)/examples/demo-start"   # after a real start, not the unstarted demo

bun run evok /research status --project "$PROJECT" --mission <id>
bun run evok /research continue --project "$PROJECT" --mission <id>

# TUI: /research status | /research continue
```

Continue refuses when:

- the Mission is not authorized (`/research continue` cannot originate authority)
- no baseline has been recorded
- the Mission is already stopped
- a BudgetDecision is supplied and is over-budget or unreserved

Chat about research does not continue a Mission. A model-authored approval
cannot continue.

After an interruption (`Ctrl+C` cancels the in-flight Run only — it is **not**
a Mission-pause binding):

```bash
bun run evok --missions --project "$PROJECT"
bun run evok --resume --mission <id> --project "$PROJECT"
# TUI: /mission-resume   (Pi /resume stays on Pi)
```

Resume reconstructs from durable records only. Intake is not repeated. Spent
budget is never restored.

A separate offline faux-model lifecycle already lives under
[`examples/lifecycle/`](../examples/lifecycle/README.md); it is **not** this
start path and is **not** a live-model pass.

---

## 6. Suite-metric + one-circle lift

True-domain loop on [`examples/demo-suite`](../examples/demo-suite/README.md).
The shipped `src/solve.js` is deliberately incomplete. The independent
`suite-metric` Evaluator measures `pass_rate = n_pass / n_total` against
`suite/cases.json`. That baseline is about **0.4** (2 of 5) — a real suite
result, not a hand-written seed.

```bash
# from the evoK repo root — always absolute --project
DEMO="$(pwd)/examples/demo-suite"
# copy if you want a private working tree
cp -R "$DEMO" /tmp/evok-demo-suite
DEMO="$(cd /tmp/evok-demo-suite && pwd)"

# 1) measure baseline (≈ 0.4 real pass_rate, or remaining hard gates)
bun run evok --start --baseline-only --project "$DEMO" --mission demo-suite

# 2) one authorized continue after a recorded baseline
bun run evok /research continue --project "$DEMO" --mission demo-suite
# TUI: /research continue
```

What continue does on this contract:

1. Requires user `/research continue`, an authorized Mission, and a recorded
   baseline. Chat / model-authored approval cannot continue.
2. Search proposes one Candidate (local helper-completion) and selects the
   unvisited child with default **`fixed_uct`**. `#40` Progressive stays off.
3. The independent suite-metric Evaluator re-measures the proposal. A model
   self-score cannot replace `pass_rate`.
4. The existing promotion hang (`runKillTestHang`, T48-mapped evidence) is
   engaged. Unmapped evidence or a failed hang **blocks Promotion**.
5. Acceptance is **measured lift** toward **≥ 0.8** **or** an evidence-complete
   honest kill archived at:

   `<abs-project>/evidence/research-continue/<mission-id>/<experiment-id>.json`

The shipped template `src/solve.js` is **not** rewritten. The proposal and
the hang decision live in `evidence/`. True submit / Deploy Arena stay
frozen. Admission / Budget / hang / T48 predicates are unchanged.

Prove the 0.4 → ≥0.8 circle offline (no live model):

```bash
bun test src/project-evaluator.test.ts
bun test src/search/suite-lift-circle.test.ts
bun test src/mission/research-continue-lift.test.ts
```

---

## Shipped skills (L0 / L1)

Eight categories. Bundled accepted skills are synced into the project's Pi
skills root (`<project>/.pi/skills/evok/<category>/<name>/`). Discovery
authority is that Pi root, not `resources/skills/` as a parallel root.

| Category | Shipped name | `/skill <name>` |
| --- | --- | --- |
| `intake` | `mission-intake` | intake interview; draft ≠ start |
| `experiment` | `experiment` | Task Contract / Experiment design |
| `evidence` | `evidence` | Evidence / File Blueprint / validity |
| `method-improvement` | `method-improvement` | in-Mission RSI; validation-gated |
| `search` | `search` | default `fixed_uct`; strong search opt-in only |
| `recovery` | `recovery` | pointers to existing continue / resume / hang |
| `pitfalls` | `pitfalls` | reusable failure signatures; not a reject library |
| `policy` | `policy` | Mission Policy red lights; skill ≠ privilege |

```bash
PROJECT="$(pwd)/examples/demo-start"
bun run evok /skills --project "$PROJECT"
bun run evok /skill experiment --project "$PROJECT"
bun run evok /skill evidence --project "$PROJECT"
bun run evok /skill method-improvement --project "$PROJECT"
bun run evok /skill search --project "$PROJECT"
bun run evok /skill recovery --project "$PROJECT"
bun run evok /skill pitfalls --project "$PROJECT"
bun run evok /skill policy --project "$PROJECT"
```

- **L0** — default context: `name` + `description` + location. Mission overlay
  injects accepted + evoK-tagged L0 only.
- **L1** — `/skill <name>` reads `SKILL.md` in place. Not authorization.
- **L2** — `scripts/` / `references/` on demand (not a second control plane).

Lifecycle (`candidate` / `accepted` / `demoted`) is orthogonal to disclosure.
A candidate is never default-injected. Accepted writeback requires Admission
(official samples + adversarial-labeled subset + **protected holdout**) and,
when a ledger is consulted, a Budget Gate pass. File-body writeback is **not
opened** — the shell is read-only. Budget pass is not Admission pass.

Each shipped L1 body states: when to use; what not to do; **≠** start /
continue / submit authorization; relation to Admission · Budget.

`/skill search` does **not** unfreeze `#40`. Default parent selection stays
`fixed_uct`. Progressive / MCTS / StrongSearch remain explicit opt-in.

`/skill method-improvement` is validation-gated (version id → verify command /
adversarial tags → enable record → rollbackable). It is not automatic
Promotion. Elite is not Admission.

`/skill recovery` points at existing program paths only. It does not invent a
second control plane or a new hang predicate.

`/skill pitfalls` names reusable, answer-agnostic failure signatures. It is
not a rejection library or auto-refuse blacklist.

Catalog and packaging notes: [`resources/skills/README.md`](../resources/skills/README.md).

---

## Hard gates that stay in force

Every start-path inventory ends with **Still in force (not downgraded; not
a pass; does not invent green)**. Those five never count as a product pass,
even when every blocking start-path check is clear:

| Gate | Honest status |
| --- | --- |
| **Admission** | Method/Skill writeback still needs official samples + adversarial-labeled subset + protected holdout. Missing holdout refuses. Elite or Team Fan-Out is not an Admission key. |
| **Budget Gate** | reserve → settle still refuses continue or writeback when spend is unreserved or over the Mission Policy cap. Budget pass is not Admission pass. |
| **hang** | Inconclusive hang is not pass. Predicates unchanged. |
| **T48** | Unmapped T48 artifacts still block. Predicates unchanged. |
| **External Submission / Broker** | True submit stays frozen. Start is not submit authorization. Broker predicates unchanged. |

**Pi model/auth** is a **blocking start-path check**, not one of those
in-force lines. It can pass once `~/.pi/agent` resolves and preflights the
requested tier. Until then it blocks the live baseline. Missing auth is
never treated as a pass.

Also still true, and **not** claimed by this guide:

- `#40` Progressive stays **off** (not a product default)
- Deploy Arena stays orthogonal **standby**
- Elite ≠ Promotion / Admission
- `/research continue` does not dispatch a Pi Run; suite-metric continue
  measures a local Candidate and engages the promotion hang
- `/research repair` / `/research stop` are reserved

## What this page does not claim

- A green / passing live baseline on every machine (demo lists remaining hard
  gates when Pi model/auth or another prerequisite is missing)
- True External Submission / AtCoder true-submit
- Deploy Arena as a mainline
- `#40` / Progressive welded on
- Admission / Budget / hang / T48 / Broker predicate changes
- Skill body as start, continue, or submit authorization
- A `/review` command, a second control plane, or ToyHarness as production
  Mission authority

Offline CLI contract tests (faux provider, no credentials) live next to the
modules they cover (`src/cli/evok-cli.test.ts`,
`src/mission/start-hard-gates.test.ts`, and kin). They are not a live-model
pass.
