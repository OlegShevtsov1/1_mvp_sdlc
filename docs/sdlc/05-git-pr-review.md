# Git, pull requests and review

Course basis: GitHub Flow (M9.1), pull requests (M9.4), code review (M9.5).

## Branches and commits

Two models, by repository (decisions 24–29):

- **The develop model**: `1_mvp_pilot_be`, `1_mvp_pilot_fe` and every project made from the S4 templates.
- **GitHub Flow** (R-C8.1): `1_mvp_sdlc`, `1_mvp_infra`, `1_mvp_prompt`. A branch `feat/...` or `fix/...` (docs PRs:
  `docs/...`) → pull request → squash merge into `main`. The develop-model conventions below do not apply there.

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
- **Commits inside the branch**: Conventional Commits with `Co-Authored-By` when an agent wrote the change: `test(`,
  `feat(`, `fix(`, `refactor(`, `docs(`, `ci(`, `chore(`. Task commits are the three TDD commits (R-C3) with the
  `SDLC-Task` and `SDLC-AC` trailers ([04-tdd-execution.md](04-tdd-execution.md)); they disappear in the squash.
- **Factory pull request text**: `/mvp-sdlc:task-brief` puts the title `PILOT-<idShort>: <card title>` and the
  description lines `Type:` (the task's optional `type` in `tasks/tasks.json`, default `feat`), `SDLC-Task` and
  `SDLC-AC` into the factory task. The card number and title come from `state.json`, written by
  `/mvp-sdlc:feature-start` (in the frontend: from the `.spec-source` record of `/mvp-sdlc:sync-spec`). A factory task
  written by hand for an app repository must carry the same lines.
- **Deploy triggers** (decision 28): Dev Deploy (`dev-deploy.yml`) runs on pushes to `develop` and to `hotfix/*`
  branches only; the release pull request deploys nothing by itself, and a `main` commit reaches dev only by a
  dispatch of Dev Deploy on `main`. Prod: `kamal-deploy.yml` with a sha on `main` that Dev Deploy built, by hand
  ([00-operator.md](00-operator.md), step 8); only from an annotated tag on `main` once the release workflow ships
  (planned, C4 and C5).

### The checks that enforce it

- `pr-conventions-check.yml` (decision 29), the authoritative gate, on every pull request into `develop` or `main`:
  (1) the head branch is `feature/PILOT-<n>-<slug>`, `hotfix/PILOT-<n>-<slug>`, `archon/task-factory-*`, or `develop`
  when the base is `main`; (2) the title matches `^PILOT-[0-9]+: .+$`; (3) the body has exactly one line starting
  with `Type:` and its value is one of the seven types.
- `develop-guard.yml`: the twin of `main-guard.yml` for `develop` (decision 27); every commit pushed to `develop`
  must come from a merged pull request, else a Telegram alert.
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
it with their brownfield start (C2, C3) and new projects from the templates (planned, S4).

## Who merges

- **Task PRs (code)**: the factory merges automatically after the operator approved the task plan (gate 2), CI is
  green and its review passed; in the app repositories they go into `develop`. Only the dev deploy follows
  automatically; prod always needs a typed confirm and a ref check (R-C1).
- **PRs with base `main` in the app repositories** (the release `develop` → `main`, a hotfix into `main`) and the
  hotfix back-merge into `develop`: the operator merges by hand; a pull request with base `main` is never merged
  automatically (decision 27). This holds because the factory profile's `base_branch` is `develop` and these pull
  requests are opened by people. `repo.manual_merge_bases: ["main"]` in `.archon/factory-profile.yaml` of the app
  repositories records the rule, but the factory engine does not read that key yet.
- **Docs PRs (feature artifacts)**: the operator merges by hand; that merge is part of the gate (R-C8.9).
- **RULE-LOOP**: if the auto-review misses a P0/P1 finding twice in a row (found later), tasks labelled `migration`,
  `auth` or `security` switch to manual merge (R-C1, variant c) and their review to the large model (R-C12); the
  cases go into the C9 retrospective.

## Review

- **Severity**: P0 (critical: must not merge), P1 (important: fix before the feature is done), P2 (minor: backlog).
  AI review informs, it does not replace the gate.
- **Cost** (R-C5): the factory's built-in multi-lens review on every PR plus `/sdlc:review-feature` once per feature,
  locally, after every task is done. No `claude-code-action` and no Managed Code Review in CI. Revisit only on
  evidence from the metrics that the built-in review misses P0/P1, or on a new operator decision after PUB; checked
  in the monthly review ([09-metrics.md](09-metrics.md)).

## Protection of `main`

Until publication there is no GitHub branch protection (private repositories); `main` is protected in layers (R-C4):

1. the `mvp-sdlc` hooks `block-main-push` and `block-destructive-git` (no push to `main`, no force push, no
   `git reset --hard`, no deleting published tags) and `block-env` (no reading secret files); `block-main-push`
   covers `main`/`master` only today, its extension to `develop` (decision 27) is a follow-up;
2. the same commands in `permissions.deny` of the committed `.claude/settings.json`;
3. the `main-guard.yml` workflow: on every push to `main` it checks through the GitHub API that the commit came from
   a merged pull request, and alerts a Telegram topic otherwise (after the fact: a push cannot be blocked
   technically this way). It runs in this repository and in both app repositories; there `develop-guard.yml` does
   the same for `develop`;
4. after PUB, for `1_mvp_sdlc`, `1_mvp_pilot_be` and `1_mvp_pilot_fe`: real branch protection on `main`, and in the
   app repositories also on `develop` (required checks, no direct pushes; linear history on `main` only in
   `1_mvp_sdlc`, since the release pull request is a merge commit) on top of layers 1–3.

The one exception is the first commit of an empty new repository: a direct push, with the operator's explicit OK.
Stop-hooks that run the tests are not used (an anti-pattern, M5.4); the quality gate is blocking CI (R-C8.12).
