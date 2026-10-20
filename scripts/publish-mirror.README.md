# publish-mirror.sh

Refreshes a public mirror (`OlegShevtsov1/<repo>`) from its primary repo as one new commit on the mirror's `main`,
without the primary's history and without the primary owner's identity. It is run by hand from the operator host;
nothing runs it automatically.

## Usage

```bash
scripts/publish-mirror.sh <repo> [<ref>] [--dry-run] [--subject <text>]
make mirror REPO=<repo> [REF=<ref>] [ARGS="--dry-run --subject <text>"]
```

| Repo | Default ref |
| --- | --- |
| `1_mvp_sdlc` | `origin/main` |
| `1_mvp_pilot_be` | `origin/develop` |
| `1_mvp_pilot_fe` | `origin/develop` |

Any other repo name is rejected: the other primary repos stay private. `<ref>` is anything `git rev-parse` resolves in
a fresh clone of the primary (`origin/<branch>`, a tag, a sha). `--subject` is appended to the commit message.
`--dry-run` builds the commit but does not push; the temporary clone is kept and its path is printed on stderr.

After a sync the only stdout line is the new mirror commit sha, so `sha=$(scripts/publish-mirror.sh …)` works. When
there is nothing to sync, stdout is instead the line `nothing to sync (mirror main <short sha>)`, also with exit 0.
Progress and check output always go to stderr.

| Exit | Meaning |
| --- | --- |
| 0 | synced, or `nothing to sync` |
| 1 | cloning the primary or the mirror, resolving the ref, or pushing failed |
| 2 | refused to publish: primary owner left over or the scan for it failed, public-repo check or gitleaks failed |
| 64 | usage |

## What it does

1. Clones the primary into a temporary directory and resolves `<ref>`.
2. Exports the tree at that commit with `git archive`.
3. Drops what is not synced (below).
4. In every text file, replaces the primary account's login (lowercase and capitalised forms) with `OlegShevtsov1`
   and the primary owner's full name with `Oleg Shevtsov`.
5. Refuses (exit 2) if the primary login is still found anywhere: in any letter case, in binary files or in path
   names. Only file paths are printed. A scan that cannot read the tree refuses too.
6. Clones the mirror's `main`, deletes everything except `.git` and copies the exported tree in.
7. Exits 0 with `nothing to sync` when the tree is unchanged and `MIRROR_SOURCE.json` already exists.
8. Writes `MIRROR_SOURCE.json`.
9. Runs the repo's public-repo check if it has one (`scripts/check-public-repo.sh`, else
   `scripts/ci/hygiene-check.sh`) and `gitleaks dir` when gitleaks is installed. A failure refuses with exit 2.
10. Commits as the mirror author.
11. Pushes to the mirror's `main` (never forced; if the mirror moved meanwhile, the push fails), unless `--dry-run`.
12. Prints the mirror commit sha.

Nothing is pushed before every check has passed. A bad sync that did reach a mirror is fixed by a new commit (rerun
after the fix, or `git revert` in a mirror clone as the mirror author); mirror history is never rewritten.

## Prerequisites

- SSH aliases in `~/.ssh/config`: `github.OlegShevtsov1` (HostName `github.com`, the mirror account's key; the mirror
  URL is `git@github.OlegShevtsov1:OlegShevtsov1/<repo>.git`) and the primary account's alias, the same one the
  primary checkouts use as `origin`.
- `git`, `python3`; `gitleaks` is optional (skipped with a message when absent).

`MIRROR_PRIMARY_URL` and `MIRROR_TARGET_URL` replace the two URLs (a URL or a local path); the tests use them to run
without network.

## The author rule

Every mirror commit has author **and** committer `Oleg Shevtsov <olegshevtsov1@gmail.com>`. Override only through
`MIRROR_AUTHOR_NAME` and `MIRROR_AUTHOR_EMAIL`. The commit is never signed, because a host signing key would carry the
primary identity. The message is `Sync from <branch> (<7-char primary sha>)`, plus `: <subject>` with `--subject`.

## What is NOT synced

- `.github/dependabot.yml` — the mirrors take no dependency updates of their own.
- The git history — each sync is one commit on top of the mirror's `main`; the primary's commits, authors and tags
  never reach the mirror.

## MIRROR_SOURCE.json

Written at the mirror root by every sync:

| Field | Value |
| --- | --- |
| `repo` | repo name, e.g. `1_mvp_pilot_be` |
| `source_ref` | the ref as given, e.g. `origin/develop` |
| `source_sha` | full primary commit sha the tree was exported from |
| `mirror_sha` | the mirror `main` commit this sync was built on (the sync commit's parent: a commit cannot contain its own sha); the sync commit is the last commit that changed this file |
| `synced_at` | UTC time, `YYYY-MM-DDTHH:MM:SSZ` |
| `tags` | kept from the previous file; release tag entries are planned for M4 and not written yet |
