# Parked: task contract kinds and the scientific suite evaluator

Date parked: 2026-11-11, from `stash@{0}` (`parked-20261111-032035`).
Origin: an unidentified writer on the main worktree, not part of any issued ticket.
The stash was exported here and dropped; nothing was merged.

## Why this is kept

Two ideas in it are worth revisiting when the Research Program (#248) work starts:

1. **A protocol violation is not a scientific refutation.** The code prefixes
   contract errors with `protocol:` and keeps them out of negative evidence.
2. **Non-measure tasks are evaluated on declared durable artifacts**, not on a
   numeric metric, so investigation and repair stay out of the scientific
   hill-climbing loop.

`MISSION_TASK_KINDS = ["measure", "investigate", "repair"]` appears in the patch's
`src/mission/mission-draft.ts` hunk. This is the seed of the typed research nodes
that `docs/research-program-prd.md` §6.1 requires, though that PRD needs more node
types and real output contracts rather than a label.

## Contents

| File | What it was |
|---|---|
| `scientific-mission-protocol.md` | the design note: execution health vs protocol validity vs scientific result |
| `task-evaluator.ts` | `missionTaskKind`, `taskContractErrors`, `createTaskArtifactEvaluator` |
| `task-evaluator.test.ts` | 4 tests: artifact success, missing-artifact protocol failure, path escape |
| `scientific-suite-evaluator.ts` | suite-level evaluation work, unfinished |
| `scientific-suite-evaluator.test.ts` | its tests |
| `scientific-suite.evaluation.json` | a template evaluation config |
| `parked-changes.patch.gz` | the tracked-file half of the stash, gzipped so the repo's whitespace gate does not parse patch context as source |

## Why it was not restored

`#257` restructured `runMissionController` into named stages, so the patch no longer
applies cleanly and a blind restore would be a semantic merge, not a file merge.
Recovering the idea should be done deliberately as part of #248, not by applying
this patch.

## Status of the science

Unverified. The 4 `task-evaluator` tests passed at the time, but the suite was never
run to completion on this work and no ticket ever owned it.
