# evoK Pi plugin with three internal Chord seats

How to install and load the single evoK Pi plugin entry with its three internal
Chord seats that landed on the Pi 0.86 / Chord wave. Per-seat contracts stay in the
ET-CHORD-SPLIT notes this page points at. This page is the install / load / limits how-to
(ET-DOC-CHORD / #193).

Authority: `approved/2026-09-21-decision-pi-086-chord-plugins.md`.
Product path (Explore → intake → review → start → research):
[how-to-use.md](how-to-use.md). Domain vocabulary: [CONTEXT.md](../CONTEXT.md).

## Honesty first

Official Pi `0.86.0` / `0.86.1` changelogs **did not advertise** Chord
hot-plug. npm may list `@earendil-works/chord@^0.86`; that is a
dependency pin, **not** a product promise that plugins hot-plug.

This path is an **experimental local pilot**. It is **not** an official
changelog capability and **not** production multi-environment distributed
Chord. The shipped Pi surface is the single `evok` extension entry; the
Chord seats are internal modules behind that entry.

The internal seat packages follow the same `chord.facets` convention as Pi
0.86 example plugins. That convention does **not** make the seats independently
installable Pi packages; Pi loads the single `extensions/evok.ts` entry.

This note does **not** open Cordis / DSH.

## One Pi plugin, three internal seats

| Module | Seat | Package | Compatibility loader | Spec |
| --- | --- | --- | --- | --- |
| `evok-platform` | Mission / 编排 / TUI·CLI | `plugins/evok-platform/` | `src/cli/evok-platform-plugin.ts` | [evok-platform-chord.md](evok-platform-chord.md) (#190) |
| `evok-research` | 选点 / Harness / SelectionPolicy | `plugins/evok-research/` | `src/cli/evok-research-plugin.ts` | [evok-research-chord.md](evok-research-chord.md) (#191) |
| `evok-eval` | eval / promotion / Broker | `plugins/evok-eval/` | `src/cli/evok-eval-plugin.ts` | [evok-eval-chord.md](evok-eval-chord.md) (#192) |

The unified `evok` entry loads all three seats together. Each seat remains
independently declarable and loadable through its compatibility loader for
focused tests and local experiments, but those loaders are not separate Pi
extensions or user install targets.

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

From the evoK repo root. Current `main` already pins
`@earendil-works/pi-coding-agent@0.86.1` and
`@earendil-works/chord@0.86.1`. The three internal seat modules live in-repo and
declare peer `@earendil-works/chord@^0.86.1` plus conventional
`chord.facets.session` + `chord.facets.tui`.

```bash
# from the evoK repo root
bun install

# use the unified Pi extension from this checkout
pi --extension ./extensions/evok.ts
```

The internal seat packages are **not** published as separate npm plugins and
are **not** installed from a marketplace. The root package manifest declares
`pi.extensions: ["./extensions/evok.ts"]`. You do **not** need a Chord daemon,
Cordis, or DSH.

A fresh clone that is missing `node_modules` is the only install step.
There is no extra Chord bootstrap.

## Load (local pilot)

In-process Chord `FacetHost` + `createStaticFacetLoader`. Session facet
provides the seat service. TUI facet consumes it and lists one smoke
command via a custom `listCommands` service. Those names are **not** Pi
InteractiveMode slashes and **not** CLI mainline verbs.

```ts
import { loadEvokPlugin } from "../src/cli/evok-plugin";

const evok = await loadEvokPlugin();
// evok.modules.platform.seat.experimental === true
// evok.modules.research.seat.defaultSelectionId === "fixed_uct"
// evok.modules.eval.seat.failClosed === true

await evok.dispose();
```

`declareEvokPlugin()` describes the unified product entry. The compatibility
`declareEvok*Plugin()` functions still read each seat package's declared facet
paths. Load with `{ facets: "session" }` for seat services alone, or the
default `"session+tui"` to also register the internal smoke commands.

The unified loader is still an in-process pilot. It is **not** a distributed
Chord fabric and **not** changelog-official hot-plug.

Declare-only snippets and seat fields: the three Spec columns above.

## Internal seat loading

What the internal loader path actually does:

- Each `package.json` can be declared from its `chord.facets` map.
- Each loader can bring up session alone, or session + tui.
- Session exposes a seat service (`evok.platform` / `evok.research` /
  `evok.eval`). Tui lists one smoke command of the same plugin id.
- Plugins do not own Mission authority, parent-selection math, scoring,
  or gate predicates.

What this path does **not** do:

- Changelog-official Chord hot-plug (the 0.86 notes never promised it).
- Chord seat hot-plug through Pi experimental `-e`; the supported entry is
  the unified `extensions/evok.ts` extension.
- Production multi-environment / multi-host Chord.
- Separate user-facing CLI or TUI slashes for the internal seats.
- Cordis / DSH.

If a Chord facet fails to load, the unified extension reports the load failure;
the seat remains unavailable until the underlying module is fixed. This is an
experimental path, not a promise of external Chord hot-plug.

## Smoke (from ET-CHORD-SPLIT-PLATFORM / RESEARCH / EVAL)

Offline; no InteractiveMode and no live model.

```bash
# ET-CHORD-SPLIT-PLATFORM / #190
bun test src/cli/evok-plugin.test.ts
bun test src/cli/evok-platform-plugin.test.ts

# ET-CHORD-SPLIT-RESEARCH / #191
bun test src/cli/evok-research-plugin.test.ts

# ET-CHORD-SPLIT-EVAL / #192
bun test src/cli/evok-eval-plugin.test.ts

bun run typecheck
```

Expected, matching the ET-CHORD-SPLIT handoffs:

| Ticket | Expect |
| --- | --- |
| #190 | `declareEvokPlatformPlugin().changelogOfficialHotPlug === false`; session loads alone; session+tui registers the `evok-platform` smoke command |
| #191 | same honesty pin; `defaultSelectionId === "fixed_uct"`; `progressiveDefault === "off"`; `createDefaultSearchSelectionPort().id` stays `fixed_uct`; `SELECTION_POLICY_40` stays `"off"` |
| #192 | same honesty pin; `failClosed === true`; `autoSubmitFailClosed === true`; `eliteIsPromotion === false`; `evaluateContestAutoSubmitGates({})` still refuses; Admission without holdout still refuses even with `elite: true`; `ELITE_IS_NOT_JINJI` stays true |

Handoffs with the original smoke write-ups:

- [2026-09-21-et-chord-split-platform.md](handoffs/2026-09-21-et-chord-split-platform.md)
- [2026-09-21-et-chord-split-research.md](handoffs/2026-09-21-et-chord-split-research.md)
- [2026-09-22-et-chord-split-eval.md](handoffs/2026-09-22-et-chord-split-eval.md)

## Known limits

- **Experimental.** Not an official changelog promise. Rollback to a
  single extension entry is OK.
- **In-process only.** Static facet loader + `FacetHost` in the same
  Node/Bun process. No multi-env, no multi-host, no daemon.
- **Convention ≠ product path.** `chord.facets` matching pi 0.86
  examples does not ship Pi `-e` as an evoK command.
- **Smoke commands are not slashes.** `listCommands` is a custom
  service, not Pi InteractiveMode and not the CLI mainline.
- **Gates and defaults unchanged.** `#40` stays off unless a Mission or
  `.evok/search.json` opts in. Admission / Budget / hang / T48 / Broker
  predicates are not loosened. Auto-submit stays fail-closed.
- **No Cordis / DSH** in this wave.
- **Plugins do not move authority.** Mission Director, Evaluator,
  Promotion, Admission, and Broker stay where the six-pack put them.

## What this note does not claim

- Changelog-official or production Chord hot-plug
- Three separate user-installed Pi plugins for the internal seats
- Pi experimental `-e` as a separate Chord-seat product path
- Production multi-environment distributed Chord
- Cordis / DSH
- New plugin code, or any change to gates / defaults
- Elite as 晋级 / Promotion / Admission / Broker / kill-test key
