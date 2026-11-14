# mission

产品控制面 = Research Loop：授权、预算、continue / repair / stop。
聊天 transcript 不是权威。Hang / T48 属 evidence，不进本包。
W1 骨架：`research-entry` 持久化 control-events 并提供薄 `/research`
status / continue（evoK 产品入口；TUI 镜像同一语义，不抢 Pi `/resume`）。
`skills-routing` 提供八类目录 + L0→L1 渐进披露 + 三态
（candidate / accepted / demoted）；默认上下文只进 **accepted + evoK-tagged**
短描述。发现走同一 Pi skills 根，再按 `owner`/`namespace: evok` 过滤。
文件体写回未开（read-only shell）。candidate 升 accepted 必须过
evidence Admission（无保护 holdout 拒绝；有效性 hang 不是 pass）。
传入 BudgetDecision 时，超预算或未预留拒绝 continue / writeback；
预算过不是 Admission 过。Budget Gate 谓词在 evidence。
Skills 路由不是第二控制面。

Physical home of Mission Director, Mission draft/intake/start/resume,
Research Loop, File Blueprint, Branch recovery, baseline-track,
start hard-gate inventory (`start-hard-gates`, ET-OPS-START), and
golden-path / outer-min orchestration glue (`v1-golden-path`,
`outer-*-path`, `llm-propose-outer-min`).

## Mission controller stages (PRD §4 Stage 4, #257)

`runMissionController` (`mission-start.ts`) only composes named stages; it holds
no execution mechanics of its own.

| Stage | Module | Responsibility |
|---|---|---|
| prepareRun | `run-preparation.ts` | authorization, lock, budget reservation, plan freeze, the Mission-owned snapshot, the memory pin → immutable `PreparedRun` |
| Director decision | `director-phases.ts` | blind → pinned Research Memory packet + Insight sidecar → revision; one durable `DecisionRecord` per priced call; then the accepted proposal becomes an applied Task (`applyDirectorProposal`) and renders the next Experiment's instructions (`experimentInstructions`); research judgement stays the Director's |
| execute | `run-dispatch.ts` | one bounded candidate Run: fresh runtime/workspace/intent, snapshot adoption, independent measurement, per-Run metering |
| finalizeRun | `run-finalization.ts` | adopt the outcome into Mission state: baseline record, Experiment trail entry, state version, concentration review, derived Memory |
| recover-or-terminate | `recovery.ts` | reuse already-durable decision stages/applications and attempt numbers; terminate on budget, Experiment bound or interruption |

Rules the split keeps: dispatch never decides, finalization never measures,
recovery only reads durable state, and a terminal condition persists its
truthful status before it throws. The stages import the shared record
vocabulary (`withEvent`, path helpers, typed errors) from `mission-start.ts`,
which imports them back — the same intra-package direction
`run-preparation.ts` has taken since Stage 1; no stage imports another stage's
internals, and only `mission-start.ts` composes them. Behaviour is pinned by
`tests/integration/ledger-trace.test.ts` (trace digests) and, at the PRD §6
commit points, by `tests/integration/mission-recovery-faults.test.ts`.

P6: physical pack is in place. Flat pack re-exports are retired; import
this directory ([ADR-0013](../../docs/adr/0013-six-pack-physical-closeout.md)).
Import `src/mission/file-blueprint.ts` for the file-blueprint schema.

`runGoldenPath` / assemble stay **mock default** (ET-ORCH-GAP / #98
**landed**). `runOrchGap` may call that glue; omit / `false` does not
auto-run hang. Live opens only with explicit `{ live: true }` (plus key
fail-closed). `EVOK_NEWAPI_LIVE` alone does not open the product path.
`runDeployArenaOrch` hangs the orthogonal DeployArena arm only when
`competitionId=deploy-arena`; it wires COI into evidence auto-submit
and does not become a second control plane.
MethodologyEvidence auto-seam (ME-1) stays wired through the existing
propose → hang path. `#27` ModelOrchestra is a **thin impl**
(`runModelOrchestra`); this pack does not own search-graph authority.

Secrets are read from the environment only and must be redacted in errors.
Elite / side-slots / Team Fan-Out are not Promotion keys (Elite ≠ 晋级).
`#40` Progressive stays off unless Mission/config explicitly opts in.
AtCoder true-submit stays frozen. DeployArena live playground submit
is fail-closed (credentials + `{ live: true }` + all-green gates).
Pattern C is not thickened here.

Do not move hang / T48 into this pack. Do not grow a second control plane
in `src/cli/`. Contest-arm runtime stays in `src/competition/`; this pack
keeps `llm-propose-outer-min` as the propose/assemble seam.
