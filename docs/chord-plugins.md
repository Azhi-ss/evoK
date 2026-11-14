# evoK Pi plugin with three internal seats

How to load the single evoK Pi plugin and the three internal seats that used to
be a local Chord pilot. Per-seat locks stay in the notes this page points at.
This page is the install / load / limits how-to (ET-DOC-CHORD / #193).

Authority: `approved/2026-09-21-decision-pi-086-chord-plugins.md`.
Product path (Explore → intake → review → start → research):
[how-to-use.md](how-to-use.md). Domain vocabulary: [CONTEXT.md](../CONTEXT.md).

## Honesty first

Official Pi `0.86.0` / `0.86.1` changelogs **did not advertise** Chord
hot-plug. The separate seat packages and their in-process facet loaders were
an experimental pilot. That pilot is rolled back. The shipped Pi surface is
the single `extensions/evok.ts` entry. Seat records live in
`src/cli/evok-plugin.ts`. They are data, not installable plugins, and this
repository does not depend on `@earendil-works/chord`.

This note does **not** open Cordis / DSH.

## One Pi plugin, three internal seats

| Module | Seat | Where it lives | Spec |
| --- | --- | --- | --- |
| `evok-platform` | Mission / 编排 / TUI·CLI | `src/cli/evok-plugin.ts` | [evok-platform-chord.md](evok-platform-chord.md) (#190) |
| `evok-research` | 选点 / Harness / SelectionPolicy | `src/cli/evok-plugin.ts` | [evok-research-chord.md](evok-research-chord.md) (#191) |
| `evok-eval` | eval / promotion / Broker | `src/cli/evok-plugin.ts` | [evok-eval-chord.md](evok-eval-chord.md) (#192) |

`loadEvokPlugin()` returns all three seats together. There is no per-seat
loader and no second Pi extension.

Seat locks that stay true after load:

- **platform** — not a second control plane. Authorize / continue /
  repair / stop stay in `src/mission/`.
- **research** — product default remains **`fixed_uct`**. `#40`
  Progressive stays **explicit Mission/config opt-in only**. Elite ≠
  晋级 / Promotion / Admission.
- **eval** — Admission / Budget / hang / T48 / Broker stay
  **fail-closed**. Contest-arm auto-submit stays fail-closed. Elite ≠
  Promotion. Promotion ≠ Admission.

## Install

From the evoK repo root. Current `main` pins
`@earendil-works/pi-coding-agent@0.86.1`. It does not pin a Chord package.

```bash
# from the evoK repo root
bun install

# use the single Pi extension from this checkout
pi --extension ./extensions/evok.ts
```

The root package manifest declares `pi.extensions: ["./extensions/evok.ts"]`.
You do **not** need a Chord daemon, Cordis, or DSH.

A fresh clone that is missing `node_modules` is the only install step.

## Load

Seat records are compiled into `src/cli/evok-plugin.ts`. `repoRoot` is
accepted so existing callers keep their options shape; it is not read.
`dispose()` is safe to call and releases nothing, because there is no host.

```ts
import { loadEvokPlugin } from "../src/cli/evok-plugin";

const evok = await loadEvokPlugin();
// evok.modules.platform.seat.experimental === true
// evok.modules.research.seat.defaultSelectionId === "fixed_uct"
// evok.modules.eval.seat.failClosed === true

await evok.dispose();
```

`declareEvokPlugin()` describes the unified product entry. Load with
`{ facets: "session" }` for the seat records alone, or the default
`"session+tui"` to also list the internal smoke commands. Those names are
**not** Pi InteractiveMode slashes and **not** CLI mainline verbs.

## What this path does not do

- Changelog-official Chord hot-plug (the 0.86 notes never promised it).
- A separate package, facet map, or loader per seat.
- Production multi-environment / multi-host Chord.
- Separate user-facing CLI or TUI slashes for the internal seats.
- Cordis / DSH.
- Mission authority, parent-selection math, scoring, or gate predicates.
  The seats name where those owners live; they do not move them.

## Smoke

Offline; no InteractiveMode and no live model.

```bash
bun test tests/integration/layout-honesty.test.ts
bun test src/cli/evok-plugin.test.ts
bun run typecheck
```

Expected:

| Ticket | Expect |
| --- | --- |
| #190 | `loadEvokPlugin().modules.platform.seat.changelogOfficialHotPlug === false`; session loads with no smoke command; session+tui lists `evok-platform` |
| #191 | same honesty pin; `defaultSelectionId === "fixed_uct"`; `progressiveDefault === "off"`; `createDefaultSearchSelectionPort().id` stays `fixed_uct`; `SELECTION_POLICY_40` stays `"off"` |
| #192 | same honesty pin; `failClosed === true`; `autoSubmitFailClosed === true`; `eliteIsPromotion === false`; `evaluateContestAutoSubmitGates({})` still refuses; Admission without holdout still refuses even with `elite: true`; `ELITE_IS_NOT_JINJI` stays true |

The dated handoffs record the retired pilot. They are not the current loader:

- [2026-09-21-et-chord-split-platform.md](handoffs/2026-09-21-et-chord-split-platform.md)
- [2026-09-21-et-chord-split-research.md](handoffs/2026-09-21-et-chord-split-research.md)
- [2026-09-22-et-chord-split-eval.md](handoffs/2026-09-22-et-chord-split-eval.md)

## Known limits

- **Experimental history, one entry now.** Not an official changelog promise.
- **In-process records only.** No facet host, no multi-env, no multi-host, no daemon.
- **Smoke commands are not slashes.** The names on the loaded plugin are not
  Pi InteractiveMode and not the CLI mainline.
- **Gates and defaults unchanged.** `#40` stays off unless a Mission or
  `.evok/search.json` opts in. Admission / Budget / hang / T48 / Broker
  predicates are not loosened. Auto-submit stays fail-closed.
- **No Cordis / DSH** in this wave.
- **Seats do not move authority.** Mission Director, Evaluator,
  Promotion, Admission, and Broker stay where the six-pack put them.

## What this note does not claim

- Changelog-official or production Chord hot-plug
- Three user-installed Pi plugins
- Pi experimental `-e` as a product path
- Production multi-environment distributed Chord
- Cordis / DSH
- Any change to gates / defaults
- Elite as 晋级 / Promotion / Admission / Broker / kill-test key
