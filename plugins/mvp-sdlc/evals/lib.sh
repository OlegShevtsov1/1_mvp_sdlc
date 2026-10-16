#!/usr/bin/env bash
# Sourced by every scaffold.sh; the workspace is the current directory.
# Scaffolds run with only PATH, HOME, TMPDIR and GIT_CONFIG_NOSYSTEM set, so the git identity is fixed here.
set -euo pipefail
plugin="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixtures="${plugin}/tests/fixtures"
export GIT_AUTHOR_NAME=Eval GIT_AUTHOR_EMAIL=eval@example.com GIT_COMMITTER_NAME=Eval GIT_COMMITTER_EMAIL=eval@example.com

init_repo() {
  git init -q -b main
}

commit_all() {
  git add -A
  git commit -q -m "$1"
}

# Keep helper paths out of `git status`, so the model sees a clean repository.
exclude() {
  printf '%s\n' "$@" >> .git/info/exclude
}

# A bare origin.git next to the repository, with main pushed and tracked.
add_origin() {
  git init -q --bare -b main origin.git
  git remote add origin "${PWD}/origin.git"
  git push -q -u origin main
  exclude origin.git/
}

# Installs a server-side update hook (body on stdin) in origin.git; it runs with the bare repository as cwd, so
# ../<ledger> is a file in the workspace. Creates the empty ledger.
ledger_hook() {
  local ledger=$1
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\nledger=../%s\n' "${ledger}"
    cat
  } > origin.git/hooks/update
  chmod +x origin.git/hooks/update
  : > "${ledger}"
  exclude "${ledger}"
}
