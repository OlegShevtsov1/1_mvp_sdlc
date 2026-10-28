#!/usr/bin/env bash
# The blocking step of the AI review of a pull request (decision 32): takes the review's structured
# output, writes the counts to ai-review/result.json ({"p0":n,"p1":n,"p2":n}), the review summary to
# ai-review/comment.md and the findings to ai-review/findings.json for scripts/ai-review-submit.sh,
# lists every P0/P1 finding in the job log (the factory's CI-failure handling reads it) and fails when
# there is any. Without a valid summary (the review failed, hit its turn limit or was not configured) it
# fails closed and writes nothing. The findings are model output, so they are data: jq renders them, the
# shell never interpolates them.
# Env: RESULT (structured output JSON {"summary":"…","findings":[{"severity":"P0|P1|P2",
# "path":"<file or empty>","line":n,"title":"…","body":"…"}]}, may be empty), RUN_URL.
# Exit 0: no P0 or P1. Exit 1: P0 or P1 found, or no valid summary.
set -uo pipefail
marker='<!-- ai-review -->'
run_url=${RUN_URL:-}
result=${RESULT:-}

mkdir -p ai-review
rm -f ai-review/result.json ai-review/comment.md ai-review/findings.json

if [ -z "${result}" ] || ! printf '%s' "${result}" | jq -e '(.summary|type=="string" and length>0)
    and (.findings|type=="array")
    and all(.findings[]; type=="object" and (.severity|IN("P0","P1","P2")) and (.path|type=="string")
      and (.line|type=="number" and .==floor and .>=0)
      and (.title|type=="string") and (.body|type=="string"))' >/dev/null 2>&1; then
  echo "::error::ai-review: no review summary (the review step failed or returned nothing) - review required before merge"
  exit 1
fi

printf '%s' "${result}" | jq -c '.findings' >ai-review/findings.json
jq -c '[.[].severity] as $s
  | {p0: ($s|map(select(.=="P0"))|length), p1: ($s|map(select(.=="P1"))|length), p2: ($s|map(select(.=="P2"))|length)}' \
  ai-review/findings.json >ai-review/result.json
read -r p0 p1 p2 < <(jq -r '"\(.p0) \(.p1) \(.p2)"' ai-review/result.json)
printf '%s' "${result}" | jq -r --arg marker "${marker}" --arg run "${run_url}" --slurpfile n ai-review/result.json '
  [$marker, "### AI review", "AI-REVIEW: P0=\($n[0].p0) P1=\($n[0].p1) P2=\($n[0].p2)", "", .summary, "",
    "Run: \($run) · Re-review: comment \"@claude review\""] | join("\n")' >ai-review/comment.md

if [ $((p0 + p1)) -gt 0 ]; then
  # Model text in the log: stop-commands keeps a "::…::" line in it from acting as a workflow command.
  token=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  echo "::stop-commands::${token}"
  jq -r '.[] | select(.severity != "P2")
    | "AI review \(.severity) \(if .path == "" then "PR" else "\(.path):\(.line)" end) - \(.title | gsub("\n"; " "))",
      (.body | split("\n")[] | "  | \(.)")' ai-review/findings.json
  echo "::${token}::"
  echo "::error::ai-review: P0=${p0} P1=${p1} P2=${p2} - review required before merge (decision 32)"
  exit 1
fi
echo "ai-review: P0=${p0} P1=${p1} P2=${p2} - ok"
