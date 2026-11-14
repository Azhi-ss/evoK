# evok research seat (internal)

Internal seat of the single evoK Pi plugin: 选点 / Harness / SelectionPolicy.
Ticket: ET-CHORD-SPLIT-RESEARCH / #191. Authority:
`approved/2026-09-21-decision-pi-086-chord-plugins.md`.

This seat is **not** a separate package and **not** changelog-official Chord
hot-plug. Pi `0.86.0` / `0.86.1` changelogs did not advertise that capability.
The product entry is `extensions/evok.ts`. The seat record lives in
`src/cli/evok-plugin.ts`.

Product default remains **`fixed_uct`**. `#40` Progressive / MCTS /
StrongSearch stay **explicit Mission/config opt-in only**. This seat does
**not** flip those defaults. Elite ≠ 晋级 / Promotion / Admission.

Full how-to / limits: [chord-plugins.md](chord-plugins.md)
(ET-DOC-CHORD / #193).

## Load

```ts
import { loadEvokPlugin } from "../src/cli/evok-plugin";

const loaded = await loadEvokPlugin({ facets: "session" });
// loaded.modules.research.seat.pluginId === "evok-research"
// loaded.modules.research.seat.defaultSelectionId === "fixed_uct"
// loaded.modules.research.seat.progressiveDefault === "off"
// loaded.modules.research.seat.selectionPolicy40 === "off"
// loaded.modules.research.seat.eliteIsPromotion === false
// loaded.modules.research.seat.changelogOfficialHotPlug === false
await loaded.dispose();
```

The seat does not own parent-selection math, Admission, Budget, hang, T48,
or Broker. Platform and eval are sibling records on the same load.

If a Progressive surface is exposed through this seat, it remains
**opt-in only**. Elite ranking is inner selection only — not a Promotion key.
