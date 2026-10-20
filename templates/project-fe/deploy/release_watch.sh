#!/usr/bin/env bash
# release-watch: after a prod deploy, checks every RELEASE_WATCH_POLL_SECONDS (default 30) for
# RELEASE_WATCH_SECONDS (default 600) that https://app.<zone>/health answers and that no GlitchTip
# issue of <PROJECT_NAME>-fe-prod appeared that was not there at the start. Stops at the first
# problem: Kamal Manage waits for this job (one prod concurrency group), so an operator's rollback
# is not held up. It never rolls back by itself.
# Usage: deploy/release_watch.sh vX.Y.Z
# Env: as deploy/glitchtip_issues.sh; GITHUB_OUTPUT (optional) receives text=<result line>.
# Exit 0: ✅ clean. Exit 1: ❌, with the reason in the result line.
# shellcheck source=deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[ $# -eq 1 ] || die "usage: deploy/release_watch.sh vX.Y.Z"
tag=$1
wait=${RELEASE_WATCH_SECONDS:-600} poll=${RELEASE_WATCH_POLL_SECONDS:-30}
load_project_env
health_url="$(destination_url prod)/health"
project="$PROJECT_NAME-fe-prod"
issues_script="$(dirname "${BASH_SOURCE[0]}")/glitchtip_issues.sh"

finish() {
  echo "$1"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "text=$1" >>"$GITHUB_OUTPUT"
  fi
  case $1 in ✅*) exit 0 ;; *) exit 1 ;; esac
}

baseline=$("$issues_script") || finish "❌ release-watch $tag: could not read GlitchTip issues of $project"
deadline=$((SECONDS + wait)) checks=0
while :; do
  curl -fsS --max-time 10 -o /dev/null "$health_url" 2>/dev/null || finish "❌ release-watch $tag: $health_url failed"
  checks=$((checks + 1))
  issues=$("$issues_script") || finish "❌ release-watch $tag: could not read GlitchTip issues of $project"
  new=$(jq -c --argjson baseline "$baseline" \
    '($baseline | map(.id)) as $known | map(select(.id as $id | $known | index($id) | not))' <<<"$issues")
  if [ "$new" != '[]' ]; then
    titles=$(jq -r '.[:3] | map(.title // "untitled" | gsub("[\r\n]+"; " ") | .[:80]) | join("; ")' <<<"$new")
    finish "❌ release-watch $tag: new GlitchTip issue(s) in $project: $titles"
  fi
  [ "$SECONDS" -lt "$deadline" ] || break
  sleep "$poll"
done
finish "✅ release-watch $tag: $checks health checks OK, no new GlitchTip issues in $project ($((wait / 60)) min)"
