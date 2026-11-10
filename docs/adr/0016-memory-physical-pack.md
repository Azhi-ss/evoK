---
status: proposed
date: 2026-11-11
amends: 0007-six-pack-ownership, 0013-six-pack-physical-closeout
implements: docs/memory-subsystem-prd.md (spec #235), not yet scheduled
---

# 0016 — `src/memory/` as the physical home of the Research Memory projection

## Context

Research Memory is one concept spread across seven files in three packages:
projection and card schemas in `src/evidence/research-memory.ts`, durable storage
in `src/execution/research-memory-provider.ts`, Run-bound slices in
`src/execution/memory-slice.ts`, and lifecycle, prompt assembly, recovery and
evaluation across `src/mission/`. `docs/agents/memory-map.md` exists only because
the layout does not explain itself.

[ADR-0007](0007-six-pack-ownership.md) fixed six **logical** owners and recorded
their physical cuts; [ADR-0013](0013-six-pack-physical-closeout.md) closed those
cuts. Neither anticipated a physical home for a projection that several packages
consume but none should own outright.

Spec [#235](https://github.com/Azhi-ss/evoK/issues/235) and
`docs/memory-subsystem-prd.md` decide to create `src/memory/`. This ADR records
what that directory is and is not, so the six-pack authority map is not read as
amended by implication.

## Decision

`src/memory/` is the physical home of the Research Memory subsystem. It is a
**seventh directory, not a seventh logical owner**.

It owns exactly four things:

| Concern | Module |
|---|---|
| Deterministic projection from Mission history, card and packet schemas | `projection.ts`, `schema.ts`, `packet.ts`, `sham.ts` |
| Durable derived storage (SQLite primary, per #235 D2) | `store.ts` |
| Run-bound slice assembly and delegation | `slice.ts` |
| Read-only serving: injection support and `memory_read(ref)` | `query.ts`, `tool.ts` |

It owns **no write path to Mission history**, and no gate, promotion, admission,
budget, T48, hang, or submission authority.

The six-pack logical map in ADR-0007 is unchanged:

- **evidence** still owns ledger truth, card semantics, and promotion gates.
  `src/memory/` projects that truth; it does not decide it.
- **execution** still owns runtime, role context, policy guard, and the tool
  registration seam. `memory_read` is registered through execution's seam, not a
  new one.
- **mission** still owns the Director, the two-phase decision, the Run loop, and
  when a snapshot is published or pinned.
- **search**, **competition**, **cli** are unaffected.

## Consequences

- Existing modules become re-export shims during migration, following the
  ADR-0013 pattern, and are removed once no importer remains.
- `src/memory/index.ts` is the only public export surface. Other packages import
  from it, not from individual memory modules, so the projection cannot grow a
  second back channel into the ledger.
- `src/memory/README.md` states the authority rule in one paragraph: derived
  projection, no write authority, SQLite primary, injection plus pinned read.
- The `Thin execution default` and the sequential Mission mainline are not
  reopened. Adding a read-only tool does not thicken the Pattern library or
  create a standing agent roster.
- Storage-engine detail (schema, parity evidence, migration and rollback order)
  lives in `docs/memory-subsystem-prd.md` §4, not here.

## Rejected alternative

Placing the same modules under `src/execution/memory/` would be functionally
identical and would avoid amending the physical map. It was rejected because the
point of the change is discoverability: a projection consumed by evidence,
execution and mission should not look like execution's private concern. If this
amendment is not accepted, that layout is the fallback and the spec's module
list applies unchanged.
