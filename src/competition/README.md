# competition

Contest and local Evaluator adapters. Does not own evidence gates or a
true contest External Submission path.

Physical home of `llm-competition-runtime` and `llm-comp-arm-before-promotion`.
Flat `src/*.ts` files re-export these modules so existing imports stay green.

Mission keeps `llm-propose-outer-min` (orchestration glue: propose → T48
map → assemble). Competition provides the runtime; mission keeps the
propose/assemble seam.

**Live** stays explicit `{ live: true }` (plus key fail-closed).
`EVOK_NEWAPI_LIVE` alone does not open the product arm. Model allowlist
is DeepSeek* / Gemini* only; GPT* stays banned.

Hang / T48 stay in `src/evidence/`. Search structure stays in
`src/search/`. Mission authorize / continue / repair / stop stay in
`src/mission/`. Execution Team / runtime stay in `src/execution/`.
`#40` SelectionPolicy stays off. Elite / side-slots / competition scores
are not Promotion keys. True External Submission stays frozen.

`idea-types` stays at `src/` (research diversity vocabulary, not
problem-facing). Methodology JSON fixtures stay at
`src/fixtures/methodology/` (evidence-owned). Do not start P6 residue
cleanup from this pack.
