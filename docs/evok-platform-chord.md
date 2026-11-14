# evok platform seat (internal)

Internal seat of the single evoK Pi plugin: Mission / 编排 / TUI·CLI.
Ticket: ET-CHORD-SPLIT-PLATFORM / #190. Authority:
`approved/2026-09-21-decision-pi-086-chord-plugins.md`.

This seat is **not** a separate package and **not** changelog-official Chord
hot-plug. Pi `0.86.0` / `0.86.1` changelogs did not advertise that capability.
The product entry is `extensions/evok.ts`. The seat record lives in
`src/cli/evok-plugin.ts`.

Full how-to / limits: [chord-plugins.md](chord-plugins.md)
(ET-DOC-CHORD / #193).

## Load

```ts
import { loadEvokPlugin } from "../src/cli/evok-plugin";

const loaded = await loadEvokPlugin({ facets: "session" });
// loaded.modules.platform.seat.pluginId === "evok-platform"
// loaded.modules.platform.seat.experimental === true
// loaded.modules.platform.seat.changelogOfficialHotPlug === false
await loaded.dispose();
```

The seat does not own authorize / continue / repair / stop. Those stay in
`src/mission/`. Research and eval are sibling records on the same load.
They are not plugins this seat loads.

`{ facets: "session" }` lists no smoke command. The default
`"session+tui"` adds `evok-platform` on the unified plugin. That name is
not a Pi slash and not Mission authority.
