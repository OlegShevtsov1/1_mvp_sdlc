#!/usr/bin/env bash
# Behaviour test for publish-mirror.sh: a local git repo stands in for the primary, a bare repo for the mirror and a
# fake gh on PATH for the mirror's GitHub API (PRs, check runs, merge). No network. The primary owner strings are assembled at runtime because this repo is itself mirrored by the
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

# new_fixture: a primary with main and develop (develop is ahead), a bare mirror seeded with one commit on main and
# an empty fake GitHub state.
new_fixture() {
  rm -rf "${tmp}/primary" "${tmp}/mirror.git" "${tmp}/seed" "${tmp}/check" "${tmp}/gh-state"
  mkdir "${tmp}/gh-state"
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
  g -C "${p}" checkout -q main

  git init -q --bare -b main "${tmp}/mirror.git"
  git init -q -b main "${tmp}/seed"
  echo "seed" > "${tmp}/seed/seed.txt"
  g -C "${tmp}/seed" add -A
  g -C "${tmp}/seed" commit -q -m "seed"
  git -C "${tmp}/seed" push -q "${tmp}/mirror.git" main
}

# primary_commit <file> <content>: commit one more file on the primary's main.
primary_commit() {
  mkdir -p "$(dirname "${tmp}/primary/$1")"
  printf '%b' "$2" > "${tmp}/primary/$1"
  g -C "${tmp}/primary" add -A
  g -C "${tmp}/primary" commit -q -m "add $1"
}

mirror_head() { git -C "${tmp}/mirror.git" rev-parse main; }
mirror_develop() { git -C "${tmp}/mirror.git" rev-parse --verify --quiet develop || true; }
calls() { cat "${tmp}/gh-state/calls.log" 2>/dev/null || true; }
fake_prs() { cat "${tmp}/gh-state/prs.json" 2>/dev/null || echo '[]'; }

# The fake gh: `auth token -u OlegShevtsov1` and `api -X <M> repos/OlegShevtsov1/<repo>/<path> -f k=v...` for the
# four PR endpoints; every invocation is logged to calls.log. Any other auth subcommand (switch) exits 99; an api
# call without the mirror token or outside the mirror exits 98. FAKE_GH_CHECKS: success | failure | pending.
# FAKE_GH_MERGE=squash makes the merge a squash commit instead of a merge commit.
mkdir -p "${tmp}/fakegh"
cat > "${tmp}/fakegh/gh" <<'PY'
#!/usr/bin/env python3
import json, os, subprocess, sys, tempfile
state, mirror = os.environ["FAKE_GH_STATE"], os.environ["FAKE_GH_MIRROR"]
args = sys.argv[1:]
call = {"argv": args, "token": os.environ.get("GH_TOKEN", "")}
if args[0] == "api":
    call.update(method=args[2], path=args[3],
                fields=dict(a.split("=", 1) for a in args[5::2]) if args[4:5] == ["-f"] else {})
with open(os.path.join(state, "calls.log"), "a") as f:
    f.write(json.dumps(call) + "\n")
if args[0] == "auth":
    if args[1:] == ["token", "-u", "OlegShevtsov1"]:
        print("fake-mirror-token")
        sys.exit(0)
    sys.exit(99)
assert args[0] == "api" and args[1] == "-X"
method, path, fields = call["method"], call["path"], call["fields"]
if call["token"] != "fake-mirror-token" or not path.startswith("repos/OlegShevtsov1/"):
    sys.exit(98)
