# publish-mirror.sh

Refreshes a public mirror (`OlegShevtsov1/<repo>`) from its primary repo as one commit on the mirror's `develop`,
merged into the mirror's `main` through a PR — without the primary's history and without the primary owner's
identity — and carries the primary's release tags. It is run by hand from the operator host; nothing runs it
automatically.

## Usage

```bash
scripts/publish-mirror.sh <repo> [<ref>] [--dry-run] [--subject <text>] [--card PILOT-<n>]
make mirror REPO=<repo> [REF=<ref>] [ARGS="--dry-run --subject <text> --card PILOT-<n>"]
```

| Repo | Default ref |
| --- | --- |
| `1_mvp_sdlc` | `origin/main` |
| `1_mvp_pilot_be` | `origin/main` |
| `1_mvp_pilot_fe` | `origin/main` |

The source is the primary's released `main` for all three (decision 55). Any other repo name is rejected: the other
primary repos stay private. `<ref>` is anything `git rev-parse` resolves in a fresh clone of the primary
(`origin/<branch>`, a tag, a sha). `--subject` is appended to the commit message. `--card` sets the card in the
release PR title and overrides the lookup (below); it must be `PILOT-<n>` with n > 0, and it is ignored with a log
line when the sync carries no release tag. `--dry-run` builds the commit and
prints every push and GitHub API call (`dry run: git push …`, `dry run: gh api -X <METHOD> <path> <args>`,
`dry run: tag <tag> on the merge commit`, or `dry run: tag <tag> on <sha>` when recreating a deleted tag) without
running any of them — `gh` is not called at all; the temporary
clone is kept and its path is printed on stderr, and stdout is the sync commit sha (the PR number shows as `<pr>`).
Every run that opens or updates a PR, a dry run included, logs `PR title: <title>` on stderr.

After a sync the only stdout line is the new mirror `main` sha (the merge commit), so
`sha=$(scripts/publish-mirror.sh …)` works. When there is nothing to sync, stdout is instead the line
`nothing to sync (mirror main <short sha>)`, also with exit 0. Progress and check output always go to stderr.

| Exit | Meaning |
| --- | --- |
| 0 | synced, or `nothing to sync` |
| 1 | cloning, resolving the ref, pushing or a GitHub API call failed; the mirror `main` has changes that are not on `develop`; no card number found for a carried release tag (rerun with `--card`); the `CHANGELOG.md` at the release tag the title names has no section with an entry for it; the merge or a tag target did not verify |
| 2 | refused to publish: primary owner left over (in the tree, a tag message or the tag's changelog section) or the scan for it failed, public-repo check or gitleaks failed |
| 3 | the PR checks failed or timed out: nothing merged, the PR stays open and its URL is the stdout line |
| 64 | usage |

## What it does

1. Exports the primary: clones it, resolves `<ref>`, exports the tree with `git archive`, drops what is not synced
   (below), replaces in every text file the primary account's login (lowercase and capitalised forms) with
   `OlegShevtsov1` and the primary owner's full name with `Oleg Shevtsov`, and refuses (exit 2) if the primary login
   is still found anywhere: in any letter case, in binary files or in path names. Only file paths are printed. A scan
   that cannot read the tree refuses too.
2. Clones the mirror and checks out its `develop` (or `main` when there is no `develop` yet: the push in step 5 then
   creates `develop` from `main`). Refuses (exit 1) when the mirror `main` has changes that are not on `develop`.
   Replaces the tree with the export.
3. Finds the release tags to carry (below).
4. Decides whether there is anything to do: with `MIRROR_SOURCE.json` already there, an unchanged tree and no tag to
   carry, it creates missing mirror tags and exits 0 with `nothing to sync` — no GitHub API call. If `develop` is still
   ahead of `main` (an earlier run stopped on red checks or a timeout), it resumes that PR instead (step 6).
5. Writes `MIRROR_SOURCE.json`, runs the repo's public-repo check if it has one (`scripts/check-public-repo.sh`, else
   `scripts/ci/hygiene-check.sh`) and `gitleaks dir` when gitleaks is installed (a failure refuses with exit 2),
   commits as the mirror author, decides the PR title and body (a release without a card number, or whose `CHANGELOG.md` has no entry for its tag,
   stops here with exit 1, before anything is pushed) and pushes to the mirror's `develop` (never forced; if `develop` moved meanwhile, the push fails
   with exit 1).
