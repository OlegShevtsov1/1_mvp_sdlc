#!/usr/bin/env bash
# The generated brief alone: the skill never searched mvp-rag, so nothing is cited.
set -euo pipefail
python3 "${EVAL_PLUGIN}/bin/task-brief" demo T1 > brief-T1.md
