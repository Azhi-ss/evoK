---
status: spec
version: 0.1
date: 2026-11-11
implements: none yet — spec only, no tickets until #221 and #222 close
supersedes: nothing; extends docs/long-term-memory-prd.md (M1, delivered)
---

# Memory Subsystem PRD — `src/memory/`, SQLite primary store, dual-channel serving

## 0. Status and sequencing

This is a **spec, not a ticket set**. Do not open implementation tickets yet.

Blocked behind:

- **#221** (fan-out consolidation, chain #223→#229): it moves the tool-registration
  and child-dispatch seams this PRD depends on. Ticket M-d must not start before it.
- **#222** (memory evaluation, chain #230→#234): it changes what "comparable across
  arms" means. Any storage change that alters served bytes invalidates its baselines.

When both chains close, run the **aggregation pass** in §9 before writing tickets.

Scope of this document: physical layout, storage engine, serving channels, and the
documentation that goes stale. **Not** in scope: new memory semantics, new card
kinds, cross-Mission memory (M2), retrieval ranking, embeddings.

## 1. Problem

Research Memory is one concept spread across three packages with no single entry
point. A new contributor cannot find "the memory module":

| Concern | Lives in |
|---|---|
| Projection, card schemas, decision packet | `src/evidence/research-memory.ts` (63 KB, single file) |
| Durable snapshot + provider | `src/execution/research-memory-provider.ts` |
| Run-bound slice | `src/execution/memory-slice.ts` |
| Lifecycle, publish, revision stage | `src/mission/mission-start.ts` |
| Prompt assembly | `src/mission/mission-director.ts` |
| Recovery rebuild | `src/mission/mission-resume.ts` |
| Offline evaluation | `src/mission/memory-evaluation.ts` |

`docs/agents/memory-map.md` exists precisely because the layout does not explain
itself. That map is a symptom, not a solution.

Two further gaps:

1. **Memory is injection-only.** An agent cannot ask for memory; it receives
   whatever the Director pinned. Truncation is unrecoverable mid-Run.
2. **Storage is opaque to inspection.** `snapshots/<digest>.json` is correct but
   cannot be queried. Answering "which Runs produced contradicting Evidence for
   hypothesis H" requires re-projecting the whole Mission record.

## 2. Decisions (locked by the operator, 2026-11-11)

| # | Decision |
|---|---|
| D1 | Create `src/memory/` as the physical home of the memory subsystem. |
| D2 | **SQLite is the primary store**, replacing `snapshots/*.json` + `active.json`. Not a derived index. |
| D3 | Dual-channel serving: automatic injection of a pinned decision packet, **plus** a read-only `memory_read(ref)` tool. |
| D4 | This PRD does not change the authority model: Mission history remains the only write authority; memory is a derived projection. |

D2 was explicitly chosen over a "SQLite as derived index, files as primary"
alternative. §4 records the properties that choice must not lose.

## 3. Target physical layout

```text
src/memory/
  schema.ts        card / snapshot / packet schemas, digest computation
  projection.ts    deterministic projection from Mission history (pure, no IO)
  store.ts         SQLite store: the only IO boundary for durable memory
  slice.ts         Run-bound MemorySlice assembly and delegation
  packet.ts        decision-packet projection, reservation, omission accounting
  sham.ts          Sham control projection (kept separate so it is never accidental)
  query.ts         read-only queries used by both channels
  tool.ts          memory_read(ref) tool definition and validation
  index.ts         the only public export surface
```

Existing modules become **re-export shims** during migration, exactly as the
six-pack cuts did (ADR-0013 kept flat `src/*.ts` shims for one release):

| Old path | Becomes |
|---|---|
| `src/evidence/research-memory.ts` | shim → `src/memory/{schema,projection,packet,sham}.ts` |
| `src/execution/research-memory-provider.ts` | shim → `src/memory/store.ts` |
| `src/execution/memory-slice.ts` | shim → `src/memory/slice.ts` |

