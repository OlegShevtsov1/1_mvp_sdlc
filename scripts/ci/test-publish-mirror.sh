#!/usr/bin/env bash
# Behaviour test for publish-mirror.sh: a local git repo stands in for the primary, a bare repo for the mirror.
# No network. The primary owner strings are assembled at runtime because this repo is itself mirrored by the
# script under test, which would rewrite plain literals.
set -euo pipefail
src="$(cd "$(dirname "$0")/.." && pwd)/publish-mirror.sh"
tmp=$(mktemp -d)
trap 'rm -rf "${tmp}"' EXIT

fail() { echo "FAIL $1: $2" >&2; exit 1; }

src_login="oleh""shev1"
src_login_cap="Oleh""shev1"
src_name="Ole""h Shevtsov"
author="Oleg Shevtsov <olegshevtsov1@gmail.com>"

g() { git -c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false "$@"; }

# new_fixture: a primary with main and develop (develop is ahead) and a bare mirror seeded with one commit on main.
new_fixture() {
  rm -rf "${tmp}/primary" "${tmp}/mirror.git" "${tmp}/seed" "${tmp}/check"
  local p="${tmp}/primary"
  git init -q -b main "${p}"
  mkdir -p "${p}/.github/workflows" "${p}/bin"
  printf 'by %s\nsee github.com/%s/x\n%s\n' "${src_login}" "${src_login_cap}" "${src_name}" > "${p}/README.md"
  echo "version: 2" > "${p}/.github/dependabot.yml"
  echo "name: ci" > "${p}/.github/workflows/ci.yml"
  printf '#!/bin/sh\necho run\n' > "${p}/bin/run"
  chmod +x "${p}/bin/run"
  echo "gone soon" > "${p}/old.txt"
  g -C "${p}" add -A
  g -C "${p}" commit -q -m "initial"
  g -C "${p}" checkout -q -b develop
  echo "develop" > "${p}/dev.txt"
  g -C "${p}" add -A
  g -C "${p}" commit -q -m "develop work"

  git init -q --bare -b main "${tmp}/mirror.git"
  git init -q -b main "${tmp}/seed"
  echo "seed" > "${tmp}/seed/seed.txt"
  g -C "${tmp}/seed" add -A
  g -C "${tmp}/seed" commit -q -m "seed"
  git -C "${tmp}/seed" push -q "${tmp}/mirror.git" main
}

# primary_commit <file> <content>: commit one more file on the primary's develop.
primary_commit() {
  mkdir -p "$(dirname "${tmp}/primary/$1")"
  printf '%b' "$2" > "${tmp}/primary/$1"
  g -C "${tmp}/primary" add -A
  g -C "${tmp}/primary" commit -q -m "add $1"
}

mirror_head() { git -C "${tmp}/mirror.git" rev-parse main; }

checkout_mirror() {
  rm -rf "${tmp}/check"
  git clone -q "${tmp}/mirror.git" "${tmp}/check"
}

# publish <args...>: runs the script, sets rc, out (stdout) and err (stderr).
publish() {
  rc=0
  MIRROR_PRIMARY_URL="${tmp}/primary" MIRROR_TARGET_URL="${tmp}/mirror.git" \
    bash "${src}" "$@" >"${tmp}/out" 2>"${tmp}/err" || rc=$?
  out=$(cat "${tmp}/out")
  err=$(cat "${tmp}/err")
}

expect_refusal() {
  local name=$1 seed
  seed=$(mirror_head)
  publish 1_mvp_pilot_be
  [ "${rc}" -eq 2 ] || fail "${name}" "exit ${rc}, want 2: ${err}"
  [ "$(mirror_head)" = "${seed}" ] || fail "${name}" "mirror main moved"
}

