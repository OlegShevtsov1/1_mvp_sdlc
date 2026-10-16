#!/usr/bin/env bash
set -euo pipefail
python3 "${EVAL_PLUGIN}/bin/sync-spec" demo --from be > /dev/null
