# Multi-agent research architecture: contracts, resources, and the Pi boundary

Status: implementation pointer for the contract/resource/context seam landed in
`src/competition/competition-contract.ts`, `src/competition/rule-visibility.ts`,
`src/execution/host-inventory.ts`, `src/execution/resource-lease.ts`,
`src/execution/run-manifest.ts`, `src/execution/execution-context.ts`,
`src/execution/researcher-context.ts`, `src/execution/role-context.ts`, `src/memory/slice.ts`,
`src/execution/context-broker.ts`, `src/execution/subagents-adapter.ts`,
`src/execution/pi-child-dispatch.ts`, and `src/execution/pi-child-metering.ts`. `RoleTaskContext` (optionally with a
`MemorySlice`) is assembled per Run by the `ContextBroker`, bound to that Run's
`targetAgentId`/`runId`, and injected only into the matching `PiAgentRuntime`
request; it is not a shared system prompt.
Vocabulary authority stays [`CONTEXT.md`](../CONTEXT.md); ownership stays
[ADR-0007](adr/0007-six-pack-ownership.md); the Pi SDK boundary stays
[ADR-0005](adr/0005-pi-sdk-execution-path.md). This document adds no gate,
promotion, or submit authority.

This repository is an evoK application built on the Pi SDK with one Pi plugin
entry at `extensions/evok.ts`. `src/execution/pi-agent-runtime.ts` is the Pi
SDK adapter used by the Research Run. `ContextBroker`, `MemorySlice`, and
`subagents-adapter` are core evoK modules. The platform, research, and eval seats are internal records loaded together by
`src/cli/evok-plugin.ts`. They are not separate packages and not separate Pi
extensions.

## Topology

```
                ┌──────────────────────────────┐
                │      Mission Controller       │  mission pack: authorize /
                │  (Mission Director + Policy)  │  continue / repair / stop
                └──────────────┬───────────────┘
                               │ Task Contract (minimal)
              ┌────────────────┼─────────────────────────┐
              ▼                ▼                         ▼
     ┌────────────────┐ ┌───────────────┐      ┌──────────────────┐
     │ Researcher      │ │ Critic         │      │ Reviewer          │  short-lived,
     │ (propose)       │ │ (defects)      │      │ (evidence check)  │  one Task each
     └───────┬────────┘ └───────┬───────┘      └────────┬─────────┘
             │ artifacts        │ objections            │ verdicts
             ▼                  ▼                       ▼
                ┌──────────────────────────────┐
                │   trusted Evaluator           │  measures; never delegates
                │   (competition adapters)      │  scoring to an agent
                └──────────────┬───────────────┘
                               │ scores / rule findings
                ┌──────────────▼───────────────┐
                │   Evidence gates (promotion,  │  evidence pack: hang / T48 /
                │   admission, budget, broker)  │  budget / auto-submit
                └──────────────────────────────┘

   Execution Broker (execution pack): HostInventory probe → ResourceLease
   grant → ResourceUsage record. pi-subagents: the ONE delegation transport
   below the Mission Controller — no Mission authority, no resource
   allocation, no evaluation, no promotion, no submission.
```

- **Mission Controller** holds the human-owned objective, Mission Policy, and
  budget. It is the only control plane; agents are replaceable Run execution
  (ADR-0005).
- **Researcher / Critic / Reviewer** are short-lived: each receives exactly
  one minimal Task Contract context and returns artifacts or findings. They
  hold no long-term context and no cross-task history.
- **Evaluator** is trusted and independent; it sees the full
  CompetitionContract and evaluation data. Researcher agents never do.
- **Execution Broker** grants ResourceLeases against a probed HostInventory
  and records ResourceUsage; it does not evaluate, promote, or submit.
- **pi-subagents** is the delegation transport (an optional *dependency*: the
  core packs do not import it). The guard in `subagents-adapter.ts` rejects
  any delegation asking for
  `mission-authority`, `resource-allocation`, `evaluation`, `promotion`,
  `admission`, or `submission` *before* the transport runs. A delegation may
  carry an explicit `RoleTaskContext` + `MemorySlice` for the CHILD, but the
  child always starts a fresh session (`freshSession: false` is refused) and
  must declare its own `targetAgentId`/`runId`: reusing the parent's
  `parentBinding` identity, or handing over a context/memory slice bound to
  the parent or a sibling Run, fails closed. The legacy
  `ResearcherContext`-only delegation stays valid.

## Contracts and records

