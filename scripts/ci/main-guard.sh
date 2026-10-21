#!/usr/bin/env bash
# Detects commits that reached a protected branch without a merged pull request (R-C4): main
# (.github/workflows/main-guard.yml) and develop (.github/workflows/develop-guard.yml).
# Env: REPO (owner/name), SHA (commit on the branch), BRANCH (default main); GH_TOKEN for gh;
# optional TELEGRAM_MVP_VPN_ALERTS_* for the alert.
# Exit 0: commit came from a merged PR. Exit 1: it did not (alert sent). Exit 2: bad input or GitHub API error.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo=${REPO:-}
sha=${SHA:-}
branch=${BRANCH:-main}
attempts=5
pause=${MAIN_GUARD_SLEEP:-5}

[[ "${repo}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "main-guard: invalid REPO '${repo}'" >&2; exit 2; }
[[ "${sha}" =~ ^[0-9a-f]{7,40}$ ]] || { echo "main-guard: invalid SHA '${sha}'" >&2; exit 2; }
[[ "${branch}" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "main-guard: invalid BRANCH '${branch}'" >&2; exit 2; }
short=${sha:0:7}

# GitHub links a fresh squash commit to its PR with a short delay, so an empty answer is retried.
prs=""
for ((i = 1; i <= attempts; i++)); do
  if prs=$(gh api "repos/${repo}/commits/${sha}/pulls" \
    --jq '[.[] | select(.merged_at != null) | .number] | join(",")'); then
    [ -z "${prs}" ] || break
  elif [ "${i}" -eq "${attempts}" ]; then
    echo "main-guard: GitHub API error for ${short}; cannot decide" >&2
    exit 2
  fi
  [ "${i}" -eq "${attempts}" ] || sleep "${pause}"
done

if [ -n "${prs}" ]; then
  echo "main-guard: ${short} came from merged PR #${prs}"
  exit 0
fi

echo "::error::main-guard: commit ${short} reached ${branch} without a merged PR"
run_url=""
if [ -n "${GITHUB_RUN_ID:-}" ]; then
  run_url=" — ${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-${repo}}/actions/runs/${GITHUB_RUN_ID}"
fi
bash "${here}/notify-telegram.sh" MVP_VPN_ALERTS \
  "❌ ${repo}: commit ${short} reached ${branch} without a merged PR${run_url}" \
  || echo "main-guard: Telegram alert failed" >&2
exit 1
