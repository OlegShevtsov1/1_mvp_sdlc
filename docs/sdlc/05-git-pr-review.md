# Git, pull requests and review

Course basis: GitHub Flow (M9.1), pull requests (M9.4), code review (M9.5).

## Branches and commits

Two models, by repository (decisions 24–29):

- **The develop model**: `1_mvp_pilot_be`, `1_mvp_pilot_fe`, every project made from the S4 templates, and
  `1_mvp_sdlc` (decision 54).
- **GitHub Flow** (R-C8.1): `1_mvp_infra`, `1_mvp_prompt`. A branch `feat/...` or `fix/...` (docs PRs:
  `docs/...`) → pull request → squash merge into `main`. The develop-model conventions below do not apply there.

### Every change via a pull request

Decision 54: every change in every repository goes through a pull request; there are no direct pushes to a working
or release branch. That covers `develop`, `main` and `env/dev` of the primary repositories; `develop` and `main` of
the public mirrors (decision 51: the sync goes mirror `develop` → PR → mirror `main`; the one sync commit on mirror
`develop` is the documented exception, which is why `develop-guard` is off there); `env/dev` and `env/prod` of the
infrastructure mirror; and `main` of the planning repository. An agent's manual fix is a commit on the branch of an
open pull request.

Not a change, so allowed without a pull request: creating a branch from an existing commit (for example `develop`
itself), the first commit of an empty new repository (with the operator's OK, see "Protection of `main`" below), and
pushing an annotated release tag.

### The develop model

- **Branches** (decision 24): a protected `develop` on top of `main`. A feature or task goes from
  `feature/PILOT-<idShort>-<slug>` into `develop` by a squash-merged pull request. A release is a pull request
  `develop` → `main`, merged with a **merge commit**. A hotfix branch `hotfix/PILOT-<idShort>-<slug>` is cut from
  `main` and merged into `main` by a squash pull request; then the same hotfix branch gets a second pull request into
  `develop` (the back-merge; a pull request from `main` itself would fail the branch-name condition of
  `pr-conventions-check.yml`). `<idShort>` is the number of the Trello card on the project's board (`PILOT` for the
  pilot), `<slug>` is derived from the card title.
- **Factory branches** (decision 26): the factory keeps its own `archon/task-factory-*` branch; it is the accepted
  exception to the names above. A factory task is traced to its card through the pull request title.
- **Squash subject and body** (decision 25): the repositories squash with the pull request title as the subject
  and the pull request body as the body. The title is exactly `PILOT-<idShort>: <card title>`, the Trello card name
  verbatim, with no type prefix. The body has exactly one line `Type: <type>`, one of `feat`, `fix`, `chore`,
  `docs`, `refactor`, `test`, `ci`, always, also for the types that do not change the version. A
  `BREAKING CHANGE: <what>` footer marks a MAJOR change (R-C9, unchanged). `next-version.sh` (planned, C4) reads the
  `Type:` line, not a subject prefix: `feat` → MINOR, `fix` → PATCH, the rest no bump.