| Record | Module | Content | Addressed by |
|---|---|---|---|
| `CompetitionContract` | `competition/competition-contract.ts` | version, rules/objective, data split, scoring, submission format/quota, limits (time, network), optional typed resource requirements | `version` + content `digest` |
| `HostInventory` | `execution/host-inventory.ts` | pre-run probe: CPU model/cores, memory, structured GPU devices, optional disk | content `digest` |
| `ResourceLease` | `execution/resource-lease.ts` | what the Task actually got: cpus, memoryBytes, structured GPU devices, deadline; inventory digest | content `digest` |
| `ResourceUsage` | `execution/resource-lease.ts` | real consumption: wall/cpu time, peak memory, GPU peak/utilization, `exitReason` | validated per lease |
| `RunManifest` | `execution/run-manifest.ts` | runId/taskId/attempt + contract version+digest + inventory digest + lease + usage + outcome | content `digest`; `serializeRunManifest`/`parseRunManifest` |

Rules:

- **Versioned rules.** A CompetitionContract requires a non-empty `version`
  and a content digest; `validateCompetitionContract` fails closed on any
  drift between a persisted contract and its digest.
- **Typed resource requirements are part of the rules.** The optional
  `resources` field (`CompetitionResourceRequirements`: `cpus`,
  `memoryBytes`, optional `gpu { backend, count, model?, minMemoryBytes? }`,
  `storageBytes`, `maxConcurrency`) is versioned with the contract and
  covered by its digest. It describes what the competition environment
  demands; the Execution Broker still grants leases only against the probed
  HostInventory. Optional for backward compatibility — contracts without it
  validate unchanged. Researcher agents never see it: the researcher
  competition summary carries only `{ competitionId, version, metric,
  direction }`.
- **Pre-run capability check.** `checkHostCapabilities(inventory,
  requirements)` (`execution/host-capabilities.ts`) validates the contract's
  typed `resources` against the probed HostInventory before a Run: CPU cores
  and memory always, and storage only when the probe recorded a disk reading
  (a storage requirement with no disk reading fails closed),
  GPU count plus per-device backend/model/min-VRAM (a device that cannot
  verify a requirement does not qualify). Mismatches fail closed with
  `ResourceCapabilityError`. Type-only coupled to the competition pack — no
  runtime import cycle, no scheduling.
- **GPU is structured, never a label.** `GpuDevice = { index, name, uuid?,
  memoryTotalBytes? }`. A lease carries these devices; `cuda:0`-style label
  strings fail lease validation. Selection is by count or by uuid/index
  against the probed inventory.
- **Capability mismatch fails closed.** Asking for more CPUs/memory/GPUs than
  the inventory lists, or for an unknown GPU, throws
  `ResourceCapabilityError` with a `mismatch` reason; the broker never
  over-promises.
- **Usage is recorded, exit reasons explicit.** `completed | timeout | oom |
  error | cancelled`. A RunManifest can only be completed with a usage record
  bound to its own lease.

## Researcher minimal-context boundary

`buildResearcherContext` (execution/researcher-context.ts) is a whitelist
assembler. A Researcher/Critic/Reviewer context contains **only**:

- `objective` (required) and optional current `hypothesis`
- `evidenceRefs` — ledger references, not evidence bodies
- `allowedPaths` — the modification scope
- `tools` — the granted tool names
- `competition` — `{ competitionId, version, metric, direction }` only
- `resources` — capacities from the lease (counts, bytes, GPU names,
  deadline); never device UUIDs or host paths
- `redacted` — audit list of dropped input keys

It never contains full competition rules, credentials, hidden data, the
global/Mission budget, or another agent's long-term history. Any input key
outside the whitelist is dropped; known-sensitive keys
(`RESEARCHER_CONTEXT_FORBIDDEN_FIELDS`) are dropped and named in `redacted`.

## ContextBroker: one Run, one competition, one context

`ContextBroker` (`execution/context-broker.ts`, also called the Research Run
assembler) is the single place a Run's injectable context is built. It is
constructed for ONE competition (`contract` + `policy`, validated as a bound
pair) and assembles per Run from:

- `missionId` / `taskId` / `runId` / `targetAgentId` and the audience `role`
- the objective, hypothesis, evidence refs, allowed paths, and tools
- an optional `ResourceRequest` (granted against a `HostInventory`) or a
  granted `ResourceLease`
- for trusted audiences, the isolated `workspace` and the evaluation entry +
  data-access policy
- an optional memory provider returning this Run's `MemorySlice`

Output is a `BrokeredContext` wrapper whose `context` is either a
`RoleTaskContext` (researcher/critic/reviewer) or an `ExecutionContext`
(executor/evaluator). The wrapper records and is covered by:

| Digest | Binds |
|---|---|
| `contract` | the competition contract (version + content digest) |
| `policy` | the `RuleVisibilityPolicy` used for this competition |
| `context` | the role context or execution context digest |
| `memory` | the injected `MemorySlice` (research roles only) |
| `inventory` / `lease` | the host snapshot the lease was granted against, and the lease itself |

