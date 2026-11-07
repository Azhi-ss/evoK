# Known host failures

`bun test --rerun-all-tests` has a set of failures that come from the environment
and the SDK, not from the change under review: symlinked temp dirs, a missing
`python` shim, the plugin barrel, Pi SDK session fixtures.
`docs/agents/known-failures.txt` records the accepted set as a **union across
hosts**, so "no failure outside the accepted set" is a command, not an eyeballed
grep over a 280KB log.

## Commands

```sh
bun run check                        # typecheck + whitespace + the suite gate (also the pre-commit hook)
bun run test:known-failures          # run the suite, print this host's failure names
bun run test:known-failures:check    # exit 1 only if a failure is outside the accepted union
bun scripts/known-failures.ts --update   # merge this host's failures into the union
```

## What the gate means

The accepted file is a **union**, because the failures are host-specific. Both of
these run the same `--check`:

| Host | Observed | Verdict |
|---|---|---|
| macOS dev machine | 44 failures, all accepted | pass |
| Ubuntu runner (GitHub Actions) | 2 failures, both accepted, 42 accepted names did not reproduce | pass |

A host that reproduces **fewer** failures passes: "no-longer-failing" is
informational, because a fix must never turn a gate red. A failure **outside** the
union fails the gate — fix it, or park the ticket; never add it to the baseline to
make the gate green.

The two runner failures (2026-11-08) are `cli pack re-export isomorphism` and
`mission intake (#111)`; both also fail on macOS, so they are environment-independent
and are the first candidates for a real fix.

## Updating

`--update` **merges** this host's failures into the union; it never removes a name.
Removing one is a reviewed manual edit, made when the failure is genuinely fixed on
every host, so one machine cannot silently drop another machine's accepted failure.

## Wiring

`bun run check` is the completion gate from `AGENTS.md`, installed as the versioned
pre-commit hook (`.githooks/pre-commit`, activated by
`git config core.hooksPath .githooks` via the `prepare` script). CI runs the same
gate on a clean runner (`.github/workflows/checks.yml`). WIP commits can bypass the
hook with `git commit --no-verify`; a ticket's final commit cannot.
