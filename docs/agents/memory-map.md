# Memory subsystem map

Research Memory has one physical home: `src/memory/` ([ADR-0016](../adr/0016-memory-physical-pack.md),
seventh directory, not a seventh logical owner). Reading one module is still not
always enough — lifecycle and prompt assembly stay in `src/mission/` — but the
projection, the packet, the store and the slice are now in one place. Read this
map before changing the memory projection, the decision packet, Run injection,
recovery, or the evaluation.

`src/memory/index.ts` is the only public export surface: code outside the
directory imports from `src/memory`, never from an individual module in it. The
old paths (`src/evidence/research-memory.ts`,
`src/execution/research-memory-provider.ts`, `src/execution/memory-slice.ts`) were
M-a re-export shims of that entry point; M-e (#246) deleted them and retargeted
every importer.

## The seam, in order

| Step | Module | Symbols |
|---|---|---|
| Card / snapshot / packet schemas, revisions, validation, digest | `src/memory/schema.ts` | `RESEARCH_MEMORY_SNAPSHOT_SCHEMA`, card schema constants, `ResearchMemoryError`, `validateResearchMemorySnapshot`, `summarizeResearchMemorySnapshot`, `researchMemoryModeOf`, `ResearchMemorySnapshot`, `ResearchDecisionPacket` |
| Projection (derived, no write authority) | `src/memory/projection.ts` | `projectResearchMemorySnapshot`, `evaluateResearchApplicability`, `retrieveResearchMemory` |
| Bounded decision view | `src/memory/packet.ts` | `projectResearchDecisionPacket`, `assertPacketCardRefs` |
| Sham control input | `src/memory/sham.ts` | `shamResearchMemorySnapshot`, `shamResearchDecisionPacket` (`RESEARCH_CONTROL_CARD_SCHEMA` lives in `schema.ts`) |
| Store seam + provider (no file IO left) | `src/memory/store.ts` | `ResearchMemoryStore` seam, `researchMemoryProviderFromStore`, `loadActiveResearchMemorySnapshot`, `createDelegatedResearchMemoryProvider` |
| The one store (default since M-c, only store since M-e) | `src/memory/sqlite-store.ts` | `createSqliteResearchMemoryStore`, `createSqliteResearchMemoryProvider` |
| Which database file a Mission's memory is | `src/memory/default-store.ts` | `researchMemoryStoreFor`, `defaultResearchMemoryProvider`, `RESEARCH_MEMORY_DATABASE_FILENAME` |
| Read-only serving tool (M-d) | `src/memory/tool.ts` | `MEMORY_READ_TOOL`, `MEMORY_READ_SCHEMA`, `readMemoryCard`, `createMemoryReadTool` |
| Run-bound slice | `src/memory/slice.ts` | `createMemorySlice`, `createResearchMemorySlice`, `deriveDelegatedMemorySlice`, `MemorySliceError` |
| Lifecycle: publish, pin, revision stage, status | `src/mission/mission-start.ts` (publish/status), `src/mission/director-phases.ts` (pin + revision stage, #257) | `projectAndPublishResearchMemory`, `researchMemoryDir`, `missionResearchSource`, `researchMemoryModeOf` use, `summarizeMission`, `submitSynthesisProposal`, `assertResearchMemoryArmUnchanged`; the decision-point pin and the blind/revision stages are `createDirectorPhases` |
| Prompt assembly (blind vs revision) | `src/mission/mission-director.ts` | `buildDirectorPrompt`, `DirectorDecisionPhase`, `deriveDecisionDelta`, `missionRetainedState`, `recordRetainedState`, `decisionRetainedState`, `assertOffRetainsMissionState` |
| Recovery rebuild | `src/mission/mission-resume.ts` | `reconcileResearchMemory` |
| Accountability / diversity / counterfactuals | `src/mission/decision-accountability.ts` | `projectDecisionAccountability`, `ResearchDiversity` |
| Offline evaluation | `src/mission/memory-evaluation.ts` | `replayResearchMemory`, `evaluateResearchMemory`, `concludeResearchMemory`, `researchMemoryArmMetrics`, `assertNoFutureInformation` |
| Decision-point counterfactual (L1) | `src/mission/decision-point-evaluation.ts` | `evaluateDecisionPoint`, `summarizeDecisionPoints`, `FrozenDecisionPoint`, `DECISION_POINT_CAVEATS`, `DECISION_POINT_HINDSIGHT_SCORING` |

F5 (#231): the off arm keeps the Mission's `Mission Retained State` (scoreboard +
current best) in the prompt and at the decision point; `assertOffRetainsMissionState`
is called where the Director input is built (`mission-start.ts`, before the decision stage) and in the
whole-Mission report.

M-b (#243) added a SQLite implementation of the same `ResearchMemoryStore` seam
(snapshot rows + `cards` query projection + `active` pointer in one transaction,
canonical-JSON `payload`, digest re-derived on every read). M-c (#244) made it
**the default**: `default-store.ts` resolves a Mission's `memory/` namespace to
one `research-memory.sqlite`. Parity was judged on bytes while both stores
existed: for one Mission record both returned identical snapshot digests and
identical packet projections. M-e (#246, ADR-0017) then deleted the file store,
the file layout, the one-shot migration and the `EVOK_RESEARCH_MEMORY_STORE`
rollback switch, so there is one store and one layout.

M-a (#242) was a physical move with zero behaviour change: for a fixed input every
snapshot, packet, Sham and slice digest is unchanged, pinned by
`src/memory/digests.test.ts`. A changed literal there is a served-content change
and must be justified as one, not edited to match new code.

## Two serving channels (M-d, #245)

Injection is channel 1 and is unchanged: one pinned decision packet reaches the
Revision stage in its prompt. `memory_read(ref)` is channel 2 and is registered
through **execution's** seam — `PiAgentRuntime.execute` binds
`createMemoryReadTool(memorySlice)` once per Run and adds it to that Run's
`customTools` and tool allowlist (`src/execution/pi-agent-runtime.ts`), so the
memory directory creates no second registration seam (ADR-0016).

| Rule | Where it is enforced |
|---|---|
| Only a card id present in the packet this Run was served | `readMemoryCard` projects `projectResearchDecisionPacket` over the slice's pinned snapshot and refuses anything else |
| Same pinned snapshot as injection, never "latest" | the tool is built from the validated `MemorySlice`; it holds no store handle and never reads the active pointer |
| Body plus provenance refs | `MemoryReadBody.body` is the published card, `provenance` carries `snapshotId`, `snapshotDigest`, `ledgerRevision` and the card's provenance refs (its `sourceRefs`/claim refs plus its `lineage` revision chain) |
| No enumeration / search / listing | the only argument is one `ref` (`additionalProperties: false`); there is no query or list parameter |
| Never crosses Run, Mission or arm | one tool per Run, bound to that Run's slice; a slice with no `research` snapshot gets no tool at all |
| Ledger-visible read event | the runtime reports `AgentRuntimeResult.memoryReads`; `dispatchCandidateAttempt` (`src/mission/run-dispatch.ts`, #257) appends one `MEMORY_READ` history event per delivered **and** refused attempt of a Run that reaches a confirmed result (a Run that fails first keeps them in its durable tool-intent record) |
| Sham parity | the Sham arm's slice carries the Sham snapshot, so the same factory exposes the same tool (same name, description, parameters) returning control-slot bodies — an arm comparison measures memory, not tool access |

A read is context, never Evidence: it changes no measurement, gate, budget or
promotion, and it does not alter packet, snapshot or slice bytes. The slice's
fixed `readPolicy` denies raw bodies inside the slice; this tool returns the card
body the pinned snapshot already published, so it cannot reach any content the
Run was not served.

## Lookup by question

- Which card schemas and fields exist? `src/memory/schema.ts` (card interfaces near the top).
- How are cards ordered, truncated, reserved, and omitted? `projectResearchMemorySnapshot` and `projectResearchDecisionPacket`.
- What does an Off/Sham/Real arm change? `researchMemoryModeOf` + `projectAndPublishResearchMemory` + the revision pin in `createDirectorPhases` (`src/mission/director-phases.ts`, PRD §4 Stage 4).
- Why can't a Run see the future? `replayResearchMemory` (dispatch vs completion instants; it pins the ledger revision the Run was durably served — `MissionRunRecord.researchMemory.ledgerRevision` — and falls back to the prefix ordinal only for legacy records without it).
- Is replay value evidence? No. `evaluateResearchMemory` labels the replay section `integrity` (`claim: integrity`) and labels its comparison `whole-mission-comparison` (`kind`); it refuses arms that all derive from one MissionRecord, because those deltas are zero by construction, and it refuses any arm whose `origin` is not `new-run`.
- When may L2 run? Only with an `l1Signal` (`ResearchMemoryL1Signal`, satisfied by a `DecisionPointEvaluationReport`) whose off→real `matched-action-taken` direction is `treatment-higher` and whose sample meets L1's floor — no significance, no under-powered gate. Every arm must declare `origin: "new-run"`; a report mixing historical-replay arms with newly-run arms is refused, as is an all-replay report, and both Director-stage costs are counted in every arm including `off`.
- How is an L2 conclusion stated? `concludeResearchMemory` takes 2–3 independent Mission comparisons (each three arms from one initial state) and reads only `hypothesisDiversity`, `knownFailureRepetition`, `validEvidencePerBudget` as directions. A direction is stated only when it is non-flat and identical in every Mission; a disagreement states no conclusion. No effect size and no significance test is produced (`statisticalSignificance: "none"`).
- How does one decision get scored? `evaluateDecisionPoint` re-decides one frozen decision point per Off/Sham/Real packet over a shared base state, dispatches nothing, and scores against the action the original Mission actually took. `summarizeDecisionPoints` needs ≥ 50 points, reports direction only, and carries all three caveats (Sham control, trajectory steering, selection bias). Every report embeds `DECISION_POINT_HINDSIGHT_SCORING` — the versioned rule (`evok.l1-hindsight-scoring/v1`, spec §3) plus its rationale and bias limits, so a reviewer never infers which reference was used. Changing the reference is a versioned evaluation-contract change (spec §3), not a code tweak. L2 is gated on that report but does not record the rule: its gate keeps only the decision-point count and the off/real direction, so an L2 reader cannot tell which hindsight reference gated it.
- Is human Insight allowed to differ across arms? No. Every arm reads the **same** Insight snapshot (same ids, versions, order) or Insight is `"disabled"` for the run; a point whose arms differ is refused before any priced call, and the result/report record the pinned ids+versions (or the disabled choice) so the control is auditable. `summarizeDecisionPoints` also refuses a sample that mixes Insight on and off, since that would measure the operator's intuition rather than Memory.
- Where is the durable arm stored? `MissionRecord.researchMemoryMode` (captured at acceptance; restore/refuse in `assertResearchMemoryArmUnchanged`).
- What does the status output expose? `summarizeMission` → `ResearchMemorySummary` (counts/ids only).
- What is stored on disk today? `missions/<id>/memory/research-memory.sqlite`, one database per Mission and the ONLY memory artifact (M-e, #246): immutable snapshot rows (canonical-JSON `payload`), a `cards` query projection rebuilt from that payload, and ONE active pointer switched in the same transaction (M-c, #244). The old file layout (`snapshots/<digest>.json` + `active.json`), its reader and its one-shot migration are deleted; a Mission whose files predate M-c is not auto-migrated, because history is the only write authority and recovery rebuilds the identical bytes (ADR-0017).
- What happens when the store is damaged? The read throws (never "empty history"); `reconcileResearchMemory` records the reason, rebuilds the projection from Mission history, republishes and verifies the served digest. Repair is scoped to derived data only: a `cards` projection that disagrees with its `payload` is rebuilt from it; a `payload` that no longer hashes to its address holds no content there, so republication restores it; a file that is not a database holds nothing readable, so republication recreates it. A valid published `payload` is never rewritten (P5). There is no migration any more, so there is no pre-migration digest to explain away (ADR-0017).
- Can an agent ask for a card body? Only for a card the packet it was served already names, and only from that same pinned snapshot: `memory_read(ref)` (M-d, `src/memory/tool.ts`). It cannot search or list, never crosses a Run/Mission/arm, and every attempt is a `MEMORY_READ` ledger event. The Sham arm exposes the same tool over control slots.

## Adjacent: Human Insight (#238)

Human Insight is **not** a memory source and has no epistemic authority: it is
advisor context the Director may consider or refute. It shares only the Director
input assembly seam, and it stays in `src/mission/` — it is not part of Research
Memory and did not move in M-a.

| Step | Module | Symbols |
|---|---|---|
| Drafts + Inbox projection (Mission ledger events, no write path of its own) | `src/mission/insight-inbox.ts` | `submitInsightDraft`, `recordInsightDisposition`, `projectInsightInbox`, `HumanInsightDraft`, `InsightInbox` |
| Revision input + dispositions (#240) | `src/mission/director-insight-sidecar.ts` | `buildDirectorInsightSidecar`, `emptyDirectorInsightSidecar`, `assertRevisionInsightDispositions`, `recordRevisionInsightDispositions`, `DirectorInsightSidecar` |

The sidecar is the only path Insight takes into a decision: `DirectorDecisionPhase.insightSidecar` is
required (the Memory-blind stage has no `decisionPhase` at all), so the Blind Proposal can never read
Insight, and loading is unconditional — no pending Insight is an explicit empty sidecar, not a skipped
input. It is bounded and truncated like the packet (default 8, `omittedCount` + `truncated`), and it is
**not** a `ResearchDecisionPacket` category (#238 D3 rejected). The Revision records a disposition
(`ignored` / `rejected` / `experiment_proposed` / `deferred`) for pinned Insight; `rejected` owes a
reason, `experiment_proposed` a `proposalRef`, and `ignored` is never merged with `rejected`. An
unanswered pin is a recorded gap (`undispositioned`), never a blocked Revision. The durable
`DecisionRecord.insight` keeps the ids/versions that Revision read, and the disposition events
are appended through the existing Insight path with a `decisionRef`, so a retry in one decision cycle
cannot disposition the same Insight twice. `StartMissionOptions.insightLedger` is the read/append seam.

Event kinds `HUMAN_INSIGHT_DRAFT_CREATED` / `HUMAN_INSIGHT_DISPOSITION_RECORDED` live on
the research Mission ledger (`src/mission/research-loop.ts`). The
Approval/Evidence/Evaluation accounting is keyed on the competition-arm
`MissionEventType`, so a research-ledger insight event has no kind at all
(`ledgerEventKind` → `null`) and can never be classified as Evidence. The Inbox is
rebuilt from events alone and its digest is byte-stable.

Tests: `src/mission/insight-inbox.test.ts`, `src/mission/director-insight-sidecar.test.ts`.

## The charter-reference seam (#251 / C2; spec #249)

A Research Charter is **not** a memory source: it is a forward-looking,
**human-authorized input** (`docs/research-charter-prd.md`), while Memory is a
derived, backward-looking projection. They are never merged. The only seam is that
a Run records which approved charter and frozen protocol version it executed
under — a reference pair, not charter content. This section exists because that
reference is what a memory projection or replay needs in order to say which study
design a result belonged to; it never lets a Run read the charter itself.

| Step | Module | Symbols |
|---|---|---|
| Charter schema, validation, content digest (`evok.research-charter/v1`) | `src/mission/research-charter.ts` | `validateResearchCharter`, `assertResearchCharter`, `ResearchCharterValidationError`, `charterDigest` |
| Ledger events, replay, start gate | `src/mission/charter-ledger.ts` | `proposeResearchCharter`, `approveResearchCharter`, `freezeBenchmarkProtocol`, `addBenchmarkExtension`, `projectCharterLedger`, `requireApprovedCharter`, `CharterLedgerError` / `CharterApprovalRejectedError` / `CharterApprovalRequiredError` |

Event kinds `RESEARCH_CHARTER_PROPOSED`, `RESEARCH_CHARTER_APPROVED`,
`BENCHMARK_PROTOCOL_FROZEN`, `BENCHMARK_EXTENSION_ADDED` live on the research
Mission ledger (`src/mission/research-loop.ts`, `ResearchEventType`), so they
follow the same append, validation and monotonic-sequence rules; they carry no
Approval/Evidence/Evaluation kind (`ledgerEventKind` → `null`).

| Rule | Where it is enforced |
|---|---|
| The ledger stores versions, digests, approvals and artifact references only | closed payloads in `projectCharterLedger`; the full charter/evidence text stays in the referenced artifact |
| Approval is human authorization | `approveResearchCharter` refuses `source: "model"` and requires `requested` plus a matching mission selector; replay refuses an approval event whose payload `source` is not `"user"`. A writer that fabricates `source: "user"` is fabricating a human event, which no ledger can authenticate — that guard lives at the append path, not in replay |
| Approval pins a version and digest | an approval must name a proposed `charterId`+`charterVersion`+`charterDigest`; a same-version proposal with a different digest is refused, and a later charter version never rewrites the recorded approval |
| Freezing records protocol version and digest | `freezeBenchmarkProtocol` derives `protocolDigest` from the approved charter's `charterDigest` and the frozen `baselineIds` from its portfolio; a charter that is not the currently approved one cannot be frozen |
| Primary-protocol change is versioned and reasoned; old results keep their version | every freeze stays in `frozenHistory`; a later freeze needs a new `protocolVersion` plus a recorded `reason`; re-freezing an existing version with different content is refused |
| Extensions never move the frozen set or digest | `addBenchmarkExtension` copies the frozen `protocolVersion`/`protocolDigest`, refuses a `baselineId` already in the frozen set, and leaves `frozenProtocol.baselineIds` untouched |
| No research loop on an unapproved charter | `requireApprovedCharter` refuses a proposal-only ledger, an approved charter with no frozen protocol, and an approval newer than the frozen protocol. #248 calls it before the long-running loop starts |
| Deterministic replay | `projectCharterLedger` rebuilds proposals, the current approval, `frozenProtocol`, `frozenHistory` and extensions from events alone; the same events produce the same state digest (byte-stable) |

Tests: `src/mission/charter-ledger.test.ts`, `src/mission/research-charter.test.ts`.

## Tests

- Digests (M-a pin): `src/memory/digests.test.ts`
- P1-P6 (M-b, now the whole durability contract): `src/memory/sqlite-store.test.ts`
- The store seam, provider and delegation: `src/memory/store.test.ts`
- Default store, pinning and damage (M-c, single store since M-e): `src/memory/default-store.test.ts`, plus the recovery cases in `src/mission/mission-resume.test.ts` and `tests/integration/mission-start.test.ts` (#216 block)
- Read tool (M-d): `src/memory/tool.test.ts`, plus the registration case in `src/execution/pi-agent-runtime.test.ts` and the `MEMORY_READ` ledger case in `tests/integration/mission-start.test.ts`
- Unit (moved into the physical home in M-e, #246): `src/memory/projection.test.ts`, `lifecycle.test.ts`, `sham.test.ts`, `slice.test.ts`
- Mission unit: `src/mission/memory-evaluation.test.ts`, `decision-point-evaluation.test.ts`, `decision-accountability.test.ts`, `mission-resume.test.ts`
- Lifecycle: `tests/integration/mission-start.test.ts` (`#210`–`#218`, `#240` blocks), `tests/integration/memory-evaluation.test.ts`
- Charter reference seam (C2): `src/mission/charter-ledger.test.ts`

## Boundaries

Memory has one physical home (`src/memory/`) and no seventh authority: the
logical map in ADR-0007 is unchanged. Memory is advisory: no evaluator,
Promotion, Admission, Budget, hang/T48 or Broker predicate may read it, and
nothing in `src/memory/` may write Mission history.
