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
| Offline evaluation | `src/mission/memory-evaluation.ts` | `replayResearchMemory`, `evaluateResearchMemory`, `concludeResearchMemory`, `researchMemoryArmMetrics`, `assertNoFutureInformation` |
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
- Is replay value evidence? No. `evaluateResearchMemory` labels the replay section `integrity` (`claim: integrity`) and labels its comparison `whole-mission-comparison` (`kind`); it refuses arms that all derive from one MissionRecord, because those deltas are zero by construction, and it refuses any arm whose `origin` is not `new-run`.
- When may L2 run? Only with an `l1Signal` (`ResearchMemoryL1Signal`, satisfied by a `DecisionPointEvaluationReport`) whose off→real `matched-action-taken` direction is `treatment-higher` and whose sample meets L1's floor — no significance, no under-powered gate. Every arm must declare `origin: "new-run"`; a report mixing historical-replay arms with newly-run arms is refused, as is an all-replay report, and both Director-stage costs are counted in every arm including `off`.
- How is an L2 conclusion stated? `concludeResearchMemory` takes 2–3 independent Mission comparisons (each three arms from one initial state) and reads only `hypothesisDiversity`, `knownFailureRepetition`, `validEvidencePerBudget` as directions. A direction is stated only when it is non-flat and identical in every Mission; a disagreement states no conclusion. No effect size and no significance test is produced (`statisticalSignificance: "none"`).
- How does one decision get scored? `evaluateDecisionPoint` re-decides one frozen decision point per Off/Sham/Real packet over a shared base state, dispatches nothing, and scores against the action the original Mission actually took. `summarizeDecisionPoints` needs ≥ 50 points, reports direction only, and carries both the Sham and the trajectory-steering caveats.
- Where is the durable arm stored? `MissionRecord.researchMemoryMode` (captured at acceptance; restore/refuse in `assertResearchMemoryArmUnchanged`).
- What does the status output expose? `summarizeMission` → `ResearchMemorySummary` (counts/ids only).

## Tests

- Unit: `src/evidence/research-memory.test.ts`, `research-memory-lifecycle.test.ts`, `research-memory-evaluation.test.ts`
- Mission unit: `src/mission/memory-evaluation.test.ts`, `decision-point-evaluation.test.ts`, `decision-accountability.test.ts`, `mission-resume.test.ts`
- Lifecycle: `tests/integration/mission-start.test.ts` (`#210`–`#218` blocks), `tests/integration/memory-evaluation.test.ts`

## Boundaries

`AGENTS.md` names the physical packs. Memory is evidence-owned for projection and
policy, execution-owned for slice/provider publication, mission-owned for the
lifecycle and evaluation reads. It is advisory: no evaluator, Promotion,
Admission, Budget, hang/T48 or Broker predicate may read it.
