# Git

- Branches: `feature/PILOT-<n>-<slug>` or `hotfix/PILOT-<n>-<slug>` (`<n>` is the Trello card number, `<slug>` comes
  from the card title); factory runs use their own `archon/task-factory-*` branch. Features reach `develop` only
  through a reviewed, squash-merged pull request; the release pull request `develop` → `main` and hotfixes into
  `main` are merged by the operator.
- Pull request title: `PILOT-<n>: <card title>`. The pull request body has exactly one line `Type: <type>` (feat,
  fix, chore, docs, refactor, test or ci), and a `BREAKING CHANGE: <what>` line for a breaking change; the squash
  commit is the title and the body.
- Never force-push, never `git reset --hard`, never delete or move a tag. The `mvp-sdlc` hooks block these; if a hook
  blocks you, change the approach instead of looking for a way around it.
- The commits inside a pull request follow Conventional Commits (`feat`, `fix`, `test`, `refactor`, `docs`,
  `chore`, `ci`); they disappear in the squash.
- A task from `tasks/tasks.json` is exactly three commits: `test(...)` with the failing tests, `feat(...)` or
  `fix(...)` that makes them pass, `refactor(...)`. Each carries the trailers `SDLC-Task: <id>` and
  `SDLC-AC: <AC ids>`.
- Stage pull requests (decision 105 c): a feature stage's docs reach `develop` through one docs pull request per
  stage, and the operator's merge of it is the stage's gate (R-C8.9). Where a course skill says "Propose commit", once
  the operator has approved the stage in the skill's own confirmation, run
  `stage-pr <slug> <stage> --message "<commit message>" <the stage's files>` instead: it branches
  `feature/PILOT-<n>-<slug>-<stage>` from a fresh `origin/develop`, commits only those files (and `state.json` when
  the gate advanced it), pushes and opens the `Type: docs` pull request. Never `git add -A`, never commit feature
  artifacts to `develop` or `main`. The handoff names the commit sha and the pull request link, and Run next says
  "merge PR #<n> first". Stages: `/sdlc:interview` → `brief`, `/sdlc:classify-size` → `brief`,
  `/sdlc:fix-term` → `glossary`, `/sdlc:write-prd` → `prd`, `/sdlc:clarify-prd` → `prd`,
  `/sdlc:prepare-design-spec` → `design-spec`, `/sdlc:architecture-design` → `sad`,
  `/sdlc:complete-sequence-diagrams` → `sad`, `/sdlc:decide-adr` → `adr-NNNN`,
  `/sdlc:generate-data-model` → `data-model`, `/sdlc:api-forge` → `contracts`, `/sdlc:plan-tests` → `test-plan`,
  `/sdlc:break-tasks` → `tasks`, `/mvp-sdlc:rails-data-model` → `data-model`, `/mvp-sdlc:task-cards` → `tasks`, and in
  the frontend `/mvp-sdlc:sync-spec` → `spec`.
- Stage files by name. Never commit `.env*` files, `config/master.key`, `.claude/*.local.md` or build output.
- When a task is done, set its row in `docs/features/<slug>/tasks/tracker.md` and its `status` in `tasks.json` to
  `done` in the same pull request.
- Release pull request `develop` → `main`: title `PILOT-<n>: Release vX.Y.Z` (the release's own card, never
  `PILOT-0`; decision 91); its body has `## Changelog` followed by the full `## [X.Y.Z]` section of
  `CHANGELOG.md`, pasted verbatim (decision 64). The release-prep pull request
  `PILOT-<n>: Release X.Y.Z changelog` writes that section first.
- Board flow: the factory moves the task's card (In Progress → Review → Test) from the pull request title line
  `PILOT-<n>: <card title>`; do not move cards by hand. The lists and who moves each:
  https://github.com/OlegShevtsov1/1_mvp_sdlc/blob/main/docs/sdlc/03-dor-dod.md#board-flow
