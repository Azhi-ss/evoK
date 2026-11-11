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
`src/execution/research-memory-provider.ts`, `src/execution/memory-slice.ts`) are
migration-period re-export shims of that entry point and are removed in M-e.

## The seam, in order

| Step | Module | Symbols |
|---|---|---|
| Card / snapshot / packet schemas, revisions, validation, digest | `src/memory/schema.ts` | `RESEARCH_MEMORY_SNAPSHOT_SCHEMA`, card schema constants, `ResearchMemoryError`, `validateResearchMemorySnapshot`, `summarizeResearchMemorySnapshot`, `researchMemoryModeOf`, `ResearchMemorySnapshot`, `ResearchDecisionPacket` |
| Projection (derived, no write authority) | `src/memory/projection.ts` | `projectResearchMemorySnapshot`, `evaluateResearchApplicability`, `retrieveResearchMemory` |
| Bounded decision view | `src/memory/packet.ts` | `projectResearchDecisionPacket`, `assertPacketCardRefs` |
| Sham control input | `src/memory/sham.ts` | `shamResearchMemorySnapshot`, `shamResearchDecisionPacket` (`RESEARCH_CONTROL_CARD_SCHEMA` lives in `schema.ts`) |
| Durable snapshot + provider | `src/memory/store.ts` | `ResearchMemoryStore` seam, `publishResearchMemorySnapshot`, `loadResearchMemorySnapshot`, `loadFileResearchMemorySnapshots`, `createFileResearchMemoryStore`, `createResearchMemoryProvider`, `createDelegatedResearchMemoryProvider` |
| SQLite store behind the same seam (M-b) | `src/memory/sqlite-store.ts` | `createSqliteResearchMemoryStore`, `createSqliteResearchMemoryProvider`, `migrateFileResearchMemory` |
| Read-only serving tool (M-d) | `src/memory/tool.ts` | `MEMORY_READ_TOOL`, `MEMORY_READ_SCHEMA`, `readMemoryCard`, `createMemoryReadTool` |
| Run-bound slice | `src/memory/slice.ts` | `createMemorySlice`, `createResearchMemorySlice`, `deriveDelegatedMemorySlice`, `MemorySliceError` |
| Lifecycle: publish, pin, revision stage, status | `src/mission/mission-start.ts` | `projectAndPublishResearchMemory`, `researchMemoryDir`, `missionResearchSource`, `researchMemoryModeOf` use, `summarizeMission`, `submitSynthesisProposal`, `assertResearchMemoryArmUnchanged` |
| Prompt assembly (blind vs revision) | `src/mission/mission-director.ts` | `buildDirectorPrompt`, `DirectorDecisionPhase`, `deriveDecisionDelta`, `missionRetainedState`, `recordRetainedState`, `decisionRetainedState`, `assertOffRetainsMissionState` |
| Recovery rebuild | `src/mission/mission-resume.ts` | `reconcileResearchMemory` |
| Accountability / diversity / counterfactuals | `src/mission/decision-accountability.ts` | `projectDecisionAccountability`, `ResearchDiversity` |
| Offline evaluation | `src/mission/memory-evaluation.ts` | `replayResearchMemory`, `evaluateResearchMemory`, `concludeResearchMemory`, `researchMemoryArmMetrics`, `assertNoFutureInformation` |
| Decision-point counterfactual (L1) | `src/mission/decision-point-evaluation.ts` | `evaluateDecisionPoint`, `summarizeDecisionPoints`, `FrozenDecisionPoint`, `DECISION_POINT_CAVEATS`, `DECISION_POINT_HINDSIGHT_SCORING` |

F5 (#231): the off arm keeps the Mission's `Mission Retained State` (scoreboard +
current best) in the prompt and at the decision point; `assertOffRetainsMissionState`
is called where the Director input is built (`mission-start.ts`) and in the
whole-Mission report.

