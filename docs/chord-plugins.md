# Chord multi-plugin pilot

How to install and load the three independent Chord plugins that landed
on the Pi 0.86 / Chord wave. Per-seat contracts stay in the
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
changelog capability, **not** a shipped evoK CLI/TUI verb, and **not**
production multi-environment distributed Chord. If the experiment fails
or is abandoned, **roll back to the single extension entry** (the
shipped `evok` CLI / Pi native TUI). That rollback is acceptable.

The packages follow the same `chord.facets` convention as pi 0.86
example plugins. That does **not** make Pi experimental `-e` a shipped
evoK product path.

This note does **not** open Cordis / DSH.

## Three independent seats

| Plugin | Seat | Package | Local loader | Spec |
| --- | --- | --- | --- | --- |
| `evok-platform` | Mission / 编排 / TUI·CLI | `plugins/evok-platform/` | `src/cli/evok-platform-plugin.ts` | [evok-platform-chord.md](evok-platform-chord.md) (#190) |
| `evok-research` | 选点 / Harness / SelectionPolicy | `plugins/evok-research/` | `src/cli/evok-research-plugin.ts` | [evok-research-chord.md](evok-research-chord.md) (#191) |
| `evok-eval` | eval / promotion / Broker | `plugins/evok-eval/` | `src/cli/evok-eval-plugin.ts` | [evok-eval-chord.md](evok-eval-chord.md) (#192) |

Each plugin is independently declarable and loadable. Loading one does
**not** declare or load the others. There is no shipped product command
that mounts all three at once.

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
`@earendil-works/chord@0.86.1`. The three plugins live in-repo and
declare peer `@earendil-works/chord@^0.86.1` plus conventional
`chord.facets.session` + `chord.facets.tui`.

```bash
# from the evoK repo root
bun install

# confirm the three in-repo packages are present
ls plugins/evok-platform/package.json \
   plugins/evok-research/package.json \
   plugins/evok-eval/package.json
```

They are **not** published npm plugins and are **not** installed from a
marketplace. You do **not** need a Chord daemon, Cordis, or DSH.

A fresh clone that is missing `node_modules` is the only install step.
There is no extra Chord bootstrap.

## Load (local pilot)

In-process Chord `FacetHost` + `createStaticFacetLoader`. Session facet
provides the seat service. TUI facet consumes it and lists one smoke
command via a custom `listCommands` service. Those names are **not** Pi
InteractiveMode slashes and **not** CLI mainline verbs.

```ts
import { loadEvokPlatformPlugin } from "../src/cli/evok-platform-plugin";
import { loadEvokResearchPlugin } from "../src/cli/evok-research-plugin";
import { loadEvokEvalPlugin } from "../src/cli/evok-eval-plugin";

const platform = await loadEvokPlatformPlugin();
// platform.declaration.changelogOfficialHotPlug === false
// platform.seat.experimental === true

const research = await loadEvokResearchPlugin();
// research.seat.defaultSelectionId === "fixed_uct"
// research.seat.progressiveDefault === "off"

const evalPlugin = await loadEvokEvalPlugin();
// evalPlugin.seat.failClosed === true
// evalPlugin.seat.autoSubmitFailClosed === true
// evalPlugin.seat.eliteIsPromotion === false

await platform.dispose();
await research.dispose();
await evalPlugin.dispose();
```

`declareEvok*Plugin()` reads each package's declared facet paths. Load
with `{ facets: "session" }` for the seat service alone, or the default
`"session+tui"` to also register the smoke command.

Calling all three loaders in one process is a **local experiment**, still
the same in-process pilot. It is **not** a distributed Chord fabric and
**not** changelog-official hot-plug.

Declare-only snippets and seat fields: the three Spec columns above.

## Hot-plug expectations

What the local pilot path actually does:

- Each `package.json` can be declared from its `chord.facets` map.
- Each loader can bring up session alone, or session + tui.
- Session exposes a seat service (`evok.platform` / `evok.research` /
  `evok.eval`). Tui lists one smoke command of the same plugin id.
- Plugins do not own Mission authority, parent-selection math, scoring,
  or gate predicates.

What this path does **not** do:

- Changelog-official Chord hot-plug (the 0.86 notes never promised it).
- Pi experimental `-e` as a shipped evoK product command.
- Production multi-environment / multi-host Chord.
- A new CLI or TUI slash that enables the three plugins.
- Cordis / DSH.

If hot-plug fails: keep using the shipped single extension entry. Do
not treat a failed or missing plugin load as a product regression.

## Smoke (from ET-CHORD-SPLIT-PLATFORM / RESEARCH / EVAL)

Offline; no InteractiveMode and no live model.

```bash
# ET-CHORD-SPLIT-PLATFORM / #190
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

- [2026-09-21-et-chord-split-platform.md](../handoffs/2026-09-21-et-chord-split-platform.md)
- [2026-09-21-et-chord-split-research.md](../handoffs/2026-09-21-et-chord-split-research.md)
- [2026-09-22-et-chord-split-eval.md](../handoffs/2026-09-22-et-chord-split-eval.md)

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
- A shipped CLI/TUI command that installs or mounts the three plugins
- Pi experimental `-e` as an evoK product path
- Production multi-environment distributed Chord
- Cordis / DSH
- New plugin code, or any change to gates / defaults
- Elite as 晋级 / Promotion / Admission / Broker / kill-test key
