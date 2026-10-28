#!/usr/bin/env bash
# Posts the AI review (decision 103 a) as one GitHub pull request review per head commit, as
# github-actions[bot]: findings on a line of the PR diff become inline comments, the others are listed
# in the review body, each finding once; Request changes on P0/P1, otherwise Comment. Its own reviews are
# the github-actions[bot] reviews whose body starts with <!-- ai-review --> (other workflows review as that
# bot too): a head already carrying one gets no second review, and a result without P0/P1 dismisses their
# Request changes on older heads, also on that re-run. When the review API rejects the inline comments (a
# 422 for a line outside the diff), it retries once with every finding in the body. The body and each
# inline comment are capped at 60000 characters with a truncation note (GitHub rejects more than 65536).
# The findings are model output, so they are data: jq builds the payload.
# The workflow runs this from its own revision, never from the PR head: it holds a write token.
# Usage: bash scripts/ai-review-submit.sh [dir] (default ai-review). Reads comment.md, findings.json and
# result.json (written by scripts/ai-review-report.sh), pr.diff and head_sha (the commit the review read) in
# <dir>.
# Env: GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER.
# Exit 0: posted, or the head was already reviewed. Exit 1: posting or a dismissal failed. Exit 2: usage error.
set -uo pipefail
dir=${1:-ai-review}
bot='github-actions[bot]'
marker='<!-- ai-review -->'
max=60000

usage() {
  echo "usage: ${0##*/} [dir]: $1" >&2
  exit 2
}

for name in comment.md findings.json result.json pr.diff head_sha; do
  [[ -r "${dir}/${name}" ]] || usage "missing ${dir}/${name}"
