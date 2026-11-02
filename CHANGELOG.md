# Changelog

All notable changes to this repository are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version is the `mvp-sdlc` plugin version, tagged
`vX.Y.Z` on `main` after the release pull request `develop` → `main`. A task never edits this file: it adds a
fragment `changelog.d/PILOT-<n>.md` ([changelog.d/README.md](changelog.d/README.md)), and `[Unreleased]` stays the six
empty categories. Release-prep runs `scripts/changelog.sh release X.Y.Z`, which assembles the fragments into a new
`## [X.Y.Z] - YYYY-MM-DD` section; the release pull request `PILOT-<n>: Release vX.Y.Z` carries that section under `## Changelog` (decision 64, checked by
`scripts/ci/pr-conventions.sh`).

## [Unreleased]

### Added

### Changed

### Deprecated

### Removed

### Fixed

### Security

## [0.10.0] - 2026-11-02

### Added

- `scripts/release.sh plugin vX.Y.Z` (PILOT-570): refreshes the marketplace `mvp`, updates `mvp-sdlc@mvp` at project
  scope for the be and fe checkouts (`RELEASE_PLUGIN_PROJECTS`) without touching their working trees, and proves the
  plugin cache and each project's entry in `claude plugin list --json`. The supervisor's `post-merge-allowlist`
  approves it, so a release's plugin step is no longer the operator's.
- The factory can pause for the operator's approval before it merges (PILOT-572, E3): a new profile key
  `repo.merge_approval: auto | operator`. With `operator`, after a green merge gate the run pauses at the wait
  `pr-approve`, whose message carries the lines `PR:`, `Head:`, `Diff:`, `Checks:`, `Review:` and `Summary:` for the
  supervisor's card. `approve` merges exactly the paused head (`gh pr merge --match-head-commit`); a head that moved
  since the pause is gated again and asked about, and in the last round stops the run unmerged. `reject <text>` runs one
  more delivery round on the same pull request with the text as its finding, then asks again (at most 4 rounds). The
  label `operator-approved`, added while a head is paused, approves it too. A bookkeeping pull request (a tracker or an
  execution log) merges without the pause. Absent means `auto`, today's behaviour; no profile changes in this release,
  and the project templates ship `auto`.
- The supervisor sends the factory's `pr-approve` pause as a Telegram card «PR готовий» (PILOT-573, E3): the PR title,
  a link to the pull request, `Diff`, `Checks`, the summary, and the buttons `✅ Апрув` and `↩️ Повернути`. A new
  policy rule `pr-approve` (`action: escalate-as-card`) always escalates the pause. «Повернути» asks «Що змінити?» with
  a ForceReply and answers `reject` with the operator's reply as the text; a reply without text answers nothing and
  asks again. Every respond now passes its text after `--`, so a reason that starts with `-` reaches Archon. It acts
  only once a profile sets `merge_approval: operator`.
- The factory collects QA dev evidence after the deploy and pauses for the operator's verdict on dev (PILOT-574, E3):
  a new optional profile key `qa_dev: { e2e_workflow, pages: [{glob, url}] }`. With it, after deploy and health the
  node `qa-dev-evidence` waits up to 20 minutes for the e2e workflow's run on the commit that is on dev now (the newest
  run of the merge commit or of a commit that contains it, matched by `sha-<commit>` in the run's title, else its
  `headSha`), shoots each dev page whose glob matches a changed file at 1440×900 and 360×800 with the checkout's
  Playwright, and writes `qa-dev.json` (`{sha, url, e2e: {conclusion, run_url}, shots: [{page, width, path}]}`). After
  the report and the card's move to Test the run pauses at the wait `qa-dev` (`ok` | `reject`), whose message carries
  the lines `URL:`, `SHA:`, `PR:`, `E2E:`, `Shots:` and `Evidence:` for the supervisor's card. A red deploy, health,
  rollback or e2e, or any state it cannot read, gives no pause: one Telegram alert to `MVP_VPN_ALERTS` with the run's
  link, and the report ends `Not delivered: deployed and healthy, but QA dev has no proof: …`. Absent means today's
  flow. No profile sets `qa_dev` in this release.