repo, rest = path.split("/")[2], path.split("/", 3)[3]
prs_file = os.path.join(state, "prs.json")
prs = json.load(open(prs_file)) if os.path.exists(prs_file) else []
def git(*a, cwd=None):
    return subprocess.run(["git", *a], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()
def save():
    json.dump(prs, open(prs_file, "w"))
if method == "GET" and rest == "pulls":
    print(json.dumps([p for p in prs if p["state"] == "open" and p["base"] == fields["base"]
                      and fields["head"].split(":")[-1] == p["head"]]))
elif method == "POST" and rest == "pulls":
    n = len(prs) + 1
    pr = {"number": n, "title": fields["title"], "body": fields["body"], "head": fields["head"],
          "base": fields["base"], "state": "open", "html_url": f"https://github.com/OlegShevtsov1/{repo}/pull/{n}"}
    prs.append(pr)
    save()
    print(json.dumps(pr))
elif method == "PATCH" and rest.startswith("pulls/"):
    pr = prs[int(rest.split("/")[1]) - 1]
    pr.update(title=fields["title"], body=fields["body"])
    save()
    print(json.dumps(pr))
elif method == "GET" and rest.endswith("/check-runs"):
    conclusion = os.environ.get("FAKE_GH_CHECKS", "success")
    second = {"pending": {"status": "in_progress", "conclusion": None}}.get(
        conclusion, {"status": "completed", "conclusion": conclusion})
    runs = [{"name": "CI", "status": "completed", "conclusion": "success"}, {"name": "PR conventions", **second}]
    print(json.dumps({"total_count": len(runs), "check_runs": runs}))
elif method == "PUT" and rest.endswith("/merge"):
    pr = prs[int(rest.split("/")[1]) - 1]
    if pr["state"] != "open" or fields.get("merge_method") != "merge" or fields.get("sha") != git("-C", mirror, "rev-parse", "develop"):
        sys.exit(1)
    work = tempfile.mkdtemp()
    git("clone", "-q", mirror, work)
    env = dict(os.environ, GIT_AUTHOR_NAME="Oleg Shevtsov", GIT_AUTHOR_EMAIL="olegshevtsov1@gmail.com",
               GIT_COMMITTER_NAME="GitHub", GIT_COMMITTER_EMAIL="noreply@github.com")
    message = f"Merge pull request #{pr['number']} from OlegShevtsov1/develop"
    if os.environ.get("FAKE_GH_MERGE") == "squash":
        subprocess.run(["git", "merge", "-q", "--squash", "origin/develop"], cwd=work, env=env, check=True)
        subprocess.run(["git", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], cwd=work, env=env, check=True)
    else:
        subprocess.run(["git", "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "origin/develop", "-m", message],
                       cwd=work, env=env, check=True)
    git("push", "-q", "origin", "main", cwd=work)
    pr["state"] = "closed"
    save()
    print(json.dumps({"sha": git("-C", work, "rev-parse", "HEAD"), "merged": True}))
else:
    sys.exit(97)
PY
chmod +x "${tmp}/fakegh/gh"

checkout_mirror() {
  rm -rf "${tmp}/check"
  git clone -q "${tmp}/mirror.git" "${tmp}/check"
}

# publish <args...>: runs the script, sets rc, out (stdout) and err (stderr).
publish() {
  rc=0
  PATH="${tmp}/fakegh:${PATH}" FAKE_GH_STATE="${tmp}/gh-state" FAKE_GH_MIRROR="${tmp}/mirror.git" \
    MIRROR_CHECKS_INTERVAL=0 MIRROR_CHECKS_TIMEOUT=0 \
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
  [ -z "$(mirror_develop)" ] || fail "${name}" "develop was pushed"
  [ -z "$(calls)" ] || fail "${name}" "gh was called: $(calls)"
}

# --- owner replacement, author, develop created from the mirror main, merged into main by a merge commit
new_fixture
seed=$(mirror_head)
src_sha=$(git -C "${tmp}/primary" rev-parse main)
publish 1_mvp_pilot_be --subject "first sync"
[ "${rc}" -eq 0 ] || fail "sync" "exit ${rc}: ${err}"
[[ "${out}" =~ ^[0-9a-f]{40}$ ]] || fail "sync" "stdout is not one sha: ${out}"
[ "${out}" = "$(mirror_head)" ] || fail "sync" "printed sha is not mirror main"
[ "$(git -C "${tmp}/mirror.git" rev-list --count "${seed}..main")" -eq 2 ] || fail "sync" "not one sync commit and one merge"
[ -n "$(mirror_develop)" ] || fail "sync" "develop not created"
[ "$(git -C "${tmp}/mirror.git" rev-parse develop^)" = "${seed}" ] || fail "sync" "develop is not created from main"
[ "$(git -C "${tmp}/mirror.git" rev-parse main^1)" = "${seed}" ] || fail "sync" "first parent is not the seed"
[ "$(git -C "${tmp}/mirror.git" rev-parse main^2)" = "$(mirror_develop)" ] || fail "sync" "second parent is not develop"
want="${author}|${author}|Sync from main (${src_sha:0:7}): first sync"
got=$(git -C "${tmp}/mirror.git" log -1 --format='%an <%ae>|%cn <%ce>|%s' develop)
[ "${got}" = "${want}" ] || fail "sync" "commit is '${got}', want '${want}'"
checkout_mirror
grep -qF "by OlegShevtsov1" "${tmp}/check/README.md" || fail "sync" "lowercase login not replaced"
grep -qF "github.com/OlegShevtsov1/x" "${tmp}/check/README.md" || fail "sync" "capitalised login not replaced"
grep -qxF "Oleg Shevtsov" "${tmp}/check/README.md" || fail "sync" "full name not replaced"
if git -C "${tmp}/check" grep -qil "${src_login}"; then fail "sync" "primary login left in the mirror"; fi
[ ! -e "${tmp}/check/.github/dependabot.yml" ] || fail "sync" "dependabot.yml was synced"
[ -f "${tmp}/check/.github/workflows/ci.yml" ] || fail "sync" "workflow missing"
[ -x "${tmp}/check/bin/run" ] || fail "sync" "bin/run lost its executable bit"
[ ! -e "${tmp}/check/dev.txt" ] || fail "sync" "default ref is not origin/main"
[ ! -e "${tmp}/check/seed.txt" ] || fail "sync" "old mirror tree was kept"
echo "PASS owner replacement, author, develop created from main and merged"

# --- the PR: title, body, merge method, the mirror token on every call
calls | python3 -c '
import json, sys
short = sys.argv[1]
calls = [json.loads(l) for l in sys.stdin]
api = [c for c in calls if c["argv"][0] == "api"]
assert all(c["token"] == "fake-mirror-token" for c in api), api
assert [c["argv"] for c in calls if c["argv"][0] == "auth"] == [["auth", "token", "-u", "OlegShevtsov1"]], calls
posts = [c for c in api if c["method"] == "POST"]
assert len(posts) == 1 and posts[0]["path"] == "repos/OlegShevtsov1/1_mvp_pilot_be/pulls", posts
f = posts[0]["fields"]
assert (f["head"], f["base"]) == ("develop", "main"), f
assert f["title"] == f"PILOT-0: Sync main ({short})", f
assert [l for l in f["body"].splitlines() if l.startswith("Type:")] == ["Type: chore"], f
puts = [c for c in api if c["method"] == "PUT"]
assert len(puts) == 1 and puts[0]["path"].endswith("/pulls/1/merge"), puts
assert puts[0]["fields"]["merge_method"] == "merge", puts
' "${src_sha:0:7}" || fail "PR" "calls are wrong: $(calls)"
echo "PASS PR opened with the right title and body, merged with a merge commit"

# --- MIRROR_SOURCE.json
python3 - "${tmp}/check/MIRROR_SOURCE.json" "${src_sha}" "${seed}" <<'PY' || fail "MIRROR_SOURCE.json" "content is wrong"
import json, re, sys
path, src_sha, seed = sys.argv[1:]
d = json.load(open(path))
assert list(d) == ["repo", "source_ref", "source_sha", "mirror_sha", "synced_at", "tags"], list(d)
assert d["repo"] == "1_mvp_pilot_be", d
assert d["source_ref"] == "origin/main", d
assert d["source_sha"] == src_sha, d
assert d["mirror_sha"] == seed, d
assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", d["synced_at"]), d
assert d["tags"] == [], d
PY
echo "PASS MIRROR_SOURCE.json content"

# --- re-run is a no-op
head=$(mirror_head)
develop=$(mirror_develop)
before=$(calls)
publish 1_mvp_pilot_be
[ "${rc}" -eq 0 ] || fail "re-run" "exit ${rc}: ${err}"
grep -qF "nothing to sync" <<<"${out}" || fail "re-run" "stdout: ${out}"
[ "$(mirror_head)" = "${head}" ] || fail "re-run" "mirror main moved"
[ "$(mirror_develop)" = "${develop}" ] || fail "re-run" "mirror develop moved"
[ "$(calls)" = "${before}" ] || fail "re-run" "gh was called"
echo "PASS re-run is a no-op"

# --- mirror main with changes not on develop is refused
git clone -q "${tmp}/mirror.git" "${tmp}/direct"
echo "direct" > "${tmp}/direct/direct.txt"
g -C "${tmp}/direct" add -A
g -C "${tmp}/direct" commit -q -m "direct commit"
git -C "${tmp}/direct" push -q origin main
rm -rf "${tmp}/direct"
primary_commit more.txt "more\n"
develop=$(mirror_develop)
before=$(calls)
publish 1_mvp_pilot_be
[ "${rc}" -eq 1 ] || fail "diverged main" "exit ${rc}, want 1: ${err}"
grep -qF "mirror main has changes that are not on develop" <<<"${err}" || fail "diverged main" "stderr: ${err}"
[ "$(mirror_develop)" = "${develop}" ] || fail "diverged main" "develop moved"
[ "$(calls)" = "${before}" ] || fail "diverged main" "gh was called"
echo "PASS mirror main with changes not on develop is refused"

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
if git -C "${tmp}/mirror.git" rev-parse -q --verify refs/tags/v0.0.1 >/dev/null; then
  fail "tree replaced" "a tag was created for an entry without primary_sha and mirror_sha"
fi
echo "PASS tree is replaced and tags are kept"

# --- merge only on green; a re-run resumes the open PR
new_fixture
seed=$(mirror_head)
FAKE_GH_CHECKS=failure publish 1_mvp_pilot_be
[ "${rc}" -eq 3 ] || fail "red checks" "exit ${rc}, want 3: ${err}"
[ "${out}" = "https://github.com/OlegShevtsov1/1_mvp_pilot_be/pull/1" ] || fail "red checks" "stdout: ${out}"
grep -qF "PR conventions" <<<"${err}" || fail "red checks" "stderr does not name the failed check: ${err}"
[ "$(mirror_head)" = "${seed}" ] || fail "red checks" "mirror main moved"
[ "$(git -C "${tmp}/mirror.git" rev-parse develop^)" = "${seed}" ] || fail "red checks" "develop has no sync commit"
if calls | grep -qF '"PUT"'; then fail "red checks" "merge was called"; fi
fake_prs | python3 -c 'import json, sys; assert [p["state"] for p in json.load(sys.stdin)] == ["open"]' ||
  fail "red checks" "PR is not left open"
publish 1_mvp_pilot_be
[ "${rc}" -eq 0 ] || fail "resume" "exit ${rc}: ${err}"
src_sha=$(git -C "${tmp}/primary" rev-parse main)
calls | python3 -c '
import json, sys
short = sys.argv[1]
api = [c for c in map(json.loads, sys.stdin) if c["argv"][0] == "api"]
assert [c["method"] for c in api if c["method"] in ("POST", "PATCH", "PUT")] == ["POST", "PATCH", "PUT"], api
patch = [c for c in api if c["method"] == "PATCH"][0]
assert patch["path"].endswith("/pulls/1"), api
assert patch["fields"]["title"] == f"PILOT-0: Sync main ({short})", patch
assert [c for c in api if c["method"] == "PUT"][0]["path"].endswith("/pulls/1/merge"), api
' "${src_sha:0:7}" || fail "resume" "calls are wrong: $(calls)"
[ "$(git -C "${tmp}/mirror.git" rev-parse main^2)" = "$(mirror_develop)" ] || fail "resume" "main is not the merge of develop"
echo "PASS merge only on green; a re-run resumes the open PR"

# --- pending checks time out
new_fixture
seed=$(mirror_head)
FAKE_GH_CHECKS=pending publish 1_mvp_pilot_be
[ "${rc}" -eq 3 ] || fail "timeout" "exit ${rc}, want 3: ${err}"
[ "${out}" = "https://github.com/OlegShevtsov1/1_mvp_pilot_be/pull/1" ] || fail "timeout" "stdout: ${out}"
grep -qF "timed out" <<<"${err}" || fail "timeout" "stderr: ${err}"
[ "$(mirror_head)" = "${seed}" ] || fail "timeout" "mirror main moved"
if calls | grep -qF '"PUT"'; then fail "timeout" "merge was called"; fi
echo "PASS pending checks time out without a merge"

# release_tag_fixture: an annotated v0.2.0 on the primary main whose message has the primary login, on the
# release-prep commit of card PILOT-165, and as negatives a lightweight v0.3.0 on main and an annotated v9.9.9 on
# develop, which main does not contain.
release_tag_fixture() {
  new_fixture
  g -C "${tmp}/primary" commit -q --allow-empty -m "PILOT-165: Release 0.2.0 changelog (#52)"
  g -C "${tmp}/primary" tag -a v0.2.0 -m "Release v0.2.0 by ${src_login}"
  g -C "${tmp}/primary" tag v0.3.0
  g -C "${tmp}/primary" tag -a v9.9.9 -m "not released" develop
}

# --- release tag carried with the right mapping
release_tag_fixture
seed=$(mirror_head)
tag_commit=$(git -C "${tmp}/primary" rev-parse 'v0.2.0^{commit}')
publish 1_mvp_pilot_be
[ "${rc}" -eq 0 ] || fail "release tag" "exit ${rc}: ${err}"
m="${tmp}/mirror.git"
calls | python3 -c '
import json, sys
post = [c for c in map(json.loads, sys.stdin) if c["argv"][0] == "api" and c["method"] == "POST"][0]["fields"]
assert post["title"] == "PILOT-165: Release v0.2.0", post
lines = post["body"].splitlines()
assert "Tags: v0.2.0" in lines and [l for l in lines if l.startswith("Type:")] == ["Type: chore"], post
' || fail "release tag" "PR is wrong: $(calls)"
[ "$(git -C "${m}" cat-file -t v0.2.0)" = tag ] || fail "release tag" "v0.2.0 is not annotated"
[ "$(git -C "${m}" for-each-ref --format='%(taggername) %(taggeremail)' refs/tags/v0.2.0)" = "${author}" ] ||
  fail "release tag" "tagger is not the mirror author"
[ "$(git -C "${m}" for-each-ref --format='%(contents:subject)' refs/tags/v0.2.0)" = "Release v0.2.0 by OlegShevtsov1" ] ||
  fail "release tag" "message is not replaced"
[ "$(git -C "${m}" rev-parse 'v0.2.0^{commit}')" = "$(mirror_head)" ] || fail "release tag" "tag is not on the merge commit"
[ "$(git -C "${m}" rev-parse 'v0.2.0^{commit}^1')" = "${seed}" ] || fail "release tag" "tag commit's first parent is not the seed"
[ "$(git -C "${m}" rev-parse 'v0.2.0^{commit}^2')" = "$(mirror_develop)" ] || fail "release tag" "tag commit's second parent is not develop"
for t in v0.3.0 v9.9.9; do
  if git -C "${m}" rev-parse -q --verify "refs/tags/${t}" >/dev/null; then fail "release tag" "${t} was carried"; fi
done
checkout_mirror
python3 - "${tmp}/check/MIRROR_SOURCE.json" "${tag_commit}" "${seed}" <<'PY' || fail "release tag" "tags entry is wrong"
import json, re, sys
path, tag_commit, seed = sys.argv[1:]
tags = json.load(open(path))["tags"]
assert len(tags) == 1 and list(tags[0]) == ["tag", "primary_sha", "mirror_sha", "synced_at"], tags
assert tags[0]["tag"] == "v0.2.0" and tags[0]["primary_sha"] == tag_commit and tags[0]["mirror_sha"] == seed, tags
assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", tags[0]["synced_at"]), tags
PY
# The rules the mirror prod deploy applies, with the jq filters copied verbatim from the mirrors: exactly one tags
# entry for the version whose primary_sha is the given source sha, and the annotated tag's commit on the mirror main.
# be deploy/_common.sh resolve_mirror_release (then resolve_release_tag):
# shellcheck disable=SC2016 # jq variables, not shell
be_filter='[.tags[]? | select(.tag == $tag) | .primary_sha] | if length == 1 then .[0] else error end'
# fe deploy/lib.sh mirror_source_tags, read by deploy/mirror_source_check.sh (then tag_check.sh, main_commit_check.sh):
fe_filter='.tags | if type == "array" then .[] | [.tag, .primary_sha] | @tsv else error end'
[ "$(jq -er --arg tag v0.2.0 "${be_filter}" "${tmp}/check/MIRROR_SOURCE.json")" = "${tag_commit}" ] ||
  fail "deploy-check parity" "be: tag entry does not map v0.2.0 to the primary tag commit"
[ "$(jq -r "${fe_filter}" "${tmp}/check/MIRROR_SOURCE.json" | awk -F '\t' '$1 == "v0.2.0" { print $2 }')" = "${tag_commit}" ] ||
  fail "deploy-check parity" "fe: not exactly one tag entry mapping v0.2.0 to the primary tag commit"
[ "$(git -C "${tmp}/check" cat-file -t v0.2.0)" = tag ] || fail "deploy-check parity" "tag is not annotated"
git -C "${tmp}/check" merge-base --is-ancestor 'v0.2.0^{commit}' main || fail "deploy-check parity" "tag is not on main"
echo "PASS release tag carried with the right mapping"

head=$(mirror_head)
tag_obj=$(git -C "${m}" rev-parse v0.2.0)
before=$(calls)
publish 1_mvp_pilot_be
[ "${rc}" -eq 0 ] || fail "tag re-run" "exit ${rc}: ${err}"
grep -qF "nothing to sync" <<<"${out}" || fail "tag re-run" "stdout: ${out}"
[ "$(mirror_head)" = "${head}" ] || fail "tag re-run" "mirror main moved"
[ "$(git -C "${m}" rev-parse v0.2.0)" = "${tag_obj}" ] || fail "tag re-run" "tag changed"
[ "$(calls)" = "${before}" ] || fail "tag re-run" "gh was called"
echo "PASS re-run with a carried tag is a no-op"

git -C "${m}" tag -d v0.2.0 >/dev/null
publish 1_mvp_pilot_be --dry-run
[ "${rc}" -eq 0 ] || fail "dry run heal" "exit ${rc}: ${err}"
grep -qF "dry run: tag v0.2.0 on ${head}" <<<"${err}" || fail "dry run heal" "tag not printed: ${err}"
if git -C "${m}" rev-parse -q --verify refs/tags/v0.2.0 >/dev/null; then fail "dry run heal" "tag was recreated"; fi
[ "$(calls)" = "${before}" ] || fail "dry run heal" "gh was called"
echo "PASS dry run does not recreate a deleted mirror tag"

publish 1_mvp_pilot_be
[ "${rc}" -eq 0 ] || fail "tag heal" "exit ${rc}: ${err}"
grep -qF "nothing to sync" <<<"${out}" || fail "tag heal" "stdout: ${out}"
[ "$(git -C "${m}" rev-parse 'v0.2.0^{commit}')" = "${head}" ] || fail "tag heal" "tag not recreated on the merge commit"
[ "$(git -C "${m}" cat-file -t v0.2.0)" = tag ] || fail "tag heal" "recreated tag is not annotated"
[ "$(calls)" = "${before}" ] || fail "tag heal" "gh was called"
echo "PASS a deleted mirror tag is recreated"

# --- a merge that is not the merge commit of the sync creates no tag
release_tag_fixture
FAKE_GH_MERGE=squash publish 1_mvp_pilot_be
[ "${rc}" -eq 1 ] || fail "squashed merge" "exit ${rc}, want 1: ${err}"
grep -qF "is not the merge of" <<<"${err}" || fail "squashed merge" "stderr: ${err}"
if git -C "${tmp}/mirror.git" rev-parse -q --verify refs/tags/v0.2.0 >/dev/null; then fail "squashed merge" "tag was created"; fi
echo "PASS a merge that does not verify creates no tag"

# --- a tag already on the mirror is skipped
release_tag_fixture
seed=$(mirror_head)
g -C "${tmp}/seed" tag -a v0.2.0 -m "made by hand"
git -C "${tmp}/seed" push -q "${tmp}/mirror.git" v0.2.0
publish 1_mvp_pilot_be
[ "${rc}" -eq 0 ] || fail "tag present" "exit ${rc}: ${err}"
[ "$(git -C "${tmp}/mirror.git" rev-parse 'v0.2.0^{commit}')" = "${seed}" ] || fail "tag present" "mirror tag moved"
grep -qF "tag v0.2.0 already exists on the mirror" <<<"${err}" || fail "tag present" "stderr: ${err}"
checkout_mirror
python3 -c 'import json, sys; assert json.load(open(sys.argv[1]))["tags"] == []' "${tmp}/check/MIRROR_SOURCE.json" ||
  fail "tag present" "an entry was written"
echo "PASS a tag already on the mirror is skipped"

# release_history_fixture: annotated v0.1.0 and v0.1.1 on older main content, the hotfix back-merged into develop,
# annotated v0.2.0 on the develop commit D that main then merges (the release merge M, same tree as D). The message of
# v0.1.0 names the primary owner: a tag that is not carried must not refuse the sync.
release_history_fixture() {
  new_fixture
  local p="${tmp}/primary"
  g -C "${p}" tag -a v0.1.0 -m "Release v0.1.0 by ${src_login^^}"
  echo "fix" > "${p}/fix.txt"
  g -C "${p}" add -A
  g -C "${p}" commit -q -m "hotfix"
  g -C "${p}" tag -a v0.1.1 -m "Release v0.1.1"
  g -C "${p}" checkout -q develop
  g -C "${p}" merge -q --no-ff --no-edit main
  echo "release" > "${p}/release.txt"
  g -C "${p}" add -A
  g -C "${p}" commit -q -m "PILOT-165: Release 0.2.0 changelog"
  g -C "${p}" tag -a v0.2.0 -m "Release v0.2.0"
  g -C "${p}" checkout -q main
  g -C "${p}" merge -q --no-ff --no-edit develop
}

# --- only the release tag whose content is synced is carried (dry run)
release_history_fixture
publish 1_mvp_pilot_be --dry-run
[ "${rc}" -eq 0 ] || fail "dry run history" "exit ${rc}: ${err}"
grep -qxF "Tags: v0.2.0" <<<"${err}" || fail "dry run history" "Tags line is wrong: ${err}"
grep -qF "dry run: tag v0.2.0 on the merge commit" <<<"${err}" || fail "dry run history" "v0.2.0 not printed: ${err}"
if grep -qF "dry run: tag v0.1." <<<"${err}"; then fail "dry run history" "an old tag is carried: ${err}"; fi
for t in v0.1.0 v0.1.1; do
  grep -qF "tag ${t} not carried: its content is not the synced content" <<<"${err}" ||
    fail "dry run history" "${t} skip not logged: ${err}"
done
[ -z "$(git -C "${tmp}/mirror.git" tag)" ] || fail "dry run history" "a mirror tag was created"
[ -z "$(calls)" ] || fail "dry run history" "gh was called: $(calls)"
rm -rf "$(dirname "$(sed -n 's/^dry run: not pushed; inspect //p' <<<"${err}")")"
echo "PASS dry run carries only the release tag whose content is synced"

# --- only the release tag whose content is synced is carried
seed=$(mirror_head)
release_commit=$(git -C "${tmp}/primary" rev-parse 'v0.2.0^{commit}')
publish 1_mvp_pilot_be
[ "${rc}" -eq 0 ] || fail "release history" "exit ${rc}: ${err}"
calls | python3 -c '
import json, sys
post = [c for c in map(json.loads, sys.stdin) if c["argv"][0] == "api" and c["method"] == "POST"][0]["fields"]
assert post["title"] == "PILOT-165: Release v0.2.0", post
assert [l for l in post["body"].splitlines() if l.startswith("Tags:")] == ["Tags: v0.2.0"], post
' || fail "release history" "PR is wrong: $(calls)"
m="${tmp}/mirror.git"
[ "$(git -C "${m}" cat-file -t v0.2.0)" = tag ] || fail "release history" "v0.2.0 is not annotated"
[ "$(git -C "${m}" rev-parse 'v0.2.0^{commit}')" = "$(mirror_head)" ] || fail "release history" "v0.2.0 is not on the merge commit"
for t in v0.1.0 v0.1.1; do
  if git -C "${m}" rev-parse -q --verify "refs/tags/${t}" >/dev/null; then fail "release history" "${t} was carried"; fi
  grep -qF "tag ${t} not carried: its content is not the synced content" <<<"${err}" ||
    fail "release history" "${t} skip not logged: ${err}"
done
checkout_mirror
python3 - "${tmp}/check/MIRROR_SOURCE.json" "${release_commit}" "${seed}" <<'PY' || fail "release history" "tags entry is wrong"
import json, sys
path, release_commit, seed = sys.argv[1:]
tags = json.load(open(path))["tags"]
assert len(tags) == 1, tags
assert tags[0]["tag"] == "v0.2.0" and tags[0]["primary_sha"] == release_commit and tags[0]["mirror_sha"] == seed, tags
PY
echo "PASS only the release tag whose content is synced is carried"

# --- a hotfix tag on the squash commit of main is carried
p="${tmp}/primary"
g -C "${p}" checkout -q -b hotfix
echo "hotfix" > "${p}/hotfix.txt"
g -C "${p}" add -A
g -C "${p}" commit -q -m "hotfix work"
g -C "${p}" checkout -q main
g -C "${p}" merge -q --squash hotfix
g -C "${p}" commit -q -m "hotfix (squash)"
g -C "${p}" tag -a v0.2.1 -m "Release v0.2.1"
squash_commit=$(git -C "${p}" rev-parse HEAD)
head=$(mirror_head)
develop=$(mirror_develop)
tag_obj=$(git -C "${m}" rev-parse v0.2.0)
before=$(calls)
publish 1_mvp_pilot_be
[ "${rc}" -eq 1 ] || fail "hotfix tag, no card" "exit ${rc}, want 1: ${err}"
grep -qF "no card number for release v0.2.1" <<<"${err}" || fail "hotfix tag, no card" "stderr: ${err}"
grep -qF -- "--card PILOT-<n>" <<<"${err}" || fail "hotfix tag, no card" "stderr does not name --card: ${err}"
[ "$(mirror_head)" = "${head}" ] || fail "hotfix tag, no card" "mirror main moved"
[ "$(mirror_develop)" = "${develop}" ] || fail "hotfix tag, no card" "develop was pushed"
[ "$(calls)" = "${before}" ] || fail "hotfix tag, no card" "gh was called"
echo "PASS a release tag without a findable card is refused before the push"

FAKE_GH_CHECKS=pending publish 1_mvp_pilot_be --card PILOT-121
[ "${rc}" -eq 3 ] || fail "hotfix tag, pending" "exit ${rc}, want 3: ${err}"
develop=$(mirror_develop)
before=$(calls)
publish 1_mvp_pilot_be
[ "${rc}" -eq 1 ] || fail "resume, no card" "exit ${rc}, want 1: ${err}"
grep -qF "resuming its PR" <<<"${err}" || fail "resume, no card" "the resume path did not run: ${err}"
grep -qF -- "--card PILOT-<n>" <<<"${err}" || fail "resume, no card" "stderr does not name --card: ${err}"
[ "$(mirror_head)" = "${head}" ] || fail "resume, no card" "mirror main moved"
[ "$(mirror_develop)" = "${develop}" ] || fail "resume, no card" "develop moved"
[ "$(calls)" = "${before}" ] || fail "resume, no card" "gh was called"
echo "PASS a resumed release sync without a findable card is refused before any gh call"

publish 1_mvp_pilot_be --card PILOT-121
[ "${rc}" -eq 0 ] || fail "hotfix tag" "exit ${rc}: ${err}"
grep -qF "resuming its PR" <<<"${err}" || fail "hotfix tag" "the open PR was not resumed: ${err}"
calls | python3 -c '
import json, sys
posts = [c for c in map(json.loads, sys.stdin) if c["argv"][0] == "api" and c["method"] == "POST"]
assert posts[-1]["fields"]["title"] == "PILOT-121: Release v0.2.1", posts[-1]
' || fail "hotfix tag" "PR title is wrong: $(calls)"
if grep -qF "tag v0.2.0 not carried" <<<"${err}"; then fail "hotfix tag" "a recorded tag is logged as not carried: ${err}"; fi
[ "$(git -C "${m}" cat-file -t v0.2.1)" = tag ] || fail "hotfix tag" "v0.2.1 is not annotated"
[ "$(git -C "${m}" rev-parse 'v0.2.1^{commit}')" = "$(mirror_head)" ] || fail "hotfix tag" "v0.2.1 is not on the merge commit"
[ "$(git -C "${m}" rev-parse 'v0.2.1^{commit}^1')" = "${head}" ] || fail "hotfix tag" "merge's first parent is not the previous main"
[ "$(git -C "${m}" rev-parse v0.2.0)" = "${tag_obj}" ] || fail "hotfix tag" "v0.2.0 changed"
for t in v0.1.0 v0.1.1; do
  if git -C "${m}" rev-parse -q --verify "refs/tags/${t}" >/dev/null; then fail "hotfix tag" "${t} was carried"; fi
done
checkout_mirror
python3 - "${tmp}/check/MIRROR_SOURCE.json" "${squash_commit}" "${head}" <<'PY' || fail "hotfix tag" "tags entry is wrong"
import json, sys
path, squash_commit, head = sys.argv[1:]
tags = json.load(open(path))["tags"]
assert [t["tag"] for t in tags] == ["v0.2.0", "v0.2.1"], tags
assert tags[1]["primary_sha"] == squash_commit and tags[1]["mirror_sha"] == head, tags
PY
echo "PASS a hotfix tag on the squash commit of main is carried"

# --- re-run after the release history is a no-op
head=$(mirror_head)
before=$(calls)
publish 1_mvp_pilot_be
[ "${rc}" -eq 0 ] || fail "history re-run" "exit ${rc}: ${err}"
grep -qF "nothing to sync" <<<"${out}" || fail "history re-run" "stdout: ${out}"
[ "$(mirror_head)" = "${head}" ] || fail "history re-run" "mirror main moved"
[ "$(calls)" = "${before}" ] || fail "history re-run" "gh was called"
for t in v0.1.0 v0.1.1; do
  if git -C "${m}" rev-parse -q --verify "refs/tags/${t}" >/dev/null; then fail "history re-run" "${t} was carried"; fi
done
echo "PASS re-run after the release history is a no-op"

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

new_fixture
g -C "${tmp}/primary" tag -a v0.2.0 -m "Release by ${src_login^^}"
expect_refusal "leftover in a tag message"
grep -qF "tag v0.2.0" <<<"${err}" || fail "leftover in a tag message" "output does not name the tag: ${err}"
echo "PASS refusal on a leftover in a tag message"

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

# --- an ancestry check that errors is refused, not read as "not an ancestor"
# shellcheck disable=SC2016 # the stub body expands when the stub runs
ancestry_error='[[ " $* " != *" merge-base --is-ancestor "* ]] || exit 128
exec "${real_git}" "$@"'
release_tag_fixture
stub_on_path git "${ancestry_error}"
PATH="${tmp}/stub:${PATH}" publish 1_mvp_pilot_be
rm -rf "${tmp}/stub"
[ "${rc}" -eq 1 ] || fail "ancestry error, tags" "exit ${rc}, want 1: ${err}"
grep -qF "cannot tell whether" <<<"${err}" || fail "ancestry error, tags" "stderr: ${err}"
[ -z "$(mirror_develop)" ] || fail "ancestry error, tags" "develop was pushed"
[ -z "$(calls)" ] || fail "ancestry error, tags" "gh was called: $(calls)"
echo "PASS an ancestry error while finding release tags is refused"

new_fixture
publish 1_mvp_pilot_be
[ "${rc}" -eq 0 ] || fail "ancestry error, develop" "first sync: exit ${rc}: ${err}"
head=$(mirror_head)
before=$(calls)
stub_on_path git "${ancestry_error}"
PATH="${tmp}/stub:${PATH}" publish 1_mvp_pilot_be
rm -rf "${tmp}/stub"
[ "${rc}" -eq 1 ] || fail "ancestry error, develop" "exit ${rc}, want 1: ${err}"
grep -qF "cannot tell whether origin/develop is an ancestor of origin/main" <<<"${err}" ||
  fail "ancestry error, develop" "stderr: ${err}"
[ "$(mirror_head)" = "${head}" ] || fail "ancestry error, develop" "mirror main moved"
[ "$(calls)" = "${before}" ] || fail "ancestry error, develop" "gh was called"
echo "PASS an ancestry error while checking for a pending develop is refused"

# --- the push is never forced: a mirror develop that moved after the clone is kept
new_fixture
seed=$(mirror_head)
git clone -q "${tmp}/mirror.git" "${tmp}/racer"
echo "concurrent" > "${tmp}/racer/concurrent.txt"
g -C "${tmp}/racer" add -A
g -C "${tmp}/racer" commit -q -m "concurrent writer"
racer_sha=$(git -C "${tmp}/racer" rev-parse HEAD)
# shellcheck disable=SC2016 # the stub body expands when the stub runs
stub_on_path git 'if [[ " $* " == *" push "* ]]; then "${real_git}" -C '"${tmp@Q}"'/racer push -q origin HEAD:develop; fi
exec "${real_git}" "$@"'
PATH="${tmp}/stub:${PATH}" publish 1_mvp_pilot_be
rm -rf "${tmp}/stub" "${tmp}/racer"
[ "${rc}" -eq 1 ] || fail "moved develop" "exit ${rc}, want 1: ${err}"
grep -qF "push to the mirror 1_mvp_pilot_be failed" <<<"${err}" || fail "moved develop" "output does not name the push: ${err}"
[ "$(mirror_develop)" = "${racer_sha}" ] || fail "moved develop" "the concurrent commit was overwritten"
[ "$(mirror_head)" = "${seed}" ] || fail "moved develop" "mirror main moved"
[ -z "$(calls)" ] || fail "moved develop" "gh was called: $(calls)"
echo "PASS a moved mirror develop is not overwritten"

# --- dry run
new_fixture
seed=$(mirror_head)
publish 1_mvp_pilot_be --dry-run
[ "${rc}" -eq 0 ] || fail "dry run" "exit ${rc}: ${err}"
[[ "${out}" =~ ^[0-9a-f]{40}$ ]] || fail "dry run" "stdout is not one sha: ${out}"
[ "$(mirror_head)" = "${seed}" ] || fail "dry run" "mirror main moved"
[ -z "$(mirror_develop)" ] || fail "dry run" "develop was pushed"
[ -z "$(calls)" ] || fail "dry run" "gh was called: $(calls)"
grep -qF "dry run: git push origin ${out}:refs/heads/develop" <<<"${err}" || fail "dry run" "develop push not printed: ${err}"
grep -qE "^dry run: gh api -X POST repos/OlegShevtsov1/1_mvp_pilot_be/pulls .*title=PILOT-0: Sync main" <<<"${err}" ||
  fail "dry run" "PR call not printed: ${err}"
grep -qE "^dry run: gh api -X PUT .*merge_method=merge" <<<"${err}" || fail "dry run" "merge call not printed: ${err}"
kept=$(sed -n 's/^dry run: not pushed; inspect //p' <<<"${err}")
[ -d "${kept}" ] || fail "dry run" "kept directory not named: ${err}"
[ "$(git -C "${kept}" rev-parse HEAD)" = "${out}" ] || fail "dry run" "kept clone HEAD is not the printed sha"
rm -rf "$(dirname "${kept}")"
publish 1_mvp_pilot_be --dry-run --card PILOT-5
[ "${rc}" -eq 0 ] || fail "dry run, card without tag" "exit ${rc}: ${err}"
grep -qF -- "--card ignored: the sync carries no release tag" <<<"${err}" ||
  fail "dry run, card without tag" "ignored --card not logged: ${err}"
grep -qE "^dry run: gh api -X POST .*title=PILOT-0: Sync main" <<<"${err}" ||
  fail "dry run, card without tag" "title is not the sync title: ${err}"
rm -rf "$(dirname "$(sed -n 's/^dry run: not pushed; inspect //p' <<<"${err}")")"
echo "PASS dry run"

release_tag_fixture
publish 1_mvp_pilot_be --dry-run
[ "${rc}" -eq 0 ] || fail "dry run tag" "exit ${rc}: ${err}"
grep -qF "dry run: tag v0.2.0 on the merge commit" <<<"${err}" || fail "dry run tag" "tag not printed: ${err}"
if git -C "${tmp}/mirror.git" rev-parse -q --verify refs/tags/v0.2.0 >/dev/null; then fail "dry run tag" "tag was created"; fi
[ -z "$(calls)" ] || fail "dry run tag" "gh was called: $(calls)"
rm -rf "$(dirname "$(sed -n 's/^dry run: not pushed; inspect //p' <<<"${err}")")"
echo "PASS dry run with a release tag"

# --- release card from the release PR when the changelog commit has no card
new_fixture
p="${tmp}/primary"
g -C "${p}" checkout -q develop
g -C "${p}" commit -q --allow-empty -m "PILOT-0: Release 0.2.0 changelog (#52)"
g -C "${p}" tag -a v0.2.0 -m "Release v0.2.0"
g -C "${p}" checkout -q main
g -C "${p}" merge -q --no-ff develop -m "Merge pull request #53 from someone/develop" -m "PILOT-170: Release v0.2.0"
publish 1_mvp_pilot_be --dry-run
[ "${rc}" -eq 0 ] || fail "card from release PR" "exit ${rc}: ${err}"
grep -qxF "publish-mirror: PR title: PILOT-170: Release v0.2.0" <<<"${err}" || fail "card from release PR" "title not logged: ${err}"
grep -qE "^dry run: gh api -X POST .*title=PILOT-170: Release v0.2.0" <<<"${err}" ||
  fail "card from release PR" "PR call not printed: ${err}"
[ -z "$(calls)" ] || fail "card from release PR" "gh was called: $(calls)"
rm -rf "$(dirname "$(sed -n 's/^dry run: not pushed; inspect //p' <<<"${err}")")"
echo "PASS release card from the release PR when the changelog commit has no card"

# --- a release sync carries the tag's changelog section
new_fixture
p="${tmp}/primary"
primary_commit CHANGELOG.md "# Changelog\n\n## [Unreleased]\n\n### Added\n\n## [0.2.0] - 2026-10-21\n\n### Added\n\n- Mirror release by ${src_login}\n\n## [0.1.0] - 2026-10-16\n\n- Old entry\n"
publish 1_mvp_pilot_be
[ "${rc}" -eq 0 ] || fail "changelog, no tag" "exit ${rc}: ${err}"
last_post() {
  calls | python3 -c '
import json, sys
posts = [c for c in map(json.loads, sys.stdin) if c["argv"][0] == "api" and c["method"] == "POST"]
print(posts[-1]["fields"]["'"$1"'"], end="")'
}
want="Sync of 1_mvp_pilot_be from main at $(git -C "${p}" rev-parse --short=7 main)."$'\n\nType: chore'
[ "$(last_post body)" = "${want}" ] || fail "changelog, no tag" "a sync without a tag has a changed body: $(last_post body)"
g -C "${p}" commit -q --allow-empty -m "PILOT-165: Release 0.2.0 changelog"
g -C "${p}" tag -a v0.2.0 -m "Release v0.2.0"
publish 1_mvp_pilot_be --dry-run
[ "${rc}" -eq 0 ] || fail "changelog, dry run" "exit ${rc}: ${err}"
grep -qxF "Changelog of v0.2.0:" <<<"${err}" || fail "changelog, dry run" "version sentence not printed: ${err}"
grep -qxF "## Changelog" <<<"${err}" || fail "changelog, dry run" "changelog not printed: ${err}"
rm -rf "$(dirname "$(sed -n 's/^dry run: not pushed; inspect //p' <<<"${err}")")"
publish 1_mvp_pilot_be
[ "${rc}" -eq 0 ] || fail "changelog" "exit ${rc}: ${err}"
body=$(last_post body)
[ "$(grep -cxF "## Changelog" <<<"${body}")" -eq 1 ] || fail "changelog" "not one exact ## Changelog heading: ${body}"
! grep -qF "## Changelog (" <<<"${body}" || fail "changelog" "the heading names the version: ${body}"
grep -xF -e "Changelog of v0.2.0:" -e "## Changelog" <<<"${body}" | head -n 1 | grep -qxF "Changelog of v0.2.0:" ||
  fail "changelog" "no version sentence above the heading: ${body}"
# The pilots' pr-conventions condition 4 compares this block with release-notes.sh output.
block=$(awk '$0 == "## Changelog" { found = 1; next } found && /^Type:/ { exit } found' <<<"${body}")
[ "${block}" = $'\n### Added\n\n- Mirror release by OlegShevtsov1' ] || fail "changelog" "block is not exactly the section: ${block}"
grep -qxF -- "- Mirror release by OlegShevtsov1" <<<"${body}" || fail "changelog" "entry missing or owner not replaced: ${body}"
! grep -qF -e "Old entry" -e "[Unreleased]" -e "## [0.2.0]" <<<"${body}" || fail "changelog" "not exactly the section: ${body}"
[ "$(tail -n 1 <<<"${body}")" = "Type: chore" ] || fail "changelog" "Type line is not last: ${body}"
[ "$(last_post title)" = "PILOT-165: Release v0.2.0" ] || fail "changelog" "title is $(last_post title)"
# The sdlc mirror runs pr-conventions.sh on this PR: the block must pass it.
mkdir -p "${tmp}/conventions-gh"
printf '#!/bin/sh\necho 1\n' > "${tmp}/conventions-gh/gh"
chmod +x "${tmp}/conventions-gh/gh"
git -C "${tmp}/mirror.git" show main:CHANGELOG.md > "${tmp}/mirror-changelog.md"
CHANGELOG_FILE="${tmp}/mirror-changelog.md" PATH="${tmp}/conventions-gh:${PATH}" REPO=o/r BASE_REF=main HEAD_REF=develop PR_TITLE="$(last_post title)" \
  PR_BODY="${body}" bash "$(dirname "${src}")/ci/pr-conventions.sh" >/dev/null ||
  fail "changelog" "the release PR body fails pr-conventions.sh"
echo "PASS a release sync carries the tag's changelog section, which passes pr-conventions"

# Two tags in one sync: the title names the higher one, and condition 4 reads the first bare ## Changelog block.
new_fixture
p="${tmp}/primary"
primary_commit CHANGELOG.md "# Changelog\n\n## [0.2.1] - 2026-10-22\n\n- Hotfix entry\n\n## [0.2.0] - 2026-10-21\n\n- Release entry\n"
g -C "${p}" commit -q --allow-empty -m "PILOT-166: Release 0.2.1 changelog"
g -C "${p}" tag -a v0.2.0 -m "Release v0.2.0"
g -C "${p}" tag -a v0.2.1 -m "Release v0.2.1"
publish 1_mvp_pilot_be
[ "${rc}" -eq 0 ] || fail "changelog, two tags" "exit ${rc}: ${err}"
body=$(last_post body)
[ "$(last_post title)" = "PILOT-166: Release v0.2.1" ] || fail "changelog, two tags" "title is $(last_post title)"
grep -qxF "Tags: v0.2.0 v0.2.1" <<<"${body}" || fail "changelog, two tags" "Tags line is wrong: ${body}"
[ "$(grep -cxF "## Changelog" <<<"${body}")" -eq 1 ] || fail "changelog, two tags" "not one exact ## Changelog heading: ${body}"
grep -qxF "Changelog of v0.2.1:" <<<"${body}" || fail "changelog, two tags" "no sentence naming the title's tag: ${body}"
block=$(awk '$0 == "## Changelog" { found = 1; next } found && /^Type:/ { exit } found' <<<"${body}")
[ "${block}" = $'\n- Hotfix entry' ] || fail "changelog, two tags" "block is not the title tag's section: ${block}"
git -C "${tmp}/mirror.git" show main:CHANGELOG.md > "${tmp}/mirror-changelog.md"
CHANGELOG_FILE="${tmp}/mirror-changelog.md" PATH="${tmp}/conventions-gh:${PATH}" REPO=o/r BASE_REF=main HEAD_REF=develop PR_TITLE="$(last_post title)" \
  PR_BODY="${body}" bash "$(dirname "${src}")/ci/pr-conventions.sh" >/dev/null ||
  fail "changelog, two tags" "the release PR body fails pr-conventions.sh"
echo "PASS a sync carrying two tags has one ## Changelog block, the title tag's, which passes pr-conventions"

for cl in "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-16\n\n- Old entry\n" \
  "# Changelog\n\n## [0.2.0] - 2026-10-21\n\n### Added\n\n### Fixed\n\n## [0.1.0] - 2026-10-16\n\n- Old entry\n"; do
  new_fixture
  primary_commit CHANGELOG.md "${cl}"
  g -C "${tmp}/primary" commit -q --allow-empty -m "PILOT-165: Release 0.2.0 changelog"
  g -C "${tmp}/primary" tag -a v0.2.0 -m "Release v0.2.0"
  seed=$(mirror_head)
  publish 1_mvp_pilot_be
  [ "${rc}" -eq 1 ] || fail "changelog refusal" "exit ${rc}, want 1: ${err}"
  grep -qF "CHANGELOG.md at v0.2.0 has no section ## [0.2.0] with an entry" <<<"${err}" ||
    fail "changelog refusal" "reason not named: ${err}"
  [ "$(mirror_head)" = "${seed}" ] || fail "changelog refusal" "mirror main moved"
  [ -z "$(mirror_develop)" ] || fail "changelog refusal" "develop was pushed"
  [ -z "$(calls)" ] || fail "changelog refusal" "gh was called: $(calls)"
done
echo "PASS a release whose CHANGELOG.md has no entry for the tag is refused before any write"

# The synced tree is scanned for the owner; the section is read at the tag, which a resumed sync takes as it is now.
new_fixture
p="${tmp}/primary"
primary_commit CHANGELOG.md "# Changelog\n\n## [0.2.0] - 2026-10-21\n\n- Fixed\n"
g -C "${p}" commit -q --allow-empty -m "PILOT-165: Release 0.2.0 changelog"
g -C "${p}" tag -a v0.2.0 -m "Release v0.2.0"
FAKE_GH_CHECKS=pending publish 1_mvp_pilot_be
[ "${rc}" -eq 3 ] || fail "leftover in the changelog section" "first run: exit ${rc}, want 3: ${err}"
g -C "${p}" checkout -q -b retag
primary_commit CHANGELOG.md "# Changelog\n\n## [0.2.0] - 2026-10-21\n\n- Fixed by ${src_login^^}\n"
g -C "${p}" tag -f -a v0.2.0 -m "Release v0.2.0" >/dev/null
g -C "${p}" checkout -q main
head=$(mirror_head)
develop=$(mirror_develop)
before=$(calls)
publish 1_mvp_pilot_be
[ "${rc}" -eq 2 ] || fail "leftover in the changelog section" "exit ${rc}, want 2: ${err}"
grep -qF "resuming its PR" <<<"${err}" || fail "leftover in the changelog section" "the resume path did not run: ${err}"
grep -qF "the changelog section of v0.2.0 still contains the primary owner" <<<"${err}" ||
  fail "leftover in the changelog section" "reason not named: ${err}"
[ "$(mirror_head)" = "${head}" ] || fail "leftover in the changelog section" "mirror main moved"
[ "$(mirror_develop)" = "${develop}" ] || fail "leftover in the changelog section" "develop moved"
[ "$(calls)" = "${before}" ] || fail "leftover in the changelog section" "gh was called"
echo "PASS refusal on a leftover in the tag's changelog section"

# --- the default ref of every repo is origin/main
for r in 1_mvp_sdlc 1_mvp_pilot_fe; do
  new_fixture
  main_sha=$(git -C "${tmp}/primary" rev-parse main)
  publish "${r}" --dry-run
  [ "${rc}" -eq 0 ] || fail "${r} default ref" "exit ${rc}: ${err}"
  kept=$(sed -n 's/^dry run: not pushed; inspect //p' <<<"${err}")
  got=$(git -C "${kept}" log -1 --format=%s)
  rm -rf "$(dirname "${kept}")"
  [ "${got}" = "Sync from main (${main_sha:0:7})" ] || fail "${r} default ref" "message is '${got}'"
  echo "PASS default ref of ${r} is origin/main"
done

# --- usage
publish 1_mvp_infra
[ "${rc}" -eq 64 ] || fail "usage" "exit ${rc}, want 64"
publish
[ "${rc}" -eq 64 ] || fail "usage" "no repo: exit ${rc}, want 64"
for card in "" PILOT-0 165; do
  publish 1_mvp_pilot_be --card ${card:+"${card}"}
  [ "${rc}" -eq 64 ] || fail "usage" "--card '${card}': exit ${rc}, want 64"
done
echo "PASS repos outside the allowlist are rejected"
