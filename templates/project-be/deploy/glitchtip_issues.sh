#!/usr/bin/env bash
# Lists the issues of the GlitchTip project <PROJECT_NAME>-be-prod first seen in a time window, one
# JSON object per line: {"id", "shortId", "title", "firstSeen"}. Used by deploy/release_watch.sh
# (via the release-watch job) and bin/sdlc-metrics --escaped.
# Usage: deploy/glitchtip_issues.sh <since epoch> [<until epoch>]   (window [since, until))
#
# API (glitchtip-backend apps/issue_events: IssueSchema, glitchtip/api/pagination.py):
# GET /api/0/projects/<org>/<project>/issues/ answers a JSON array of issues with string id,
# shortId, title and an ISO 8601 firstSeen; the next page is the Link entry
# rel="next"; results="true"; cursor="...". The org is PROJECT_NAME.
# Env: GLITCHTIP_API_TOKEN (read-only API token, environment prod secret; sent only as a header on
# curl's stdin, never printed), and GLITCHTIP_API_URL or else SENTRY_DSN, whose scheme, host and
# port are GlitchTip's (masked in Actions, never printed otherwise).
# Exit 0: listed. 2: usage or configuration error. 3: the API failed or answered another shape.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
source deploy/_common.sh

MAX_PAGES=10

since="${1:-}" until="${2:-}"
if [[ ! "$since" =~ ^[0-9]+$ || ! "$until" =~ ^([0-9]+)?$ ]]; then
  echo "usage: $0 <since epoch> [<until epoch>]" >&2
  exit 2
fi
if [[ -z "${GLITCHTIP_API_TOKEN:-}" ]]; then
  echo 'error: GLITCHTIP_API_TOKEN is not set (environment prod secret, see README "Releases")' >&2
  exit 2
fi
base="${GLITCHTIP_API_URL:-}"
if [[ -z "$base" ]]; then
  if [[ ! "${SENTRY_DSN:-}" =~ ^(https?://)[^@/]+@([^/]+)/ ]]; then
    echo 'error: set GLITCHTIP_API_URL, or SENTRY_DSN to derive it from' >&2
    exit 2
  fi
  base="${BASH_REMATCH[1]}${BASH_REMATCH[2]}"
fi
base="${base%/}"
mask "$base" >&2
load_project_env

shape_fail() {
  echo "error: GlitchTip API shape check failed: $1" >&2
  exit 3
}

body="$(mktemp)" headers="$(mktemp)"
trap 'rm -f "$body" "$headers"' EXIT

path="/api/0/projects/${PROJECT_NAME}/${PROJECT_NAME}-be-prod/issues/"
for (( page = 1; page <= MAX_PAGES; page++ )); do
  if ! code="$(curl -sS --max-time 30 -o "$body" -D "$headers" -w '%{http_code}' -H @- "${base}${path}" \
                <<< "Authorization: Bearer ${GLITCHTIP_API_TOKEN}" 2> /dev/null)"; then
    shape_fail "the request for page ${page} failed"
  fi
  [[ "$code" == 200 ]] || shape_fail "HTTP ${code} for page ${page}"
  jq -e 'type == "array" and all(.[]; (.id | type) == "string" and (.title | type) == "string" and (.firstSeen | type) == "string")' \
    "$body" > /dev/null 2>&1 || shape_fail 'expected an array of issues with string id, title and firstSeen'
  # firstSeen carries microseconds and Z or +00:00; fromdateiso8601 takes neither.
  jq -c --argjson since "$since" --arg until "$until" '
    .[]
    | (.firstSeen | sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | fromdateiso8601) as $seen
    | select($seen >= $since and ($until == "" or $seen < ($until | tonumber)))
    | {id, shortId, title, firstSeen}
  ' "$body" 2> /dev/null || shape_fail 'firstSeen is not an ISO 8601 UTC time'
  next="$(tr -d '\r' < "$headers" | grep -i '^link:' | tr ',' '\n' \
          | grep 'rel="next"; results="true"' | sed -E 's/.*<([^>]*)>.*/\1/' || true)"
  [[ -n "$next" ]] || exit 0
  # The next URL names whatever host GlitchTip thinks it has; only its path and query are used.
  path="/${next#*://*/}"
done
echo "error: more than ${MAX_PAGES} pages of issues; the list is cut off" >&2
exit 3
