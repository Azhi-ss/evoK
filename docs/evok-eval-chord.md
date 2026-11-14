# evok eval seat (internal)

Internal seat of the single evoK Pi plugin: eval / promotion / Broker.
Ticket: ET-CHORD-SPLIT-EVAL / #192. Authority:
`approved/2026-09-21-decision-pi-086-chord-plugins.md`.

This seat is **not** a separate package and **not** changelog-official Chord
hot-plug. Pi `0.86.0` / `0.86.1` changelogs did not advertise that capability.
The product entry is `extensions/evok.ts`. The seat record lives in
`src/cli/evok-plugin.ts`.

Admission / Budget / hang / T48 / Broker predicates stay **fail-closed**.
This seat does **not** loosen those gates. Contest-arm auto-submit remains
fail-closed. Elite ≠ 晋级 / Promotion / Admission / Broker.

Full how-to / limits: [chord-plugins.md](chord-plugins.md)
(ET-DOC-CHORD / #193).

## Load

```ts
import { loadEvokPlugin } from "../src/cli/evok-plugin";

const loaded = await loadEvokPlugin({ facets: "session" });
// loaded.modules.eval.seat.pluginId === "evok-eval"
// loaded.modules.eval.seat.seat === "eval-promotion-broker"
// loaded.modules.eval.seat.failClosed === true
// loaded.modules.eval.seat.autoSubmitFailClosed === true
// loaded.modules.eval.seat.eliteIsPromotion === false
// loaded.modules.eval.seat.changelogOfficialHotPlug === false
await loaded.dispose();
```

The seat does not own scoring math, Promotion, Admission, Budget, hang, T48,
or Broker. Promotion ≠ Admission. Platform and research are sibling records
on the same load.

Seat declaration only. Auto-submit policy is unchanged. Elite ranking is
not a Promotion key.
