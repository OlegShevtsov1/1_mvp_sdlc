#!/usr/bin/env bash
# Fails when tracked files contain internal network details or private IDs
# that must never reach this public repository. Only file:line is printed,
# never the matching text, so CI logs do not repeat what was found.
# Patterns are written so they never match this file itself
# (escaped dots, bracketed single characters).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

status=0

check() {
  local label=$1
  shift
  local out rc
  out=$(git grep -nI "$@" -- .)
  rc=$?
  case $rc in
    0)
      echo "::error::public-repo check failed: ${label}"
      printf '%s\n' "${out}" | cut -d: -f1,2
      status=1
      ;;
    1) ;;
    *) echo "git grep failed (${rc}) on rule: ${label}" >&2; exit 2 ;;
  esac
}

check "private LAN IP (192-168 range)"  -E  -e '192\.168\.'
check "internal VPN IP (10-18 range)"   -E  -e '(^|[^0-9])10\.18\.'
check "IPv4 literal (EIP or internal)" -E  -e '(^|[^0-9.])([0-9]{1,3}\.){3}[0-9]{1,3}([^0-9.]|$)'
check "internal hostname (vr8 prefix)"  -iE -e 'vr8[-]'
check "internal hostname srvN.local"   -iE -e 'srv[0-9]+\.local'
check "internal hostname (bonfir[e])"  -iE -e 'bonfir[e]'
check "AWS account ID (12 digits)"     -E  -e '(^|[^0-9])[0-9]{12}([^0-9]|$)'
check "Route53 hosted zone ID"         -E  -e '(^|[^A-Za-z0-9+/])Z[A-Z0-9]{12,}([^A-Za-z0-9+/=]|$)'
check "Trello link"                    -iE -e 'trello\.com'
check "Notion link or page ID"         -iE -e 'notion\.(so|site)' -e '(^|[^0-9a-f])[0-9a-f]{32}([^0-9a-f]|$)'
check "Telegram link, API or chat ID"  -iE -e 't\.me/' -e 'api\.telegram\.org' -e '-100[0-9]{9,}'
check "local home path"                -E  -e '/home/de[v]'

if [ "${status}" -eq 0 ]; then
  echo "public-repo check: clean"
fi
exit "${status}"
