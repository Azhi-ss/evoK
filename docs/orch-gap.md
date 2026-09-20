# Spec · ET-ORCH-GAP (#181) orchestration ports

Control-plane glue for three already-owned ports. Product defaults stay
**`fixed_uct`**. Progressive / StrongSearch stay **opt-in / off**.
Environment variables never flip that default. Deploy Arena stays standby.
This is not a second control plane.

## #27 ModelOrchestra — thin impl

`runModelOrchestra(catalog, config?, ctx?)` is a one-shot over the existing
`ModelOrchestra` thin impl (not a stub). Unconfigured / omitted config
resolves the catalog default. Configured Flash-first routing and
fail-closed unknown gates are unchanged. The orchestra only picks model
tiers — it does not schedule Tasks, spend Budget, or promote.

## #98 golden-path glue — landed

`runGoldenPath` / `assembleV1GoldenPath` stay the landed V1-G glue.
`runOrchGap({ goldenPath: true | { statement } })` calls that path.
Omit / `false` does **not** auto-run hang. Mock is the default; live
needs explicit `{ live: true }` + key fail-closed.

## #99 StrongSearch opt-in port

`SearchSelectionPort` / `StrongSearchAdapter` remain the spec #99 port.
Default factory and `resolveSearchSelection()` stay `fixed_uct` / `#40` off.

Explicit opt-in (any one):

- Mission / config: `{ strongSearch: true }`
- `{ selectionId: "strong_search" }` or `{ searchSelection: "strong_search" }`
- `createSearchSelectionPort("strong_search")` / `optInStrongSearchPort()`
- SEA: `mountStrongSearchOptIn()` — `host.defaultSelection()` stays `fixed_uct`

StrongSearch is an alias of the existing Progressive adapter
(`progressive_mcgs_optin`). It does not invent a second default and does
not weld `#40` on. Elite ≠ 晋级 / Promotion / Admission / Broker /
kill-test key.

## How to call the glue

```ts
const gap = await runOrchGap({
  catalog,
  // orchestra omitted → unconfigured default model
  // goldenPath omitted → glue landed but not run
  // searchSelection omitted → fixed_uct
});
```

Opt-in example:

```ts
await runOrchGap({
  catalog,
  orchestra: { fast: "acme/flash-2", deep: "acme/pro-2" },
  goldenPath: { statement: "hold-out must not move" },
  searchSelection: { strongSearch: true, t: 8 },
});
```

Do not set env vars expecting a silent default flip. Do not start
Deploy Arena from this path.