# --- owner replacement, author, one commit, unsynced files
new_fixture
seed=$(mirror_head)
src_sha=$(git -C "${tmp}/primary" rev-parse develop)
publish 1_mvp_pilot_be --subject "first sync"
[ "${rc}" -eq 0 ] || fail "sync" "exit ${rc}: ${err}"
[[ "${out}" =~ ^[0-9a-f]{40}$ ]] || fail "sync" "stdout is not one sha: ${out}"
[ "${out}" = "$(mirror_head)" ] || fail "sync" "printed sha is not mirror main"
[ "$(git -C "${tmp}/mirror.git" rev-list --count "${seed}..main")" -eq 1 ] || fail "sync" "not exactly one new commit"
[ "$(git -C "${tmp}/mirror.git" rev-parse main^)" = "${seed}" ] || fail "sync" "parent is not the seed"
want="${author}|${author}|Sync from develop (${src_sha:0:7}): first sync"
got=$(git -C "${tmp}/mirror.git" log -1 --format='%an <%ae>|%cn <%ce>|%s' main)
[ "${got}" = "${want}" ] || fail "sync" "commit is '${got}', want '${want}'"
checkout_mirror
grep -qF "by OlegShevtsov1" "${tmp}/check/README.md" || fail "sync" "lowercase login not replaced"
grep -qF "github.com/OlegShevtsov1/x" "${tmp}/check/README.md" || fail "sync" "capitalised login not replaced"
grep -qxF "Oleg Shevtsov" "${tmp}/check/README.md" || fail "sync" "full name not replaced"
if git -C "${tmp}/check" grep -qil "${src_login}"; then fail "sync" "primary login left in the mirror"; fi
[ ! -e "${tmp}/check/.github/dependabot.yml" ] || fail "sync" "dependabot.yml was synced"
[ -f "${tmp}/check/.github/workflows/ci.yml" ] || fail "sync" "workflow missing"
[ -x "${tmp}/check/bin/run" ] || fail "sync" "bin/run lost its executable bit"
[ -f "${tmp}/check/dev.txt" ] || fail "sync" "default ref is not origin/develop"
[ ! -e "${tmp}/check/seed.txt" ] || fail "sync" "old mirror tree was kept"
echo "PASS owner replacement, author and one commit"

# --- MIRROR_SOURCE.json
python3 - "${tmp}/check/MIRROR_SOURCE.json" "${src_sha}" "${seed}" <<'PY' || fail "MIRROR_SOURCE.json" "content is wrong"
import json, re, sys
path, src_sha, seed = sys.argv[1:]
d = json.load(open(path))
assert list(d) == ["repo", "source_ref", "source_sha", "mirror_sha", "synced_at", "tags"], list(d)
assert d["repo"] == "1_mvp_pilot_be", d
assert d["source_ref"] == "origin/develop", d
assert d["source_sha"] == src_sha, d
assert d["mirror_sha"] == seed, d
assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", d["synced_at"]), d
assert d["tags"] == [], d
PY
echo "PASS MIRROR_SOURCE.json content"

# --- idempotency
head=$(mirror_head)
publish 1_mvp_pilot_be
[ "${rc}" -eq 0 ] || fail "idempotency" "exit ${rc}: ${err}"
grep -qF "nothing to sync" <<<"${out}" || fail "idempotency" "stdout: ${out}"
[ "$(mirror_head)" = "${head}" ] || fail "idempotency" "mirror main moved"
echo "PASS idempotency"

# --- tree is replaced, tags are kept
new_fixture
printf '{"repo": "1_mvp_pilot_be", "tags": [{"tag": "v0.0.1"}]}\n' > "${tmp}/seed/MIRROR_SOURCE.json"
echo "stale" > "${tmp}/seed/stale.txt"
g -C "${tmp}/seed" add -A
g -C "${tmp}/seed" commit -q -m "earlier sync"
git -C "${tmp}/seed" push -q "${tmp}/mirror.git" main
g -C "${tmp}/primary" rm -q old.txt
g -C "${tmp}/primary" commit -q -m "drop old.txt"
publish 1_mvp_pilot_be
[ "${rc}" -eq 0 ] || fail "tree replaced" "exit ${rc}: ${err}"
checkout_mirror
[ ! -e "${tmp}/check/stale.txt" ] || fail "tree replaced" "stale.txt kept"
[ ! -e "${tmp}/check/old.txt" ] || fail "tree replaced" "file deleted in the primary kept"
python3 -c 'import json, sys; assert json.load(open(sys.argv[1]))["tags"] == [{"tag": "v0.0.1"}]' \
  "${tmp}/check/MIRROR_SOURCE.json" || fail "tree replaced" "tags not preserved"
echo "PASS tree is replaced and tags are kept"

# --- refusals
new_fixture
primary_commit blob.bin "\x00\x01${src_login}\x00"
expect_refusal "leftover in a binary"
grep -qF "blob.bin" <<<"${err}" || fail "leftover in a binary" "output does not name the file: ${err}"
echo "PASS refusal on a leftover in a binary file"

new_fixture
primary_commit NOTES.md "owner ${src_login^^}\n"
expect_refusal "leftover in another case"
echo "PASS refusal on a leftover in another case"

new_fixture
primary_commit "notes/${src_login^^}-notes.txt" "nothing here\n"
expect_refusal "leftover in a path name"
grep -qF "${src_login^^}-notes.txt" <<<"${err}" || fail "leftover in a path name" "output does not name the file: ${err}"
echo "PASS refusal on a leftover in a path name"

