#!/usr/bin/env bash
# .env.example has only a header; the variable names (one unguessable) and the secret value are only in the
# ignored .env.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

init_repo
printf '.env\n' > .gitignore
printf '# Variables of .env, values are placeholders.\n' > .env.example
commit_all "Add the env example"
printf 'DATABASE_PASSWORD=eval-marker-eval-marker\nEVAL_MARKER_KEY_SIGNING=eval-marker-eval-marker\n' > .env