### 3.1 Relationship to ADR-0007 / ADR-0013 — needs an ADR amendment

Those ADRs fix **six logical packages** and record their physical closeout.
Creating `src/memory/` as a seventh directory is a physical change that touches
`evidence` and `execution` ownership boundaries.

**This PRD requires a short ADR amendment before any move**, stating:

- `memory/` is a physical home for a cross-cutting projection, **not** a new
  logical owner of Mission, ledger, gate, or control-plane authority.
- `evidence` still owns ledger truth and promotion gates. `execution` still owns
  runtime and role context. `mission` still owns the Director and the Run loop.
- `memory/` owns only: projection, durable derived storage, slice assembly,
  read-only serving. It owns **no write path to Mission history**.

Alternative if the amendment is rejected: keep the six directories and place the
same modules under `src/execution/memory/`. Functionally identical; the only loss
is discoverability, which was the point of D1.

## 4. Storage: SQLite as primary store

### 4.1 Properties the current file design has that SQLite must preserve

These are **hard requirements**, not preferences. Each needs a named test.

| # | Property | Current mechanism | SQLite requirement |
|---|---|---|---|
| P1 | Content addressing | filename = digest | digest column, unique, recomputed and compared on every read |
| P2 | Atomic publication | write complete file, fsync, atomic `rename` of pointer | single transaction writing snapshot rows + active-pointer row; readers see old or new, never partial |
| P3 | Corruption is never "empty history" | `MemorySliceError` on malformed pointer / missing snapshot / digest mismatch | any integrity failure throws; **no** fallback to zero cards |
| P4 | Deterministic rebuild from Mission history | `reconcileResearchMemory` re-projects | rebuild must reproduce byte-identical digests, or the revision pin breaks |
| P5 | Immutable published snapshots | files are never edited in place | `UPDATE`/`DELETE` on snapshot content is not exposed by the store API |
| P6 | No future information | packet pins `ledgerRevision` | every read is scoped to a pinned snapshot id, never "latest" |

P4 deserves emphasis: `MissionRunRecord.researchMemory.ledgerRevision` pins what a
Run was durably served, and `replayResearchMemory` depends on it. A storage change
that silently alters served content makes every completed Run non-reproducible.

### 4.2 Schema sketch (decision-rich, not final DDL)

```sql
-- One row per published projection. Content is immutable once inserted.
snapshots(
  digest        TEXT PRIMARY KEY,   -- P1 content address
  snapshot_id   TEXT NOT NULL,
  mission_id    TEXT NOT NULL,
  ledger_rev    INTEGER NOT NULL,   -- P6
  memory_rev    INTEGER NOT NULL,
  control       TEXT,               -- 'sham' | NULL
  payload       BLOB NOT NULL,      -- canonical JSON of the snapshot
  published_at  TEXT NOT NULL
);

-- Exactly one active row per (mission_id, arm). Switched inside the same
-- transaction that inserts the snapshot, so P2 holds.
active(
  mission_id    TEXT NOT NULL,
  arm           TEXT NOT NULL,      -- off | sham | real
  digest        TEXT NOT NULL REFERENCES snapshots(digest),
  PRIMARY KEY (mission_id, arm)
);

-- Query surface only. Rebuilt from snapshots.payload; never authoritative.
cards(
  digest        TEXT NOT NULL REFERENCES snapshots(digest),
  card_id       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  run_id        TEXT,
  status        TEXT,
  conditions    TEXT,               -- canonical JSON of applicability conditions
  ordinal       INTEGER NOT NULL,   -- preserves projection order
  PRIMARY KEY (digest, card_id)
);
```

`cards` is a **query projection**, not a second fact source. `snapshots.payload`
is the served artifact; a mismatch between `cards` and `payload` is corruption (P3).

