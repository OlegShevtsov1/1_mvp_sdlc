#!/usr/bin/env bash
# A small Rails application: users and posts, soft-deleted with discarded_at.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

cp -R "${fixtures}/rails-mini/." .
init_repo
commit_all "Add the application"
