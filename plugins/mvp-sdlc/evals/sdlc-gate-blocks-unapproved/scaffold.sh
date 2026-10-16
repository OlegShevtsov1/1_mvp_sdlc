#!/usr/bin/env bash
# Feature demo at stage idea with a Draft idea brief and no PRD yet; no remote, so nothing is merged either.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

cp -R "${fixtures}/feature-demo/." .
rm -r docs/features/demo/PRD.md docs/features/demo/test-plan.md docs/features/demo/tasks
sed -i 's/^status: Confirmed$/status: Draft/' docs/features/demo/idea-brief.md
init_repo
commit_all "Start feature demo"
