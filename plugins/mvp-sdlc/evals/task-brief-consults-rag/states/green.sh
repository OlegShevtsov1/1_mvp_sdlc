#!/usr/bin/env bash
# The generated brief followed by the skill's citation of the mvp-rag mock's hit.
set -euo pipefail
python3 "${EVAL_PLUGIN}/bin/task-brief" demo T1 > brief-T1.md
cat >> brief-T1.md <<'CITE'

Project knowledge (mvp-rag):
- 1_mvp_prompt/docs/decisions/0099-export-format-canary.md@0000000 — https://github.com/example/1_mvp_prompt/blob/0000000/docs/decisions/0099-export-format-canary.md — export format
CITE
