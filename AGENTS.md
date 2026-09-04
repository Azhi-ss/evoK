# evoK — agent guidance

## Agent skills

### Issue tracker

Issues live in GitHub Issues (this repo); use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-label vocabulary kept as-is. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Ticket workflow

- Implement one ticket per fresh Pi context.
- After a ticket is committed, use the session-resolved Orca CLI to create a new `pi` terminal in the active worktree, wait for TUI readiness, then send the next ticket prompt to that new terminal. Do not send a new ticket to an existing Pi session when context isolation is required.
- Sequential tickets may reuse the main worktree after the previous ticket is committed and the working tree is clean. Use an isolated worktree only for concurrent work or uncommitted changes.
- Use Pi, not Codex, for ticket sessions. A formal handoff file is optional and is only needed for context not captured in the issue or repository.

## Autonomous ticket execution

- Implement exactly one explicitly identified GitHub ticket per Pi session; do not continue to another ticket in the same session.
- Before editing, read the ticket and its comments, verify its `ready-for-agent` status and blockers, then claim it with `gh issue edit <number> --add-assignee @me` as the first write.
- Read `CONTEXT.md` and relevant ADRs before exploring; follow the repository vocabulary and existing decisions.
- Follow the ticket acceptance criteria, use TDD for behavior changes, and do not expand scope into follow-up tickets.
- Before completion, run `bun test --rerun-all-tests`, `bun run typecheck`, `git diff --check`, and `/code-review`.
- Commit only the ticket's changes. Preserve pre-existing or unrelated files; do not reset, clean, or overwrite them.
- Comment the verified acceptance criteria, commit, validation, and remaining risks on the ticket, then close it. If blocked or ambiguous, report the blocker and stop without guessing.