- **Release titles** (decision 91): every release, interim ones included, has its own Trello card. The release-prep
  pull request is `PILOT-<card>: Release X.Y.Z changelog`; the release pull request `develop` → `main` and the mirror
  sync pull request are `PILOT-<card>: Release vX.Y.Z`. `PILOT-0` is only for card-less chores, never for a release;
  how the release card moves is in [Board flow](03-dor-dod.md#board-flow).
- **Commits inside the branch**: Conventional Commits with `Co-Authored-By` when an agent wrote the change: `test(`,
  `feat(`, `fix(`, `refactor(`, `docs(`, `ci(`, `chore(`. Task commits are the three TDD commits (R-C3) with the
  `SDLC-Task` and `SDLC-AC` trailers ([04-tdd-execution.md](04-tdd-execution.md)); they disappear in the squash.
- **Factory pull request text**: `/mvp-sdlc:task-brief` puts the title `PILOT-<task card idShort>: <task title>` and
  the description lines `Type:` (the task's optional `type` in `tasks/tasks.json`, default `feat`), `SDLC-Task` and
  `SDLC-AC` into the factory task. The task card number comes from `tasks/tasks.json`, written by
  `/mvp-sdlc:task-cards` (decision 78); a task without a card falls back, with a warning, to the feature card's
  `PILOT-<n>: <card title>` from `state.json`, written by `/mvp-sdlc:feature-start` (in the frontend: from the
  `.spec-source` record of `/mvp-sdlc:sync-spec`). Frontend tasks are briefed with `--from <be checkout>`. A factory task
  written by hand for an app repository must carry the same lines.
- **Deploy triggers** (decision 28): Dev Deploy (`dev-deploy.yml`) runs on pushes to `develop` and to `hotfix/*`
  branches only; the release pull request deploys nothing by itself, and a `main` commit reaches dev only by a
  dispatch of Dev Deploy on `main`. Prod: `kamal-deploy.yml` with a sha on `main` that Dev Deploy built, by hand
  ([00-operator.md](00-operator.md), step 8); only from an annotated tag on `main` once the release workflow ships
  (planned, C4 and C5).

### In this repository (1_mvp_sdlc)

- Factory branches `archon/task-factory-*` and human branches `feature/PILOT-<n>-<slug>` or
  `hotfix/PILOT-<n>-<slug>` go into `develop`.
- `main` is what the marketplace `mvp` and `install.sh` users read; it stays the default branch.
- A release is a pull request `develop` → `main` (title `PILOT-<n>: Release vX.Y.Z` (decisions 58, 91: the
  release's own card), `Type: chore`, head `develop`, and a body that carries `## Changelog` with the version's
  `CHANGELOG.md` section) that the operator merges with a merge commit, then the annotated tag `vX.Y.Z` equal to
  the `mvp-sdlc` version ([06-releases-changelog-hotfix.md](06-releases-changelog-hotfix.md)).
- No deploy, no Dev Deploy and no `tdd-check.yml` here. The checks are `ci.yml`, `pr-conventions-check.yml`
  (`scripts/ci/pr-conventions.sh`), `develop-guard.yml` and `main-guard.yml` (`scripts/ci/main-guard.sh`, alerts to
  `MVP_VPN_ALERTS`).

### The checks that enforce it

- `pr-conventions-check.yml` (decision 29), the authoritative gate, on every pull request into `develop` or `main`:
  (1) the head branch is `feature/PILOT-<n>-<slug>`, `hotfix/PILOT-<n>-<slug>`, `archon/task-factory-*`, or `develop`
  when the base is `main`; (2) the title matches `^PILOT-[0-9]+: .+$`; (3) the body has exactly one line starting
  with `Type:` and its value is one of the seven types; (4) a release pull request `PILOT-<n>: Release vX.Y.Z`
  carries a non-empty `## Changelog` section for the version (decision 64; in this repository); (5) a title
  `PILOT-0…: Release …` fails, into any base (decision 91; in every develop-model repository, condition 4 of the
  be/fe templates).
- `develop-guard.yml`: the twin of `main-guard.yml` for `develop` (decision 27); every commit pushed to `develop`
  must come from a merged pull request, else a Telegram alert. Skipped where the repository variable `MIRROR` is
  `true` (the public mirrors, decision 51).
- `main-guard.yml`: the same for `main` (see "Protection of `main`" below).
- `tdd-check.yml`: the order of the TDD commits and RED on the test commit (R-C3). Decision 27 needs it on
  feature/hotfix → `develop` and hotfix → `main`, not on the release pull request; today it runs on every pull
  request.
- `check-branch-name` (PreToolUse Bash) — warns, never blocks, when `git checkout -b`, `git switch -c` or
  `git branch <name>` creates a branch whose name is not `feature/PILOT-<n>-<slug>` or `hotfix/PILOT-<n>-<slug>`;
  factory branches `archon/task-factory-…` are exempt (decision 26). It is a hint for the session only; the
  authoritative check is `pr-conventions-check.yml`.
- After PUB, `pr-conventions-check.yml` joins the required status checks of the branch protection of both `main`
  and `develop` (PUB step 7).

### Both models

- Draft PRs: when the factory decides (deliver); by hand, after the first clean commit (R-C8.18).
- **Squash merge** (R-C8.2): one commit per PR on the target branch; the only merge commit is the release pull
  request `develop` → `main` of the develop model.

## Pull request template

`templates/github/pull_request_template.md` is the task Definition of Done as a checklist; the app repositories get
it with their brownfield start (C2, C3) and new projects from the templates in
`templates/project-be/` and `templates/project-fe/`.

## Who merges

- **Task PRs (code)**: the factory merges automatically after the operator approved the task plan (gate 2), CI is
  green and its review passed; in the app repositories they go into `develop`. Only the dev deploy follows
  automatically; prod always needs a typed confirm and a ref check (R-C1). The one exception to the review's round
  cap (PILOT-300, decisions 93, 99, 100): when the delivery stops from round 3 on and its only open blockers re-raise
  earlier findings on narrower cases, with every other contract item met and CI green, the factory creates a
  follow-up card (label `task`, in `Ready`) per such finding, links the cards in the PR description and the run
  report, and merges; a new defect class, an unmet contract item or red CI still stops the run.
- **PRs with base `main` in the develop-model repositories, `1_mvp_sdlc` included** (the release `develop` → `main`, a hotfix into `main`) and the
  hotfix back-merge into `develop`: the operator merges by hand; a pull request with base `main` is never merged
  automatically (decision 27). The factory enforces it through `repo.manual_merge_bases: ["main"]` in
  `.archon/factory-profile.yaml` of the develop-model repositories (an absent key means `["main"]`): a green pull request into
  a listed base is not merged, the factory comments on it for the operator, and the run ends
  `delivered-pending-operator`.
- **Docs PRs (feature artifacts)**: the operator merges by hand; that merge is part of the gate (R-C8.9).
- **RULE-LOOP**: if the auto-review misses a P0/P1 finding twice in a row (found later), tasks labelled `migration`,
  `auth` or `security` switch to manual merge (R-C1, variant c) and their review to the large model (R-C12); the
  cases go into the C9 retrospective.

## Review

- **Severity**: P0 (critical: must not merge), P1 (important: fix before the feature is done), P2 (minor: backlog).
  AI review informs, it does not replace the gate.
- **AI PR review** (decisions 32, 103 a): in the app repositories and every project made from the templates,
  `ai-review.yml` (off unless the repository variable `AI_REVIEW` is `on`) reviews every pull request, factory PRs
  included; drafts, Dependabot and the release PR `develop` → `main` are skipped. `claude-code-action` reviews with
  read-only tools, then a script posts one GitHub pull request review per head commit as `github-actions`, shown
  under Reviewers. Findings on changed lines are inline comments, the others are listed in the review body, each
  finding once; the body and every inline comment are capped at 60000 characters, below GitHub's limit, with a
  truncation note. The review state is *Request changes* on P0/P1 and *Comment* otherwise; a later clean review
  dismisses the earlier *Request changes*. The script knows its own reviews by the `github-actions` login and the
  `<!-- ai-review -->` marker that starts their body, both for the dismissal and for posting nothing on a head it
  already reviewed. P0/P1 or a missing summary turn the check `ai-review` red, and the job log lists every P0/P1
  for the factory's CI-failure handling. A comment `@claude review` asks for a re-review, which posts nothing new on
  an unchanged head.
- **Cost** (R-C5): the factory's built-in multi-lens review on every PR, the AI PR review above, and
  `/sdlc:review-feature` once per feature, locally, after every task is done. No Managed Code Review in CI. Revisit
  only on evidence from the metrics that the built-in review misses P0/P1, or on a new operator decision after PUB;
  checked in the monthly review ([09-metrics.md](09-metrics.md)).

## Protection of `main`

Until publication there is no GitHub branch protection (private repositories); `main` is protected in layers (R-C4):

1. the `mvp-sdlc` hooks `block-main-push` and `block-destructive-git` (no push to `main`, no force push, no
   `git reset --hard`, no deleting published tags) and `block-env` (no reading secret files); `block-main-push`
   covers `main`/`master` only today, its extension to `develop` (decision 27) is a follow-up;
2. the same commands in `permissions.deny` of the committed `.claude/settings.json`;
3. the `main-guard.yml` workflow: on every push to `main` it checks through the GitHub API that the commit came from
   a merged pull request, and alerts a Telegram topic otherwise (after the fact: a push cannot be blocked
   technically this way). It runs in this repository and in both app repositories, and `develop-guard.yml` does
   the same for `develop` in all three;
4. after PUB, for `1_mvp_sdlc`, `1_mvp_pilot_be` and `1_mvp_pilot_fe`: real branch protection on `main` and on
   `develop` (required checks, no direct pushes) on top of layers 1–3.

The one exception is the first commit of an empty new repository: a direct push, with the operator's explicit OK.
Stop-hooks that run the tests are not used (an anti-pattern, M5.4); the quality gate is blocking CI (R-C8.12).