6. Opens the PR `develop → main` on the mirror, or updates the open one.
7. Waits for the PR checks, then merges with a merge commit.
8. Verifies the merge: the new `main` has two parents, the previous `main` and the sync commit, and the sync commit's
   tree. Then creates the carried tags on it.
9. Prints the mirror `main` sha.

Nothing is pushed before every check has passed, and nothing is merged before the mirror CI is green. A bad sync that
did reach a mirror is fixed by a new sync (rerun after the fix); mirror history is never rewritten.

## The PR flow

No sync is pushed to the mirror's `main` (decision 54): the sync commit goes to `develop` and reaches `main` through a
PR, so `main-guard` on the mirror stays green and the mirror `main` can be branch-protected.

- **Title:** `PILOT-<n>: Release <tag>` when the sync carries a new release tag (the highest one), where `<n>` is the
  release's card on the primary (decision 58). The card comes from the release-prep squash commit
  `PILOT-<n>: Release X.Y.Z changelog` reachable from the tag, else from the release PR `PILOT-<n>: Release vX.Y.Z`
  reachable from the synced commit (its squash subject or the title line of its merge commit); PILOT-0 never counts.
  When neither is found the script stops with exit 1 before pushing; rerun with `--card PILOT-<n>` — typical for a
  hotfix tag, whose history has neither. Otherwise the title is `PILOT-0: Sync <branch> (<7-char primary sha>)`,
  where `<branch>` is the ref without `origin/`.
- **Body:** one line naming the repo, branch and primary sha; a `Tags: <list>` line when tags are carried; for the
  tag the title names, the sentence `Changelog of vX.Y.Z:` and then `## Changelog` with that version's `CHANGELOG.md`
  section (decision 64) — one block, since condition 4 reads only the first; then `Type: chore` — the only line starting with `Type:` (the mirror's `pr-conventions-check`
  demands one).
- **Changelog:** the section is read from the primary's `CHANGELOG.md` at the tagged commit, without its
  `## [X.Y.Z] - date` heading, owner replaced (a leftover refuses with exit 2): exactly what the app repos'
  `scripts/release-notes.sh vX.Y.Z` prints, which their pr-conventions condition 4 demands under an exact
  `## Changelog` line. There is no block when the tagged commit has no `CHANGELOG.md`. A `CHANGELOG.md` with no
  `## [X.Y.Z]` section, or one without a list entry, stops the sync with exit 1 before anything is pushed; the fix is
  a new release whose section is written. On the sdlc mirror the block passes the release rule of its own
  `pr-conventions-check`, which compares it with the mirror's `CHANGELOG.md`.
- **Checks:** every `MIRROR_CHECKS_INTERVAL` seconds (default 30), for up to `MIRROR_CHECKS_TIMEOUT` seconds (default
  1800), it reads the check runs of the sync commit. Green means at least one check run, all completed, each
  `success`, `neutral` or `skipped`. A failed check or the timeout stops with exit 3: the failed check names on stderr,
  the PR URL on stdout, nothing merged.
- **Merge:** a merge commit, never a squash (decision 51), with the sync commit sha pinned, so GitHub refuses the merge
  if `develop` moved after the checks.
- **Resume:** after exit 3, fix the cause and run the script again. The open PR is reused (its title and body are
  updated); a primary that moved meanwhile adds one more sync commit on `develop`.
- **Refusal:** if the mirror `main` has commits whose changes are not on `develop` (someone committed or merged
  something else into `main`), the script stops with exit 1 before pushing. Reconcile the mirror by hand.

## The gh account rule

Every mirror API call runs as `OlegShevtsov1` with `GH_TOKEN` set for that one call to the output of
`gh auth token -u OlegShevtsov1`. The script never runs `gh auth switch` and never exports `GH_TOKEN`: the active gh
account of the host stays as it is. `gh` must be logged in for `OlegShevtsov1` (`gh auth status` lists it); without a
token the script stops with exit 1. The `develop` push and the tag pushes go over the mirror SSH alias, not the API.

## Release tags

A primary tag is carried when it is annotated, named `vX.Y.Z`, its commit is contained in the synced ref, its
commit's tree is the synced tree (the tag's content is what the mirror `main` holds after the merge), and the
mirror's `MIRROR_SOURCE.json` does not record it yet. A release tag sits on the develop-side parent of the release
merge, which has the same tree as the merge, so the new release tag is carried. A hotfix tag sits on the squash commit
of `main`, which is the synced commit, so it is carried. A tag whose content differs (older releases) is skipped with
the log line `tag vX.Y.Z not carried: its content is not the synced content` and is not recorded. A tag that already
exists on the mirror but is not recorded is skipped with a log line and never overwritten.