The wrapper is itself content-addressed, so `validateBrokeredContext` re-checks
the inner context, the memory slice, the competitions binding, and the
Run/agent binding. Two competitions, or two roles under one competition, get
different contexts — rules are never broadcast. `ExecutionContext` remains the
trusted-only shape: holdout data is evaluator-only and an executor asking for
it fails closed.

## MemorySlice: reference-first agent memory

`MemorySlice` (`execution/memory-slice.ts`) is what one short-lived agent may
remember from earlier Runs of the same Mission: `sliceId`, `missionId`,
`taskId`, `runId`, `targetAgentId`, `sourceRefs` / `evidenceRefs` / `artifactRefs`, structured
`facts` and `findings`, a fixed `readPolicy`, and a content digest. The read
policy is not configurable: references and summaries are readable, bodies and
sensitive content are not. Slices are frozen and serializable; a persisted
slice that no longer matches its digest fails validation.

Sensitive content fails closed at assembly, not silently: credential/secret
fields, `hiddenData`/`holdout`, `transcript`/`history`, global or Mission
budget, and raw rule bodies are rejected as top-level fields, fact names, and
finding ids. `MemoryWriteProposal` is the agent's *proposal* to add memory
(never applied by the agent), and `AgentResult` is the structured return a
short-lived agent produces; `validateAgentResult` checks it against the
dispatched Mission/Task/Run/agent so a child cannot answer with a parent's
identity.

## Mission-start Run assembly

`startAuthorizedMission` / `resumeAuthorizedMission` accept an optional
`competitionContext` (`{ contract, policy, memory?, inventory?, resourceRequest? }`) and an optional
`runtimeFactory` seam. When a competition context is supplied:

1. the controller builds ONE `ContextBroker` for that competition (policy must
   be bound to the contract) and fails at entry if it is not;
2. before each candidate dispatch it assembles the context for
   `targetAgentId = "<role>@<runId>"` and the researcher audience;
3. the `runtime.execute` call carries `roleContext`, `memorySlice` (when the
   provider returned one), and `targetAgentId`, with the role plan declaring
   `audience: "researcher"` for concrete agent names;
4. generic `task.constraints` carry ONLY non-sensitive identity
   (`missionId`, `runId`, `taskId`) — never the full `hardRules` array; rules
   reach the agent only through its role context, and execution limits
   (network, submission, credentials) stay enforced by the sandbox.

If the contract declares `resources`, Mission start requires a matching
`HostInventory`, checks the competition requirements before dispatch, and
passes the contract resource floor into the broker so each candidate receives a
Run-bound `ResourceLease` summary. The lease is currently an execution-context
record and capability gate; GPU environment mapping, cgroup/container limits,
and automatic `RunManifest`/`ResourceUsage` persistence remain a separate
execution-adapter step.

Without a competition context the Run keeps the legacy prompt and no role
context (backward-compatible default); the generic constraints still carry no
rule array. The Mission Director/Controller keeps its own authoritative policy
projection (`buildDirectorInput`), but that projection is never pasted into a
Researcher prompt.

## Pi SDK vs pi-subagents boundary

- **Pi SDK (`@earendil-works/pi-coding-agent`)** is the Run execution engine
  (ADR-0005): sessions, model/tool loops, sandbox, prompts/skills loading.
  evoK does not build a second agent loop and does not inherit Pi's prompts,
  skills, or history into Runs (ADR-0006).
- **pi-subagents** is the ONE native delegation transport. The core packs
  still do not import it: it is driven by `src/execution/pi-child-dispatch.ts`
  over Pi's event bus, reached only through the seam below.

## One seam, one transport, one mainline

Delegated child execution has exactly one of each; adding a second of any of
these is a design change, not an implementation detail. Rules for each are
owned by the fan-out spec
([`subagent-fanout-consolidation-v2.md`](subagent-fanout-consolidation-v2.md) §3);
this section states the shape and points there for the detail.

- **One delegation seam.** `SubagentTransport` behind
  `createPiSubagentsAdapter` (`execution/subagents-adapter.ts`) is the only way
  a Mission may dispatch a child, and its guard runs before any native
  registration. There is no second dispatch path, adapter or wrapper to keep
  in sync with that guard. The seam and its transport are exported from
  `execution/index.ts`; both are covered by unit tests and the offline e2e
  smoke, and neither is wired into the Mission mainline yet (explicit
  non-goal, §7 of the spec).
- **One native transport.** `execution/pi-child-dispatch.ts` is the only
  transport behind that seam. It negotiates the installed pi-subagents
  protocol before anything is registered (`pi-subagents-protocol.ts`),
  registers one child on the plugin's own event bus, and uses one deadline for
  registration, launch and execution. Failures — registration, launch, native
  crash — reject with a `PiChildFailureError` whose message and `diagnostics`
  record carry the native status, error text, exit code, last tool and a
  bounded tail of what the child had already streamed; that record is built
  through `pi-child-records.ts`, so no credential can reach a caller or a
  persisted file. Streams are retained and redacted, never drained and
  discarded.
