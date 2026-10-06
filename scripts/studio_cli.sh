#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -n "${FLOWKIT_PYTHON:-}" ]]; then
  exec "$FLOWKIT_PYTHON" -m agent.studio_cli "$@"
elif [[ -x .venv/bin/python ]]; then
  exec .venv/bin/python -m agent.studio_cli "$@"
else
  exec python3 -m agent.studio_cli "$@"
fi
