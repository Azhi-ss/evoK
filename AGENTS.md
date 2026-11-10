# evoK — agent guidance

## Agent skills

### Issue tracker

Issues live in GitHub Issues (this repo); use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-label vocabulary kept as-is. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
Memory subsystem (projection, decision packet, Run injection, recovery, evaluation): `docs/agents/memory-map.md`.

## Source and test layout

- Production code lives under `src/`.
- Unit tests may stay next to the module they cover as `*.test.ts`.
- Put cross-module integration tests under `tests/integration/` and end-to-end tests under `tests/e2e/` when those test types are introduced.
- Do not move existing tests or create extra folders without a concrete maintenance or feature need.

## Ticket workflow

- One fresh Pi context handles exactly one GitHub ticket: start it with `/implement` and a compact prompt naming the issue, its acceptance criteria, and stop conditions. Do not paste AGENTS.md or the full issue body.
- Before editing, read the issue and comments, verify `ready-for-agent` and blockers, claim it with `gh issue edit <number> --add-assignee @me` as the first write, then read `CONTEXT.md` and relevant ADRs.
- Use TDD for behavior changes. Preserve unrelated changes. Before completion, run `bun run check` (typecheck + whitespace + full suite vs the known-host-failure baseline) and `/code-review`; then commit, comment the result on the issue, and close it. Baseline rules: `docs/agents/known-failures.md`.
- Only after the ticket is committed, closed, and the tracked worktree is clean, use the session-resolved Orca CLI to open a new fresh Pi in the active worktree and send it the next eligible ticket. Never implement the next ticket in the current session.
- Stop on blockers, failed gates, ambiguity, unexplained dirty state, or when no eligible ticket remains.

<!-- CODEGRAPH_START -->
## CodeGraph

This repository is indexed by CodeGraph (`.codegraph/` at the root): a SQLite graph
of symbols, calls, imports and inheritance, kept fresh by a file watcher.

Use it **before** grep/read when you need to understand or locate code, and before
editing a symbol you can name:

- **MCP tool** `mcp__codegraph__codegraph_explore` — pass this repository's absolute
  path as `projectPath`; the MCP server starts outside the repo, so without it there
  is no default project. One call returns the relevant symbols' line-numbered source
  plus the call paths and blast radius; treat that source as already Read.
- **Shell fallback**: `codegraph explore "<symbols or question>" -p <repo root>` —
  same output, for subagents without the MCP tool.

Read/grep is still the tool for configs, docs, and files the index skipped.
Trust the graph; re-reading a file it already returned is wasted work.
<!-- CODEGRAPH_END -->