- The supervisor sends the factory's `qa-dev` pause as a Telegram card «На dev готово» (PILOT-575, E3): first the
  screenshots as one album (`sendMediaGroup`, at most 6, read only from the run's own `qa-dev.json` when its commit is
  the paused one; past 6 the card says how many were left out), then the card with the title, links to dev, the e2e
  run and the PR, and the buttons `✅ Прийнято` and `↩️ Є зауваження`. A new policy rule `qa-dev`
  (`action: escalate-as-card`) always escalates the pause. «Прийнято» answers `ok` and moves the task's Trello card to
  `Ready to Release` (credentials from `~/.config/trello/.env`); «Є зауваження» asks for the text with a ForceReply,
  answers `reject` with it and queues the fix brief `queue/<repo>/fix-PILOT-<n>-<run8>.md` (`Fix for PILOT-<n>:
  <text>`, the card link, the PR and the original task's paths). A failed move or brief is escalated as its own
  message. It acts only once a profile sets `qa_dev`.
- The supervisor takes `/task <be|fe|sdlc> <text>` in Telegram (PILOT-576, E3): it creates the Trello card
  `t<n>: <first line>` in Backlog (of `TRELLO_BOARD_ID_<PROJECT_NAME>` of the be checkout, as `feature-start` reads
  it, else `TRELLO_BOARD_ID`), and for `be` and `fe` runs the SDLC stages one by one as headless
  `claude -p` sessions (`/mvp-sdlc:feature-start` → `/sdlc:write-prd` → `/sdlc:architecture-design` → `/sdlc:api-forge`
  → `/sdlc:break-tasks` → `/mvp-sdlc:task-cards`; `fe` then `/mvp-sdlc:sync-spec` in fe) in a fresh worktree of the
  be checkout, through the queue's run slots. The session takes the task text as its answers, picks the recommended
  option at each checkpoint and records its assumptions in the stage document. Each stage's docs PR comes as the «PR
  готовий» card once its checks pass; `✅ Апрув` merges the head the card showed (a moved head is refused and asked
  again), and queues the next stage, `↩️ Повернути` reruns the stage on its PR branch with the reason, and the label
  `operator-approved` or a merge on GitHub advance it too. After the last stage one factory brief per open task of
  `tasks.json` is queued with `task-brief`; tasks with unfinished dependencies wait. `/task sdlc` only creates the card,
  and a malformed `/task` gets a format hint. Chains live in `stages.json`; new ledger rules `stage-failed`,
  `stage-no-pr`, `stage-ci-red`, `stage-pr-closed`, `stage-merge-failed`, `stage-task-brief` and `queue-stage-hung`.
  Nothing changes until the next sdlc release installs the supervisor.
- Changelog fragments (PILOT-579): a task pull request adds `changelog.d/PILOT-<n>.md` (front matter `category:`,
  body the entry; `changelog.d/README.md`) instead of editing `CHANGELOG.md`, so sdlc tasks in flight no longer
  conflict in `[Unreleased]`. A new check `check.sh changelog` (`scripts/changelog.sh check`, its own CI step) fails a
  malformed fragment and any entry under `[Unreleased]`, which now always stays the six empty categories.
  Release-prep runs `scripts/changelog.sh release X.Y.Z` to assemble the fragments into `## [X.Y.Z] - YYYY-MM-DD` in
  category order, by card number, and delete them. The pending `[Unreleased]` entries moved to fragments.

### Changed

### Deprecated

### Removed

### Fixed

- `publish-mirror.sh` no longer merges the mirror PR while its checks are still queued: a check run that is not
  completed keeps the PR waiting whatever its start time, the newest-run rule only picks among completed runs of a
  name, and a GitHub Actions check suite that has no check runs yet keeps it waiting too. Before, the v0.9.4 mirror PR
  was merged three seconds after it opened, on a lone skipped run (PILOT-560).
- The supervisor's Telegram escalations close reliably and say what to do (PILOT-569). The tick reads the runs again
  right before sending, so a pause answered outside Telegram during the tick is no longer sent with live buttons (the
  e9af1deb A9 message was sent 8 s after its CLI answer). A close whose edit failed with no answer, 429 or a server
  error is retried on the next tick instead of being forgotten, and every close is logged. The post-merge step line uses
  the step's full heading from `steps.json`, shortened at a word boundary to at most 90 characters with `…`, instead of
  the heading cut mid-word (`… prove the plugin cache holds 0`). A checkout step's recommendation says what to run:
  `claude plugin update mvp-sdlc@mvp --scope project` in be and fe for a plugin update, else the step's commands,
  shown in the details.

### Security

## [0.9.5] - 2026-11-01

### Added

### Changed

### Deprecated

### Removed

### Fixed

- Runs that `sdlc-autopilot` starts (respond, resume, queued `archon workflow run`, post-merge `launch.ts`) now get
  the operator's toolchain PATH: `install.sh` renders the unit's `PATH` from the login shell's PATH (a clean
  `$SHELL -lc`, else the current PATH) plus the existing `~/.rbenv/shims`, `~/.rbenv/bin`, newest
  `~/.nvm/versions/node/*/bin`, `~/.pyenv/shims` and `~/.tfenv/bin`, each directory once with the standard
  directories last, and warns when `ruby`, `bundle` or `node` does not resolve; `runDetached` passes the
  supervisor's environment explicitly. Before, be/fe merge gates failed with `bundle: command not found`
  (PILOT-559).

