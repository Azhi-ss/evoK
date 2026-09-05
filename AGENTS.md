# evoK — agent guidance

## Agent skills

### Issue tracker

Issues live in GitHub Issues (this repo); use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-label vocabulary kept as-is. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Source and test layout

- Production code lives under `src/`.
- Unit tests may stay next to the module they cover as `*.test.ts`.
- Put cross-module integration tests under `tests/integration/` and end-to-end tests under `tests/e2e/` when those test types are introduced.
- Do not move existing tests or create extra folders without a concrete maintenance or feature need.

## Ticket workflow

- One fresh Pi context handles exactly one GitHub ticket. Start with a compact `/goal --tokens 60000 ...` naming the issue, acceptance criteria, validation, and stop conditions.
- Before editing, read the issue and comments, verify `ready-for-agent` and blockers, claim it with `gh issue edit <number> --add-assignee @me` as the first write, then read `CONTEXT.md` and relevant ADRs.
- Use TDD for behavior changes. Preserve unrelated changes. Before completion, run `bun test --rerun-all-tests`, `bun run typecheck`, `git diff --check`, and `/code-review`; then commit, comment the result on the issue, and close it.
- Only after the ticket is committed, closed, and the tracked worktree is clean, use the session-resolved Orca CLI to open a new fresh Pi in the active worktree and send it the next eligible ticket. Never implement the next ticket in the current session.
- Stop on blockers, failed gates, ambiguity, unexplained dirty state, or when no eligible ticket remains.
