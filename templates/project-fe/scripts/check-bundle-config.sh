#!/usr/bin/env bash
# Fails when the source or the built bundle carries an environment value: a host of the
# project zone, an error-tracker host or a DSN value. These reach the app only through the
# runtime /config.js (docker/40-config-js.sh), because one image is promoted unchanged from
# dev to prod. Key names such as SENTRY_DSN are allowed; only file:line is printed, never
# the matching text.
# Usage: check-bundle-config.sh <dir>...   (CI: src dist, after npm run build)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

zone=$(sed -n 's/^PROJECT_ZONE=//p' config/project.env)
[[ $zone =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] || { echo "config/project.env: invalid PROJECT_ZONE" >&2; exit 2; }
zone_pattern=${zone//./\\.}
credentialed_url="[a-z][a-z0-9+.-]*://[^/[:space:]\"'@]+@"

status=0

check() {
  local label=$1
  shift
  local out rc
  out=$(grep -rnIE "$@")
  rc=$?
  case $rc in
    0)
      echo "::error::bundle-config check failed: ${label}"
      printf '%s\n' "${out}" | cut -d: -f1,2
      status=1
      ;;
    1) ;;
    *) echo "grep failed (${rc}) on rule: ${label}" >&2; exit 2 ;;
  esac
}

[ $# -gt 0 ] || { echo "usage: check-bundle-config.sh <dir>..." >&2; exit 2; }
for dir in "$@"; do
  [ -d "${dir}" ] || { echo "${dir}: not found (run npm run build first)" >&2; exit 2; }
done

check "host of the project zone" -e "${zone_pattern}" -- "$@"
check "error tracker host" -e 'track\.' -- "$@"
check "DSN or other URL with credentials" --exclude='*.test.*' -e "${credentialed_url}" -- "$@"

if [ "${status}" -eq 0 ]; then
  echo "bundle-config check: clean"
fi
exit "${status}"
