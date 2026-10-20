#!/usr/bin/env bash
# Checks a pushed release tag before release.yml drafts its GitHub Release:
#   1. the name is vX.Y.Z;
#   2. it is an annotated tag;
#   3. its commit is an ancestor of main (MAIN_REF);
#   4. its number is what scripts/next-version.sh gives for that commit;
#   5. CHANGELOG.md at the tag has a non-empty section for it;
#   6. that section's "Minimum backend version:" equals deploy/min-be-version at the tag.
# Usage: scripts/release-check.sh <tag>
# Env: MAIN_REF (default origin/main).
# Exit 0: a valid release tag. Exit 1: not one.
set -euo pipefail
here=$(dirname "${BASH_SOURCE[0]}")
tag=${1:-}
main=${MAIN_REF:-origin/main}

fail() {
  echo "::error::release-check: $*"
  exit 1
}

[[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "tag '$tag' must be vX.Y.Z"
[ "$(git cat-file -t "refs/tags/$tag" 2>/dev/null)" = tag ] ||
  fail "$tag is not an annotated tag (create it with git tag -a)"
git merge-base --is-ancestor "$tag^{commit}" "$main" 2>/dev/null ||
  fail "$tag is not an ancestor of ${main#origin/}: tag a commit on main"

expected=$("$here/next-version.sh" "$tag^{commit}") || fail "scripts/next-version.sh cannot give a version for $tag (see above)"
[ "$tag" = "v$expected" ] || fail "$tag does not match the next version: expected v$expected"

changelog=$(mktemp)
trap 'rm -f "$changelog"' EXIT
git show "$tag:CHANGELOG.md" >"$changelog" 2>/dev/null || fail "$tag has no CHANGELOG.md"
notes=$(CHANGELOG_FILE=$changelog "$here/release-notes.sh" "$tag" 2>/dev/null) ||
  fail "no section [${tag#v}] in CHANGELOG.md at $tag"

declared=$(sed -n 's/^Minimum backend version: //p' <<<"$notes")
minimum=$(git show "$tag:deploy/min-be-version" 2>/dev/null | tr -d '[:space:]') || true
if [ -z "$declared" ] || [ "$declared" != "$minimum" ]; then
  fail "the [${tag#v}] section's 'Minimum backend version: ${declared:-<missing>}' must equal deploy/min-be-version (${minimum:-<missing>})"
fi

echo "release-check: $tag ok (annotated, on ${main#origin/}, next version, CHANGELOG section, minimum backend $minimum)"
