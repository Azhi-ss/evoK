---
status: accepted
---

# 0006 — Isolate evoK research resources and include project .agents/skills

System prompts and skills use evoK-owned user/project resource directories while retaining Pi SDK resource-loading mechanisms and file formats. Day-to-day Pi resource changes must not silently alter an autonomous evoK Mission, so evoK does not automatically inherit Pi's other global or project resource directories; the project `.agents/skills/` directory is an explicitly shared skill source.

Approved resource locations:

```text
~/.evok/
  SYSTEM.md
  APPEND_SYSTEM.md
  skills/

<project>/.evok/
  SYSTEM.md
  APPEND_SYSTEM.md
  skills/

<project>/.agents/skills/
  <skill>/SKILL.md
```

The additional project directory is `.agents/skills/` (with a leading dot); `agents/skills/` is not an automatic discovery source. Project resource paths are relative to the selected research project, not a Run's temporary execution directory; skill-relative references remain relative to their skill directory. Reuse the SDK loader with explicit resource sources rather than implementing a separate skill parser. Resource discovery does not grant additional tool, network, or filesystem authority.

Configured system-prompt and skill sources load directly at startup without a project-trust confirmation, trust registry, or first-use approval failure. This follows the bare SDK loading path rather than reproducing Pi CLI's optional trust-resolution UI. Direct loading does not enable arbitrary extension/package execution or grant tools additional authority.

Model definitions and authentication reuse Pi's existing configuration stores as recorded in ADR-0005; they are not duplicated into the evoK resource directories. Resource precedence and collision handling, role visibility, and discovery/reload timing remain separate design questions. These paths and the no-confirmation policy are an accepted design, not implemented startup behavior; the current default factory still disables skill discovery. The pinned SDK behavior and integration caveats are documented in `docs/pi-resource-loading.md`.

## Read skills in place; no v1 resource snapshots

Runs read discovered skill directories in their original locations, including their `SKILL.md`, reference files, and helper scripts. Access is read-only and scoped to those directories, not the entire user home or project; granting read access does not permit modifying skill sources or executing scripts. Candidate writes remain confined to the Run workspace, and script execution remains subject to the execution policy. Path resolution must preserve these restrictions rather than allowing traversal or symlinks to expand access.

V1 does not copy or freeze skill resources per Mission. A user edit during a Mission may therefore be observed by a later read; this trade-off is accepted to keep Pi-style in-place use and avoid snapshot copying/path management. It is not a guarantee of immutable skill versions or hot-reloading of the discovery index.
