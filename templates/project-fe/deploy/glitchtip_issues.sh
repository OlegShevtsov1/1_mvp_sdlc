#!/usr/bin/env bash
# Lists the GlitchTip issues of the prod frontend project <PROJECT_NAME>-fe-prod as a compact JSON
# array of {id, title, firstSeen}. GlitchTip speaks the Sentry API:
# GET /api/0/projects/<org>/<project>/issues/?query=<query> answers a JSON array of issues.
# Usage: deploy/glitchtip_issues.sh [<query>]   (default is:unresolved)
# Env: GLITCHTIP_API_URL (its host is reachable only over the VPN, so it is a secret too) and
# GLITCHTIP_API_TOKEN. Both reach curl on stdin, never on its command line, and are never printed.
# shellcheck source=deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_vars GLITCHTIP_API_URL GLITCHTIP_API_TOKEN
require_commands curl jq
load_project_env
query=$(jq -rn --arg query "${1:-is:unresolved}" '$query | @uri')
url="${GLITCHTIP_API_URL%/}/api/0/projects/$PROJECT_NAME/$PROJECT_NAME-fe-prod/issues/?query=$query&limit=100"

status=0
body=$(curl -fsS --max-time 15 --config - 2>/dev/null <<CONFIG
url = "$url"
header = "Authorization: Bearer $GLITCHTIP_API_TOKEN"
CONFIG
) || status=$?
[ "$status" -eq 0 ] || die "GlitchTip API request failed (curl exit $status)"
jq -e 'type == "array"' >/dev/null 2>&1 <<<"$body" ||
  die "GlitchTip API returned an unexpected shape (expected a JSON array of issues)"
jq -c '[.[] | {id, title, firstSeen}]' <<<"$body"
