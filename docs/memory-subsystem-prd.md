---
status: delivered
version: 0.2
date: 2026-11-11 (M-e closeout 2026-11-12)
implements: M-a #242, M-b #243, M-c #244, M-d #245, M-e #246 — all delivered
supersedes: nothing; extends docs/long-term-memory-prd.md (M1, delivered)
---

# Memory Subsystem PRD — `src/memory/`, SQLite primary store, dual-channel serving

## 0. Status and sequencing

**Delivered.** M-a–M-e are all closed; M-e (#246) ran the §9 aggregation pass and
deleted the file store, its migration and the re-export shims
([ADR-0017](adr/0017-single-memory-store-closeout.md)). The sequencing notes below
are kept as the record of why each ticket waited.

This was a **spec, not a ticket set**. Blocked behind:

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

Existing modules became **re-export shims** during migration, exactly as the
six-pack cuts did (ADR-0013 kept flat `src/*.ts` shims for one release). All
three are **deleted** by M-e (#246); every importer was retargeted to
`src/memory`:

| Old path | Was |
|---|---|
| `src/evidence/research-memory.ts` | shim → `src/memory` (named re-exports of the pre-move surface) |
| `src/execution/research-memory-provider.ts` | shim → `src/memory` (named re-exports of the pre-move surface) |
| `src/execution/memory-slice.ts` | shim → `src/memory` (named re-exports of the pre-move surface) |

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
| M-e | Delete the file store and the migration shims — **delivered (#246)** | M-c, M-d, plus one release of soak (satisfied: SQLite served every Run through #254–#257; see ADR-0017) | single store, single layout, stale docs removed |

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

### 9.1 Result — the pass was run in M-e (#246)

| # | Item | Outcome |
|---|---|---|
| 1 | Dead code | `pi-campaign-director.ts` is **wired**: `extensions/evok.ts` registers `registerCampaignDirector`, and `src/cli/pi-campaign-director.test.ts` + `tests/integration/pi-supervisor.test.ts` cover it. `dag-scheduler.ts` and `team-execution.ts` are **wired as barrel capability**, not as mainline execution: `src/execution/index.ts` exports `Coordinator`/`PolicyGuard`/`DeterministicScheduler`/`ArtifactFanIn` and `DAGScheduler`/`MissionQueue`, each with its own test suite, but no production path constructs them — the mainline is sequential (#257) and on-demand fan-out is a capability, not a default (ADR-0013 thin-default rule). Deleted nothing: removing them would delete an ADR-protected capability, which is a capability change, not an aggregation cleanup. No barrel exports a removed symbol (typecheck is the proof). |
| 2 | Shims | All 32 flat `src/*.ts` re-exports from ADR-0013 and the three memory shims are deleted; 121 importer specifiers were retargeted to the physical modules. `tests/integration/six-pack-physical-closeout.test.ts` now asserts that no flat re-export exists. |
| 3 | Docs drift | Every row of §8 re-read and fixed: `memory-map.md` and `CONTEXT.md` rewritten around the single store; ADR-0013's shim table marked deleted; ADR-0016's storage row amended; ADR-0007 needed no further change (M-a landed its amendment) and ADR-0001 already records `memory_read` as a runtime-registered trusted tool (its M-d note); the three pack READMEs mention no memory path; `docs/long-term-memory-prd.md` already points here. Two pack barrels (`src/evidence/index.ts`, `src/execution/index.ts`) re-exported the memory surface as a second route; those blocks are removed so `src/memory` is the only one. |
| 4 | Spec files | `docs/subagent-fanout-consolidation-v2.md` and `docs/research-memory-evaluation-v2.md` are tracked and now marked **delivered** (#221/#222 closed). No v1 fanout file survives to delete. |
| 5 | God files | `src/evidence/research-memory.ts` no longer exists (M-a split it into `src/memory/`, 554-line projection plus schema/packet/sham). `src/mission/mission-start.ts` is 1881 lines, but the Run loop is no longer inside it: it is a ~100-line orchestration over `run-preparation.ts`, `director-phases.ts`, `run-dispatch.ts`, `run-finalization.ts`, `recovery.ts` (#257). **No separate ticket opened** — AC6's condition ("if the Run loop is still unreadable") is not met. |
| 6 | Baseline flakiness | Not reproducible at `641c443`: `bun run check` is green (39 current failures against 42 accepted) before and after this pass, in a fresh worktree with a lockfile install. No accepted-union change, no explanation added — the PRD's re-run-in-a-clean-worktree rule stays the advice. |

## 10. Explicitly out of scope

- Cross-Mission memory (M2) — requires evidence that M1's benefit exceeds its
  decision cost, which #222 has not yet produced.
- New card kinds, synthesis authority, background LLM synthesis.
- Vector stores, embeddings, Neo4j.
- Transcript storage or Pi session reuse (ADR-0001).
- A2A or any external agent peer.
- Parallel Mission mainline fan-out.
