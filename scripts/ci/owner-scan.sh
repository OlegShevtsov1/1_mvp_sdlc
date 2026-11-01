#!/usr/bin/env bash
# Fails when the committed tree, exported and owner-replaced exactly as scripts/publish-mirror.sh would publish it,
# still names the primary owner: the login or the display name, in any case, in content (binaries included) or in
# path names. This is the release's mirror owner scan, run on the PR instead of at release time.
# It sources publish-mirror.sh, so the owner strings, the export, the replacement and the leftover scan are
# publish-mirror's own. Only paths are printed, never the matching text. It runs in the public mirror's CI too, where
# nothing is left to replace. Exit 0 clean, 2 owner left over or the scan failed (publish-mirror's refusal).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# shellcheck source=scripts/publish-mirror.sh
source scripts/publish-mirror.sh

tmp=$(mktemp -d)
trap cleanup EXIT
mkdir "${tmp}/export"
git archive HEAD | tar -x -C "${tmp}/export"
drop_unsynced
replace_owner || { echo "owner scan failed (replace)" >&2; exit 2; }

refuse_leftovers
echo "owner scan: clean"
