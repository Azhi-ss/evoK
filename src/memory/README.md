# memory

Research Memory is a **derived projection, with no write authority**. Mission
history stays the only write log: nothing in this directory appends, rewrites,
retires or promotes anything there, and a snapshot can be rebuilt from the
Mission record at any time. What lives here is the deterministic projection
(`schema.ts`, `projection.ts`, `packet.ts`, `sham.ts`), the durable derived
storage (`store.ts`, currently the immutable snapshot files plus an atomically
switched pointer; SQLite becomes the primary store in M-b), and Run-bound slice
assembly (`slice.ts`). Serving today is injection only: the Director's revision
is bound to one pinned decision packet, never to whatever the pointer names
later. Gates, promotion, admission, budget,
T48, hang and submission authority stay where ADR-0007 put them; this directory
is a seventh physical home, not a seventh logical owner (ADR-0016).

`index.ts` is the only public export surface: other packages import from
`src/memory`, never from an individual module here. `src/evidence/research-memory.ts`,
`src/execution/research-memory-provider.ts` and `src/execution/memory-slice.ts`
are migration-period re-export shims.

Human Insight (`src/mission/insight-inbox.ts`, `director-insight-sidecar.ts`) is
a parallel Director input, not Research Memory, and stays in `src/mission/`.
