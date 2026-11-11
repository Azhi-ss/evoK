# memory

Research Memory is a **derived projection, with no write authority**. Mission
history stays the only write log: nothing in this directory appends, rewrites,
retires or promotes anything there, and a snapshot can be rebuilt from the
Mission record at any time. What lives here is the deterministic projection
(`schema.ts`, `projection.ts`, `packet.ts`, `sham.ts`), the durable derived
storage (`store.ts`: the immutable snapshot files plus an atomically switched
pointer; `sqlite-store.ts`: the same bytes in one database), Run-bound slice
assembly (`slice.ts`), and the read-only serving tool (`tool.ts`). Serving is two
channels: the Director's revision is bound to one pinned decision packet, never
to whatever the pointer names later; and `memory_read(ref)` (M-d, #245) returns
the body of a card that packet already names, resolved against that same pinned
snapshot. The tool is registered through execution's Run-tool seam, not a memory
seam, cannot search or enumerate, and each read is a `MEMORY_READ` ledger event.
Gates, promotion, admission, budget,
T48, hang and submission authority stay where ADR-0007 put them; this directory
is a seventh physical home, not a seventh logical owner (ADR-0016).

`index.ts` is the only public export surface: other packages import from
`src/memory`, never from an individual module here. `src/evidence/research-memory.ts`,
`src/execution/research-memory-provider.ts` and `src/execution/memory-slice.ts`
are migration-period re-export shims.

## The store (M-c, #244)

**SQLite is the default store.** `default-store.ts` resolves a Mission's
`memory/` namespace to one `research-memory.sqlite` file, migrated from that
Mission's existing `snapshots/*.json` + `active.json` on first use (every file is
re-verified against its content address before anything is written, and a
populated database is never re-seeded). Migration serves the same bytes: a Run
pinned before the switch resolves its recorded digest to an identical snapshot
and packet afterwards.

Nothing above the seam knows which store is live — `publish`, `loadActive` and
`loadPinned` are the whole surface — so the switch cannot change a digest, a
packet or a slice.

**Rollback is configuration, not code:** `EVOK_RESEARCH_MEMORY_STORE=file` serves
from the untouched file store (`createFileResearchMemoryStore`), whose last
pointer is whatever was published before the switch. New publications go to one
store only, so rollback is a pin to the pre-switch snapshot, never a blend of
two histories. Both stores stay until M-e, after the soak period.

**Damage.** A store that cannot produce the pinned bytes throws; it never
reports an empty research history. `reconcileResearchMemory` catches that as
damage, rebuilds the deterministic projection from Mission history, republishes,
verifies the served digest, and records the reason in `RECOVERY_MEMORY_REBUILT`.
Repair boundaries in the database, smallest to largest: a `cards` projection that
disagrees with its `payload` is rebuilt from the payload; a `payload` that no
longer hashes to its address holds no content there, so republication restores
it; a database file that is not a database at all holds no readable content, so
republication recreates it. That last step is safe because everything in the
store is derived (P4), and it is the same repair the file store performed by
rewriting a snapshot file. A valid published `payload` is never rewritten (P5).
A failed one-shot migration is surfaced, never retried: a pre-migration digest
that only ever existed in damaged files reports that damage, not "never
published".

Human Insight (`src/mission/insight-inbox.ts`, `director-insight-sidecar.ts`) is
a parallel Director input, not Research Memory, and stays in `src/mission/`.