For each carried tag the sync commit appends an entry to `MIRROR_SOURCE.json` `tags`; after the merge the script
creates an annotated tag with the same name on the merge commit, tagger `Oleg Shevtsov <olegshevtsov1@gmail.com>`,
unsigned, with the primary tag's message after the same owner replacement as the tree (a message that still holds the
primary login refuses with exit 2). Tags are pushed, never forced.

Every run also recreates a tag recorded on the mirror `main` but missing on the mirror, on the merge commit that
brought its entry in, after checking that commit's first parent is the entry's `mirror_sha`. Entries without
`primary_sha` or `mirror_sha` (written by hand before this flow) are logged and not tagged.

One sync carries only tags whose content it brings, so an old tag never lands on newer content (published tags are
immutable). To publish an older release, or a release whose content `main` has already moved past, sync that tag as an
explicit ref first (`publish-mirror.sh 1_mvp_pilot_be v0.1.0`), then the default ref.

## Prerequisites

- SSH aliases in `~/.ssh/config`: `github.OlegShevtsov1` (HostName `github.com`, the mirror account's key; the mirror
  URL is `git@github.OlegShevtsov1:OlegShevtsov1/<repo>.git`) and the primary account's alias, the same one the
  primary checkouts use as `origin`.
- `gh` logged in for `OlegShevtsov1` (above).
- `git`, `python3`; `gitleaks` is optional (skipped with a message when absent).

`MIRROR_PRIMARY_URL` and `MIRROR_TARGET_URL` replace the two URLs (a URL or a local path); the tests use them, with a
fake `gh` on `PATH`, to run without network.

## Operator steps on each mirror

Done once per mirror by the operator as `OlegShevtsov1`, not by the script:

- `vars.MIRROR=true` (`GH_TOKEN="$(gh auth token -u OlegShevtsov1)" gh variable set MIRROR --body true -R
  OlegShevtsov1/<repo>`), so the mirror's `develop-guard` skips the sync PRs. The skip exists only once the mirror's
  workflows carry it (PILOT-154 for be, PILOT-155 for fe); until then every push of a sync to `develop` still raises
  the `develop-guard` alert.
- Branch protection on the mirror `main`: PR required, required status checks = the mirror's CI jobs +
  `pr-conventions-check`.

## The author rule

Every sync commit has author **and** committer `Oleg Shevtsov <olegshevtsov1@gmail.com>`; so has every tag's tagger.
Override only through `MIRROR_AUTHOR_NAME` and `MIRROR_AUTHOR_EMAIL`. Commits and tags are never signed, because a
host signing key would carry the primary identity. The message is `Sync from <branch> (<7-char primary sha>)`, plus
`: <subject>` with `--subject`. The merge commit is made by GitHub for `OlegShevtsov1`; its email comes from that
account's commit-email setting.

## What is NOT synced

- `.github/dependabot.yml` — the mirrors take no dependency updates of their own.
- The git history — each sync is one commit on the mirror's `develop`; the primary's commits and authors never reach
  the mirror. Of the primary's tags only the release tags above are carried.

## MIRROR_SOURCE.json

Written at the mirror root by every sync:

| Field | Value |
| --- | --- |
| `repo` | repo name, e.g. `1_mvp_pilot_be` |
| `source_ref` | the ref as given, e.g. `origin/main` |
| `source_sha` | full primary commit sha the tree was exported from |
| `mirror_sha` | the mirror `main` commit the sync PR merges into — the first parent of the merge commit (a commit cannot contain its own sha, nor the sha of the merge that brings it in) |
| `synced_at` | UTC time, `YYYY-MM-DDTHH:MM:SSZ` |
| `tags` | the previous file's entries, plus one per carried tag: `{"tag", "primary_sha", "mirror_sha", "synced_at"}` |

In a `tags` entry, `primary_sha` is the primary commit the primary tag points at, and `mirror_sha` is the same as the
top-level one of the sync that wrote it. The mirror tag sits on the merge commit, so for every entry
`git rev-parse <tag>^{commit}^1` equals `mirror_sha`, and `<tag>^{commit}^2` is the sync commit that wrote the
entry. The mirror prod deploy checks read only `tag` and `primary_sha` (exactly one entry for the version, its
`primary_sha` equal to the requested source sha) and require the annotated tag's commit on the mirror `main`.