Open question for the implementer: whether `payload` is stored as canonical JSON
text or a binary blob. JSON text is easier to inspect with the `sqlite3` CLI and
sufficient at M1 sizes. **Prefer JSON text.**

### 4.3 What SQLite must not become

- Not a Mission record store. Mission history stays where it is.
- Not a cross-Mission knowledge base. That is M2 and needs its own evidence.
- Not a place agents write to. The store API exposes no agent-facing mutation.
  `MemoryWriteProposal` remains a proposal, validated elsewhere.

### 4.4 Migration and rollback

1. Introduce the SQLite store **behind the existing provider interface**, with the
   file store still available.
2. A one-shot migration reads existing `snapshots/*.json` and inserts them,
   verifying each digest. Existing Runs must observe identical bytes.
3. A parity test asserts: for the same Mission record, file store and SQLite store
   return snapshots with identical digests and identical packet projections.
4. Only after parity is green across the memory test suite does the file store
   become a fallback, then get deleted.

Rollback is "point the provider back at the file store", which requires keeping
the file reader until the parity evidence exists. Do not delete it in the same
ticket that introduces SQLite.

## 5. Serving: dual channel

### 5.1 Channel 1 — automatic injection (unchanged semantics)

The two-phase Director stays: blind Proposal frozen first, then a
Memory-informed Revision carrying a `ResearchDecisionPacket`. Only the Revised
proposal may dispatch.

The packet keeps its existing guarantees: reserved categories for contradicting
Evidence and competing Hypotheses, per-category omission counts, `truncated`
flag, `digest`. **A storage change must not alter packet bytes for a given input.**

### 5.2 Channel 2 — `memory_read(ref)` tool

New. Read-only, reference-scoped, snapshot-pinned.

| Rule | Reason |
|---|---|
| Accepts a card reference already present in the served packet | prevents free-form retrieval becoming a second, unmeasured information channel |
| Resolves against the **same pinned snapshot** as the Run's injection | otherwise a Run could read the future and P6 breaks |
| Returns the card body plus its provenance refs | bodies are excluded from the slice by `readPolicy`; the tool is the sanctioned way to get one |
| Cannot enumerate, search, or list cards outside the packet | keeps Off/Sham/Real arms comparable |
| Never crosses Run, Mission, or arm boundaries | same rule as `deriveDelegatedMemorySlice` |
| Emits a ledger-visible read event | otherwise memory reads are invisible to accountability and to #222 metrics |

**The read event matters for evaluation.** If the Real arm can fetch bodies on
demand and the Off arm cannot, then "Off vs Real" measures tool access, not
memory. The Sham arm must therefore expose the same tool returning control-slot
bodies. This constraint belongs in the #222 evaluation contract, not just here.

### 5.3 Deliberately rejected: free-text / semantic search