### Security

## [0.9.4] - 2026-11-01

### Added

### Changed

- The `sdlc-autopilot` supervisor writes its Telegram escalations in plain Ukrainian (HTML): one header naming the
  release, card or run, the step in words, what happened, a recommendation where a rule gives one, and the original
  pause text in a collapsed block, with plain button labels. A message whose pause was answered — by its button,
  outside Telegram, or because the run moved on — is edited once with the outcome and loses its buttons (PILOT-544).
- The `sdlc-autopilot` supervisor approves a post-merge step of type approval or manual whose only write command is
  one `bash scripts/release.sh <subcommand> v<semver>` line (rule `post-merge-allowlist`); the new
  `scripts/release.sh` runs the release steps `merge-release-pr`, `tag`, `mirror`, `install` and `verify` as
  reviewed, idempotent code. Every other post-merge step still escalates. This replaces PILOT-509's rule that every
  post-merge gate escalates (operator decision 2026-11-01, PILOT-545).

### Deprecated

### Removed

### Fixed

- Telegram button presses under `sdlc-autopilot` escalations get feedback again. The supervisor read updates only
  inside its 30 s tick, after Telegram's ~15 s window to answer a press had passed. Updates are now read by long
  polling in their own loop, and each press is answered at once with a toast (`✅ Прийнято, виконую`,
  `⏭ Пропускаю крок`, `⛔ Зупиняю`, `🔁 Чекаю далі`, or `Це питання вже вирішене`); only the first press on an open
  pause acts (PILOT-546).

### Security

## [0.9.3] - 2026-11-01

### Added

### Changed

### Deprecated

### Removed

### Fixed

- The supervisor fixture `orchestration/supervisor/tests/fixtures/post-merge-gate-c2154fea.json` no longer quotes the
  owner display name from the v0.8.0 A3 pause text (now `<owner name>`), so the release owner scan of the public
  mirror prints 0 again. Primary CI now runs the mirror owner scan (`check.sh owner`) over the tree publish-mirror
  would publish, using publish-mirror's own leftover scan. That scan now also refuses the owner display name in any
  letter case, as the release scan does, and publish-mirror no longer stops silently on a tree with no owner string
  (PILOT-536).
- The supervisor's `limits.min_mem_available_mb` is now 800 (was 1500, above the 7.9 GB host's idle MemAvailable of
  about 1342 MB, so no queued brief or post-merge launch ever started). A brief or post-merge launch that waits only
  for the host now names the limit and the measured value in the journal, e.g. `MemAvailable 700 MB < 800 MB`
  (PILOT-540).

### Security

## [0.9.2] - 2026-11-01

### Added

### Changed

### Deprecated

### Removed

### Fixed

- `publish-mirror` judges each check of the mirror PR by its newest run, so a run cancelled because publish-mirror's own
  title edit superseded it no longer counts as red and blocks the merge; a cancelled newest run still does (PILOT-528).
- The `sdlc-autopilot` supervisor launches `post-merge` only for PRs merged at or after `post_merge.since` in its
  `policy.yaml` (set to 2026-11-01 06:00 UTC), else its first start, kept in `~/.local/state/sdlc-autopilot/state.json`,
  so enabling it no longer re-runs post-merge for PRs merged before; a `post-merge` run naming the PR by URL,
  `owner/repo#n` or `#n` in its repo suppresses the launch (PILOT-533).

### Security

## [0.9.1] - 2026-11-01

### Added

### Changed

### Deprecated

### Removed

### Fixed

- The `sdlc-autopilot` supervisor's ledger no longer masks a file path with a mixed-case segment (such as the mirror's
  `OlegShevtsov1` owner) as a base64 secret: the base64 rule now stops at `/` and masks only contiguous blobs
  (PILOT-521).
