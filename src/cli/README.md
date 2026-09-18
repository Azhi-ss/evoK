# cli

Thin Mission CLI shell. Not a second control plane.

Physical home of `evok-cli` and the `evok` executable wrapper.
`bin/evok.ts` remains the installed entry and imports this pack.

The shell parses argv, resolves Pi models / project resources, and calls
the mission API (`startAuthorizedMission`, intake, resume, status).
A tty with no request launches Pi native TUI (`InteractiveMode`, #134);
`/model` and `/new` stay on Pi. The TUI is not Mission authority.
Authorize / budget / continue · repair · stop stay in `src/mission/`.
Hang / T48 stay in `src/evidence/`.
Product baseline: [ADR-0014](../../docs/adr/0014-prd-rsi-baseline.md).

P6: physical pack is in place. The dead `src/evok-cli.ts` shim is gone;
import `src/cli` / `src/cli/evok-cli` instead. Remaining Mission flat
shims used by this shell stay migration-period re-exports
([ADR-0013](../../docs/adr/0013-six-pack-physical-closeout.md)).

Secrets are read from the environment / Pi stores only; never copy or
print credentials. Model/resource wiring (`evok-model`, `evok-resources`)
stays at `src/` because execution also uses it.
