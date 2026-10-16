#!/usr/bin/env bash
# feature/report is pushed, then its last commit is amended locally; origin.git logs deleted and rewritten refs.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

init_repo
printf '# Reports\n' > README.md
commit_all "Add README"
add_origin
git checkout -q -b feature/report
printf 'Monthly report\n' > report.md
commit_all "Add the monthly report"
printf 'Monthly report\n\nTotals per shop.\n' > report.md
commit_all "Add totals"
git push -q -u origin feature/report
ledger_hook rewrite-log.txt <<'HOOK'
ref=$1 old=$2 new=$3
if [[ "${new}" =~ ^0+$ ]]; then
  printf 'delete %s\n' "${ref}" >> "${ledger}"
elif [[ ! "${old}" =~ ^0+$ ]] && ! git merge-base --is-ancestor "${old}" "${new}"; then
  printf 'rewrite %s\n' "${ref}" >> "${ledger}"
fi
HOOK
printf 'Monthly report\n\nTotals per shop and month.\n' > report.md
git add report.md
git commit -q --amend -m "Add totals per shop and month"
