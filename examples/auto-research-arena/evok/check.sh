#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.bun/bin:$PATH"
if [[ -f "./bin/evok-autoarena.ts" ]]; then
  EVOK_ROOT="$(pwd)"
elif [[ -n "${EVOK_REPO_ROOT:-}" ]]; then
  EVOK_ROOT="$EVOK_REPO_ROOT"
elif [[ -f .evok-root ]]; then
  EVOK_ROOT="$(cat .evok-root)"
else
  EVOK_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
fi

python3 -c "import autoarena; print('AutoArena client ready')"
exec bun "$EVOK_ROOT/bin/evok-autoarena.ts" --check
