# evoK Skills directory (ET-M1-SKILL)

Eight-category scaffold. Pack contents are engineering-owned and may be
empty. This directory is a **routing shell**, not a second control plane:
Mission authorize / continue / repair / stop stay on `/research`.

## Categories

| id | purpose |
|---|---|
| `intake` | Mission intake / briefing |
| `experiment` | Experiment / Task Contract design |
| `evidence` | Evidence, ledger, File Blueprint |
| `method-improvement` | Task-internal RSI / method updates |
| `search` | Pluggable search; when to opt-in strong search |
| `recovery` | continue / repair / hang recovery procedures |
| `pitfalls` | reusable failure patterns (not a rejected answer) |
| `policy` | Mission Policy / red lights / permissions |

`mission-intake` is the shipped accepted skill and maps to `intake`.

## Progressive disclosure (orthogonal to lifecycle)

- **L0 pointer** — default context: `name` + `description` + location
- **L1 body** — on trigger, read `SKILL.md` in place
- **L2 resources** — on demand, `scripts/` and `references/`

## Lifecycle states (orthogonal to disclosure)

`candidate` / `accepted` / `demoted`

Default context loads **accepted** short descriptions only. Unspecified
state is accepted so existing ADR-0006 discovery still injects L0
metadata. Set `state:` in SKILL.md frontmatter to hold a skill out
(`candidate` or `demoted`).

## Writeback

**writeback not opened — read-only shell.** Admission / one-slice
writeback belongs to ET-M1-EXP. Do not treat chat as authority.