- The `sdlc-autopilot` systemd unit that `install.sh` renders now puts the Claude CLI's directory (`command -v
  claude`, else `~/.local/bin` with a warning) and the bun, archon and gh directories on its `PATH`, each once and
  ahead of `/usr/local/bin:/usr/bin:/bin`; `scripts/ci/archon-check.sh` renders the unit into a scratch
  `XDG_CONFIG_HOME` instead of overwriting the operator's (PILOT-524).

### Security

## [0.9.0] - 2026-11-01

### Added

- `orchestration/supervisor/`, the skeleton of the `sdlc-autopilot` supervisor: every 30 s it reads Archon's run
  state read-only, classifies each pause as plan gate, install gate, post-merge gate or other, and writes one line
  per pause event to `~/.local/state/sdlc-autopilot/ledger.jsonl`, including pauses that predate its start. Its
  `policy.yaml` starts without rules. `install.sh` copies it to `~/.archon/supervisor` and renders its systemd user
  unit `sdlc-autopilot.service` without enabling it, and `scripts/ci/check.sh supervisor` runs its tests in CI
  (PILOT-507).
- The `sdlc-autopilot` supervisor launches `post-merge` once for every PR of a factory run that finished (completed
  or cancelled) in the last 14 days and that GitHub reports merged, with `run=PILOT<n>` for a `PILOT-<n>: Release …`
  PR and `run=C8.Tn pr=<url> part=C8.TnP<n>` otherwise. It skips a PR that already has a post-merge run, failed ones
  included, waits while load1 > 8, `MemAvailable` < 1500 MB, 5 runs or 3 runs of the repo are running, escalates a
  PR without a `PILOT-<n>:` title, in a repo outside its reach or whose launch fails, and starts `launch.ts`
  detached; every launch is a ledger line (PILOT-510).
- The `sdlc-autopilot` supervisor resumes a failed run whose error is transient (Claude session limit, OAuth, GitHub
  5xx, network, SIGTERM, no first output within 60 s, `database is locked`) with `archon workflow resume` after 2, 5
  and 15 minutes, at most 3 times per run and class, then escalates once with the class and a recommendation, kept in
  the ledger line's `evidence.message`. A resume that leaves no new failure event counts as an attempt and is retried
  on the same event. It never resumes over a live owner process or while the host has under 1500 MB available or load1
  above 8, and escalates failures older than 60 minutes, or whose time cannot be read, instead of resuming them
  (`policy.yaml` rule `transient-resume`). A resume that cannot start (the run has no working directory, it is not a
  git work tree, or `archon` is not on PATH) is escalated, a run in `1_hrss_pilot` or `pilot-srv-*` is escalated and
  never resumed, and a malformed rule stops the supervisor at startup. Ledger evidence text and message are stored with token-like strings masked (PILOT-508).
- sdlc-autopilot gate policy: the supervisor answers a plan gate whose plan is ready and has only Non-blocking open
  questions, retries an install gate while an active factory run blocks it (up to 4 retries, ≈1 h), escalates every
  post-merge gate, 🔒 steps included, and escalates everything else; answers go
  through a detached `archon workflow respond` with the pause's occurrence (PILOT-509).
- The `sdlc-autopilot` supervisor starts queued factory briefs: a ready brief put in
  `~/.config/sdlc-autopilot/queue/<repo>/<name>.md` is launched detached as `archon workflow run factory` in that
  repo's checkout, `1_mvp_sdlc` first and then oldest first, and moved to `queue/started/<repo>/`, renamed
  `<run-id>--<name>.md` once the Archon run carrying its launch marker (a trailing `sdlc-autopilot-launch: <uuid>`
  line of the factory message) shows up. A brief does not start while an open factory run of its repo, a paused one
  included, names an overlapping repo-relative path (`CHANGELOG.md`, or a file under a named directory), and a brief
  that names no path runs alone in its repo. Queued briefs and post-merge launches share the limits, now in
  `policy.yaml` (5 runs, 3 per repo, `MemAvailable` ≥ 1500 MB, load1 ≤ 8); transient resumes read the same host
  threshold, and the `transient-resume` rule no longer has its own `host` key. A brief for an unknown or out-of-reach repo, without a `PILOT-<n>` card,
  whose launch fails or whose run does not show up within 15 minutes escalates once. Once a day the supervisor
  removes test leftovers older than 24 h (`~/.cache/orchestration-tests/run-*`, `/tmp/bun-*`) (PILOT-511).
- The `sdlc-autopilot` supervisor sends every escalation of the last 24 h to the operator as one Telegram message
  (`@mvp_vpn_alerts_bot`, variables `TELEGRAM_MVP_VPN_ALERTS_{BOT_TOKEN,CHAT_ID,THREAD_ID}` from
  `~/.config/telegram-bots/.env`) naming the run, the step and the reason, and retries a send that fails on the next
  tick. A message about an open pause carries that pause's own buttons (approve/skip/abort on a post-merge gate,
  retry/abort on an install gate); a press from the operator's chat answers that pause once with
  `archon workflow respond --occurrence` and is written to the ledger with `rule: operator`, and `/status` replies
  with the running runs, the runs waiting for the operator, the queue and the next brief. Updates from other chats
  are ignored, and the bot token never reaches the ledger, the state file or the logs (PILOT-512).

### Changed

### Deprecated

### Removed

### Fixed

- The after-merge test fixture `plugins/mvp-sdlc/tests/fixtures/after-merge/sdlc-77.md` no longer quotes the owner
  display name from its mirror owner scan (now `<owner name>`), so the release owner scan of the public mirror prints
  0 again (PILOT-505).

### Security

## [0.8.0] - 2026-10-31

### Added

- The factory profile takes an optional `stack.preflight` block: `tools` that must be on `PATH`, TCP `services`
  (`{name, tcp: "host:port", start}` with an optional start command, at most 8) and `min_disk_free_pct` (default
  20). The new `preflight` node checks it before any work, and `merge-gate` checks it again right before the test
  command. A down service is started once and polled for 60 s; low disk runs the leftovers cleanup and is measured
  again. Anything still missing stops the run with one message naming the fix: before any work as `Stopped before
  any work: preflight: …`, at the merge gate as the refusal class `preflight` with the pull request left open. A
  profile without the block behaves as before. The project-be (tools, test Postgres and Redis, check-only) and
  project-fe (tools) profile templates declare their blocks (PILOT-499).

### Changed

### Deprecated

### Removed

### Fixed

- `scripts/ci/hygiene-check.sh` no longer reports 12 consecutive digits inside a hex git SHA (or any alphanumeric
  token) as an AWS account ID, so `publish-mirror.sh` no longer refuses a sync whose `MIRROR_SOURCE.json` carries such
  a SHA; a standalone account ID, one in an ARN and one in an ECR host are still caught (PILOT-482).
- `task-brief --check-after-merge` accepts the bold `**A<n> — <title>**` steps that post-merge and release pull
  requests use, with text after the closing `**` as post-merge allows: steps with a fenced block (its `Run:` line
  optional) and prose steps whose commands are inline code. A section that mixes them with `### A<n>` steps is
  refused, since post-merge would run the heading as part of the bold step above it. Prose expectations (an inline
  `Expected: <text>`, a prose item, an output sample) and prose steps are warnings; the new `--strict` refuses them
  (PILOT-478).