- **Sequential Mission mainline.** `runMissionController` stays sequential:
  one Run at a time, no fan-out, no DAG scheduler. When more than one child is
  genuinely independent, concurrency is `Promise.all` over the guarded
  adapter (`fanOut`), which is a caller-side choice and grants no additional
  authority. Nothing in the mainline depends on parallel children.
- **Controller-owned metering.** `createChildMetering`
  (`execution/pi-child-metering.ts`, live in
  `src/cli/pi-campaign-director.ts`) starts ONE loopback relay and registers
  the unique `evok-meter-*` provider *before* the first child dispatch; both
  live for the controller's lifetime, so consecutive children reuse one
  registration instead of one per call. The relay forwards with the host's
  resolved credentials, which never leave the controller process and are
  never handed to a child. Token counts stay controller-side; cost pricing
  stays with the caller.

## Who sees what (context injection boundary)

Three injectable context types, all content-addressed and audit-stamped:

| Audience | Context type | Sees | Never sees |
|---|---|---|---|
| **Mission Controller** | (authority, not a context) | full CompetitionContract, Mission Policy, budget | — |
| **Execution Broker** | HostInventory + ResourceLease/Usage | probed hardware, granted capacities, real usage, exit reasons | evaluation data, promotion authority |
| **Trusted Executor/Evaluator** | `ExecutionContext` (`execution/execution-context.ts`) | contract version+digest, evaluation entry + data-access policy, inventory digest + lease, isolated workspace, network/time policy | holdout data for the **executor** (evaluator-only; requesting it fails closed) |
| **Researcher / Critic / Reviewer** | `RoleTaskContext` (`execution/role-context.ts`) + optional `MemorySlice` (`execution/memory-slice.ts`) | objective, hypothesis, evidence refs, allowed paths, tools, lease resource summary, plus only the rule fields the competition's `RuleVisibilityPolicy` allowlists **for that role**, plus reference/summary memory bound to this Run | full rules, credentials, hidden data, global budget, transcripts, other agents' history, typed resource requirements, memory bodies |

`RuleVisibilityPolicy` (`competition/rule-visibility.ts`) is
per-competition, bound to one contract by `competitionId` + digest, and
draws from a closed catalog (`RULE_SUMMARY_FIELDS`). Unknown or unsafe
fields (`resources.*`, credentials, quotas, raw rule bodies) are rejected at
policy creation. A role the policy does not name gets an empty rule summary
— rules are injected per role, never broadcast. Every `RoleTaskContext` records
`audit { role, contractDigest, policyDigest, source }` plus, when the broker
assembled it, `targetAgentId`, `runId`, `missionId`, `taskId`, and
`memoryDigest`, and its own content digest, so what each agent was told is
reproducible and attributable.

`PiAgentRuntimeRequest` validates before any workspace use, session creation,
or intent dispatch:

- `roleContext.role` must equal `role.audience ?? role.name` (a concrete agent
  name can declare its audience);
- a bound context must declare BOTH `audit.targetAgentId` and `audit.runId`, the
  request must declare the matching `targetAgentId`, and `identity.runId` must
  match — a partial binding fails closed;
- an injected `MemorySlice` requires a bound context and must match the context
  audit (`runId`, `missionId`, `taskId`, `memoryDigest`); a tampered or foreign
  slice is refused;
- the prompt receives bounded `ROLE CONTEXT` / `MEMORY SLICE` blocks only for
  that Run, and `computeInputDigest` covers the audience, `targetAgentId`, the
  context digest, the bound identities, and the memory digest.

Requests without a role context keep the legacy prompt and input digest
unchanged (only role-scoped requests grow the digest).

Examples:
[`rule-visibility.example.json`](../examples/contracts/rule-visibility.example.json),
[`execution-context.example.json`](../examples/contracts/execution-context.example.json),
[`brokered-context.example.json`](../examples/contracts/brokered-context.example.json),
[`role-context.example.json`](../examples/contracts/role-context.example.json),
[`memory-slice.example.json`](../examples/contracts/memory-slice.example.json).

## Examples

- [`examples/contracts/competition-contract.example.json`](../examples/contracts/competition-contract.example.json)
- [`examples/contracts/run-manifest.example.json`](../examples/contracts/run-manifest.example.json)

## Explicit non-goals

No real cloud GPU scheduling, no commercial contest platform, no container
orchestration. Gates, promotion, admission, budget, hang/T48, and the Broker
stay in the evidence pack, unchanged. Thin execution default (B) is
unchanged; no standing verification roster is added.