done
head_sha=$(< "${dir}/head_sha")
[[ "${head_sha}" =~ ^[0-9a-f]{40}$ ]] || usage "${dir}/head_sha is not a commit sha"
[[ "${GITHUB_REPOSITORY:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || usage "invalid GITHUB_REPOSITORY"
[[ "${PR_NUMBER:-}" =~ ^[0-9]+$ ]] || usage "invalid PR_NUMBER"
pr=${PR_NUMBER}
reviews_url="repos/${GITHUB_REPOSITORY}/pulls/${pr}/reviews"

work=$(mktemp -d)
trap 'rm -rf "${work}"' EXIT

if ! gh api --paginate "${reviews_url}" > "${work}/pages.json" \
    || ! jq -s --arg bot "${bot}" --arg marker "${marker}" \
      'add // [] | map(select(.user.login == $bot and ((.body // "") | startswith($marker))))' \
      "${work}/pages.json" > "${work}/mine.json"; then
  echo "::warning::AI review could not read the reviews of PR #${pr}"
  exit 1
fi
reviewed=false
if jq -e --arg sha "${head_sha}" 'any(.[]; .commit_id == $sha)' "${work}/mine.json" > /dev/null; then
  reviewed=true
fi

# "<path>\t<line>" for every line an inline comment may anchor to: added and context lines on the RIGHT.
# The hunk header's counts say where a hunk ends, so a content line starting with +++ is never a header.
# git C-quotes a path with a quote, backslash, control or non-ASCII byte ("b/\303\244.rb") and ends a
# path with a space with a tab; LC_ALL=C makes awk work on bytes, so the octal escapes decode to UTF-8.
LC_ALL=C awk '
  function unquote(s,   out, i, c) {
    out = ""
    for (i = 2; i < length(s); i++) {
      c = substr(s, i, 1)
      if (c == "\\") {
        c = substr(s, ++i, 1)
        if (c ~ /[0-7]/) { c = sprintf("%c", c * 64 + substr(s, i + 1, 1) * 8 + substr(s, i + 2, 1)); i += 2 }
        else if (c == "t") c = "\t"
      }
      out = out c
    }
    return out
  }
  /^diff --git / { path = ""; left = 0; right = 0; next }
  left > 0 || right > 0 {
    c = substr($0, 1, 1)
    if (c == "+") { if (path != "") print path "\t" n; n++; right--; next }
    if (c == "-") { left--; next }
    if (c == "\\") next
    if (path != "") print path "\t" n; n++; left--; right--; next
  }
  /^\+\+\+ / {
    path = substr($0, 5); sub(/\t$/, "", path)
    if (path ~ /^".*"$/) path = unquote(path)
    if (path == "/dev/null") path = ""; else sub(/^b\//, "", path)
    next
  }
  /^@@ / {
    split($2, a, ","); left = (2 in a) ? a[2] + 0 : 1
    split($3, b, ","); n = substr(b[1], 2) + 0; right = (2 in b) ? b[2] + 0 : 1
    next
  }
' "${dir}/pr.diff" > "${work}/lines.tsv"

# The review payload; with inline false every finding goes into the body. comment.md holds the frame (marker,
# counts, summary) and its last line stays last; this is the only place the findings are listed.
payload() {
  jq -n --arg sha "${head_sha}" --argjson inline "$1" --argjson max "${max}" \
    --rawfile comment "${dir}/comment.md" --rawfile lines "${work}/lines.tsv" \
    --slurpfile findings "${dir}/findings.json" --slurpfile result "${dir}/result.json" '
    ($lines | split("\n") | map(select(. != "") | {(.): true}) | add // {}) as $diff
    | def on_diff: $inline and .line > 0 and ($diff["\(.path)\t\(.line)"] // false);
    def cap($n):
      "\n\n_Truncated to fit GitHub, which takes at most 65536 characters; the job log lists every P0/P1._\n" as $note
      | if length <= $n then . else .[0:$n - ($note | length)] + $note end;
    def bullet: "- **\(.severity)** "
      + (if .path == "" then "" elif .line == 0 then "`\(.path)` " else "`\(.path):\(.line)` " end)
      + (.title | gsub("\n"; " ")), (.body | split("\n")[] | "  \(.)");
    ($findings[0] | map(select(on_diff))) as $on
    | ($findings[0] | map(select(on_diff | not))) as $off
    | ($comment | rtrimstr("\n") | split("\n")) as $summary
    | (if $off == [] then []
       else [if $inline then "### Findings outside the diff" else "### Findings" end] + [$off[] | bullet] + [""]
       end) as $section
    | {
        commit_id: $sha,
        event: (if $result[0].p0 + $result[0].p1 > 0 then "REQUEST_CHANGES" else "COMMENT" end),
        body: (($summary[:-1] + $section | join("\n") | cap($max - ($summary[-1] | length) - 1))
          + "\n" + $summary[-1]),
        comments: [$on[] | {path, line, side: "RIGHT", body: ("**\(.severity)** \(.title)\n\n\(.body)" | cap($max))}]
      }'
}

# Posts the review; when the API rejects its inline comments, posts once more with every finding in the body.
post() {
  gh api -X POST "${reviews_url}" --input "${work}/review.json" > /dev/null && return
  (( inline > 0 )) || return 1
  echo "AI review: the inline comments were rejected, posting every finding in the body"
  payload false > "${work}/review.json"
  inline=0
  gh api -X POST "${reviews_url}" --input "${work}/review.json" > /dev/null
}

failed=false
payload true > "${work}/review.json"
event=$(jq -r '.event' "${work}/review.json")
inline=$(jq '.comments | length' "${work}/review.json")
total=$(jq 'length' "${dir}/findings.json")
if [[ "${reviewed}" == true ]]; then
  echo "AI review already posted for ${head_sha}, not posting another"
elif post; then
  echo "AI review posted on PR #${pr} for ${head_sha}: ${event}, ${inline} inline, $(( total - inline )) in the body"
else
  echo "::warning::AI review could not be posted on PR #${pr}"
  failed=true
fi

# Also after a failed post or on a head already reviewed (a re-run retries a failed dismissal): the gate
# let this head through, so no Request changes of this script, not even one on this head, may block it.
if (( $(jq '.p0 + .p1' "${dir}/result.json") == 0 )); then
  mapfile -t stale < <(jq -r '.[] | select(.state == "CHANGES_REQUESTED") | .id' "${work}/mine.json")
  for id in "${stale[@]}"; do
    if gh api -X PUT "${reviews_url}/${id}/dismissals" \
        -f message="Superseded by the AI review of ${head_sha}" -f event=DISMISS > /dev/null; then
      echo "AI review dismissed the earlier Request changes ${id}"
    else
      echo "::warning::AI review could not dismiss review ${id} on PR #${pr}"
      failed=true
    fi
  done
fi

[[ "${failed}" == false ]]
