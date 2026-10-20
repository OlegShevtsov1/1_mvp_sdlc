#!/usr/bin/env bash
# Resolves a prod release tag on GitHub: it must be an annotated tag vX.Y.Z pointing at a commit.
# Whether that commit is on main is deploy/main_commit_check.sh's job.
# Usage: deploy/tag_check.sh vX.Y.Z
# Env: GH_REPO (owner/name); needs gh with a token that can read the repository.
# Prints version=sha-<40 hex> and sha=<40 hex>, ready for GITHUB_OUTPUT.
set -euo pipefail

: "${GH_REPO:?}"
tag=${1:-}
fail() {
  echo "::error::$1" >&2
  exit 1
}

[[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "expected a release tag vX.Y.Z (got '$tag')"
object='.object.type + " " + .object.sha'
read -r type ref_sha < <(gh api "repos/$GH_REPO/git/ref/tags/$tag" --jq "$object" 2>/dev/null) || true
case ${type:-} in
  tag) ;;
  commit) fail "$tag is a lightweight tag; prod needs an annotated tag (git tag -a)" ;;
  *) fail "$tag does not exist in $GH_REPO" ;;
esac
read -r type sha < <(gh api "repos/$GH_REPO/git/tags/$ref_sha" --jq "$object" 2>/dev/null) || true
if [ "${type:-}" != commit ] || ! [[ ${sha:-} =~ ^[0-9a-f]{40}$ ]]; then
  fail "$tag does not point at a commit"
fi

echo "version=sha-$sha"
echo "sha=$sha"
