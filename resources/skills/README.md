# evoK Skills directory (ET-M1-SKILL + ET-SKILL-NS)

Eight-category scaffold. Pack contents are engineering-owned and may be
empty. This directory is the **packaging source**: `evok` startup syncs
or links it into the Pi native skills root with evoK tags. Runtime
discovery authority is that Pi root, not this tree as a parallel root.

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

Shipped accepted skills: `mission-intake` (`intake`), `experiment`
(`experiment`), `evidence` (`evidence`), `policy` (`policy`),
`search` (`search`), `method-improvement` (`method-improvement`),
`recovery` (`recovery`), and `pitfalls` (`pitfalls`).

## Tags (same Pi root)

evoK product skills in the Pi tree carry:

- `owner: evok` or `namespace: evok`
- `category` ∈ the eight ids above
- `state` ∈ `candidate` | `accepted` | `demoted`

Optional subpath: `<project>/.pi/skills/evok/<category>/<name>/SKILL.md`.

`/skills` lists only evoK-tagged skills. Explore can still see ordinary
Pi skills. Mission/Intake default-inject accepted + evoK-tagged L0 only.

## Progressive disclosure (orthogonal to lifecycle)

- **L0 pointer** — default context: `name` + `description` + location
- **L1 body** — `/skill <name>` reads `SKILL.md` in place
- **L2 resources** — on demand, `scripts/` and `references/`

A Skill body is **not** authorization to start, continue, or submit.

## Lifecycle states (orthogonal to disclosure)

`candidate` / `accepted` / `demoted`

Default context loads **accepted + evoK-tagged** short descriptions only.

## Writeback

**writeback not opened — read-only shell.** Admission + Budget Gate
still gate accepted writeback. Do not treat chat as authority.

## How to demo 「标记过滤 / L0→L1」

Offline, no model:

```bash
evok /skills --project <dir>
```

You should see eight category lines and `mission-intake`, `experiment`,
`evidence`, `policy`, `search`, `method-improvement`, `recovery`, and
`pitfalls` in default context as **accepted** (synced into
`<dir>/.pi/skills/evok/<category>/`).
Ordinary untagged Pi skills are omitted from this list. Then:

```bash
mkdir -p <dir>/.pi/skills/evok/search/try-search
cat > <dir>/.pi/skills/evok/search/try-search/SKILL.md <<'EOF'
---
name: try-search
description: candidate search tip
owner: evok
state: candidate
category: search
---
body stays out of default context
EOF
evok /skills --project <dir>
evok /skill try-search --project <dir>
```

`try-search` appears as **candidate** (held out of default context).
`/skill try-search` prints the L1 body and states it is not
authorization. `/skill experiment`, `/skill evidence`, `/skill policy`,
`/skill search`, `/skill method-improvement`, `/skill recovery`,
and `/skill pitfalls` load the shipped L1 bodies the same way and do
not authorize start, continue, or submit.
`/skill policy` also states it is not privilege expansion and that red
lights still ask a human. `/skill search` states default parent
selection is `fixed_uct`, strong search / Progressive is explicit
opt-in only, and `#40` stays off. `/skill method-improvement` states
in-Mission RSI is validation-gated (version id → verify command /
adversarial tags → enable record → rollbackable), is not automatic
promotion, and Elite is not Admission. `/skill recovery` points at
existing continue / repair / hang program paths only and is not a
second control plane. `/skill pitfalls` names reusable failure
signatures as guidance and is not a rejection library or auto-refuse
blacklist. `/research` stays Mission
authority.
