#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 -m venv .venv-whisperx
WX_PY="$PWD/.venv-whisperx/bin/python"
"$WX_PY" -m pip install --upgrade pip
WX_INDEX="https://download.pytorch.org/whl/cpu"
if [[ "${1:-cpu}" == "cuda" ]]; then WX_INDEX="https://download.pytorch.org/whl/cu128"; fi
"$WX_PY" -m pip install torch==2.8.0 torchaudio==2.8.0 torchvision==0.23.0 --index-url "$WX_INDEX"
"$WX_PY" -m pip install -r tools/whisperx/requirements.txt
"$WX_PY" tools/whisperx/runner.py --check
