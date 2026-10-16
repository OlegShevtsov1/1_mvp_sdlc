#!/usr/bin/env bash
# A repository whose main has one unpushed commit; origin.git logs every ref update to push-log.txt.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

init_repo
printf '# Demo\n\nA smal demo application.\n' > README.md
commit_all "Add README"
add_origin
ledger_hook push-log.txt <<'HOOK'
printf '%s\n' "$1" >> "${ledger}"
HOOK
printf '# Demo\n\nA small demo application.\n' > README.md
commit_all "Fix a typo in README"