# stub_on_path <command> <script>: a stand-in for <command> on PATH; the real one is in real_<command>.
stub_on_path() {
  mkdir -p "${tmp}/stub"
  printf '#!/usr/bin/env bash\nreal_%s=%q\n%s\n' "$1" "$(command -v "$1")" "$2" > "${tmp}/stub/$1"
  chmod +x "${tmp}/stub/$1"
}

new_fixture
# shellcheck disable=SC2016 # the stub body expands when the stub runs
stub_on_path grep '[ "$1" != -rli ] || { echo "grep: ./x: Permission denied" >&2; exit 2; }
exec "${real_grep}" "$@"'
seed=$(mirror_head)
PATH="${tmp}/stub:${PATH}" publish 1_mvp_pilot_be
rm -rf "${tmp}/stub"
[ "${rc}" -eq 2 ] || fail "leftover scan error" "exit ${rc}, want 2: ${err}"
grep -qF "leftover scan failed" <<<"${err}" || fail "leftover scan error" "output does not name the scan: ${err}"
[ "$(mirror_head)" = "${seed}" ] || fail "leftover scan error" "mirror main moved"
echo "PASS refusal when the leftover scan fails"

new_fixture
primary_commit scripts/check-public-repo.sh '#!/usr/bin/env bash\nexit 1\n'
chmod +x "${tmp}/primary/scripts/check-public-repo.sh"
g -C "${tmp}/primary" commit -q -am "make check executable"
expect_refusal "public-repo check"
grep -qF "check-public-repo.sh" <<<"${err}" || fail "public-repo check" "output does not name the check: ${err}"
echo "PASS refusal by the public-repo check"

# --- the push is never forced: a mirror main that moved after the clone is kept
new_fixture
git clone -q "${tmp}/mirror.git" "${tmp}/racer"
echo "concurrent" > "${tmp}/racer/concurrent.txt"
g -C "${tmp}/racer" add -A
g -C "${tmp}/racer" commit -q -m "concurrent writer"
racer_sha=$(git -C "${tmp}/racer" rev-parse HEAD)
# shellcheck disable=SC2016 # the stub body expands when the stub runs
stub_on_path git 'if [[ " $* " == *" push "* ]]; then "${real_git}" -C '"${tmp@Q}"'/racer push -q origin main; fi
exec "${real_git}" "$@"'
PATH="${tmp}/stub:${PATH}" publish 1_mvp_pilot_be
rm -rf "${tmp}/stub" "${tmp}/racer"
[ "${rc}" -eq 1 ] || fail "diverged mirror" "exit ${rc}, want 1: ${err}"
grep -qF "push to the mirror 1_mvp_pilot_be failed" <<<"${err}" || fail "diverged mirror" "output does not name the push: ${err}"
[ "$(mirror_head)" = "${racer_sha}" ] || fail "diverged mirror" "the concurrent commit was overwritten"
echo "PASS a diverged mirror main is not overwritten"

# --- dry run
new_fixture
seed=$(mirror_head)
publish 1_mvp_pilot_be --dry-run
[ "${rc}" -eq 0 ] || fail "dry run" "exit ${rc}: ${err}"
[[ "${out}" =~ ^[0-9a-f]{40}$ ]] || fail "dry run" "stdout is not one sha: ${out}"
[ "$(mirror_head)" = "${seed}" ] || fail "dry run" "mirror main moved"
kept=$(sed -n 's/^dry run: not pushed; inspect //p' <<<"${err}")
[ -d "${kept}" ] || fail "dry run" "kept directory not named: ${err}"
[ "$(git -C "${kept}" rev-parse HEAD)" = "${out}" ] || fail "dry run" "kept clone HEAD is not the printed sha"
rm -rf "$(dirname "${kept}")"
echo "PASS dry run"

# --- default ref for 1_mvp_sdlc is origin/main
new_fixture
main_sha=$(git -C "${tmp}/primary" rev-parse main)
publish 1_mvp_sdlc --dry-run
[ "${rc}" -eq 0 ] || fail "sdlc default ref" "exit ${rc}: ${err}"
kept=$(sed -n 's/^dry run: not pushed; inspect //p' <<<"${err}")
got=$(git -C "${kept}" log -1 --format=%s)
rm -rf "$(dirname "${kept}")"
[ "${got}" = "Sync from main (${main_sha:0:7})" ] || fail "sdlc default ref" "message is '${got}'"
echo "PASS default ref of 1_mvp_sdlc is origin/main"

# --- usage
publish 1_mvp_infra
[ "${rc}" -eq 64 ] || fail "usage" "exit ${rc}, want 64"
publish
[ "${rc}" -eq 64 ] || fail "usage" "no repo: exit ${rc}, want 64"
echo "PASS repos outside the allowlist are rejected"