- The factory's merge rebases once when `gh pr merge` fails on a conflict that appeared after `pr-state` (another PR
  merged during the gate), then runs `pr-state` and `merge-gate` again on the new head before merging; a PR already
  merged at the run's head is reported delivered and deployed instead of refused, while one merged at another head is
  still refused (PILOT-492).
- The factory's squash merge passes the pull request title plus ` (#<n>)` as the commit subject (`gh pr merge --squash
  --subject`), so a one-commit PR keeps its `PILOT-<n>:` prefix instead of GitHub's default, that commit's subject; the
  body is unchanged, and a PR already merged is still not merged again (PILOT-497).

### Security

## [0.7.0] - 2026-10-31

### Added

- `task-brief --check-after-merge <file|PR>` validates the `## After merge (operator)` section of a factory message
  or a pull request body against a schema (`### A<n> — <title>` steps, optional 🔒, one fenced `Run:` block, an
  `Expected:` list of `check: <kind> <args>` and `manual:` lines; kinds `gh-pr-merged`, `workflow-run-success`,
  `url-contains`, `http-ok`, `git-tag-at`, `file-contains`) and reports each error with its line. A deferred step
  (no command, or "separate task", "after the release", "later") is refused with the Backlog card it becomes;
  `--create-cards` creates that card linked to the task card and drops the step. The brief points to the format
  (PILOT-472).

### Changed

### Deprecated

### Removed

### Fixed

