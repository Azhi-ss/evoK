# Spec · `#40` Progressive opt-in (ET-PROG-40 / #178)

Product default remains **`fixed_uct`**. Progressive / `#40` is **off** unless
a Mission or config **explicitly** opts in. Environment variables never flip
that default. Progressive is not welded on as a product default.

## When Progressive is callable

Opt-in is explicit only. Any one of:

- Mission / lift: `{ progressive: true }` or `{ searchSelection: "progressive_mcgs_optin" }`
- Config object: `{ selectionId: "progressive_mcgs_optin" }` or `{ selectionPolicy40: "opt-in" }`
- StrongSearch alias (#99): `{ strongSearch: true }` or `{ selectionId: "strong_search" }`
- Project file: `<abs-project>/.evok/search.json` with the same explicit fields

Resolver: `resolveSearchSelection` / `readSearchSelectionConfig` in
`src/search/progressive-opt-in.ts`. Missing, empty, or `progressive: false`
stays `fixed_uct` / `#40` off.

`createSearchSelectionPort()` with no id, `createDefaultSearchSelectionPort()`,
and an unmounted SEA host remain `fixed_uct`. Setting `EVOK_SEARCH_SELECTION`,
`EVOK_SELECTION_POLICY`, or `SELECTION_POLICY` does **not** mount Progressive.

## Anneal + Elite (opt-in only)

When opted in, parent selection uses decaying exploration and an Elite
soft-switch. These formulas are **inner selection only**.

```text
c(t) = c0 / (1 + t / tau)
w(t) = min(1, t / tau)
```

Defaults: `c0 = √2`, `tau = 8`, `topK = 2`. At `t = 0`, `c = √2` and
`w = 0` (UCT / unvisited first). At `t = tau`, `w = 1` and Elite top-K
soft-switch is fully on.

`selectionPolicy40` on that opted-in port is `"opt-in"`. The product-default
constant `SELECTION_POLICY_40` stays `"off"`.

## Elite ≠ 晋级

**Elite ≠ 晋级 / Promotion / Admission / Broker / kill-test key.**

Elite `value` ranking may change which parent is selected **inside** the
search tree when Progressive is opted in. It does not:

- promote a Candidate
- pass Admission or Budget
- satisfy hang / T48
- authorize Broker or External Submission
- appear on `SearchParentSelection` as `eliteScore` or any other promotion key

`ELITE_IS_NOT_JINJI === true` and `ELITE_ROLE_WHEN_OPTED_IN === "inner-selection-only"`
are the Spec pins. Tests refuse T48 map / HypothesisLedger / hang when Elite
or MMD / near-dup / side-slot fields are smuggled as keys.

## Gates that stay in force

Opt-in does **not** change Admission, Budget, hang, or T48 predicate
semantics. Missing protected holdout still refuses Admission. Unreserved
spend still refuses continue / writeback. Hang inconclusive is not pass.
Unmapped T48 artifacts still block. True submit and Deploy Arena stay
frozen.

## How to opt in

```json
{
  "progressive": true,
  "tau": 8,
  "topK": 2,
  "t": 8
}
```

`t` is the anneal step (absent ⇒ `t = 0`, so `w = 0` and Elite is not yet
on). Write that object as `.evok/search.json`, or pass it as
`continueResearch({ lift: { searchSelection: { progressive: true, t: 8 } } })`.
Do not set env vars expecting a silent default flip.
