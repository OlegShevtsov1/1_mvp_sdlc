#!/usr/bin/env bash
# Behaviour test for changelog.sh: each case builds a CHANGELOG.md and changelog.d/ in a temp root (CHANGELOG_ROOT).
set -euo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "${tmp}"' EXIT

fail() { echo "FAIL $1: $2" >&2; exit 1; }

old_section='## [1.1.0] - 2026-10-01

### Added

- An older entry (PILOT-1).

### Changed

### Deprecated

### Removed

### Fixed

### Security'

new_root() {
  root="${tmp}/$1"
  mkdir -p "${root}/changelog.d"
  echo '# Changelog fragments' > "${root}/changelog.d/README.md"
  printf '# Changelog\n\n## [Unreleased]\n\n### Added\n\n### Changed\n\n### Deprecated\n\n### Removed\n\n### Fixed\n\n### Security\n\n%s\n' \
    "${old_section}" > "${root}/CHANGELOG.md"
}
fragment() { printf -- '---\ncategory: %s\n---\n\n%s\n' "$2" "$3" > "${root}/changelog.d/$1"; }
cl() { CHANGELOG_ROOT="${root}" bash "${here}/scripts/changelog.sh" "$@"; }
expect_rc() {
  local want=$1 what=$2 rc=0
  shift 2
  cl "$@" > "${tmp}/out" 2> "${tmp}/err" || rc=$?
  [ "${rc}" -eq "${want}" ] || fail "${what}" "exit ${rc}, want ${want}: $(cat "${tmp}/err")"
}

new_root fragment-only
fragment PILOT-7.md Fixed '- A fix (PILOT-7).'
expect_rc 0 "check with a fragment only" check
echo "PASS check passes with a fragment only"

new_root readme-only
expect_rc 0 "check with README.md only" check
echo "PASS check passes with README.md only"

new_root unreleased-entry
sed -i 's/^### Added$/### Added\n\n- A direct entry (PILOT-8)./' "${root}/CHANGELOG.md"
expect_rc 1 "check with an [Unreleased] entry" check
grep -qF 'changelog.d/PILOT-<n>.md' "${tmp}/err" || fail "[Unreleased] entry" "the error does not name the fragment: $(cat "${tmp}/err")"
echo "PASS check fails an [Unreleased] entry and names the fragment"

new_root no-unreleased
sed -i '/^## \[Unreleased\]$/d' "${root}/CHANGELOG.md"
expect_rc 1 "check without [Unreleased]" check
echo "PASS check fails a CHANGELOG.md without [Unreleased]"

for bad in category front-matter body name; do
  new_root "bad-${bad}"
  case "${bad}" in
    category) fragment PILOT-9.md Improved '- An entry (PILOT-9).' ;;
    front-matter) printf -- '- An entry (PILOT-9).\n' > "${root}/changelog.d/PILOT-9.md" ;;
    body) fragment PILOT-9.md Added 'An entry that is no list item (PILOT-9).' ;;
    name) fragment foo.md Added '- An entry (PILOT-9).' ;;
  esac
  expect_rc 1 "bad fragment ${bad}" check
  grep -qF 'changelog.d/' "${tmp}/err" || fail "bad fragment ${bad}" "the error names no file: $(cat "${tmp}/err")"
done
echo "PASS check fails an unknown category, a missing front matter, a non-list body and a misnamed file"

new_root release
fragment PILOT-12.md Fixed '- A fix (PILOT-12).'
fragment PILOT-3.md Added '- The first feature (PILOT-3), wrapped onto
  a continuation line.'
fragment PILOT-10.md Added '- The second feature (PILOT-10).'
expect_rc 0 "release" release 1.2.0 2026-11-02
want=$(printf '%s\n' \
  '# Changelog' '' '## [Unreleased]' '' '### Added' '' '### Changed' '' '### Deprecated' '' '### Removed' '' \
  '### Fixed' '' '### Security' '' \
  '## [1.2.0] - 2026-11-02' '' \
  '### Added' '' '- The first feature (PILOT-3), wrapped onto' '  a continuation line.' \
  '- The second feature (PILOT-10).' '' \
  '### Changed' '' '### Deprecated' '' '### Removed' '' '### Fixed' '' '- A fix (PILOT-12).' '' '### Security' '' \
  "${old_section}")
[ "$(cat "${root}/CHANGELOG.md")" = "${want}" ] \
  || fail "release" "unexpected CHANGELOG.md: $(diff <(echo "${want}") "${root}/CHANGELOG.md")"
echo "PASS two categories of fragments assemble in category order, by card number, after an empty [Unreleased]"
grep -qE '^## \[1\.2\.0\] - [0-9]{4}-[0-9]{2}-[0-9]{2}$' "${root}/CHANGELOG.md" \
  || fail "release heading" "release.sh merge-release-pr would not find the section"
echo "PASS the assembled heading is the one release.sh reads"

[ "$(ls "${root}/changelog.d")" = README.md ] || fail "release" "fragments left: $(ls "${root}/changelog.d")"
expect_rc 0 "check after release" check
echo "PASS release-prep leaves no fragments and check passes"

cp "${root}/CHANGELOG.md" "${tmp}/assembled"
expect_rc 0 "release rerun" release 1.2.0
cmp -s "${root}/CHANGELOG.md" "${tmp}/assembled" || fail "release rerun" "CHANGELOG.md changed"
expect_rc 1 "release without fragments" release 1.3.0
fragment PILOT-13.md Added '- A late feature (PILOT-13).'
expect_rc 1 "release of an assembled version with fragments" release 1.2.0
echo "PASS a rerun changes nothing; no fragments, or fragments for an assembled version, are refused"

for args in "" "release" "release v1.2.0" "release 1.2" "release 1.2.0 2026-11" "check extra" "assemble 1.2.0"; do
  # shellcheck disable=SC2086 # word splitting builds the argv
  expect_rc 64 "usage '${args}'" ${args}
done
echo "PASS usage errors exit 64"
