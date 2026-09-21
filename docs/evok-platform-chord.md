# evok-platform Chord plugin (pilot)

Independent Chord plugin for the **platform** seat: Mission / 编排 /
TUI·CLI. Ticket: ET-CHORD-SPLIT-PLATFORM / #190. Authority:
`approved/2026-09-21-decision-pi-086-chord-plugins.md`.

This is an **experimental local pilot**. Pi `0.86.0` / `0.86.1` changelogs
did **not** advertise Chord hot-plug. Do not treat this path as a
changelog-official or production multi-environment capability. Failure
may roll back to a single extension entry.

Full how-to / limits write-up is ET-DOC-CHORD / #193.

## Declare

`plugins/evok-platform/package.json` follows the pi 0.86 conventional
plugin shape (`chord.facets.session` + `chord.facets.tui`, peer
`@earendil-works/chord@^0.86`).

```ts
import { declareEvokPlatformPlugin } from "../src/cli/evok-platform-plugin";

declareEvokPlatformPlugin();
// pluginId: "evok-platform"
// changelogOfficialHotPlug: false
```

## Load (local pilot)

In-process Chord `FacetHost` + static facet loader. Session facet
provides `evok.platform`. TUI facet consumes it and lists a smoke
command. Neither facet owns authorize / continue / repair / stop.

```ts
import { loadEvokPlatformPlugin } from "../src/cli/evok-platform-plugin";

const loaded = await loadEvokPlatformPlugin();
// loaded.seat.experimental === true
await loaded.dispose();
```

`evok-research` (#191) and `evok-eval` (#192) are other seats. This
package does not declare or load them.

The package uses the same `chord.facets` convention as pi 0.86 example
plugins. That does **not** make Pi experimental `-e` a shipped evoK
product path, and it is **not** changelog-official Chord hot-plug.
