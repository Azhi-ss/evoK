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

- Implement exactly one explicitly identified GitHub ticket per Pi session; never implement the next ticket in the current session.
- Before editing, read the ticket and its comments, verify its `ready-for-agent` status and blockers, then claim it with `gh issue edit <number> --add-assignee @me` as the first write.
- Read `CONTEXT.md` and relevant ADRs before exploring; follow the repository vocabulary and existing decisions.
- Follow the ticket acceptance criteria, use TDD for behavior changes, and do not expand scope into follow-up tickets.
- Before completion, run `bun test --rerun-all-tests`, `bun run typecheck`, `git diff --check`, and `/code-review`.
- Commit only the ticket's changes. Preserve pre-existing or unrelated files; do not reset, clean, or overwrite them.
- Comment the verified acceptance criteria, commit, validation, and remaining risks on the ticket, then close it. If blocked or ambiguous, report the blocker and stop without guessing.
- After all completion gates pass, the current Pi may act as a one-shot dispatcher: use the session-resolved Orca CLI to create a new `pi` terminal in the active worktree, send it a complete prompt for the next eligible ticket, then stop. Never dispatch before validation, commit, and issue closure succeed.
- Continue only serially. Skip spec/epic/map parents, `ready-for-human` issues, and tickets with open blockers; stop when no eligible ticket remains or when the current ticket has a failure, unexplained dirty worktree, ambiguity, or launch failure.
- An eligible ticket is open, explicitly labelled `ready-for-agent`, unassigned, and free of blockers in its issue body. Do not rely on GitHub's dependency summary alone; current blockers may be recorded under `## Blocked by`.

## Goal usage

- Start each ticket in a fresh Pi terminal with the literal `/goal ...` command; do not send `GOAL ...` as ordinary text.
- Keep one goal scoped to one ticket and include its issue number, acceptance criteria, validation gates, and stop conditions. Use `/goal --tokens ...` when an explicit token budget is needed.
- `/goal` continues the current Pi session; it does not create or inherit a new terminal. After successful completion, use Orca to create the next fresh Pi and send it a new `/goal ...` command.
- Call `goal_complete` only after requirement-by-requirement evidence is verified; use `goal_wait` only for an arranged external wake, and `goal_blocked` only for the same evidenced blocker recurring across at least three goal turns.