- `bin/wait-dev-deploy` of the be and fe templates finds the commit's Dev Deploy run by its title
  `Dev Deploy sha-<sha>` (be gains the `run-name` and catches up with the be project's waiter), waits for the
  duplicate that deploys instead of a skipped one, and reports success when a newer develop commit that contains
  the merge deployed after its own run was superseded or cancelled. be retries GitHub 5xx and network errors (3
  tries) and waits 1440 s by default. fe exits 3 with "dev auto-deploy disabled" when Front CI passed but
  `DEV_AUTO_DEPLOY` is not `true` (PILOT-471).
- The factory's merge gate no longer merges with unfinished CI and handles the causes it used to refuse on
  (PILOT-470): a check still pending after `pr-state`'s 20-minute wait gets one more wait and then refuses
  (`pending: checks still pending after N min`); a red check that the new profile setting `stack.flaky_patterns`
  (substrings of a job name or its failed-step log, empty by default) names gets one `gh run rerun --failed` before
  it refuses as `flaky-after-rerun`; ignored `__pycache__/` and `.terraform/` leftovers are removed before the test
  command; a pull request that conflicts with its base is rebased once and pushed with `--force-with-lease`, and a
  rebase that conflicts refuses with the conflicting files for a replan; every refusal reason is one line that
  starts with its class (`pending`, `flaky-after-rerun`, `failure`, `timeout`, `conflict`).

### Security

## [0.6.0] - 2026-10-29

### Added

### Changed

- Every feature stage commits, pushes and opens its docs PR by itself (PILOT-373, decision 105 c): the new
  `mvp-sdlc` command `stage-pr` branches `feature/PILOT-<n>-<slug>-<stage>` from a fresh `origin/develop`, commits
  only the stage's files (and `state.json`), pushes and opens a `Type: docs` pull request titled
  `PILOT-<n>: <card title> — <stage>`, refusing on unrelated changes or nothing to commit; `sdlc-gate-hook` fetches
  the base before the gate and tells the course feature-stage skills to run it instead of "Propose commit", and
  `sync-spec`, `task-cards` and `rails-data-model` run it themselves; a blocked gate names the artifact's open pull
  request. The operator still merges each stage's PR by hand (R-C8.9); the course plugin `plugins/sdlc/` is
  unchanged (R-B1).
- The AI review of the be and fe templates takes its auth secret, model and the backend's authorization wording from
  render placeholders with documented defaults (`ANTHROPIC_API_KEY`, `claude-sonnet-5`), overridden per project in
  `templates/projects/<name>.env`, and names the ticket key and the factory branch in its conventions; a `pilot`
  render reproduces the pilot's `ai-review.yml` and its workflow test byte for byte (PILOT-396).

### Deprecated

### Removed

### Fixed

- The merge gate's test-command limit is a profile setting (PILOT-375): `stack.test_timeout_seconds` (whole seconds,
  1 to 3600; absent means the old fixed 1000 s). A test command that outlives it runs once more before the gate
  refuses, and the refusal reads `test command timed out after N s …` instead of `test command exited 124`; a command
  that exits 124 by itself is still reported as exiting 124. The `merge-gate` node timeout grows from 3600 s to
  9600 s to cover a retried test at the maximum plus lint and build. This repository's profile sets 2400 s:
  `check.sh` had outgrown 1000 s under parallel factory load and stopped merges into it.
- Both CI jobs in `ci.yml` have a 30-minute limit, up from 10 (`Actionlint, hygiene, gitleaks`) and 20 (`Archon
  workflows`), so a 2-3x slowdown of the shared self-hosted runner no longer cancels them (PILOT-429).

### Security

## [0.5.0] - 2026-10-28

### Added

- `sync-spec` copies the frontend's own tasks (PILOT-397, mvp-sdlc 0.5.0): `tasks/tasks.json` reduced to the tasks
  whose `"repo"` is the frontend (deps on backend tasks move to `"external_deps"`), their task files and the epic, so
  `/sdlc:implement-tasks <slug>` runs in the frontend. `tasks/tracker.md` stays in the backend, which owns task
  status. `--check` also covers the task copy and fails on a file under `tasks/` that is not a copy; a re-sync
  removes a copied file that is no longer a source. `task-brief --from` works next to the copy and is required for
  it. The operator guide makes the factory the default for code and `implement-tasks` the supported alternative, with
  the steps the operator then does by hand.
- A blocker re-raised on a narrower case from round 3 on becomes a follow-up card (PILOT-300, decisions 93, 99, 100):
  when the bundled delivery ends `replan` at round 3 or later, or at the round cap, and its only open blockers
  re-raise earlier findings on narrower cases, every other contract item is met and CI is green, the factory creates
  a Trello card per such finding (label `task`, in `Ready`), links the cards in the PR description and the run
  report, marks the PR ready and goes on to the merge gate. New nodes `review-state`, `followup-judge` and
  `review-followup`; two fixtures cover both paths.

### Changed

