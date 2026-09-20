---
status: accepted
---

# 0012 — Physical `src/competition/` pack (ET-A5 / #125)

Physical cut of the competition package. Logical ownership stays the
six-pack map in [ADR-0007](0007-six-pack-ownership.md). No gate, T48,
hang, `#40`, or live-default behavior change.

## Decision

Contest-arm runtime modules live under `src/competition/`:

- runtime: `llm-competition-runtime` (mock default; live explicit)
- before-promotion AC: `llm-comp-arm-before-promotion`

Flat `src/*.ts` files remain compatibility re-exports. Consumers may keep
importing the old paths.

**Boundary:** competition owns contest-arm runtime and local Evaluator
adapters. It does not own evidence gates (hang / T48 / Broker) or Mission
propose/assemble glue. `llm-propose-outer-min` stays in `src/mission/`
(orchestration seam). Hang / T48 stay in `src/evidence/`. Search
structure stays in `src/search/`. Execution Team / runtime stay in
`src/execution/`. CLI stays a thin shell in `src/cli/`.

**Live** stays explicit `{ live: true }`. `EVOK_NEWAPI_LIVE` alone does
not open the product arm. Model allowlist is DeepSeek* / Gemini* only;
GPT* stays banned. True External Submission stays frozen. Elite /
side-slots / competition scores are not Promotion keys.

`idea-types` stays at `src/` (research diversity vocabulary — not
problem-facing). Methodology JSON fixtures stay at
`src/fixtures/methodology/` (evidence-owned). `local-file-evaluator`
stays at `src/` (CLI / Mission start wiring; not this cut).
`evok-model` / `evok-resources` / `newapi-client` stay at `src/`
(shared wiring). P6 residue cleanup is recorded in
[ADR-0013](0013-six-pack-physical-closeout.md).

Amendment (ET-SUBMIT-AUTO / #179): contest-arm auto-submit authority
stays in evidence (`attemptContestAutoSubmit`). Competition still
does not own gate predicates or the Broker. Live destination remains
explicit `{ live: true }`. `#40` stays opt-in.

## Out of scope / freezes

- No change to gate three-state, T48, hang, or Broker predicates.
- No weld of `#40` / Progressive as product default.
- Contest-arm auto-submit stays fail-closed and evidence-owned.
- No move of `src/mission/`, `src/cli/`, `src/execution/`,
  `src/evidence/`, or `src/search/`.
- No start of P6 residue cleanup.
- No Elite / side-slot / competition-score as Promotion keys.
