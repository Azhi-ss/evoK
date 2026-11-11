# memory

Research Memory is a **derived projection, with no write authority**. Mission
history stays the only write log: nothing in this directory appends, rewrites,
retires or promotes anything there, and a snapshot can be rebuilt from the
Mission record at any time. What lives here is the deterministic projection
(`schema.ts`, `projection.ts`, `packet.ts`, `sham.ts`), the durable derived
storage (`store.ts`, currently the immutable snapshot files plus an atomically
switched pointer; SQLite becomes the primary store in M-b), Run-bound slice
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

Human Insight (`src/mission/insight-inbox.ts`, `director-insight-sidecar.ts`) is
a parallel Director input, not Research Memory, and stays in `src/mission/`.
