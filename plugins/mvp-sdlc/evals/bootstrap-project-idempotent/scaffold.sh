#!/usr/bin/env bash
# A backend repository already bootstrapped, whose CLAUDE.md has a team section the template does not have.
# CLAUDE.md is untracked (info/exclude), so a lost team section cannot be restored from git.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

init_repo
printf 'source "https://rubygems.org"\n\ngem "rails"\n' > Gemfile
"${plugin}/bin/bootstrap-project" be --target . > /dev/null
printf '\n## Team notes\n\nKEEP-THIS-LINE: deploys go through the factory only.\n' >> CLAUDE.md
exclude CLAUDE.md
commit_all "Add the Claude Code setup"
