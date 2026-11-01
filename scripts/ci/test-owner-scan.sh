#!/usr/bin/env bash
# Behaviour test for owner-scan.sh in a throwaway git repo.
# Owner strings are assembled at runtime so this file passes the scan itself.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "${tmp}"' EXIT

login="oleh""shev1"
login_cap="Oleh""shev1"
name="Ole""h Shevtsov"

fail() { echo "FAIL $1: $2" >&2; exit 1; }

# run_case <name> <expected exit> <file> <content> [uncommitted]
run_case() {
  local name=$1 want=$2 file=$3 content=$4 uncommitted=${5:-} out rc=0
  rm -rf "${tmp}/repo"
  mkdir -p "${tmp}/repo/scripts/ci"
  git -C "${tmp}/repo" init -q
  cp "${here}/owner-scan.sh" "${tmp}/repo/scripts/ci/owner-scan.sh"
  cp "${here}/../publish-mirror.sh" "${tmp}/repo/scripts/publish-mirror.sh"
  echo "innocuous" > "${tmp}/repo/README.md"
  git -C "${tmp}/repo" add -A
  mkdir -p "$(dirname "${tmp}/repo/${file}")"
  printf '%s\n' "${content}" > "${tmp}/repo/${file}"
  [ -n "${uncommitted}" ] || git -C "${tmp}/repo" add -A
  git -C "${tmp}/repo" -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false commit -qm fixture
  out=$(cd "${tmp}/repo" && bash scripts/ci/owner-scan.sh 2>&1) || rc=$?
  [ "${rc}" -eq "${want}" ] || fail "${name}" "exit ${rc}, want ${want}: ${out}"
  if [ "${want}" -eq 2 ]; then
    grep -qxF "${file}" <<<"${out}" || fail "${name}" "output does not name ${file}: ${out}"
    if grep -qF -- "${content}" <<<"${out}"; then fail "${name}" "output repeats the matched text"; fi
  fi
  echo "PASS ${name}"
}

lower_name=$(tr '[:upper:]' '[:lower:]' <<<"${name}")
upper_login=$(tr '[:lower:]' '[:upper:]' <<<"${login}")

run_case "clean repo (nothing to replace)" 0 fixture.txt "nothing to see here"
run_case "login and display name publish-mirror rewrites" 0 docs/x.md \
  "${login}/${login_cap} by ${name} at git@github.${login}:${login}/repo.git"
run_case "fixture quoting the lowercase display name" 2 tests/fixtures/gate.json \
  "{\"data\": \"the scan pattern itself \`'${lower_name}'\`\"}"
run_case "the same fixture redacted" 0 tests/fixtures/gate.json \
  "{\"data\": \"the scan pattern itself \`'<owner name>'\`\"}"
run_case "login in upper case" 2 fixture.txt "by ${upper_login}"
run_case "login in a path name" 2 "docs/${login}-notes.md" "innocuous"
run_case "display name in a path name" 2 "docs/${lower_name}.md" "innocuous"
run_case "dependabot.yml is not published" 0 .github/dependabot.yml "by ${upper_login}"
run_case "uncommitted files are not scanned" 0 fixture.txt "by ${upper_login}" uncommitted
