# release.sh

Runs one step of a `1_mvp_sdlc` release from reviewed code: the release PR merge, the tag, the mirror sync and the
install. A release-prep PR writes its post-merge steps A1–A4 as one `release.sh` line each, and the sdlc-autopilot
supervisor approves such a step by itself ([`post-merge-allowlist`](../orchestration/supervisor/README.md#post-merge-allowlist),
operator decision 2026-11-01, PILOT-545). Any other step text still goes to the operator.

## Usage

```bash
bash scripts/release.sh <merge-release-pr|tag|mirror|install|verify> v<X.Y.Z>
```

It runs from the repository it is in (its top level), fetches `origin` with its tags (never `--prune`) and reads the
primary repo name with `gh repo view`. Every subcommand is idempotent: a rerun after a success proves the result
again and changes nothing, and a rerun after a fix finishes the release. Each proof prints `ok <what>` or
`DIFF <what>` on stdout; progress, and the output of the commands it runs, go to stderr.

| Subcommand | What it does |
| --- | --- |
| `merge-release-pr` | Checks that `origin/develop` has the `## [X.Y.Z] - <date>` section in `CHANGELOG.md` and version `X.Y.Z` in `plugins/mvp-sdlc/.claude-plugin/plugin.json`. Takes the card from the one merged release-prep PR `PILOT-<n>: Release X.Y.Z changelog` into `develop`, and finds the release PR `PILOT-<n>: Release vX.Y.Z` from `develop` into `main`. A merged one is only proved again and an open one is reused. Otherwise it opens it with the body `## Changelog` and the version's section, then `Type: chore`, checked first by `scripts/ci/pr-conventions.sh`. It waits for the checks (`gh pr checks --watch`), then merges with a merge commit at the head it saw (`--match-head-commit`). Proves that the PR is `MERGED`, that its merge commit `M` has two parents with the PR head second, and that `M` is on `origin/main`. Prints `merged: #<R> <M>`. |
| `tag` | Proves the merged release PR as above and that `plugin.json` at `M` is `X.Y.Z`. Creates the annotated tag `vX.Y.Z` (`mvp-sdlc X.Y.Z`) on `M` unless it exists, refuses one that is lightweight or on another commit, and pushes it. Proves `vX.Y.Z^{}` on `origin` is `M`. Prints `tagged: vX.Y.Z <M>`. No GitHub Release. |
| `mirror` | Needs the tag on `origin`. In a temporary worktree at the tag it runs that tag's `scripts/publish-mirror.sh 1_mvp_sdlc --dry-run`, and only when it passes, the real run. Proves the mirror has `refs/tags/vX.Y.Z`. A rerun is safe: publish-mirror then has nothing to sync, or resumes its open PR. |
| `install` | Needs the tag on `origin`. While `archon workflow status --all --json` lists a running `factory`, `plan-review` or `plugin-probe` run (or cannot be read), it waits. Then it runs `./install.sh` from a temporary worktree at the tag and proves what it installed (below). |
| `verify` | Read-only: proves the release merge, that `origin`'s tag is on it, that the mirror has the tag, and the install. It pushes, creates and merges nothing. |

The install proofs compare `<ARCHON_HOME>/workflows/sdlc-factory/factory` with the tag's factory pack (`diff -r`,
`notify-telegram.sh` aside), its `scripts/_lib/notify-telegram.sh` with `scripts/ci/notify-telegram.sh`, each
`orchestration/workflows/*.yaml` with its installed copy, and `<ARCHON_HOME>/supervisor` with
`orchestration/supervisor` (`node_modules` aside): the paths `install.sh` writes.

A temporary worktree is removed on exit, so a step never needs `git worktree remove --force` or `rm -rf` itself.

| Exit | Meaning |
| --- | --- |
| 0 | done, or already done |
| 1 | a precondition or a proof failed (the message on stderr names it) |
| 3 | `merge-release-pr`: the release PR checks failed or timed out, nothing merged |
| 64 | usage |
| 75 | `install`: runs that `install.sh` would replace are still running after the wait; nothing installed |

`mirror` exits with publish-mirror.sh's own code when the dry run or the real run fails (1, 2, or 3 for the mirror
PR checks; [publish-mirror.README.md](publish-mirror.README.md)).

| Env | Default | Meaning |
| --- | --- | --- |
| `RELEASE_CHECKS_TIMEOUT` | `1200` | seconds to wait for the release PR checks |
| `RELEASE_INSTALL_WAIT` | `1800` | seconds `install` waits for running runs |
| `RELEASE_INSTALL_INTERVAL` | `30` | seconds between two reads of the run list |
| `MIRROR_CHECKS_TIMEOUT` | `1200` | passed to publish-mirror.sh |
| `MIRROR_TARGET_URL` | the mirror's SSH URL | the mirror, for publish-mirror.sh and the mirror tag proof |
| `ARCHON_HOME` | `~/.archon` | where `install.sh` installs and the proofs look |

## The post-merge steps

A release-prep PR's "After merge (operator)" writes A1–A4 as one block each, with `git fetch origin --tags` and
exactly one `release.sh` line; read-only proof lines (`git log`, `gh pr view`, …) may follow:

```bash
git fetch origin --tags
bash scripts/release.sh merge-release-pr vX.Y.Z
```

A2 is `… tag vX.Y.Z`, A3 `… mirror vX.Y.Z`, A4 `… install vX.Y.Z`, and `… verify vX.Y.Z` is a closing proof. The
post-merge agent already works in the run's worktree, so no `cd` is needed. Any other write command, or prose outside
the block and its `Expected:` items, sends the step to the operator.

`scripts/ci/test-release.sh` tests every subcommand against a local bare `origin`, a fake `gh` and a fake `archon`.