- The AI PR review of the be and fe templates posts a GitHub pull request review (PILOT-369, decision 103 a): one
  review per head commit as `github-actions`, with findings as inline comments on the changed lines (others in the
  review body), *Request changes* on P0/P1, otherwise *Comment*, and the bot's earlier *Request changes* dismissed
  once a review is clean. The posting script runs from the workflow's own revision. Factory PRs are now reviewed
  too. The issue comment is gone. The check stays red on P0/P1 or a missing summary, and the job log lists every
  P0/P1.

### Deprecated

### Removed

### Fixed

- A failed delivery is re-run once (PILOT-301, decision 100): when the bundled delivery ends `failed`, for example
  because the review's `route` node got no structured output from Claude, the factory runs one more delivery on the
  same branch and pull request (new nodes `redeliver` and `last-delivery`) and the report says it retried and why; a
  second failure or any other reason ends the run as before. Two fixtures cover both paths.
- pr-conventions never dies on SIGPIPE under `pipefail` (PILOT-336): the Type-line check of this repository and of
  the fe template, and this repository's release-changelog check, piped the PR body into a reader that stops at its
  first match, so the writer could die of SIGPIPE and a valid pull request failed the check. They now read the body
  from a here-string. Found in 1_mvp_pilot_fe (PILOT-306); the be template already used here-strings.
- The fe template's TDD check never skips the gate on a large change list (PILOT-339): it piped the changed files
  into `grep -q`, so on a list larger than the pipe buffer the upstream `grep` died of SIGPIPE under `pipefail`
  and the check printed "not applicable" and passed. It now reads the whole list before deciding. Found and fixed
  in 1_mvp_pilot_fe (PILOT-117); the be template has no such pipe.
- The merge gate no longer refuses a pull request whose check has a cancelled run superseded by a newer green one
  (PILOT-372): `pr-state` reads every run on the head (`statusCheckRollup`), judges each check by its latest run per
  workflow and name, and waits, bounded like `review-state` (20 min), while a check or a workflow run on the head is
  queued or in progress; a latest run that failed, timed out or was cancelled with nothing newer still refuses.
  Found on 1_mvp_pilot_be#108 (run dacea56f) and 1_mvp_pilot_fe#65.
- The AI PR review of the be and fe templates lists each finding once (PILOT-399): inline on a changed line,
  otherwise in the review body; the summary no longer repeats them (fe report, be prompt). The review body and every
  inline comment are capped at 60000 characters with a truncation note, as GitHub rejects more than 65536. Only a
  `github-actions` review whose body starts with `<!-- ai-review -->` counts as the AI review's own, for the
  same-head no-op and for the dismissal, so another workflow's review on the same token is left alone. The fe
  PR-head checkout no longer persists the token, as in be (PILOT-396). Found by the review of fe parity run
  0e711247.

### Security

## [0.4.0] - 2026-10-27

### Added

- UI tasks pass an operator visual-review gate inside the factory run (PILOT-278, decisions 85, 86): the brief names
  a visual reference, the build commits e2e screenshots under `docs/screenshots/<card>/` and embeds them in the PR
  body, and after CI the run waits for approve / needs-revision / abort; needs-revision runs a new implement round in
  the same run on the same PR.
- Every release has its own card (decision 91, PILOT-283): the pr-conventions checks of this repository and of the
  be/fe templates fail a `PILOT-0: Release …` title, and the factory keeps a release-prep run's card in
  `In Progress` instead of `Review` and `Test`.
- The factory stops with an operator alert when the Claude CLI login has expired (decision 93, PILOT-305): it checks
  the login with one minimal call before it starts and classifies a provider auth failure in any later node from the
  run's transcript; the run stops with a `claude /login` message and one Telegram alert to `MVP_VPN_ALERTS` per run.
  `install.sh` copies `notify-telegram.sh` into the pack, and `scripts/claude-auth.ts preflight|scan` is the helper
  for `post-merge`.
- One Trello card per feature task (decision 78, PILOT-250): `task-cards` creates or adopts the task cards and
  records them in `tasks.json`; `task-brief` titles the pull request by the task card and briefs frontend tasks from
  the backend checkout with `--from`.
- Every release pull request carries its changelog (decision 64, PILOT-207): this `CHANGELOG.md`; the mirror sync
  pull request of a release has `## Changelog` with the tag's section (PILOT-302), and `publish-mirror.sh` refuses a
  release whose `CHANGELOG.md` has no entries for the tag; the prod infra promotion pull request lists the `env/dev`
  pull requests merged since the last promotion; the pr-conventions check fails a `PILOT-<n>: Release vX.Y.Z` pull
  request without a non-empty `## Changelog` section for the version.
