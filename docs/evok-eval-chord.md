# evok-eval Chord plugin (pilot)

Independent Chord plugin for the **评测发布** seat: eval / promotion /
Broker. Ticket: ET-CHORD-SPLIT-EVAL / #192. Authority:
`approved/2026-09-21-decision-pi-086-chord-plugins.md`.

This is an **experimental local pilot**. Pi `0.86.0` / `0.86.1` changelogs
did **not** advertise Chord hot-plug. Do not treat this path as a
changelog-official or production multi-environment capability. Failure
may roll back to a single extension entry.

Admission / Budget / hang / T48 / Broker predicates stay **fail-closed**.
This plugin does **not** loosen those gates. Contest-arm auto-submit
remains fail-closed. Elite ≠ 晋级 / Promotion / Admission / Broker.

Full how-to / limits write-up is ET-DOC-CHORD / #193.

## Declare

`plugins/evok-eval/package.json` follows the pi 0.86 conventional
plugin shape (`chord.facets.session` + `chord.facets.tui`, peer
`@earendil-works/chord@^0.86`).

```ts
import { declareEvokEvalPlugin } from "../src/cli/evok-eval-plugin";

declareEvokEvalPlugin();
// pluginId: "evok-eval"
// seat: "eval-promotion-broker"
// failClosed: true
// changelogOfficialHotPlug: false
```

## Load (local pilot)

In-process Chord `FacetHost` + static facet loader. Session facet
provides `evok.eval`. TUI facet consumes it and lists a smoke
command. Neither facet owns scoring math, Admission, Budget, hang,
T48, or Broker.

```ts
import { loadEvokEvalPlugin } from "../src/cli/evok-eval-plugin";

const loaded = await loadEvokEvalPlugin();
// loaded.seat.failClosed === true
// loaded.seat.autoSubmitFailClosed === true
// loaded.seat.eliteIsPromotion === false
await loaded.dispose();
```

`evok-platform` (#190) and `evok-research` (#191) are other seats. This
package does not declare or load them.

The package uses the same `chord.facets` convention as pi 0.86 example
plugins. That does **not** make Pi experimental `-e` a shipped evoK
product path, and it is **not** changelog-official Chord hot-plug.

Seat declaration only. Auto-submit policy is unchanged. Elite ranking
is not a Promotion key.