M-b (#243) added a SQLite implementation of the same `ResearchMemoryStore` seam
(snapshot rows + `cards` query projection + `active` pointer in one transaction,
canonical-JSON `payload`, digest re-derived on every read). The **file store is
still the default**; M-c (#244) switches it. Parity is judged on bytes: for one
Mission record both stores must return identical snapshot digests and identical
packet projections (`src/memory/sqlite-store.test.ts`).

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
| Ledger-visible read event | the runtime reports `AgentRuntimeResult.memoryReads`; `runMissionController` appends one `MEMORY_READ` history event per delivered **and** refused attempt of a Run that reaches a confirmed result (a Run that fails first keeps them in its durable tool-intent record) |
| Sham parity | the Sham arm's slice carries the Sham snapshot, so the same factory exposes the same tool (same name, description, parameters) returning control-slot bodies — an arm comparison measures memory, not tool access |

A read is context, never Evidence: it changes no measurement, gate, budget or
promotion, and it does not alter packet, snapshot or slice bytes. The slice's
fixed `readPolicy` denies raw bodies inside the slice; this tool returns the card
body the pinned snapshot already published, so it cannot reach any content the
Run was not served.

## Lookup by question

- Which card schemas and fields exist? `src/memory/schema.ts` (card interfaces near the top).
- How are cards ordered, truncated, reserved, and omitted? `projectResearchMemorySnapshot` and `projectResearchDecisionPacket`.
- What does an Off/Sham/Real arm change? `researchMemoryModeOf` + `projectAndPublishResearchMemory` + the revision pin in `runMissionController`.
- Why can't a Run see the future? `replayResearchMemory` (dispatch vs completion instants; it pins the ledger revision the Run was durably served — `MissionRunRecord.researchMemory.ledgerRevision` — and falls back to the prefix ordinal only for legacy records without it).
- Is replay value evidence? No. `evaluateResearchMemory` labels the replay section `integrity` (`claim: integrity`) and labels its comparison `whole-mission-comparison` (`kind`); it refuses arms that all derive from one MissionRecord, because those deltas are zero by construction, and it refuses any arm whose `origin` is not `new-run`.
- When may L2 run? Only with an `l1Signal` (`ResearchMemoryL1Signal`, satisfied by a `DecisionPointEvaluationReport`) whose off→real `matched-action-taken` direction is `treatment-higher` and whose sample meets L1's floor — no significance, no under-powered gate. Every arm must declare `origin: "new-run"`; a report mixing historical-replay arms with newly-run arms is refused, as is an all-replay report, and both Director-stage costs are counted in every arm including `off`.
- How is an L2 conclusion stated? `concludeResearchMemory` takes 2–3 independent Mission comparisons (each three arms from one initial state) and reads only `hypothesisDiversity`, `knownFailureRepetition`, `validEvidencePerBudget` as directions. A direction is stated only when it is non-flat and identical in every Mission; a disagreement states no conclusion. No effect size and no significance test is produced (`statisticalSignificance: "none"`).
- How does one decision get scored? `evaluateDecisionPoint` re-decides one frozen decision point per Off/Sham/Real packet over a shared base state, dispatches nothing, and scores against the action the original Mission actually took. `summarizeDecisionPoints` needs ≥ 50 points, reports direction only, and carries all three caveats (Sham control, trajectory steering, selection bias). Every report embeds `DECISION_POINT_HINDSIGHT_SCORING` — the versioned rule (`evok.l1-hindsight-scoring/v1`, spec §3) plus its rationale and bias limits, so a reviewer never infers which reference was used. Changing the reference is a versioned evaluation-contract change (spec §3), not a code tweak. L2 is gated on that report but does not record the rule: its gate keeps only the decision-point count and the off/real direction, so an L2 reader cannot tell which hindsight reference gated it.
- Is human Insight allowed to differ across arms? No. Every arm reads the **same** Insight snapshot (same ids, versions, order) or Insight is `"disabled"` for the run; a point whose arms differ is refused before any priced call, and the result/report record the pinned ids+versions (or the disabled choice) so the control is auditable. `summarizeDecisionPoints` also refuses a sample that mixes Insight on and off, since that would measure the operator's intuition rather than Memory.
- Where is the durable arm stored? `MissionRecord.researchMemoryMode` (captured at acceptance; restore/refuse in `assertResearchMemoryArmUnchanged`).
- What does the status output expose? `summarizeMission` → `ResearchMemorySummary` (counts/ids only).
- What is stored on disk today? `snapshots/<digest>.json` plus `active.json`, written by `store.ts` (immutable snapshot first, then an atomic pointer switch) — still the default after M-b (#243). The SQLite store in `sqlite-store.ts` holds the same bytes behind the same provider; `migrateFileResearchMemory` copies the files over with digest verification.
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

## Tests

- Digests (M-a pin): `src/memory/digests.test.ts`
- Store parity and P1-P6 (M-b): `src/memory/sqlite-store.test.ts`
- Read tool (M-d): `src/memory/tool.test.ts`, plus the registration case in `src/execution/pi-agent-runtime.test.ts` and the `MEMORY_READ` ledger case in `tests/integration/mission-start.test.ts`
- Unit: `src/evidence/research-memory.test.ts`, `research-memory-lifecycle.test.ts`, `research-memory-evaluation.test.ts`, `src/execution/memory-slice.test.ts`, `src/execution/research-memory-provider.test.ts`
- Mission unit: `src/mission/memory-evaluation.test.ts`, `decision-point-evaluation.test.ts`, `decision-accountability.test.ts`, `mission-resume.test.ts`
- Lifecycle: `tests/integration/mission-start.test.ts` (`#210`–`#218`, `#240` blocks), `tests/integration/memory-evaluation.test.ts`

## Boundaries

Memory has one physical home (`src/memory/`) and no seventh authority: the
logical map in ADR-0007 is unchanged. Memory is advisory: no evaluator,
Promotion, Admission, Budget, hang/T48 or Broker predicate may read it, and
nothing in `src/memory/` may write Mission history.
