---
status: accepted
---

# 0010 — Physical `src/mission/` + `src/cli/` packs (ET-A3 / #123)

Physical cut of the mission and CLI packages. Logical ownership stays the
six-pack map in [ADR-0007](0007-six-pack-ownership.md). No gate, T48, hang,
`#40`, or `runGoldenPath` behavior change.

## Decision

Mission control-plane modules live under `src/mission/`:

- director / authorize: `mission-director`, `mission-start`, `mission-resume`
- intake / draft: `mission-draft`, `mission-intake`
- research loop: `research-loop`, `baseline-track`, `file-blueprint`, `branch-recovery`
- golden-path glue: `v1-golden-path`, `outer-min-path`, `outer-e2e-min-path`,
  `llm-propose-outer-min` (orchestration seam, not competition fixtures)

The thin CLI shell lives under `src/cli/`:

- `evok-cli` — parse argv and call the mission API
- `evok` — executable wrapper (`bin/evok.ts` remains the installed entry)

Flat `src/*.ts` files remain compatibility re-exports. Consumers may keep
importing the old paths.

**Boundary:** Mission owns authorize / budget / continue · repair · stop.
CLI is not a second control plane. Hang / T48 stay in `src/evidence/`
(already cut in ET-A1). Search structure stays in `src/search/` (ET-A2).

`runGoldenPath` / assemble stay mock-default. Live opens only with explicit
`{ live: true }`. `EVOK_NEWAPI_LIVE` alone does not open the product path.
MethodologyEvidence auto-seam (ME-1) stays wired. Secrets are read from the
environment only and redacted in errors.

Model/resource wiring (`evok-model`, `evok-resources`) stays at `src/`
because execution also uses it.

## Out of scope / freezes

- No change to gate three-state, T48, hang, or Broker predicates.
- No weld of `#40` / Progressive as product default.
- No real contest submit path enabled.
- No move of `src/evidence/` or `src/search/`.
- No start of ET-A4 / ET-A5 (`execution/` / `competition/`).
- No C thicken of the execution roster.
- No Elite / side-slot / Team Fan-Out as Promotion keys.
