#!/usr/bin/env bash
# Behaviour test for hygiene-check.sh in a throwaway git repo.
# Forbidden strings are assembled at runtime so this file passes the check itself.
set -euo pipefail
src="$(cd "$(dirname "$0")" && pwd)/hygiene-check.sh"
tmp=$(mktemp -d)
trap 'rm -rf "${tmp}"' EXIT

fail() { echo "FAIL $1: $2" >&2; exit 1; }

# run_case <name> <expected exit> <file> <content> [<rule label that must fire>]
run_case() {
  local name=$1 want=$2 file=$3 content=$4 rule=${5:-} out rc=0
  rm -rf "${tmp}/repo"
  mkdir -p "${tmp}/repo/scripts/ci"
  git -C "${tmp}/repo" init -q
  cp "${src}" "${tmp}/repo/scripts/ci/hygiene-check.sh"
  echo "innocuous" > "${tmp}/repo/README.md"
  mkdir -p "$(dirname "${tmp}/repo/${file}")"
  printf '%s\n' "${content}" > "${tmp}/repo/${file}"
  git -C "${tmp}/repo" add -A
  out=$(cd "${tmp}/repo" && bash scripts/ci/hygiene-check.sh 2>&1) || rc=$?
  [ "${rc}" -eq "${want}" ] || fail "${name}" "exit ${rc}, want ${want}: ${out}"
  if [ "${want}" -eq 1 ]; then
    grep -qF "${file}:1" <<<"${out}" || fail "${name}" "output does not name ${file}:1"
    grep -qF -- "check failed: ${rule}" <<<"${out}" || fail "${name}" "rule '${rule}' did not fire: ${out}"
    if grep -qF -- "${content}" <<<"${out}"; then fail "${name}" "output repeats the matched text"; fi
  fi
  echo "PASS ${name}"
}

telegram_api=$(printf 'https://api.%s.org/bot' telegram)

run_case "clean repo"                 0 fixture.txt "nothing to see here"
run_case "private LAN IP"             1 fixture.txt "host $(printf '%s.%s.7.7' 192 168)" "private LAN IP"
run_case "internal VPN IP"            1 fixture.txt "net $(printf '%s.%s.x' 10 18)" "internal VPN IP"
run_case "IPv4 literal"               1 fixture.txt "dns $(printf '%s.%s.%s.%s' 8 8 4 4)" "IPv4 literal"
run_case "vr8 hostname"               1 fixture.txt "ssh $(printf 'vr%s-db' 8)" "internal hostname (vr8"
run_case "srvN.local hostname"        1 fixture.txt "ssh $(printf 'srv%s.local' 3)" "internal hostname srvN"
run_case "bonfir[e] hostname"          1 fixture.txt "ssh $(printf 'bonfir%s' e)" "internal hostname (bonfir"
run_case "12-digit account ID"        1 fixture.txt "account $(printf '%s%s' 123456 789012)" "AWS account ID"
run_case "vendored UUID may end in 12 digits" 0 plugins/sdlc/skills/generate-data-model/SKILL.md \
  "id $(printf '00000000-0000-0000-0000-%s%s' 000000 000001)"
run_case "Route53 zone ID"            1 fixture.txt "zone $(printf 'Z%s' 0ABCDEFGHIJK1)" "Route53 hosted zone ID"
run_case "Trello link"                1 fixture.txt "$(printf 'https://trello.%s/b/x' com)" "Trello link"
run_case "feature-start may name the Trello API host" 0 plugins/mvp-sdlc/bin/feature-start \
  "api $(printf 'https://api.trello.%s/1' com)"
run_case "Notion link"                1 fixture.txt "$(printf 'https://notion.%s/page' so)" "Notion link"
run_case "Notion page ID"             1 fixture.txt "page $(printf 'a%.0s' {1..32})" "Notion link"
run_case "Telegram link"              1 fixture.txt "$(printf 'https://t.%s/channel' me)" "Telegram"
run_case "Telegram chat ID"           1 fixture.txt "chat $(printf -- '-100%s' 123456789)" "Telegram"
run_case "local home path"            1 fixture.txt "$(printf '/home/%s/projects' dev)" "local home path"
run_case "notifier may name Bot API"  0 scripts/ci/notify-telegram.sh "url ${telegram_api}"
run_case "Bot API elsewhere is caught" 1 fixture.txt "url ${telegram_api}" "Telegram"
run_case "template may use loopback"  0 templates/project-be/x.rb "bind $(printf '%s.%s.%s.%s' 127 0 0 1)"
run_case "template may use a documentation IP" 0 templates/project-be/x.rb "ip $(printf '%s.%s.%s.%s' 192 0 2 10)"
run_case "public IP in a template"    1 templates/project-fe/x.ts "dns $(printf '%s.%s.%s.%s' 8 8 4 4)" "IPv4 literal in a template"
run_case "template lockfile may carry four-part versions" 0 templates/project-be/Gemfile.lock \
  "    rails ($(printf '%s.%s.%s.%s' 7 2 3 2))"
run_case "four-part version elsewhere is caught" 1 fixture.txt \
  "    rails ($(printf '%s.%s.%s.%s' 7 2 3 2))" "IPv4 literal"
