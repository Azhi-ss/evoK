# Known host failures

`bun test --rerun-all-tests` has a set of failures that come from the environment
and the SDK, not from the change under review: symlinked temp dirs, a missing
`python` shim, and Pi SDK session fixtures.
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
| macOS dev machine | 42 failures, all accepted | pass |
| Ubuntu runner (GitHub Actions) | 0 failures; the 42 accepted names are macOS-only and do not reproduce there | pass |

A host that reproduces **fewer** failures passes: "no-longer-failing" is
informational, because a fix must never turn a gate red. A failure **outside** the
union fails the gate — fix it, or park the ticket; never add it to the baseline to
make the gate green.

The two failures the runner used to reproduce were fixed on 2026-11-08
(`3add2af`, `48a764f`): both were **stale test expectations**, not product
defects — the `src/cli` barrel legitimately also re-exports the unified
`evok-plugin`, and intake reads the skill from its discovered project copy
instead of the packaged source. Both names were removed from the union after the
fix, and the runner now reproduces zero failures.

## When the gate goes red

Re-run the suite in a clean worktree at the same commit before concluding anything: a
red gate on a dirty or half-installed tree is not evidence about your change. Then read
the shape of the failure list, because the common causes look different:

- **Hundreds of names, all inside `harness-opt`** (`optimization loop`, `optimize`,
  `tests 1-14`, `EWI metric`, `search tree`): the child resolved a Python < 3.10. The
  gate does not run in your interactive shell's `PATH`, so `python3` there can be
  `/usr/bin/python3` 3.9.6 while your shell has 3.14. Check with
  `env PATH=/usr/bin:$PATH bun run test:known-failures` and pin the interpreter with
  `HARNESS_OPT_PYTHON=/path/to/python3.14`. Since #237 an interpreter below 3.10 is refused with
  one error naming the path, the version and that variable, instead of a cascade of
  `TypeError`s inside the relay scripts.
- **A handful of names plus `Cannot find module ... from harness-opt/src/pi/delegate.ts`**: the
  workspace has no usable `node_modules`, so whole files fail to load and their tests never
  report. That is why the same command can pass on one run and refuse the next on the same
  machine. Run `bun install --frozen-lockfile`, then re-run the gate.
- **`Address already in use` and whole groups of relay tests** (`optimize-one command`,
  `search tree`): the relay binds a fixed default port, so a second suite on the same host
  (`harness-opt` in another worktree, or a leftover relay) steals it. Check
  `ps -eo command | grep 'bun test --rerun-all-tests'` and `lsof -nP -iTCP:8642` before
  blaming your change; re-run the gate once the other run finishes.

Measured on the reference host at `d703c38`: 3.14 first on `PATH` gave 39 current /
42 accepted, exit 0; `/usr/bin` first (3.9.6) gave 207 current / 168 new, exit 1; with
`node_modules` absent, whole files failed to load and the gate saw only 4-21 names.
Never make this go away with `--update`.

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
