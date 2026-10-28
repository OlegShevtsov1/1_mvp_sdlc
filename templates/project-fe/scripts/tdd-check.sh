#!/usr/bin/env bash
# Enforces the TDD commit order of a pull request (R-C3) when it changes code (non-test
# files under src/ bin/ deploy/ scripts/ docker/):
#   1. the first commit is test(...), and its tests fail (RED);
#   2. a later feat(...) or fix(...) commit follows;
#   3. tests (tests/ and *.test.* files under those directories) that the task's own commits
#      change do not change between those two commits.
# Merge commits are skipped, and commits merged in from the base branch never count.
# GitHub runs CI only on the pushed head, so RED is reproduced here (npm ci && npm test at
# the test commit) and recorded on that commit as the failing status tdd-check/red.
# Env: BASE_REF (the pull request's base branch, e.g. develop), HEAD_SHA (40 hex),
# REPO (owner/name); GH_TOKEN for gh.
# Exit 0: order kept or not applicable. Exit 1: order broken. Exit 2: bad input or tool error.
set -uo pipefail
base_ref=${BASE_REF:-}
head_sha=${HEAD_SHA:-}
repo=${REPO:-}

[[ "${base_ref}" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "tdd-check: invalid BASE_REF '${base_ref}'" >&2; exit 2; }
[[ "${head_sha}" =~ ^[0-9a-f]{40}$ ]] || { echo "tdd-check: invalid HEAD_SHA" >&2; exit 2; }
[[ "${repo}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "tdd-check: invalid REPO '${repo}'" >&2; exit 2; }
base="origin/${base_ref}"
test_subject='^test\('
code_subject='^(feat|fix)[(!:]'
code_path='^(src|bin|deploy|scripts|docker)/'
test_path="^tests/|${code_path}.*\\.test\\.[^/]+\$"

fail() {
  echo "::error::tdd-check: $*"
  exit 1
}

commits=$(git rev-list --reverse --no-merges "${base}..${head_sha}") || exit 2
[ -n "${commits}" ] || { echo "tdd-check: no commits between ${base} and ${head_sha}" >&2; exit 2; }

changed=$(git diff --name-only "${base}...${head_sha}") || exit 2
code_changed=$(grep -E "${code_path}" <<<"${changed}" | grep -vE "${test_path}")
if [ -z "${code_changed}" ]; then
  echo "tdd-check: not applicable (no code under src/ bin/ deploy/ scripts/ docker/ changed)"
  exit 0
fi

subject() {
  git log -1 --format=%s "$1"
}

red=$(head -n 1 <<<"${commits}")
[[ "$(subject "${red}")" =~ ${test_subject} ]] || fail "the first commit must start with test( (got: $(subject "${red}"))"

green=""
own=""
while read -r commit; do
  own+="${commit}"$'\n'
  if [[ "$(subject "${commit}")" =~ ${code_subject} ]]; then
    green=${commit}
    break
  fi
done < <(tail -n +2 <<<"${commits}")
[ -n "${green}" ] || fail "no feat( or fix( commit after the test commit ${red:0:7}"

red_to_green=$(git diff --name-only "${red}" "${green}") || exit 2
own_changed=$(git diff-tree --stdin --no-commit-id --name-only -r <<<"${own}") || exit 2
tests_changed=$(grep -E "${test_path}" <<<"${red_to_green}" | grep -Fx -f <(printf '%s\n' "${own_changed}"))
if [ -n "${tests_changed}" ]; then
  echo "::error::tdd-check: tests changed between the test commit and the feat/fix commit:"
  printf '%s\n' "${tests_changed}"
  exit 1
fi

checkout=$(mktemp -d)
trap 'git worktree remove --force "${checkout}" >/dev/null 2>&1; rm -rf "${checkout}"' EXIT
git worktree add --quiet --detach "${checkout}" "${red}" || exit 2
(cd "${checkout}" && npm ci) || { echo "tdd-check: could not install at the test commit ${red:0:7}" >&2; exit 2; }
if (cd "${checkout}" && npm test); then
  fail "tests pass at the test commit (not RED): ${red:0:7}"
fi

gh api -X POST "repos/${repo}/statuses/${red}" \
  -f state=failure \
  -f context=tdd-check/red \
  -f description="RED reproduced by tdd-check: npm test fails at this commit" >/dev/null \
  || { echo "tdd-check: could not record the RED status on ${red:0:7}" >&2; exit 2; }

echo "tdd-check: ${red:0:7} test( RED, ${green:0:7} feat/fix, tests unchanged"
