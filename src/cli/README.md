# cli

Thin Mission CLI shell. Not a second control plane.

Physical home of `evok-cli` and the `evok` executable wrapper.
`bin/evok.ts` remains the installed entry and imports this pack.

The shell parses argv, resolves Pi models / project resources, and calls
the mission API (`startAuthorizedMission`, intake, resume, status,
`/research` status/continue, `/skills` directory view, `/skill <name>` L1).
A tty with no request launches Pi native TUI (`InteractiveMode`, #134 / #148 / #150).
The status bar and launch banner show `mode=explore|intake|mission`.
Explore keeps the Pi default prompt (optional footnote). Intake overlays
mission-intake L1 + draft constraints (draft ≠ authorization). Mission
overlays objective / constraints / budget / stop / no-submit / baseline +
L0 evoK skills. Casual chat is not hijacked by Mission wording.
Pi owns Pi shorts (`/model`, `/new`, `/resume`, …). evoK mirror slashes
(`/skills` or `/evok-skills`, `/skill`, `/research`, `/missions`,
`/intake`, `/start`, `/mission-resume`) have the same semantics and gates
as this CLI. Mission resume is `/mission-resume`, not Pi `/resume`.
`/skills` lists evoK-tagged skills from the same Pi skills root
(directory + three states; accepted requires Admission; file-body
writeback not opened). `/skill <name>` loads L1 from that tagged
catalog and is not authorization. The TUI is an entry mirror, not
Mission authority.
Authorize / budget / continue · repair · stop stay in `src/mission/`.
Hang / T48 / Admission / Budget Gate stay in `src/evidence/`.
Product baseline: [ADR-0014](../../docs/adr/0014-prd-rsi-baseline.md).

P6: physical pack is in place. The dead `src/evok-cli.ts` shim is gone;
import `src/cli` / `src/cli/evok-cli` instead. Remaining Mission flat
shims used by this shell stay migration-period re-exports
([ADR-0013](../../docs/adr/0013-six-pack-physical-closeout.md)).

Secrets are read from the environment / Pi stores only; never copy or
print credentials. Model/resource wiring (`evok-model`, `evok-resources`)
stays at `src/` because execution also uses it.
