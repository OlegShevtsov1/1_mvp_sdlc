Release-prep for mvp-sdlc v0.7.0 (E1 of the SDLC autopilot design, 1_mvp_prompt #281). Card PILOT-477 (the release's own card, decision 91): <card URL>

## What changes

- `CHANGELOG.md`: new `## [0.7.0] - 2026-10-31` holding the three changes merged after v0.6.0 (`0e25a9e` on `main`): PILOT-472 (#74) under Added, PILOT-471 (#75) and PILOT-470 (#76) under Fixed. `[Unreleased]` is back to the six empty categories.
- `[0.6.0]` and everything below already equal `git show v0.6.0:CHANGELOG.md` (diff empty); no entry had to move.
- `plugins/mvp-sdlc/.claude-plugin/plugin.json` and the `mvp-sdlc` entry of `.claude-plugin/marketplace.json`: version 0.6.0 to 0.7.0 (they must be equal, `lint_plugins.py`), as #71 did. The `sdlc` entry (4.5.1) is untouched.

## Deviations from the request

- No `make eval` (paid model calls, never run in CI); the latest result is `eval/results/0.3.0.json`, as for 0.4.0–0.6.0.
- No back-merge or GitHub Release is expected: v0.6.0 had none (release PR #73 used a merge commit; 0 GitHub Releases).
- Entry order in `[0.7.0]` → Fixed is merge order (PILOT-471, then PILOT-470), as in #71; cheap to reverse.
- The After merge steps use bold `**A<n> — …**` headers, as the operator asked and v0.6.0 did; `post-merge` reads them. `task-brief --check-after-merge` (PILOT-472) accepts only `### A<n>` steps, so it is not run on this body.

## Validation

- `[0.6.0]`-and-below vs tag v0.6.0, the `[Unreleased]` block vs v0.6.0's, and the set of entry lines vs develop: all `diff` empty.
- `python3 scripts/lint_plugins.py` OK; `scripts/ci/check.sh` `plugins`, `docs`, `hygiene` and `actionlint` pass.
- `scripts/ci/pr-conventions.sh` passes for this PR and for the prospective release PR (`PILOT-477: Release v0.7.0`, body `## Changelog` plus the `[0.7.0]` section).

Refs PILOT-477

Type: docs

In the sections below, `N` is this PR's number and `<this PR URL>` its URL; `<release PR number>` is filled in by the operator session at A1.

## After merge (operator)

Run: `archon workflow run post-merge --cwd /home/operator/projects/mvp/1_mvp_sdlc --no-worktree "run=PILOT477 pr=<this PR URL>"`.
Release v0.7.0 of 1_mvp_sdlc (E1 of the SDLC autopilot design; card PILOT-477, decision 91). 🔒 marks a GitHub
write. The operator delegated this release's merges to the operator session, as for v0.6.0: A1 merges the release
PR with a **merge commit** (`gh pr merge --merge`; never squash or rebase). On any mismatch with an Expected, stop on
a gate with the command output as evidence; do not improvise. Every step re-derives `P` (this PR's squash commit) and
`M` (the release PR's merge commit) itself. `N` below is this PR's number.

**A0 — Preconditions**

```bash
cd /home/operator/projects/mvp/1_mvp_sdlc && git fetch origin --tags --prune
P=$(gh pr view N -R OlegShevtsov1/1_mvp_sdlc --json mergeCommit --jq .mergeCommit.oid); echo "P=$P"
git log -1 --format=%s "$P"
git rev-parse origin/develop origin/main
git show origin/develop:CHANGELOG.md | grep -cE '^## \[0\.7\.0\] - [0-9]{4}-[0-9]{2}-[0-9]{2}$'
diff <(git show 'v0.6.0:CHANGELOG.md' | sed -n '/^## \[0\.6\.0\]/,$p') <(git show origin/develop:CHANGELOG.md | sed -n '/^## \[0\.6\.0\]/,$p') && echo v060-section-same
git show origin/develop:plugins/mvp-sdlc/.claude-plugin/plugin.json | grep '"version"'
git show origin/develop:.claude-plugin/marketplace.json | python3 -c 'import json,sys; print([p["version"] for p in json.load(sys.stdin)["plugins"] if p["name"]=="mvp-sdlc"])'
git ls-remote --tags origin 'v0.7.0*'
gh pr list -R OlegShevtsov1/1_mvp_sdlc --base main --state open --json number --jq length
git merge-base --is-ancestor 4d4cc21 origin/develop && git diff --quiet origin/main 4d4cc21 && echo main-content-in-develop
git log --format=%s 0e25a9e..origin/develop | grep -oE '^PILOT-[1-9][0-9]*' | sort -uV | paste -sd' '
```

Expected:
- The subject is `PILOT-477: Release 0.7.0 changelog (#N)`, and `origin/develop` equals `P`. Any later commit on
  `develop` is a mismatch: gate, because the release would carry changes outside `[0.7.0]`.
- `origin/main` is `0e25a9e63464bceac1f6b3f5f60089f675481e8f` (v0.6.0). Anything else: gate.
- The count is `1`, and `v060-section-same` is printed.
- The plugin version is `"version": "0.7.0"`, and the marketplace prints `['0.7.0']`.
- `ls-remote` prints nothing (no tag v0.7.0 yet), and there are `0` open PRs into `main`.
- `main-content-in-develop` is printed: `main` (`0e25a9e`) is not an ancestor of `develop` (no back-merge after
  v0.6.0), but its tree equals `4d4cc21`, which is in `develop`, so the release merge is conflict-free.
- The card list is exactly `PILOT-470 PILOT-471 PILOT-472 PILOT-477`.

**A1 — 🔒 Release PR develop → main, merged by this session with a merge commit**

```bash
cd /home/operator/projects/mvp/1_mvp_sdlc && git fetch origin
B=/tmp/pilot477-release-body.md
{ echo "Release mvp-sdlc 0.7.0 (1_mvp_sdlc develop → main). E1 of the SDLC autopilot design; the release's own card is PILOT-477 (decision 91)."
  echo; echo "Evals: the latest recorded result is eval/results/0.3.0.json (verdict PASS, complete); the plugin is 0.7.0."
  echo; echo "Card: <card URL>"; echo; echo "## Changelog"; echo
  git show origin/develop:CHANGELOG.md | awk '/^## \[0\.7\.0\]/{f=1} f&&/^## \[0\.6\.0\]/{exit} f'
  echo "Type: chore"; } > "$B"
REPO=OlegShevtsov1/1_mvp_sdlc BASE_REF=main HEAD_REF=develop PR_TITLE='PILOT-477: Release v0.7.0' PR_BODY="$(cat "$B")" bash scripts/ci/pr-conventions.sh
gh pr create -R OlegShevtsov1/1_mvp_sdlc --base main --head develop --title 'PILOT-477: Release v0.7.0' --body-file "$B"
gh pr checks <release PR number> -R OlegShevtsov1/1_mvp_sdlc --watch
gh pr merge <release PR number> -R OlegShevtsov1/1_mvp_sdlc --merge
git fetch origin
P=$(gh pr view N -R OlegShevtsov1/1_mvp_sdlc --json mergeCommit --jq .mergeCommit.oid)
gh pr view <release PR number> -R OlegShevtsov1/1_mvp_sdlc --json state,mergeCommit --jq '.state, .mergeCommit.oid'
M=$(gh pr view <release PR number> -R OlegShevtsov1/1_mvp_sdlc --json mergeCommit --jq .mergeCommit.oid)
git rev-list --parents -n 1 "$M"; git rev-parse "$M^1" "$M^2" origin/main
git diff --quiet "$M" "$P" && echo same-tree
gh run list -R OlegShevtsov1/1_mvp_sdlc --commit "$M" --json workflowName,conclusion --jq '.[] | "\(.workflowName) \(.conclusion)"'
```

Expected:
- The local check prints `pr-conventions: ok (branch, title, Type line)`.
- The PR opens titled `PILOT-477: Release v0.7.0`. Its body has exactly `## Changelog` followed by
  `## [0.7.0] - <date>` with the PILOT-472 (Added) and PILOT-471, PILOT-470 (Fixed) entries. Its diff contains only
  the changes since v0.6.0.
- Every check passes, including `pr-conventions`, before the merge. A red or cancelled-only check: gate with its
  output, do not merge.
- After the merge, the state is `MERGED`.
- `M` has two parents: `M^1` = `0e25a9e63464bceac1f6b3f5f60089f675481e8f` (the previous `main`, v0.6.0) and
  `M^2` = `P`. `origin/main` equals `M`.
- `same-tree` is printed, and `main-guard` on `M` is `success`.
- One parent (squash or rebase): gate. Do not continue to A2.

**A2 — 🔒 Annotated tag v0.7.0 on the merge commit M (shape as v0.6.0; no GitHub Release)**

```bash
cd /home/operator/projects/mvp/1_mvp_sdlc && git fetch origin --tags
P=$(gh pr view N -R OlegShevtsov1/1_mvp_sdlc --json mergeCommit --jq .mergeCommit.oid)
M=$(git rev-parse origin/main); echo "M=$M"; git log -1 --format=%s "$M"
test "$(git rev-parse "$M^2")" = "$P" && echo m-is-main
git tag -a v0.7.0 -m 'mvp-sdlc 0.7.0' "$M"
git push origin refs/tags/v0.7.0
git cat-file -p v0.7.0 | head -6; git cat-file -p v0.6.0 | head -6; git ls-remote --tags origin 'v0.7.0*'
gh api repos/OlegShevtsov1/1_mvp_sdlc/releases --jq length
```

Expected:
- `M` is the A1 merge commit: subject `Merge pull request #<release PR number> from OlegShevtsov1/develop`, and
  `m-is-main` is printed. If `main` moved past the release merge: gate.
- The tag object has `type commit`, `object` = `M`, `tag v0.7.0` and the message `mvp-sdlc 0.7.0`. This is the same
  shape as v0.6.0 (annotated, `object 0e25a9e…`, message `mvp-sdlc 0.6.0`).
- `ls-remote` shows `refs/tags/v0.7.0` and `refs/tags/v0.7.0^{}` = `M`.
- The release count stays `0`: v0.6.0 had no GitHub Release, so none is created.

**A3 — 🔒 Mirror sync (OlegShevtsov1/1_mvp_sdlc) from the released script, dry run then real**

```bash
cd /home/operator/projects/mvp/1_mvp_sdlc && git fetch origin --tags
W=/tmp/sdlc-main-v0.7.0-mirror; git worktree remove --force "$W" 2>/dev/null; git worktree add --detach "$W" v0.7.0
"$W/scripts/publish-mirror.sh" 1_mvp_sdlc --dry-run 2>&1 | tail -30
"$W/scripts/publish-mirror.sh" 1_mvp_sdlc; echo "rc=$?"
gh pr list -R OlegShevtsov1/1_mvp_sdlc --state merged --limit 1 --json title,body,url --jq '.[0].title, .[0].url, (.[0].body | test("(?m)^## Changelog$"))'
git ls-remote --tags git@github.com:OlegShevtsov1/1_mvp_sdlc.git 'v0.7.0*'
T=$(mktemp -d) && git clone -q --depth 1 git@github.com:OlegShevtsov1/1_mvp_sdlc.git "$T/m" && git -C "$T/m" fetch -q --depth 1 origin tag v0.7.0 && { grep -rIil -e OlegShevtsov1 -e 'oleh shevtsov' "$T/m" --exclude-dir=.git | wc -l; git -C "$T/m" for-each-ref --format='%(contents)' refs/tags/v0.7.0; }; rm -rf "$T"
git worktree remove "$W"
```

Expected:
- The dry run exits 0. Its stderr has `PR title: PILOT-477: Release v0.7.0` and `dry run: tag v0.7.0 on the merge
  commit`, and no `tag v0.7.0 not carried` and no `no card number`.
- The real run prints the mirror `main` sha and `rc=0`.
- The newest merged mirror PR is titled `PILOT-477: Release v0.7.0`, and its body has `## Changelog` (`true`).
- The mirror has `refs/tags/v0.7.0`. The owner scan prints `0`, and the mirror tag message is `mvp-sdlc 0.7.0`.
- If the script exits 1, 2 or 3: gate with its stderr. Exit 3 means the mirror PR stays open; do not merge it by
  hand.

**A4 — Install the released factory from main and prove it equals main**

```bash
cd /home/operator/projects/mvp/1_mvp_sdlc && git fetch origin --tags
W=/tmp/sdlc-main-v0.7.0; git worktree remove --force "$W" 2>/dev/null; git worktree add --detach "$W" origin/main
git -C "$W" status --short | wc -l; test "$(git -C "$W" rev-parse HEAD)" = "$(git rev-parse 'v0.7.0^{commit}')" && echo tag-is-head
(cd "$W" && ./install.sh); echo "install rc=$?"
diff -r ~/.archon/workflows/sdlc-factory/factory "$W/orchestration/factory/.archon/workflows/sdlc-factory/factory"
ls ~/.archon/workflows/sdlc-factory
cmp ~/.archon/workflows/sdlc-factory/factory/scripts/_lib/notify-telegram.sh "$W/scripts/ci/notify-telegram.sh" && echo notify-same
for y in "$W"/orchestration/workflows/*.yaml; do cmp "$y" ~/.archon/workflows/"$(basename "$y")" || echo "DIFF $y"; done
git worktree remove "$W"
```

Expected:
- The worktree is clean (`0`), and its HEAD is the tagged merge commit (`tag-is-head`).
- `install.sh` prints `installed: …`. Each validated workflow (`factory`, `plan-review`, `plugin-probe`) reports
  `0 with errors` (warnings allowed), and the step prints `install rc=0`.
- `diff -r` prints exactly one line: `Only in /home/operator/.archon/workflows/sdlc-factory/factory/scripts/_lib:
  notify-telegram.sh`. `ls` shows only `factory`.
- `notify-same` is printed, and there is no `DIFF` line.
- Run this only when no factory or plan-review run is active other than this post-merge: install replaces the pack
  in place. If one is active: gate.

**A5 — Back-merge check: develop's content is already main's (no back-merge PR)**

```bash
cd /home/operator/projects/mvp/1_mvp_sdlc && git fetch origin
git merge-base --is-ancestor origin/develop origin/main && echo develop-in-main
git diff --quiet origin/develop origin/main && echo same-tree
git log --oneline origin/develop..origin/main
```

Expected:
- `develop-in-main` and `same-tree` are printed.
- The log shows only the two release merge commits: `M` and `0e25a9e` (v0.6.0's, never back-merged, tree-equal).
  v0.6.0 needed no back-merge after its merge-commit release, so none is opened now.
- Otherwise (a commit other than those two, or no `same-tree`): gate with the output. The remedy, after the
  operator's OK, is a 🔒 back-merge PR `PILOT-477: Back-merge release v0.7.0 into develop` from
  `feature/PILOT-477-backmerge` (= `origin/main`) into `develop`, merged with a merge commit, as #68.

**A6 — The operator's marketplace serves mvp-sdlc 0.7.0 with `--check-after-merge`; update the pilot repositories**

```bash
claude plugin marketplace update mvp
(cd /home/operator/projects/mvp/1_mvp_pilot_be && claude plugin update mvp-sdlc@mvp --scope project); echo "be rc=$?"
(cd /home/operator/projects/mvp/1_mvp_pilot_fe && claude plugin update mvp-sdlc@mvp --scope project); echo "fe rc=$?"
python3 -c 'import json; print([p["version"] for p in json.load(open("/home/operator/.claude/plugins/marketplaces/mvp/.claude-plugin/marketplace.json"))["plugins"] if p["name"]=="mvp-sdlc"])'
python3 -c 'import json; d=json.load(open("/home/operator/.claude/plugins/installed_plugins.json"))
for e in d["plugins"]["mvp-sdlc@mvp"]:
    if e.get("projectPath") in ("/home/operator/projects/mvp/1_mvp_pilot_be", "/home/operator/projects/mvp/1_mvp_pilot_fe"):
        print(e["projectPath"], e["version"], e.get("gitCommitSha"), e.get("installPath"))'
grep -c -- '--check-after-merge' ~/.claude/plugins/cache/mvp/mvp-sdlc/0.7.0/bin/task-brief
grep '"version"' ~/.claude/plugins/cache/mvp/mvp-sdlc/0.7.0/.claude-plugin/plugin.json
git -C /home/operator/projects/mvp/1_mvp_sdlc rev-parse origin/main
```

Expected:
- The marketplace update succeeds, and both updates exit 0 (`be rc=0`, `fe rc=0`).
- The marketplace copy prints `['0.7.0']`.
- The JSON shows exactly two lines, `/home/operator/projects/mvp/1_mvp_pilot_be 0.7.0 <sha> …/cache/mvp/mvp-sdlc/0.7.0`
  and the same for `/home/operator/projects/mvp/1_mvp_pilot_fe`, where `<sha>` is `origin/main` (= M).
- The grep count is at least `1`, and the cached plugin.json has `"version": "0.7.0"`.
- Still `0.6.0`, a missing `0.7.0` cache directory, a count of `0` or a missing path: gate with the output. Open
  Claude sessions in those repositories need a restart to load 0.7.0.

**A7 — Bookkeeping: released cards → Done**

```bash
cd /home/operator/projects/mvp/1_mvp_sdlc && git fetch origin --tags
git log --format=%s 0e25a9e..v0.7.0 | grep -oE '^PILOT-[1-9][0-9]*' | sort -uV | paste -sd' '
for c in PILOT-470 PILOT-471 PILOT-472; do
  bun ~/.archon/workflows/mvp-ops/post-merge/scripts/trello.ts move-card "$c" Done >/dev/null && echo "$c Done" || echo "$c FAIL"; done
```

Expected:
- The cards are `PILOT-470 PILOT-471 PILOT-472 PILOT-477`.
- Each of PILOT-470, PILOT-471 and PILOT-472 prints `Done`. Any `FAIL`: gate with the output.
- After the steps, post-merge's own nodes finish the bookkeeping:
  - `task-card-final` moves PILOT-477 (<card URL>) through `Test after Release` to `Done`
    (decision 91).
  - `bookkeeping` writes the section `### PILOT477 — Release 0.7.0 changelog` in 1_mvp_prompt
    `docs/superpowers/plans/releases.md`, with the links of A1–A6.

## Deploy / health

None: `1_mvp_sdlc` has no runtime service. Consumers get the release from `main` (the marketplace `mvp`, `install.sh`).

## Rollback

- Before A1: revert this PR on `develop`, on a branch `feature/PILOT-477-revert-release-changelog`, with `git revert
  <squash sha>`, then a PR into `develop`.
- After A1, do not rewrite `main`; fix forward with a hotfix PR. Delete the tag only if A3 has not carried it yet:
  `git push origin :refs/tags/v0.7.0`.
- A4's previous install is in `~/.archon/workflows-backup/<UTC timestamp>/`, and install.sh prints the restore
  command.

