#!/usr/bin/env bash
# Enforces the pull request conventions of the develop branch model (decisions 24-26, 29) on PRs
# into develop and main:
#   1. the head branch is feature/<KEY>-<n>-<slug> or hotfix/<KEY>-<n>-<slug> (lowercase slug),
#      the factory's archon/task-factory-*, or develop as the head of a release PR into main;
#   2. the title is <KEY>-<n>: <card title>;
#   3. the body, which becomes the squash commit body, has exactly one valid Type: line;
#   4. a release PR or release-prep PR is titled with the release's own card, never <KEY>-0 (decision 91).
# Not applicable until the develop branch exists: before that the repository is on GitHub Flow.
# The title and body are data: they are only matched, never printed or executed.
# <KEY> is the ticket key: PROJECT_NAME from config/project.env in capitals (the tracker board name).
# Env: REPO (owner/name), BASE_REF, HEAD_REF, PR_TITLE, PR_BODY; GH_TOKEN for gh;
# PROJECT_ENV_FILE (default config/project.env of this repository).
# Exit 0: conventions kept or not applicable. Exit 1: broken. Exit 2: bad input or GitHub API error.
set -uo pipefail
repo=${REPO:-}
base_ref=${BASE_REF:-}
head_ref=${HEAD_REF:-}
title=${PR_TITLE:-}
body=${PR_BODY:-}

[[ "${repo}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "pr-conventions: invalid REPO '${repo}'" >&2; exit 2; }
[[ "${base_ref}" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "pr-conventions: invalid BASE_REF '${base_ref}'" >&2; exit 2; }
[[ "${head_ref}" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "pr-conventions: invalid HEAD_REF '${head_ref}'" >&2; exit 2; }

project_env=${PROJECT_ENV_FILE:-$(dirname "$0")/../config/project.env}
[ -f "${project_env}" ] || { echo "pr-conventions: ${project_env} not found; cannot derive the ticket key" >&2; exit 2; }
key=$(sed -n 's/^PROJECT_NAME=//p' "${project_env}" | head -n 1 | tr '[:lower:]' '[:upper:]')
[[ "${key}" =~ ^[A-Z][A-Z0-9]*$ ]] || { echo "pr-conventions: invalid ticket key '${key}' (PROJECT_NAME in ${project_env} in capitals must match ^[A-Z][A-Z0-9]*$)" >&2; exit 2; }

if ! develop=$(gh api "repos/${repo}/git/matching-refs/heads/develop" \
  --jq '[.[] | select(.ref == "refs/heads/develop")] | length'); then
  echo "pr-conventions: GitHub API error; cannot decide" >&2
  exit 2
fi
if [ "${develop}" = 0 ]; then
  echo "pr-conventions: not applicable (no develop branch yet: GitHub Flow until the decision-24 branch model starts)"
  exit 0
fi

card_branch="^(feature|hotfix)/${key}-[0-9]+-[a-z0-9-]+\$"
factory_branch='^archon/task-factory-[A-Za-z0-9._-]+$'
card_title="^${key}-[0-9]+: .+\$"
no_card_release="^${key}-0[0-9]*: Release "
failed=0

if ! [[ "${head_ref}" =~ ${card_branch} || "${head_ref}" =~ ${factory_branch} ]] \
  && ! [[ "${head_ref}" = develop && "${base_ref}" = main ]]; then
  echo "::error::pr-conventions: branch '${head_ref}' must match feature/${key}-<n>-<slug> or hotfix/${key}-<n>-<slug> (lowercase slug), or be archon/task-factory-* (develop only as the head of a release PR into main)"
  failed=1
fi

if ! [[ "${title}" =~ ${card_title} ]]; then
  echo "::error::pr-conventions: PR title must match ${card_title}"
  failed=1
fi

body=${body//$'\r'/}
types=$(printf '%s\n' "${body}" | grep -c '^Type:')
if [ "${types}" -ne 1 ]; then
  echo "::error::pr-conventions: the PR body must have exactly one Type: line (found ${types})"
  failed=1
elif ! printf '%s\n' "${body}" | grep -qxE 'Type: (feat|fix|chore|docs|refactor|test|ci)'; then
  echo '::error::pr-conventions: the Type: line must be one of feat, fix, chore, docs, refactor, test, ci'
  failed=1
fi

if [[ "${title}" =~ ${no_card_release} ]]; then
  echo "::error::pr-conventions: a release PR is titled ${key}-<n>: Release vX.Y.Z (release-prep: ${key}-<n>: Release X.Y.Z changelog) with the release's own card, never ${key}-0 (decision 91: every release has its own card; ${key}-0 is only for card-less chores)"
  failed=1
fi

[ "${failed}" -eq 0 ] || exit 1
echo "pr-conventions: ok (branch, title, Type line)"
