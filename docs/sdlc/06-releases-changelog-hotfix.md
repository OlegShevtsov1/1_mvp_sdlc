# Releases, changelog and hotfixes

Course basis: release and documentation pipelines and RULE-LOOP (M9.7), deploy and rollback (M11.2). Decision: R-C9.

## Today: prod deploys a commit

What exists in `1_mvp_pilot_be` and `1_mvp_pilot_fe` now:

- Every commit pushed to `develop` or a `hotfix/*` branch that passed CI is built once into ECR by **Dev Deploy**
  (`dev-deploy.yml`) and deployed to dev (decision 28); a `main` commit only when Dev Deploy is dispatched on `main`.
- **prod**: `kamal-deploy.yml`, run by hand from `main`, with `environment=prod`, `version` = a commit sha that Dev
  Deploy built, and the confirm word `confirm=prod`. Nothing is built: the dev-tested image is promoted, and the
  deploy completes only after health and a read-only smoke check pass. From the console the same is
  `deploy/deploy.sh prod`.
- **Manage prod**: `kamal-manage.yml` with `action` = `status`, `logs` (no confirm), `restart`, `rollback`
  (`confirm=prod`) or `remove` (`confirm=remove-prod`, after a backup gate). Rollback without a `version` returns to
  the version before the current one. From the console: `deploy/rollback.sh prod`.
- There are no tags and no `CHANGELOG.md` yet.

## Agreed model (R-C9)

Delivered by C4 (backend) and C5 (frontend); everything in this section is planned, C4 and C5.

- **Semantic version tags** `vX.Y.Z` on the app repositories, on `main` after the release pull request `develop` →
  `main`; `next-version.sh` (planned, C4) decides the number from the `Type:` lines of the squash commits (`feat` →
  MINOR, `fix` → PATCH, a `BREAKING CHANGE:` footer → MAJOR, the other types no bump); the agent explains, a person tags
  (M9.7: the script decides, the agent explains, the human confirms).
- **`CHANGELOG.md`** in the repository root, Keep a Changelog with its six categories (Added, Changed, Deprecated,
  Removed, Fixed, Security) and an `[Unreleased]` section (R-C8.16) that stays empty: task PRs add fragments in
  `changelog.d/` and release-prep assembles them into the version section; `/sdlc:ship-feature`
  already writes the feature's own `docs/features/<slug>/CHANGELOG.md` and PR body today.
- **Deterministic pipeline** (R-C8.15): the person pushes an annotated tag on `main`; `release.yml` (planned, C4)
  creates a **draft** GitHub Release from that version's changelog section, with no LLM in CI and no write to `main`;
  the person reviews and publishes it.
- **prod only from a tag**: the prod deploy refuses anything that is not an annotated tag on `main`.
- After a prod deploy `release-watch` (planned, C4) checks health and new GlitchTip issues for 10 minutes and posts
  the result to the project's prod topic. **No automatic rollback**: the decision is the operator's.
- The body of the app repositories' release pull request carries `## Changelog` with the version's section
  (decision 64); the backend and frontend checks for it come with their own cards.

## This repository (1_mvp_sdlc)

- There is no deploy target. A release is the pull request `develop` → `main`, followed by an annotated tag `vX.Y.Z`
  on `main`. The post-merge run of the release-prep pull request merges it with a merge commit (decision 54) through
  `scripts/release.sh merge-release-pr`, and the sdlc-autopilot supervisor approves that step (operator decision
  2026-11-01, PILOT-545).
- The number is the `mvp-sdlc` plugin version in `plugins/mvp-sdlc/.claude-plugin/plugin.json`, bumped in a pull
  request into `develop` after `make eval`.
- Consumers get the release from `main`: the marketplace `mvp` and `install.sh`.
- A hotfix is a branch `hotfix/PILOT-<n>-<slug>` from `main` → a pull request into `main` (merged by the operator) and
  the back-merge pull request into `develop`.
- The public mirror is synced from the released `main` (decision 55).
- The changes are kept in `CHANGELOG.md` (Keep a Changelog), but a task pull request never edits it: it adds one
  fragment `PILOT-<n>.md` in `changelog.d/` for its own card (front matter `category:`, body the entry;
  [changelog.d/README.md](../../changelog.d/README.md)), so tasks in flight never conflict in `[Unreleased]`.
  `bash scripts/ci/check.sh changelog` fails a malformed fragment and any entry under `[Unreleased]`. The release-prep
  pull request `PILOT-<n>: Release X.Y.Z changelog`, where `<n>` is the release's own card (decision 91), runs
  `bash scripts/changelog.sh release X.Y.Z`, which writes `## [X.Y.Z] - YYYY-MM-DD` from the fragments in category
  order, deletes them and leaves `[Unreleased]` empty, and commits that together with the `plugin.json` bump.
- Its "After merge (operator)" writes the release steps as `scripts/release.sh` lines
  ([scripts/release.README.md](../../scripts/release.README.md)): A1 `bash scripts/release.sh merge-release-pr vX.Y.Z`,
  A2 `bash scripts/release.sh tag vX.Y.Z`, A3 `bash scripts/release.sh mirror vX.Y.Z`, A4
  `bash scripts/release.sh install vX.Y.Z`, A5 `bash scripts/release.sh plugin vX.Y.Z`, and
  `bash scripts/release.sh verify vX.Y.Z` as a closing proof. A5 updates `mvp-sdlc` at project scope for be and fe
  from their checkouts' top level without changing their working trees, in place of the operator's hand-run plugin
  update (PILOT-570). Each
  step's command block holds `git fetch origin --tags` and exactly one `release.sh` line; no `cd` is needed, because
  the run's agent already works in the run's worktree. Read-only proof lines may be added. The supervisor approves
  such a step by itself; any other write command, or prose outside the block and its `Expected:` items, sends the
  step to the operator.
- Every release pull request carries its changelog (decision 64):
  - the release pull request `PILOT-<n>: Release vX.Y.Z` has `## Changelog` with that section, and
    `scripts/ci/pr-conventions.sh` fails it otherwise;
  - the mirror sync pull request of a release gets `## Changelog` with the tag's section from
    `scripts/publish-mirror.sh`;
  - the infra promotion pull request lists the changes since the last promotion (`scripts/publish-prod-infra.sh`).

## Hotfix

1. If prod is burning, roll back first: `kamal-manage.yml` `action=rollback` with `confirm=prod`, or
   `deploy/rollback.sh prod` from the console.
2. Then fix forward: a `hotfix` card → branch `hotfix/PILOT-<n>-<slug>` from `main`, Dev Deploy from that branch →
   a pull request into `main` and the back-merge pull request into `develop`, both merged by the operator → prod as
   above ([00-operator.md](00-operator.md), section 5). Under the agreed model that is a PATCH tag and the prod deploy from it (planned, C4); nothing reaches prod
   without a tag, a hotfix included.
3. The cause goes into the release's execution log; a defect that review should have caught becomes a saved eval
   ([04-tdd-execution.md](04-tdd-execution.md#defects-become-saved-evals)).
