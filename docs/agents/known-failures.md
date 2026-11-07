# Known host failures

`bun test --rerun-all-tests` has a fixed set of failures on the reference host.
They come from the environment and the SDK, not from the change under review:
symlinked temp dirs, a missing `python` shim, the plugin barrel, and Pi SDK
session fixtures. `docs/agents/known-failures.txt` records the accepted set, so a
ticket can say "identical to the baseline" with a command, not with an eyeballed
grep over a 280KB log.

## Commands

```sh
bun run check                        # typecheck + whitespace + known-failure set (the pre-commit hook)
bun run test:known-failures          # run the suite, print the current failure names
bun run test:known-failures:check    # exit 1 unless the current set equals the baseline
bun scripts/known-failures.ts --update   # rewrite the baseline
```

`--check` reports both directions: a **new** failure (never accept it into the
baseline to make the gate pass — fix it or park the ticket) and a
**no-longer-failing** name (the baseline needs a reviewed update).

## The baseline is host-scoped

The file is the *reference host's* accepted set. On another machine the suite may
fail differently; compare against the baseline, and explain the difference in the
ticket instead of auto-updating it. If a failure becomes environment-independent,
fix the cause and shrink the baseline in the same change.

## Wiring

`bun run check` is the completion gate from `AGENTS.md`, also installed as the
versioned pre-commit hook (`.githooks/pre-commit`, activated by
`git config core.hooksPath .githooks` via the `prepare` script). WIP commits can
bypass it with `git commit --no-verify`; a ticket's final commit cannot.
