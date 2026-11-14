# memory

Research Memory is a **derived projection, with no write authority**. Mission
history stays the only write log: nothing in this directory appends, rewrites,
retires or promotes anything there, and a snapshot can be rebuilt from the
Mission record at any time. What lives here is the deterministic projection
(`schema.ts`, `projection.ts`, `packet.ts`, `sham.ts`), the durable derived
storage (`store.ts`: the store seam; `sqlite-store.ts`: the immutable snapshot
rows plus an atomically switched pointer in one database), Run-bound slice
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
`src/memory`, never from an individual module here. The former evidence and
execution forwarding files are retired.

## The store (M-c #244, the only store since M-e #246)

**SQLite is the store.** `default-store.ts` resolves a Mission's `memory/`
namespace to one `research-memory.sqlite` file and nothing else: there is no
second layout, no configuration switch and no one-shot migration any more
([ADR-0017](../adr/0017-single-memory-store-closeout.md)).

The seam in `store.ts` (`publish`, `loadActive`, `loadPinned`) stays because the
provider, the recovery path and the tests are written against it; there is simply
one implementation. It cannot change a digest, a packet or a slice, and a Run
pinned before a later publication still resolves its recorded digest to identical
bytes.

**Damage.** A store that cannot produce the pinned bytes throws; it never
reports an empty research history. `reconcileResearchMemory` catches that as
damage, rebuilds the deterministic projection from Mission history, republishes,
verifies the served digest, and records the reason in `RECOVERY_MEMORY_REBUILT`.
Repair boundaries in the database, smallest to largest: a `cards` projection that
disagrees with its `payload` is rebuilt from the payload; a `payload` that no
longer hashes to its address holds no content there, so republication restores
it; a database file that is not a database at all holds no readable content, so
republication recreates it. That last step is safe because everything in the
store is derived (P4), and a valid published `payload` is never rewritten (P5). A Mission whose
pre-M-c memory files were never migrated is not auto-migrated: history is the only
write authority, so recovery rebuilds the same bytes and the stale files are
ignored.

Human Insight (`src/mission/insight-inbox.ts`, `director-insight-sidecar.ts`) is
a parallel Director input, not Research Memory, and stays in `src/mission/`.
