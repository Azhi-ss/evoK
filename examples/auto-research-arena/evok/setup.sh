#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.bun/bin:$PATH"
if ! command -v bun >/dev/null 2>&1; then
  echo "evok setup: bun (>=1.1) is required on PATH; install via https://bun.sh/install before engine run" >&2
  exit 1
fi

if [[ -f "./bin/evok-autoarena.ts" ]]; then
  EVOK_ROOT="$(pwd)"
elif [[ -n "${EVOK_REPO_ROOT:-}" ]]; then
  EVOK_ROOT="$EVOK_REPO_ROOT"
else
  EVOK_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
fi

if [[ ! -f "$EVOK_ROOT/bin/evok-autoarena.ts" ]]; then
  echo "evok setup: cannot locate bin/evok-autoarena.ts (set run-config \"source\" to evoK repo root or export EVOK_REPO_ROOT)" >&2
  exit 1
fi

printf '%s\n' "$EVOK_ROOT" > .evok-root
if [[ ! -d "$EVOK_ROOT/node_modules" ]]; then
  (cd "$EVOK_ROOT" && bun install --frozen-lockfile)
fi