- The SDLC uses the project knowledge server mvp-rag (K1, PILOT-196): the factory's `rag-context` node searches it
  before the plan, the planner cites the sources it used and `report.json` records `rag_status` and
  `rag_sources`; the `mvp-sdlc` skills `feature-start`, `task-brief`, `sync-spec` and `rails-data-model` search it
  first and cite their hits; `bin/rag search|reindex` is the client for shells and post-merge. An unset or
  unreachable server is only a warning.
- `bin/project-add <name>`, the new-project orchestrator (S5, PILOT-187): preflight, infrastructure through
  `vpnctl`, the backend and frontend repositories from the templates with `main` and `develop`, environments and
  secrets (`RAG_MCP_URL` and `RAG_MCP_TOKEN` included), Telegram topics, the Trello board, the Notion page, the
  plugin check and a report; `--dry-run`, `--step`, `--undo`; state in `~/.local/state/project-add/`.

### Changed

- `task-brief` accepts a task estimated `L` (one day) and refuses only `XL`.
- publish-mirror titles a release sync with the release card number, `PILOT-<n>: Release vX.Y.Z` (decision 58,
  PILOT-176).

### Deprecated

### Removed

### Fixed

- The factory ends cleanly after a failed merge (PILOT-164).
- The factory creates the run worktree from the profile's `base_branch` (PILOT-168).
- The recheck action reads the review verdict correctly (PILOT-163).
- The factory plan and profile gates use wait attention, and the gate rounds read the decision saved by
  `until_bash`, so runs resume under Archon v0.12.1 (PILOT-217).
- The factory republishes the pull-request description from the run's latest body file before the merge, and
  refuses to merge a description it could not republish; the implement agents are told not to wait with `pgrep -f`
  on a literal in their own command (PILOT-219).
- The TDD order check of the be and fe templates counts only the task's own commits: be compares against the live
  base branch instead of the event's stale base sha, and fe ignores test changes brought in by merging the base
  (PILOT-281).

### Security

## [0.2.0] - 2026-10-21

### Added

- `publish-prod-infra.sh` syncs the prod infra root to the private infra copy `env/prod` through a pull request
  (PILOT-175).
- Eval results for mvp-sdlc 0.1.2: 10/10 cases discriminate, verdict PASS; the plugin moves to 0.2.0 (PILOT-173).

### Changed

- publish-mirror syncs through the mirror `develop` and a pull request into `main`, and carries release tags
  (decision 51, PILOT-157).
- publish-mirror carries only the release tags whose content the sync brings (PILOT-167).

## [0.1.0] - 2026-10-20

Everything merged into `main` before the develop branch model (decision 54); not tagged. The `mvp-sdlc` plugin
went through 0.1.0, 0.1.1 and 0.1.2 in this period; its own list is in `plugins/mvp-sdlc/README.md` ("Versioning").

### Added

- Repository skeleton and CI with one entry point, `scripts/ci/check.sh`: actionlint, the public-repo check and
  gitleaks.
- The plugin marketplace `mvp` with the vendored course plugin `sdlc` 4.5.1 and the plugin lint (evals layer 0).
- The `mvp-sdlc` plugin: Rails/ActiveRecord data model, two-repository spec sync, Trello-card feature start,
  factory task briefs, app-repo `.claude/` bootstrap and deterministic guards (phase gate, PRD lint, script-only
  `state.json`, git and secret hooks), later the `check-branch-name` hook.
- The SDLC process documents in `docs/sdlc/`.
- The golden eval suite for the mvp-sdlc skills and hooks, with pass^3 results.
- The Archon `factory` workflow pack and the `plan-review` workflow, moved here with their history, and
  `install.sh`.
- `publish-mirror.sh`, which syncs the public mirrors from the primary repositories.
- The project templates `templates/project-be` and `templates/project-fe`, rendered from the pilot release.
- The factory moves the task's Trello card through the SDLC board; the plugin and the templates follow the board
  flow.

### Changed

- The develop branch model in the SDLC docs and the factory briefs; the PILOT title and the `Type:` line in the
  briefs.
- CI jobs take their runner from `vars.RUNS_ON`.
- The public README: intro, live links and how the AI process works; the delivery history moved to `docs/`.
- The factory never merges a pull request whose base is `main` by itself (decision 27).
- This repository moves to the develop branch model: `develop` is the working branch, `main` the released version
  (decision 54).

### Fixed

- Factory runs no longer stall on CI waits under Archon v0.10.1.
- Six mvp-sdlc eval cases that did not discriminate now fail RED.
