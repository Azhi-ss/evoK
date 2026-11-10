# Memory subsystem map

M1 Research Memory spans evidence, execution, and mission. Reading one module is
usually not enough; this map is the index. Read it before changing the memory
projection, the decision packet, Run injection, recovery, or the evaluation.

## The seam, in order

| Step | Module | Symbols |
|---|---|---|
| Projection (derived, no write authority) | `src/evidence/research-memory.ts` | `projectResearchMemorySnapshot`, `validateResearchMemorySnapshot`, `summarizeResearchMemorySnapshot`, card schemas, `researchMemoryModeOf` |
| Bounded decision view | `src/evidence/research-memory.ts` | `projectResearchDecisionPacket`, `assertPacketCardRefs` |
| Sham control input | `src/evidence/research-memory.ts` | `RESEARCH_CONTROL_CARD_SCHEMA`, `shamResearchMemorySnapshot`, `shamResearchDecisionPacket` |
| Durable snapshot + provider | `src/execution/research-memory-provider.ts` | `publishResearchMemorySnapshot`, `loadResearchMemorySnapshot`, `createResearchMemoryProvider`, `createDelegatedResearchMemoryProvider` |
| Run-bound slice | `src/execution/memory-slice.ts` | `createMemorySlice`, `createResearchMemorySlice`, `deriveDelegatedMemorySlice` |
| Lifecycle: publish, pin, revision stage, status | `src/mission/mission-start.ts` | `projectAndPublishResearchMemory`, `researchMemoryDir`, `missionResearchSource`, `researchMemoryModeOf` use, `summarizeMission`, `submitSynthesisProposal`, `assertResearchMemoryArmUnchanged` |
| Prompt assembly (blind vs revision) | `src/mission/mission-director.ts` | `buildDirectorPrompt`, `DirectorDecisionPhase`, `deriveDecisionDelta`, `missionRetainedState`, `recordRetainedState`, `decisionRetainedState`, `assertOffRetainsMissionState` |
| Recovery rebuild | `src/mission/mission-resume.ts` | `reconcileResearchMemory` |
| Accountability / diversity / counterfactuals | `src/mission/decision-accountability.ts` | `projectDecisionAccountability`, `ResearchDiversity` |
| Offline evaluation | `src/mission/memory-evaluation.ts` | `replayResearchMemory`, `evaluateResearchMemory`, `researchMemoryArmMetrics`, `assertNoFutureInformation` |
| Decision-point counterfactual (L1) | `src/mission/decision-point-evaluation.ts` | `evaluateDecisionPoint`, `summarizeDecisionPoints`, `FrozenDecisionPoint`, `DECISION_POINT_CAVEATS` |

F5 (#231): the off arm keeps the Mission's `Mission Retained State` (scoreboard +
current best) in the prompt and at the decision point; `assertOffRetainsMissionState`
is called where the Director input is built (`mission-start.ts`) and in the
whole-Mission report.

## Lookup by question

- Which card schemas and fields exist? `src/evidence/research-memory.ts` (card interfaces near the top).
- How are cards ordered, truncated, reserved, and omitted? `projectResearchMemorySnapshot` and `projectResearchDecisionPacket`.
- What does an Off/Sham/Real arm change? `researchMemoryModeOf` + `projectAndPublishResearchMemory` + the revision pin in `runMissionController`.
- Why can't a Run see the future? `replayResearchMemory` (dispatch vs completion instants; it pins the ledger revision the Run was durably served — `MissionRunRecord.researchMemory.ledgerRevision` — and falls back to the prefix ordinal only for legacy records without it).
- Is replay value evidence? No. `evaluateResearchMemory` labels the replay section `integrity` (`claim: integrity`) and labels its comparison `whole-mission-comparison` (`kind`); it refuses arms that all derive from one MissionRecord, because those deltas are zero by construction.
- How does one decision get scored? `evaluateDecisionPoint` re-decides one frozen decision point per Off/Sham/Real packet over a shared base state, dispatches nothing, and scores against the action the original Mission actually took. `summarizeDecisionPoints` needs ≥ 50 points, reports direction only, and carries both the Sham and the trajectory-steering caveats.
- Where is the durable arm stored? `MissionRecord.researchMemoryMode` (captured at acceptance; restore/refuse in `assertResearchMemoryArmUnchanged`).
- What does the status output expose? `summarizeMission` → `ResearchMemorySummary` (counts/ids only).

## Adjacent: Human Insight (#238)

Human Insight is **not** a memory source and has no epistemic authority: it is
advisor context the Director may consider or refute. It shares only the Director
input assembly seam.

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

- Unit: `src/evidence/research-memory.test.ts`, `research-memory-lifecycle.test.ts`, `research-memory-evaluation.test.ts`
- Mission unit: `src/mission/memory-evaluation.test.ts`, `decision-point-evaluation.test.ts`, `decision-accountability.test.ts`, `mission-resume.test.ts`
- Lifecycle: `tests/integration/mission-start.test.ts` (`#210`–`#218`, `#240` blocks), `tests/integration/memory-evaluation.test.ts`

## Boundaries

`AGENTS.md` names the physical packs. Memory is evidence-owned for projection and
policy, execution-owned for slice/provider publication, mission-owned for the
lifecycle and evaluation reads. It is advisory: no evaluator, Promotion,
Admission, Budget, hang/T48 or Broker predicate may read it.
