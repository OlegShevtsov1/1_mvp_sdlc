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
  Removed, Fixed, Security) and an `[Unreleased]` section (R-C8.16) that task PRs update; `/sdlc:ship-feature`
  already writes the feature's own `docs/features/<slug>/CHANGELOG.md` and PR body today.
- **Deterministic pipeline** (R-C8.15): the person pushes an annotated tag on `main`; `release.yml` (planned, C4)
  creates a **draft** GitHub Release from that version's changelog section, with no LLM in CI and no write to `main`;
  the person reviews and publishes it.
- **prod only from a tag**: the prod deploy refuses anything that is not an annotated tag on `main`.
- After a prod deploy `release-watch` (planned, C4) checks health and new GlitchTip issues for 10 minutes and posts
  the result to the project's prod topic. **No automatic rollback**: the decision is the operator's.

## Hotfix

1. If prod is burning, roll back first: `kamal-manage.yml` `action=rollback` with `confirm=prod`, or
   `deploy/rollback.sh prod` from the console.
2. Then fix forward: a `hotfix` card → branch `hotfix/PILOT-<n>-<slug>` from `main`, Dev Deploy from that branch →
   a pull request into `main` and the back-merge pull request into `develop`, both merged by the operator → prod as
   above ([00-operator.md](00-operator.md), section 5). Under the agreed model that is a PATCH tag and the prod deploy from it (planned, C4); nothing reaches prod
   without a tag, a hotfix included.
3. The cause goes into the release's execution log; a defect that review should have caught becomes a saved eval
   ([04-tdd-execution.md](04-tdd-execution.md#defects-become-saved-evals)).