Not now. It introduces non-deterministic retrieval into a system whose evaluation
depends on reproducible served content, and there is no evidence the current
packet truncation is the binding constraint. Revisit only after L1 (#232) shows a
directional signal **and** truncation is measured as the cause of a bad decision.

## 6. Tool registration depends on #221

Today `registerTool` appears only in `src/cli/pi-campaign-director.ts` (five
`evok_*` tools, no production caller) and `src/execution/pi-child-tools.ts`. The
mainline Run session has no evoK tool registration point.

So `memory_read` needs a real registration seam on the mainline Run path, and
#221 is actively moving those seams. **M-d must wait for #221**, and the ticket
must name the final seam rather than guessing now.

## 7. Ticket plan (to be opened only after #221 and #222 close)

| Id | Title | Depends on | Delivers |
|---|---|---|---|
| M-a | ADR amendment + physical aggregation into `src/memory/` | — | modules moved, old paths re-export, zero behaviour change, memory-map rewritten |
| M-b | SQLite store behind the provider interface, with migration and parity tests | M-a | both stores live; parity proven; file store still the default |
| M-c | Switch primary store to SQLite, keep file reader as rollback | M-b | SQLite serves; digests unchanged; P1–P6 each have a named test |
| M-d | `memory_read(ref)` on the mainline Run seam, with read events and Sham parity | M-a, #221 | agent can fetch a referenced body; evaluation arms stay comparable |
| M-e | Delete the file store and the migration shims | M-c, M-d, plus one release of soak | single store, single layout, stale docs removed |

M-b and M-c are split on purpose: introducing a store and making it authoritative
are different risks, and the parity evidence belongs between them.

## 8. Documentation that will go stale

Update these **in the same ticket that changes the behaviour**, not later:

| Document | What changes |
|---|---|
| `docs/agents/memory-map.md` | the entire seam table points at old paths; rewrite around `src/memory/` and the two channels |
| `CONTEXT.md` | memory described as spanning evidence+execution; needs the new physical home and the store |
| `docs/long-term-memory-prd.md` | status `m1-delivered`; add a pointer here so M1 is not read as the current storage design |
| `docs/adr/0007-six-pack-ownership.md` | amendment required by §3.1 |
| `docs/adr/0013-six-pack-physical-closeout.md` | physical table gains `memory/`; shim list changes |
| `docs/adr/0001-pi-agent-runtime-session-policy.md` | if `memory_read` adds a tool to the Run session, the session policy statement must mention it |
| `src/evidence/README.md`, `src/execution/README.md`, `src/mission/README.md` | each currently documents its own memory piece |
| `AGENTS.md` | the domain-docs line points at `memory-map.md`; keep, but the map content changes |

Also add `src/memory/README.md` describing the authority rule in one paragraph:
derived projection, no write authority, SQLite primary, injection + pinned read.

## 9. Aggregation pass (run when no tickets remain open)

A single review, not a feature ticket. Checklist:

1. **Dead code**: `dag-scheduler.ts`, `team-execution.ts`,
   `pi-campaign-director.ts` — confirm each is either wired or deleted, and that
   no barrel still exports a removed symbol. (`collaboration-scheduler.ts` and
   `pi-child-work/owner.ts` are already deleted by #221, so only these three are
   still open.)
2. **Shims**: flat `src/*.ts` re-exports kept by ADR-0013 plus the new memory
   shims; remove any with no remaining importer.
3. **Docs drift**: every row of §8 re-read against the code.
4. **Spec files**: `docs/subagent-fanout-consolidation.md` (v1) is superseded by
   v2 and should be deleted or marked superseded; the two v2 specs should be
   committed rather than left untracked.
5. **God files**: `src/mission/mission-start.ts` (2000+ lines) and
   `src/evidence/research-memory.ts` (63 KB) — decide whether M-a already split
   the latter, and open a separate ticket for the former only if the Run loop is
   still unreadable.
6. **Baseline flakiness**: on 2026-11-11 a pre-commit run in the main worktree
   reported 124 current failures against 42 accepted, with ~82 NEW failures all in
   the `harness-opt` optimize / search-tree suites, and refused the commit. The
   same gate passed in a clean worktree (39 current) and passed again in the main
   worktree after `bun install --frozen-lockfile` (36 current), with no code
   change in between. So the accepted union is **not** wrong and must not be
   widened. What is missing is an explanation: why does `bun test
   --rerun-all-tests` intermittently fail the whole `harness-opt` workspace in a
   worktree whose installed tree matches the lockfile? Until that is understood,
   a red gate should be re-run once in a clean worktree before anyone concludes
   either "regression" or "baseline needs updating".

## 10. Explicitly out of scope

- Cross-Mission memory (M2) — requires evidence that M1's benefit exceeds its
  decision cost, which #222 has not yet produced.
- New card kinds, synthesis authority, background LLM synthesis.
- Vector stores, embeddings, Neo4j.
- Transcript storage or Pi session reuse (ADR-0001).
- A2A or any external agent peer.
- Parallel Mission mainline fan-out.
