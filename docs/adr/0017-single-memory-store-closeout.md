---
status: accepted
date: 2026-11-12
amends: 0016-memory-physical-pack, 0013-six-pack-physical-closeout
implements: docs/memory-subsystem-prd.md §4.4, §7 (M-e) and §9 (spec #235); delivered by #246
---

# 0017 — One store, one layout: the file store and the migration shims are deleted

## Context

[ADR-0016](0016-memory-physical-pack.md) recorded `src/memory/` as the physical
home and kept two migration crutches alive on purpose: re-export shims at the old
module paths, and the pre-M-c file store (`snapshots/<digest>.json` +
`active.json`) as the rollback reader behind `EVOK_RESEARCH_MEMORY_STORE=file`.
PRD §4.4 allowed deleting the file store only "after parity is green across the
memory test suite … then get deleted", and issue #246 required a soak period with
the decision recorded. #247's eligibility check parked the ticket precisely
because no such record existed, and silence was not treated as approval.

## The soak evidence

- M-c (#244, `d9b9e21`) made SQLite the default store.
- The whole structure refactor then ran on it: #254 (trace-equivalence harness
  and `src/harness/`), #255, #256 (harness capability), #257 (the five named
  Mission controller stages). Nothing in that refactor reached into the file
  format, and no rollback was invoked: the default path has been the SQLite store
  for every Run since M-c.
- Parity was measured on bytes, not impressions: for one Mission record, both
  stores returned identical snapshot digests and identical packet projections
  (`src/memory/sqlite-store.test.ts` while both existed), and the served bytes
  are independently pinned for a fixed input by seven literals computed before
  M-a (`src/memory/digests.test.ts`).
- P1–P6 each have a named SQLite test and stayed green through the refactor: the
  store is not a newly trusted component, it is the one that already served.

The reservation comment on #246
(`#issuecomment-6813918070`) records that this satisfies the soak requirement, and
this ADR is the recorded decision the AC asks for.

## Decision

Delete the file store, its one-shot migration and the rollback switch:

- `publishResearchMemorySnapshot`, `loadResearchMemorySnapshot`,
  `createFileResearchMemoryStore`, `loadFileResearchMemorySnapshots`,
  `createResearchMemoryProvider`, `RESEARCH_MEMORY_POINTER_SCHEMA` and the
  `snapshots/` + `active.json` layout are gone from `src/memory/store.ts`.
- `migrateFileResearchMemory` and the `migrateFrom` argument of
  `createSqliteResearchMemoryStore` are gone from `src/memory/sqlite-store.ts`.
- `EVOK_RESEARCH_MEMORY_STORE`, `researchMemoryStoreName`,
  `ResearchMemoryStoreName` and the `ResearchMemoryStoreName` branch in
  `researchMemoryStoreFor` are gone from `src/memory/default-store.ts`.

`ResearchMemoryStore` stays: it is the seam the provider, the recovery path and
the tests are written against, and it is what makes `withDatabase` private.
There is simply one implementation now.

The flat `src/*.ts` re-export shims that ADR-0013 kept "for one more release" are
deleted in the same ticket, along with the three memory shims
(`src/evidence/research-memory.ts`, `src/execution/research-memory-provider.ts`,
`src/execution/memory-slice.ts`). Every importer was retargeted to the physical
module; nothing was retargeted by editing an appender of the old path, and no
package may import an individual module inside `src/memory/` — `index.ts` remains
the only public surface.

## Consequences

- **One store, one layout.** A Mission's durable memory is exactly
  `missions/<id>/memory/research-memory.sqlite`. Nothing writes `snapshots/` or
  `active.json` any more, and no configuration selects another store.
- **No migration path, deliberately.** A Mission whose files predate M-c and
  which was never read since then is not auto-migrated any more. That is not data
  loss: Mission history is the only write authority (PRD D4), memory is a derived
  projection, and `reconcileResearchMemory` rebuilds the identical snapshot bytes
  from history on resume (P4, `deterministic rebuild`). A stale file layout on
  disk is simply ignored, and the next publication writes only the database.
- **Rollback is no longer available.** Reverting this ADR would have to restore
  the file store from history (`git show 641c443:src/memory/store.ts`), not from
  any surviving artifact. This is why the decision needed the soak record above.
- Publishing into a database that is not a database still rebuilds rather than
  blocks, and a corrupt row is still repaired only by republication of bytes that
  address it (P5): the single store keeps the repair posture the file store had.
- The shim deletion is proved behaviour-neutral, not merely green: the ledger
  trace-equivalence harness (`tests/integration/ledger-trace.test.ts`) pins the
  normalized trace digest of a simulated Mission and `src/memory/digests.test.ts`
  pins the seven served-content digests, both computed at review base `641c443`
  and both unchanged after the deletion.

## Rejected alternative

Keeping the file reader as a read-only fallback "in case the database is lost"
was rejected: it is a second layout to test, document and keep in parity forever,
it protects against a case `reconcileResearchMemory` already repairs from the only
authoritative source, and it leaves the two-store ambiguity that ADR-0016's
`default-store.ts` existed to manage.
