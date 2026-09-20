# Spec · DeployArena thick orchestration (ET-DEPLOY-ORCH / #182)

DeployArena is an **orthogonal serving arm**, not a second control plane
and not a commercial contest OS. It is **opt-in**: callers must pass
`competitionId=deploy-arena`. Env alone never opens live submit. AtCoder
true-submit stays frozen.

Thick orchestration here means:

1. A task / service graph
2. Multi-machine / multi-GPU workers
3. Local metric aggregation (capability gate: both subjects **> 95**)
4. A Competition I/O (COI) adapter that assembles `submission.json`
   `{ image, command, env }` and wires into the existing contest-arm
   auto-submit path ([contest-auto-submit.md](contest-auto-submit.md))

It does **not** mean accounts, billing, multi-tenant, a Web plugin
marketplace, or a full commercial competition SaaS.

## Seams

| Layer | API | Owns |
|---|---|---|
| Mission hang | `runDeployArenaOrch` | Task Contract switch; wires COI → `#179` |
| Graph / workers / aggregation / COI assemble | `runDeployArenaGraph`, `aggregateDeployArenaMetrics`, `assembleDeployArenaSubmission` | `src/competition/deploy-arena.ts` |
| Auto-submit | `attemptContestAutoSubmit` | evidence; fail-closed; not loosened |
| Playground argv | `playgroundTaskDownloadArgv` / `playgroundSubmitArgv` / `createPlaygroundContestSubmitSeam` | user-env CLI; keys stay local |

Default / omitted `competitionId` does **not** open this arm.

## Smoke path

`DEPLOY_ARENA_SMOKE_GRAPH` runs capability tasks (`aime26`, `gpqa-diamond`)
on two workers (`host-a/cuda:0`, `host-b/cuda:1`), aggregates locally,
then optional load (`n-at-slo`) tasks. `runDeployArenaOrch` assembles
`submission.json` and calls `attemptContestAutoSubmit`.

```ts
import { runDeployArenaOrch } from "../src/mission/deploy-arena-orch";

const result = await runDeployArenaOrch({
  competitionId: "deploy-arena",
  knobs: { image: "registry.example/serving:v1", command: "python -m serve", env: { CONCURRENCY: "4" } },
  gates,          // existing Admission / Budget / hang / T48 / promotion inputs
  live: false,    // default; env never flips this
});
```

- All evidence gates green + dry-run → `autoSubmit.submitted === true`, status `DRY_RUN`.
- Any red / yellow / missing gate → refuse; playground is not called.
- `{ live: true }` without playground / bohr credentials → fail-closed
  (`submit-unavailable`); playground is not called.
- Capability scores are local evaluation. They are **not** a Promotion key
  and do not loosen evidence predicates. If either subject mean is not
  **> 95**, load (`n-at-slo`) tasks are **skipped**.

## Bohrium / playground CLI (user environment)

Documented for the operator machine. evoK does **not** vendor credentials
or install these tools.

| Tool | Inventory version | Runtime |
|---|---|---|
| `playground` | 0.1.39 | **WSL2** (not Windows-native) |
| `bohr` | 2.7.0 | same user env |

Challenge id candidate: `llm-challenge-arena-v1`.

```bash
# pull the brief (user env)
playground task download --challenge-id llm-challenge-arena-v1 --out "$OUT"

# submit after gates are green and credentials are present
playground submit --challenge-id llm-challenge-arena-v1 --outputs "$OUT" --trace "$TRACE"

# optional status
playground task status --challenge-id llm-challenge-arena-v1
```

Login / tokens stay on the user machine (`playground` / `bohr` auth).
Do not commit secrets. This repository only records argv.

If `playground` / `bohr` is missing, live COI **fails closed**. Dry-run
and local aggregation still run.

## Locks

- Admission / Budget / hang / T48 **predicates are not loosened**.
- `#40` / Progressive default stays **off** / `fixed_uct`.
- Execution Pattern C is not thickened. This graph is not the Team DAG.
- No accounts / billing / multi-tenant / Web marketplace / commercial OS.
- Elite / score / Team Fan-Out are **not** Promotion keys.
