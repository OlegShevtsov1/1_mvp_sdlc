#!/usr/bin/env bash
# Report of the AI review of a pull request (decision 32): takes the review's structured output,
# writes the counts to ai-review/result.json ({"p0":n,"p1":n,"p2":n}), posts them with the findings
# as one PR comment (updated in place on re-runs) and fails when there is a P0 or P1. Without a valid
# summary (the review failed, hit its turn limit or was not configured) it fails closed.
# The findings are model output, so they are data: jq renders the comment, the shell never
# interpolates or prints them.
# Env: RESULT (structured output JSON, may be empty), REPO (owner/name), PR_NUMBER, RUN_URL,
# GH_TOKEN (for gh).
# Exit 0: no P0 or P1. Exit 1: P0 or P1 found, or no valid summary. Exit 2: bad input or gh error.
set -uo pipefail
marker='<!-- ai-review -->'
repo=${REPO:-}
pr=${PR_NUMBER:-}
run_url=${RUN_URL:-}
result=${RESULT:-}

[[ "${repo}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "ai-review: invalid REPO" >&2; exit 2; }
[[ "${pr}" =~ ^[0-9]+$ ]] || { echo "ai-review: invalid PR_NUMBER" >&2; exit 2; }

body=$(mktemp)
trap 'rm -f "${body}"' EXIT

if [ -n "${result}" ] && printf '%s' "${result}" | jq -e '(.summary|type=="string" and length>0)
    and (.findings|type=="array")
    and all(.findings[]; (.severity|IN("P0","P1","P2")) and (.file|type=="string")
      and (.title|type=="string") and (.detail|type=="string"))' >/dev/null 2>&1; then
  valid=true
  mkdir -p ai-review
  printf '%s' "${result}" | jq -c '[.findings[].severity] as $s
    | {p0: ($s|map(select(.=="P0"))|length), p1: ($s|map(select(.=="P1"))|length), p2: ($s|map(select(.=="P2"))|length)}' \
    >ai-review/result.json
  read -r p0 p1 p2 < <(jq -r '"\(.p0) \(.p1) \(.p2)"' ai-review/result.json)
  printf '%s' "${result}" | jq -r --arg marker "${marker}" --arg run "${run_url}" --slurpfile n ai-review/result.json '
    ([$marker, "### AI review", "AI-REVIEW: P0=\($n[0].p0) P1=\($n[0].p1) P2=\($n[0].p2)", "", .summary, ""]
    + (.findings | sort_by(.severity) | map("- **\(.severity)** `\(.file)\(if .line then ":\(.line)" else "" end)` — \(.title): \(.detail)"))
    + ["", "Run: \($run) · Re-review: comment \"@claude review\""]) | join("\n") | .[0:60000]' >"${body}"
else
  valid=false
  printf '%s\n' "${marker}" '### AI review' 'AI-REVIEW: no summary' \
    'The review did not return a summary (it failed, hit its turn limit or was not configured) — review required before merge.' \
    "Run: ${run_url}" >"${body}"
fi

post() {
  local id method=POST target="repos/${repo}/issues/${pr}/comments"
  id=$(gh api --paginate "repos/${repo}/issues/${pr}/comments" | jq -s --arg marker "${marker}" \
    'add // [] | map(select(.user.login=="github-actions[bot]" and (.body|startswith($marker)))) | last | .id // empty') || return 1
  if [ -n "${id}" ]; then
    method=PATCH target="repos/${repo}/issues/comments/${id}"
  fi
  jq -n --rawfile body "${body}" '{body:$body}' | gh api --method "${method}" "${target}" --input - >/dev/null
}
post || { echo "::error::ai-review: could not post the review comment"; exit 2; }

if [ "${valid}" != true ]; then
  echo "::error::ai-review: no review summary (the review step failed or returned nothing) - review required before merge"
  exit 1
fi
if [ $((p0 + p1)) -gt 0 ]; then
  echo "::error::ai-review: P0=${p0} P1=${p1} P2=${p2} - review required before merge (decision 32)"
  exit 1
fi
echo "ai-review: P0=${p0} P1=${p1} P2=${p2} - ok"
