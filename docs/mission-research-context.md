# Explicit research context for Mission candidates

Use the selected research project's `.evok/APPEND_SYSTEM.md` for approved rules
that every candidate must receive. The trusted resource loader reads its content
and appends it to the Pi system prompt for each Run, including resumed Missions.
Candidates do not need permission to open the `.evok` controller directory.
Project and personal `AGENTS.md`, Pi `SYSTEM.md`, and Pi `APPEND_SYSTEM.md` are
not automatically inherited by these isolated Mission sessions.

Start from the [copyable template](../templates/research-context.APPEND_SYSTEM.md).
Copy it only when creating a new prompt; merge its sections into an existing
project prompt instead of overwriting approved instructions:

```sh
mkdir -p /absolute/project/.evok
cp -n templates/research-context.APPEND_SYSTEM.md /absolute/project/.evok/APPEND_SYSTEM.md
```

Replace `<kb-id>` and the project rules with approved public research context.
For example, a project may name literature KB `697419`, explain its keyword
search syntax, and require evidence citations. A reference command is context,
not permission to call a network service, spend money, or expose credentials.
Provide local excerpts for offline Runs.

An optional `.evok/SYSTEM.md` replaces the base system prompt. Prefer
`APPEND_SYSTEM.md` when adding domain rules. Each prompt selects one file:
project `.evok` first, then `~/.evok` as fallback; the two copies do not stack.
Discovery happens at CLI startup. A resumed CLI invocation discovers resources
again. Prompt text is not a frozen per-Mission snapshot.

## Approved reference files

For longer procedures and literature excerpts, create an accepted evoK-tagged
skill under the project Pi root:

```text
/absolute/project/.pi/skills/domain-research/
  SKILL.md
  references/literature.md
```

Example `SKILL.md`:

```markdown
---
name: domain-research
description: Approved project research procedures and literature references
owner: evok
category: policy
state: accepted
---
Read references/literature.md relative to this skill directory.
Record the evidence supporting each research claim and label untested hypotheses.
```

Name this skill in `APPEND_SYSTEM.md`. Accepted, evoK-tagged skills contribute
their name, description, and location to the initial prompt. Their bodies and
references are read on demand from that directory, not from the Run's temporary
cwd. Always-relevant rules belong in `APPEND_SYSTEM.md`, since skill bodies are
not automatically injected. Do not use `.evok/skills` as a second skill root.

The candidate can already inspect ordinary project inputs read-only. Skill
discovery grants only the discovered directories, never a whole user home or
arbitrary external folder. Writes remain inside the isolated Run workspace.
Controller `.evok` records, evaluator internals, credential stores, unapproved
external paths, and symlinks escaping approved roots remain blocked. Keep secret
or evaluator-only instructions out of candidate prompts and skill references.
Resources carry no tool or network grants. The `.agents` tree remains protected
on the Mission candidate path; use `.pi/skills` for these candidate references.

## Model and network choices

```sh
bun run evok --start --project /absolute/project --mission m-example \
  --tier deep --director-tier fast --allow-host nose
```

`--tier` chooses the candidate model; `--director-tier` chooses the Director and
defaults to the candidate tier. Both must resolve through the existing Pi model
catalog and Orchestra. Each call is priced using its actual model. Start,
resume, and user-invoked Mission slash commands in the Pi TUI carry these choices.

Network defaults to `none`. `--allow-host nose` is an explicit operator grant
for the current start/resume invocation; re-supply it when resuming. It never
enables shell execution if the Mission lacks `local-shell-in-workspace`.
The Director retains its read-only, network-disabled boundary.

Supported SSH/SCP examples are `ssh nose 'pwd'`,
`scp candidate.txt nose:/tmp/candidate.txt`, and
`scp nose:/tmp/result.txt result.txt`. SSH destinations must match the granted
hostname exactly. Options, compound shell commands, expansions, nested SSH,
extra SCP operands, and unapproved hosts fail closed. SCP uploads need a readable
local source; downloads must stay in the writable Run workspace. Existing URL
checks use the same outbound host policy for supported network commands.
Downloads require an explicit local file path; a directory destination such as
`.` is rejected so a remote basename cannot select a different local target.

The command checks are an application boundary, not an OS network sandbox.
SSH uses the operator's existing host alias/configuration; the allowlist does
not verify the alias's resolved server, ProxyCommand, or remote filesystem
permissions. Provision that alias with the intended remote permissions before
granting it. This option does not create remote isolation.

Offline acceptance lives in `tests/integration/mission-start.test.ts` and
`src/execution/security-boundary.test.ts`: real Pi sessions with deterministic
faux providers check prompt delivery, in-place reference reads, denied paths,
candidate shell grants, distinct Director pricing, and host rejection. They
make no paid/live model or SSH calls.
