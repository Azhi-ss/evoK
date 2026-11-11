#!/usr/bin/env bun
/**
 * The repo's completion gates, in the order the ticket workflow requires:
 * types, whitespace, import boundaries, then the known-host-failure set. Run by
 * the versioned pre-commit hook (`.githooks/pre-commit`) and by `bun run check`.
 *
 * Fail fast: the first red gate stops the commit and prints what to fix.
 */
const ROOT = `${import.meta.dir}/..`;

const steps: readonly { readonly name: string; readonly command: readonly string[] }[] = [
  { name: "typecheck", command: ["bun", "run", "typecheck"] },
  // Staged changes are the commit; unstaged ones still land in the diff, so both.
  { name: "whitespace", command: ["sh", "-c", "git diff --check && git diff --cached --check"] },
  // PRD §5: harness/memory/capability dependencies are enforced, not documented.
  { name: "import boundaries", command: ["bun", "scripts/import-boundaries.ts"] },
  { name: "known failures", command: ["bun", "scripts/known-failures.ts", "--check"] },
];

for (const step of steps) {
  process.stdout.write(`\n== ${step.name}\n`);
  const exitCode = await Bun.spawn([...step.command], { cwd: ROOT, stdout: "inherit", stderr: "inherit" }).exited;
  if (exitCode !== 0) {
    process.stderr.write(`\ncheck: ${step.name} failed (exit ${exitCode}); the commit is refused\n`);
    process.exit(exitCode);
  }
}
process.stdout.write("\ncheck: all completion gates passed\n");
