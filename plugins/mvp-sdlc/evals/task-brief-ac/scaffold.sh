#!/usr/bin/env bash
# Feature demo with tasks: T1 is ready (size S), T3 is estimated L.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

cp -R "${fixtures}/feature-demo/." .
init_repo
commit_all "Add feature demo"
