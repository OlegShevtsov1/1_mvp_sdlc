#!/usr/bin/env bash
# The workspace is the fe repository with a synced copy of feature demo; be/ is the backend checkout, whose PRD
# gained one sentence after the sync (committed and pushed to be-origin.git).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

init_repo
printf '# Frontend\n' > README.md
exclude be/ be-origin.git/
commit_all "Add README"

git init -q --bare -b main be-origin.git
mkdir be
cp -R "${fixtures}/spec-sync/." be/
(
  cd be
  init_repo
  commit_all "Add feature demo artifacts"
  git remote add origin "${PWD}/../be-origin.git"
  git push -q -u origin main
)
"${plugin}/bin/sync-spec" demo --from be > /dev/null
commit_all "Sync the demo spec from be"
(
  cd be
  printf '\nThe export file name includes the period.\n' >> docs/features/demo/PRD.md
  commit_all "PRD: name the export file after the period"
  git push -q
)
