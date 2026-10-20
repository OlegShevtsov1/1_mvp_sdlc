#!/usr/bin/env bash
# Fails when tracked files contain internal network details or private IDs
# that must never reach this public repository. Only file:line is printed,
# never the matching text, so CI logs do not repeat what was found.
# Patterns are written so they never match this file itself
# (escaped dots, bracketed single characters).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

status=0

# scan <label> <git grep args...> -- <pathspecs...>
scan() {
  local label=$1
  shift
  local out rc
  out=$(git grep -nI "$@")
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

check() {
  local label=$1
  shift
  scan "${label}" "$@" -- .
}

# Same as check, but skips one path for this rule only.
check_except() {
  local exclude=$1 label=$2
  shift 2
  scan "${label}" "$@" -- . ":(exclude)${exclude}"
}

# The project templates are a copy of a real app: loopback, bind-all and RFC 5737 documentation addresses
# are allowed there, and the Gemfile, its lock and brakeman.ignore carry four-part gem versions.
template_ipv4() {
  local hits rc out
  hits=$(git grep -nIoE "${ipv4}" -- templates/project-be templates/project-fe \
    ':(exclude)templates/project-be/Gemfile' ':(exclude)templates/project-be/Gemfile.lock' \
    ':(exclude)templates/project-be/config/brakeman.ignore')
  rc=$?
  [ "${rc}" -le 1 ] || { echo "git grep failed (${rc}) on rule: IPv4 literal in a template" >&2; exit 2; }
  out=$(printf '%s\n' "${hits}" | grep -vE \
    ':[^0-9.]?(0\.0\.0\.0|127\.0\.0\.1|192\.0\.2\.[0-9]+|198\.51\.100\.[0-9]+|203\.0\.113\.[0-9]+)([^0-9.]|$)' |
    grep -v '^$')
  if [ -n "${out}" ]; then
    echo "::error::public-repo check failed: IPv4 literal in a template"
    printf '%s\n' "${out}" | cut -d: -f1,2 | sort -u
    status=1
  fi
}

ipv4='(^|[^0-9.])([0-9]{1,3}\.){3}[0-9]{1,3}([^0-9.]|$)'
check "private LAN IP (192-168 range)"  -E  -e '192\.168\.'
check "internal VPN IP (10-18 range)"   -E  -e '(^|[^0-9])10\.18\.'
scan "IPv4 literal (EIP or internal)" -E -e "${ipv4}" -- . \
  ':(exclude)templates/project-be' ':(exclude)templates/project-fe'
template_ipv4
check "internal hostname (vr8 prefix)"  -iE -e 'vr8[-]'
check "internal hostname srvN.local"   -iE -e 'srv[0-9]+\.local'
check "internal hostname (bonfir[e])"  -iE -e 'bonfir[e]'
# The vendored upstream file has a UUID example whose last group is 12 digits; it cannot be edited (plugins/sdlc/UPSTREAM.md).
check_except plugins/sdlc/skills/generate-data-model/SKILL.md \
  "AWS account ID (12 digits)"         -E  -e '(^|[^0-9])[0-9]{12}([^0-9]|$)'
check "Route53 hosted zone ID"         -E  -e '(^|[^A-Za-z0-9+/])Z[A-Z0-9]{12,}([^A-Za-z0-9+/=]|$)'
# feature-start has to call the Trello API; card and board links are still banned everywhere else.
check_except plugins/mvp-sdlc/bin/feature-start \
  "Trello link"                        -iE -e 'trello\.com'
check "Notion link or page ID"         -iE -e 'notion\.(so|site)' -e '(^|[^0-9a-f])[0-9a-f]{32}([^0-9a-f]|$)'
# The notifier has to name the Bot API host; chat IDs and links are still banned everywhere else.
check_except scripts/ci/notify-telegram.sh \
  "Telegram link, API or chat ID"      -iE -e 't\.me/' -e 'api\.telegram\.org' -e '-100[0-9]{9,}'
check "local home path"                -E  -e '/home/de[v]'

if [ "${status}" -eq 0 ]; then
  echo "public-repo check: clean"
fi
exit "${status}"
