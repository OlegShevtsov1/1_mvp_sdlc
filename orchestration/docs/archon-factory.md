# The Archon `factory` — operator guide

The `factory` is an Archon workflow that takes one task and carries it to production: it plans, writes the code,
reviews it, merges the pull request, deploys to your server, checks health and monitoring, rolls back when something
is red, and reports honestly. It stops for you twice: the project profile (first run in a repository only) and the
plan. Everything after the plan is unattended, except for a UI task: once its CI is green, it stops a third time so
you can review its screenshots at the visual gate.

This repository also carries `plan-review` (an interactive, round-by-round review of an existing plan document) and
`plugin-probe` (checks which `sdlc:` skills an unattended run sees). The process around the factory — which tasks go
in, in which order, what the cards say — is in [docs/sdlc/00-operator.md](../../docs/sdlc/00-operator.md).

| What | Where |
|---|---|
| The factory pack (workflow, scripts, commands, fixtures, unit tests) | [orchestration/factory/](../factory/README.md) |
| `plan-review`, `plugin-probe` | [orchestration/workflows/](../workflows/) |
| Dry-run stubs the CI uses for the single-file workflows | [orchestration/tests/dry-run/](../tests/dry-run/) |
| The installer | [install.sh](../../install.sh) |

## 1. Requirements on the Archon host

| Tool | Why |
|---|---|
| Archon CLI **v0.12.1**, plus `archon provider add claude` | runs the workflows; release binaries from v0.12.0 on ship without providers. CI tests exactly this version |
| Bun ≥ 1.2.21 | the factory's scripts (`runtime: bun`; they parse YAML with `Bun.YAML.parse`) |
| uv and Python ≥ 3.10, with `UV_PYTHON` set (for example `3.12`) | Archon's own bundled scripts (`runtime: uv`) |
| `gh`, logged in as the repository owner (`OlegShevtsov1`) | pull requests, CI status, merge |
| Claude Code, logged in | the agent inside the AI nodes. Every run first checks the login with one minimal call (about $0.0001) and stops with a Telegram alert when it has expired |
| The "Exception: unattended Archon workflow runs" section in the operator's `~/.claude/CLAUDE.md` | without it the agent stops and asks for permission to commit, push or open a pull request |

## 2. Install, update and roll back

From a clone of this repository:

```sh
git checkout main && git pull --ff-only
./install.sh
```

That installs the released factory. To test a change before it is released, use
`git checkout develop && git pull --ff-only` instead, and reinstall from `main` afterwards.

`install.sh` checks the tools above, then:

1. copies whatever it is about to replace — `~/.archon/workflows/sdlc-factory/factory/` and every
   `~/.archon/workflows/<name>.yaml` that this repository ships — to `~/.archon/workflows-backup/<UTC timestamp>/`
   and prints `backup: <dir>` (or `backup: nothing to back up`). The backup lives outside `workflows/` on purpose:
   Archon reads every file under `workflows/`, so a backup there would be discovered as a second copy;
2. installs the factory pack and every `orchestration/workflows/*.yaml`. Other packs in `~/.archon/workflows/`
   (for example `mvp-ops`) are never touched;
3. validates each installed workflow and exits 1 on a validation error, naming the backup and the restore command.
   Deprecation `WARNINGS` for `plan-review` are expected and do not fail the install.

Runs that are already in progress keep the workflow source they started with; only new runs use the new install.

**Rollback** to the previous install (`<ts>` is the directory the install printed):

```sh
rm -rf ~/.archon/workflows/sdlc-factory/factory
cp -R ~/.archon/workflows-backup/<ts>/sdlc-factory/factory ~/.archon/workflows/sdlc-factory/
cp ~/.archon/workflows-backup/<ts>/*.yaml ~/.archon/workflows/
```

A workflow file that did not exist before the install has no backup; remove it by hand if you want it gone.

Knobs (used by the CI check and the installer's tests; leave them unset on a real machine):

| Variable | Default | Meaning |
|---|---|---|
| `ARCHON_HOME` | `~/.archon` | the Archon home to install into |
| `ARCHON_BIN` | `archon` | the Archon binary that validates |
| `INSTALL_SKIP_RUNTIME_TOOLS=1` | unset | skip the `gh`/`claude` checks (needed to run workflows, not to install them) |

## 3. Machine setup notes

- **Shell environment.** Archon starts the scripts from the shell you run it in. Put `bun` on `PATH` and set
  `UV_PYTHON` in the login shell's startup file (and in the other shell's, if you use both).
- **Git identity per owner.** If the machine's default SSH key belongs to another GitHub account, map the owner's
  repositories to the right key with `url.<alias>.insteadOf` in the git config, and clone with
  `gh repo clone OlegShevtsov1/<repo>`.
- **One remote, one default.** In a repository with more than one remote (`origin` and `upstream`), run
  `gh repo set-default OlegShevtsov1/<repo>`; otherwise `gh` looks for the pull request in the wrong repository and the
  run fails on its CI step ("no pull requests found for branch").
- **The deploy server must be reachable** from the Archon host (SSH for the deploy command, HTTP for the health URL).
  If a VPN on the Archon host captures all traffic, add a route for the local network around it.

## 4. One-time setup per project

1. The project is a GitHub repository with a `main` branch, cloned on the Archon host.
2. The deploy and rollback are known and reachable from the Archon host: one command each (for example a
   `deploy/deploy.sh` and `deploy/rollback.sh` in the repository).
3. A health URL that answers HTTP 200 when the service is up. Each project on a shared deploy server needs its own
   port.
4. Secrets (tokens, keys) exist only as environment variables on the Archon host; the profile records their names,
   never their values. A `~/.config/<project>.env` file (mode 600) loaded by the shell's startup file works well.
5. **CI must be green on `main` before the first task.** The factory merges only green work; a check that is already
   red on `main` stops every run at the merge.
6. Optional: `RAG_MCP_URL` and `RAG_MCP_TOKEN` in the Archon host's shell environment (the same mode-600 file
   approach, for example `~/.config/mvp-rag/env`), so the plan stage reads the project knowledge server `mvp-rag`.
   Without them every run still works, and `rag.log` and the plan say mvp-rag was unavailable.
7. Optional: `TELEGRAM_MVP_VPN_ALERTS_BOT_TOKEN`, `TELEGRAM_MVP_VPN_ALERTS_CHAT_ID` and
   `TELEGRAM_MVP_VPN_ALERTS_THREAD_ID` in the environment or in `~/.config/telegram-bots/.env` (mode 600, written by
   `bin/project-add`), so a run whose Claude login has expired alerts the `MVP_VPN_ALERTS` topic. Without them the run
   still stops, and `claude-auth.log` says the alert was skipped.

The first run asks the profile questions and, after Gate 1, commits `.archon/factory-profile.yaml`. Later you can
edit it as text; delete it to be asked again.

## 5. How to write a task

Four blocks; for a project that already has a profile, block A is enough.

- **A. What to do** — one concrete change and how to tell it works (a test, a behaviour, an endpoint's answer).
- **B. How to deploy** — where, with what: one command, or what the command is made of.
- **C. Health URL** — the address and how many seconds to wait.
- **D. How to roll back.**

Example for a new project:

```text
Add GET /health that returns 200 and {"status":"ok"}, with a unit test.
Deploy: to <deploy-host> (SSH port <ssh-port>) into ~/myapp with rsync, then docker compose up on port <port>;
create a Dockerfile, docker-compose.yml, deploy/deploy.sh and deploy/rollback.sh.
Health URL: http://<deploy-host>:<port>/health, wait up to 120 seconds.
Rollback: switch to the previous release and restart compose.
```

Too big: "build a shop website" is a dozen tasks. One task is one pull request.

**A UI task** (PILOT-278, decisions 85 and 86). A task is visual when its text has the line `Layer: ui.`
(`task-brief` prints it for a task whose `layer` in `tasks.json` is `ui`) or a line `Visual review: required`.
A visual task must name its visual reference on a line `Visual reference: <URL or style>`. Give it as a `dod` item
of the task in `tasks.json`, which `task-brief` prints as `- Visual reference: …`. Without it the run stops before
the plan: `Stopped before the plan: … names no visual reference`. The factory adds the screenshot rules to the plan
and delivery work orders. The build shoots every screen the task changes with the project's e2e tooling, in each
variant: desktop and mobile, light and dark, with data and empty. It commits the files as
`docs/screenshots/<card>/<screen>-<desktop|mobile>-<light|dark>-<data|empty>.png` (`<card>` is `PILOT-<n>`, or
`no-card`) and embeds them in the PR description.

**The task's Trello card.** When the task text names a card — its card link (the card's full URL), or the
`PILOT-<n>: <card title>` line `task-brief` writes — the factory moves that card through the board
([Board flow](../../docs/sdlc/03-dor-dod.md#board-flow)). `PILOT-0` means "no card". The factory reads
`TRELLO_API_KEY`, `TRELLO_TOKEN` and `TRELLO_BOARD_ID` at run time from `~/.config/trello/.env` on the Archon host;
without that file, or when the card is not on that board, it only logs a warning and delivers as usual.

## 6. Running and the gates

In the foreground (the task may also come from a file: `"$(cat task.md)"`):

```sh
archon workflow run factory --cwd <project checkout> "<the task>"
```

In the background, independent of the terminal or SSH session:

```sh
mkdir -p ~/archon-logs
nohup setsid zsh -lic 'archon workflow run factory --cwd <project checkout> "<the task>"' \
  > ~/archon-logs/$(date +%Y%m%d-%H%M).log 2>&1 < /dev/null &
tail -f ~/archon-logs/<file>.log | grep -v '^{"level"'
```

Each gate prints the run ID.

**Gate 1 — the project profile** (first run only). Check the test command, the deploy command, the health URL, the
rollback and the list of secrets (real secrets only, not settings). Answer with one of:

```sh
archon workflow respond <run-id> approve
archon workflow respond <run-id> needs-revision "what to change, in your own words"
archon workflow respond <run-id> abort
```

**Gate 2 — the plan.** Read the summary (the full plan is `plan.md`; the message gives its path). Check that the plan
does not declare red CI checks "out of scope": the factory could not merge then — answer `needs-revision` and ask
for green CI. The same three answers.

After the plan is approved the factory works alone: code → tests → draft PR → review (several lenses) → corrections
→ re-review → validation → CI → (the visual gate, for a UI task) → the factory's own merge gate → merge → deploy →
health → monitoring → report.

**Visual gate — the screenshots** (UI tasks only, once the delivery is ready and CI is green). The message names the
round (at most 4), the pull request and the visual reference. It says whether the round is ready to approve and
lists the screenshot links at the PR head. The round is not ready when it has no screenshots under
`docs/screenshots/<card>/`, or when a revision ended not ready. A variant that no file name shows, or a description
that does not embed the folder, is only listed, and you judge it. The same three answers:

- `approve` → the run goes on to the merge, deploy and checks as usual. Approving a round that is not ready stops
  the run, with the PR left open.
- `needs-revision "what to change"` → the same run delivers your words on the same pull request. It adds commits,
  goes through review and CI again, and shoots new screenshots. Then the gate asks again. A `needs-revision` in
  round 4 ends the run.
- `abort` → the run stops; the pull request stays open.

**Follow-up instead of another round** (PILOT-300, decisions 93, 99, 100). A review that keeps re-raising one
invariant on ever narrower edge cases used to run the delivery into its 4-round cap. Now, when the bundled delivery
stops at round 3 or later with `replan`, or at the cap, the factory takes the delivery as ready when all of these
hold:

- every open blocking finding re-raises an earlier finding on a narrower case: the same id carried from an earlier
  round, or a new id narrowing one an earlier round raised. An agent (`followup-judge`, read-only) judges each one
  `narrower`, `unfixed` or `new`, and the factory checks its answer against `review/findings.json`;
- no open blocker is a contract finding raised in the last review round (review and rereview each count a round,
  so it is the highest `review/report-round-N.md`, not the delivery's round), and every contract item the review
  left open is unmet only on the evidence of those findings;
- CI on the pull request head is green (the factory waits up to 20 minutes for pending checks), and the review
  comment judged that head.

The factory then creates one card per such finding in `Ready`, with the label `task`, titled
`Follow-up PILOT-<n>: R<k> <claim>`, holding the finding, why it is narrower and the links to the PR and the review
report. It adds a `## Follow-up cards` section to the PR description, marks the draft PR ready, and goes on to the
merge gate as usual; the run's report names the cards. A new defect class, an `unfixed` blocker, any other unmet
contract item or red or pending CI keeps today's behaviour: the run ends not delivered, and the summary says
`Not followed up: <why>`. The rule acts after the bundled delivery has ended, because the factory never forks
Archon's bundled blocks, so a delivery whose review stays open still runs to round 4. Stopping inside the loop at
round 3 needs a round-policy hook in Archon itself; that is an operator follow-up. The board needs a label named
`task`: without it, or without the Trello credentials file, the rule creates nothing and the run ends not
delivered, with the reason in the summary.

**One retry of a failed delivery** (PILOT-301, decision 100). When the bundled delivery ends `failed` (a node inside
it broke, most often the review's `route`, see §9), the same run delivers once more (`redeliver`, a second include of
`archon-deliver-block`) on the same branch, continuing its pull request when one is open, and every later node reads
the retry's report. A second failure, or any other reason, ends the run as before: there is never a third attempt,
and `review_open`, `round_cap`, `replan`, `needs_human` and `ci_*` are never retried. The report's summary then ends
`Retried the delivery once: …`, saying why and how the retry ended.

This gate replaces the manual visual check. You no longer need a side script that keeps a pending
`operator/visual-review` commit status on the PR head, or hand-sent screenshots, or a continuation run started by
hand. Do not keep `operator/visual-review` as a required check: a required status left pending makes GitHub refuse
the merge, and the run ends `merge refused`.

Useful while it runs:

```sh
archon workflow status --cwd <project checkout>   # running and paused runs
archon workflow get <run-id>                      # details and the artifacts path
archon workflow runs --cwd <project checkout>     # history
archon workflow resume <run-id>                   # continue a failed or paused run
archon workflow abandon <run-id>                  # close a stuck run
```

## 7. Reading the result

| Status | Meaning | What to do |
|---|---|---|
| `completed`, report `delivered: true` | merged to `main`, deployed, health 200, monitoring not red | nothing; `git pull` your checkout |
| `completed`, report `delivered: true`, summary `… Follow-up cards: R<k> → <card> …` | the delivery ended `replan` or at the round cap with only narrower re-raises of earlier findings open (§6). The factory created the follow-up cards in `Ready`, linked them in the PR description, and merged and deployed as usual | pick the follow-up cards up like any other task |
| `completed`, report `status: delivered-pending-operator` | the PR's base is in the profile's `manual_merge_bases` (default `main`, decision 27). Every check was green, but the factory did **not** merge, deploy or check health; it commented `ready for the operator: …` on the PR | review and merge the PR yourself, then deploy as usual. If the summary says the notification could not be posted, the comment is missing but the PR is still waiting |
| `cancelled`, summary `Stopped before any work: the Claude CLI login …` | the pre-flight `claude-auth` found the Claude CLI login of the Archon host expired or missing, sent one alert to `MVP_VPN_ALERTS`, and nothing else ran | run `claude /login` on the host, then start a new run |
| `cancelled`, summary `Not delivered: the Claude CLI login on the Archon host has expired (node …)` | a later AI node failed with a provider auth error; `claude-auth-scan` found it in the run's transcript and sent the alert, once per run | run `claude /login` on the host, then start a new run. The PR, if any, is left open |
| `cancelled`, summary `merge refused (…)` | the factory's merge gate found a red check, or the PR was not open and ready, or the checkout was not the PR head, or the PR conflicts with its base, or the factory could not republish the PR description, or `gh pr merge` refused it (gh's message is in the summary). The PR is open and was **not** merged | fix the cause and start a new run, or close the PR. `resume` does not work for `cancelled` |
| `cancelled`, summary `… is merged, but its merge commit could not be read …` | the PR **is** merged; GitHub had not published the merge commit yet, so nothing was deployed | deploy the merge commit the way the profile's deploy command does, or start a new run once `gh pr view <url> --json mergeCommit` shows it |
| `cancelled`, summary `stopped at the visual gate (…)` | you answered `abort` at the visual gate, approved a round that was not ready, or answered `needs-revision` in its last round; the PR is open and was **not** merged | start a new run on the same task to continue, or close the PR |
| `cancelled`, reason `Stopped before the plan: … names no visual reference` | a UI task without a `Visual reference:` line | add the `dod` item, run `task-brief` again and start a new run |
| `cancelled`, summary `the delivery ended not ready (<reason>)` | the bundled delivery stopped (`review_open`, `round_cap`, `replan`, `needs_human`, `ci_*`, `failed`) and nothing was merged; the rest of the summary is the delivery's own. After a `replan` from round 3 on or a `round_cap`, `Not followed up: <why>` at its end says why the follow-up rule (§6) did not apply. With `failed` and `Retried the delivery once: …`, both the delivery and its one retry failed | read `review/report.md` in the run's artifacts, then fix the cause or start a new run |
| `cancelled`, any other "Not delivered: …" | delivery stopped before a mergeable PR, or the deploy, health or monitoring was red (rolled back when needed) | fix the cause and start a new run |
| `failed`, report.json `delivered: true`, summary `… Retried the delivery once: …` | the first delivery broke, the retry (§6) delivered, and the factory merged and deployed as usual. Archon keeps the run's status `failed` because one node failed | nothing. Do **not** `resume` it: that re-runs the failed node and everything that depends on it |
| `failed`, report.json missing or not delivered | a node broke and the run ended without the report's verdict | `archon workflow get <run-id>` names the node; fix it; `archon workflow resume <run-id>` |

Run artifacts: `~/.archon/workspaces/<owner>/<repo>/artifacts/runs/<run-id>/` — `report.json`, `plan.md`,
`implementation.md`, `review/report.md`, `sync-base.log`, `rag-context.md`, `rag.log`, `merge-gate.log`,
`trello.log`, `claude-auth.log`, `deploy.log`, `rollback.log`; for a UI task also `visual-gate.decision`, `visual-gate.text` and
`visual-gate.decisions` (your answers) and `visual-shots.json` and `visual.log` (each round's screenshots and
readiness). `report.json` also records `rag_status` and `rag_sources`: whether the
plan stage got project knowledge from `mvp-rag` (`ok`, `unavailable`, `dry-run`, or `skipped` when the plan stage
did not run, for example because `sync-base` could not fetch the base) and the sources it was given.

Where the task's card ends: `Test` when delivered; `Review` with "waits for the operator merge" when the PR's base is
merged by hand; `Blocked` after a failed rollback; `Ready`, with the reason as a comment, for every other stop. A
release run — its task names the card's release title `PILOT-<n>: Release X.Y.Z changelog` or
`PILOT-<n>: Release vX.Y.Z` — keeps the release card in `In Progress` instead of `Review` and `Test` (decision 91).
While a gate waits for you (gate 1, gate 2 or the visual gate) the card is in `Blocked`.
`trello.log` has one line per move, with the warning when Trello could not be reached.

## 8. Troubleshooting

- **`Executable not found in $PATH: "bun"`** on `load-profile`: bun is not on the `PATH` of the shell that started
  the run. Start it from the login shell (or `zsh -lic`).
- **`TypeError: unsupported operand type(s) for |`** in the implement step: `UV_PYTHON` was not picked up; open a new
  terminal.
- **The CI step fails with "no pull requests found for branch"**: `gh` looks at the wrong repository;
  `gh repo set-default OlegShevtsov1/<repo>`.
- **The run ends with `merge refused`**: read `merge-gate.log` in the run's artifacts. Often a check that is red on
  `main` too (lint, security audit): make CI green in a separate PR first. A reason
  `test command timed out after N s` means the test command outlived its limit twice (the gate retries it once): the
  suite needs more time on the Archon host, so raise `stack.test_timeout_seconds` in the profile (at most 3600).
- **The agent asks for permission to push or open a PR**: check the unattended-runs exception in
  `~/.claude/CLAUDE.md`.
- **Health is always red**: request the health URL from the Archon host with `curl -i`; check the route to the
  deploy server around the VPN.
- **`Permission denied` / `Repository not found` on push**: git used the wrong account; check
  `git config --show-origin --get-regexp '^url\.'`.
- **`archon validate` complains about `.archon/mcp/monitoring.json`**: create that file with `{}` in the checkout you
  validate from; runs are not affected.
- **`provider reported auth` / `OAuth session expired and could not be refreshed`** in a node's error: the Claude CLI
  login of the Archon host has expired. Run `claude /login` on the host and start a new run. `claude-auth.log` in the
  run's artifacts says whether the Telegram alert was sent.
- **`resume` refuses because of a digest**: never change anything inside `artifacts/runs/<id>/workflow-source/`.

## 9. Known Archon issues the factory handles

- **Run worktree cut from the default branch.** Archon cuts the run's worktree from `origin/HEAD`
  (or a `--from` flag, or `worktree.baseBranch` in the repository's `.archon/config.yaml`) and never reads the profile,
  so a repository whose `base_branch` is not its default branch started the run on stale code. The factory's
  `sync-base` node, right after `load-profile` and before the plan, fetches `<remote>/<base_branch>` and hard-resets a
  run branch that has no commits of its own. The profile and `.archon/mcp/monitoring.json` are carried over the reset
  when the base does not track them yet, and so is the first run's profile commit. It leaves a published branch, a
  checkout that is not a linked worktree, a dirty tree or a branch with work untouched and says why. It fails the run
  when the base cannot be fetched or a git check it relies on fails, and logs every decision to `sync-base.log`.
- **Interim review verdict (Archon < v0.12, PILOT-163).** The bundled review's structured verdict was taken from the
  agent's first turn while background work still ran, so a `ready: false, action: none` interim verdict reached
  `recheck-action` ("invalid review verdict") although `review/report.md` later said ready. Fixed upstream in v0.12.0
  (an AI node finishes when its provider settles, #3530); the `review-interim-verdict` fixture guards the factory's
  reaction should a not-ready verdict still arrive.
- **A failed delivery still reports (v0.12).** `archon-deliver-block` completes its report after a failed inner node,
  so `pr-state` runs only when that report says `ready`, and otherwise the run ends `cancelled` with the delivery's
  reason and summary quoted; a `failed` report is first retried once (§6).
- **The review route's missing structured output (v0.12.1, PILOT-301).** The `route` node of the bundled
  `archon-review-block` (in a run's record `deliver__rounds.review__route`) picks the review lenses. When Claude's reply
  carries no schema-valid structured output, it fails with `output_format declared but the provider returned no
  schema-valid structured output` on the first try: v0.12.1 re-asks (3 times) only providers whose structured output
  is `best-effort`, and Claude's is not. That fails the rounds loop, and the delivery reports `failed` (runs
  ddb63036, 53bd05a7, 55e90696, each merged by hand). The factory may not fork the block (`rulings.md`), so it retries
  the whole delivery once (§6). The fix belongs upstream (re-ask native providers too, or fall back to every lens);
  filing it is deferred by the operator. The `delivery-failed-twice` fixture reproduces the defect by stubbing `route`
  with prose.
- **The factory's own merge guard.** The factory's nodes cannot depend on nodes inside the deliver block, and the
  bundled delivery judges red with an agent. `pr-state` reads the PR, its CI checks and the checkout from GitHub and
  git, waiting (bounded, 20 min) until the head's checks and workflow runs settle and keeping the latest run of each
  check; `merge-gate` re-runs the profile's test and build commands on the exact PR head (verified against GitHub, with
  no uncommitted changes) and `merge` runs only when it is green. The lint command runs too, unless the PR has a
  passing CI check whose name contains the word lint (`Lint`, `Rails CI / Lint`; not `Actionlint` or `ESLint`): run in
  the run's worktree, under a path that contains `.archon/`, RuboCop's excludes miss and it refused a PR whose CI Lint
  was green. **`merge-gate` refuses any red command and any CI check whose latest run failed or was cancelled** (a
  cancelled run superseded by a newer run is ignored), including red that the deliver block would have accepted as
  `inherited` or `environment`; test and build run twice on the happy path. The test command runs under the profile's
  `stack.test_timeout_seconds` (default 1000 s, at most 3600 s) and once more after a timeout; lint and build have
  1000 s each, and the `merge-gate` node timeout (9600 s) covers the worst case of all of them.
- **The visual gate's loop (v0.12.1, PILOT-278).** A wait node must be the last node of its loop, and nothing outside
  a loop can read a node inside it. The `visual-cycle` loop therefore follows the PILOT-217 pattern of the other
  gates: its `until_bash` saves each answer to `visual-gate.decision`, `visual-gate.text` and
  `visual-gate.decisions`. The next round's `visual-turn` reads them, because `$LOOP_PREV` in a `when:` does not
  parse on the first round. `visual-shots` saves the round's readiness to `visual-shots.json`, which `visual-round`
  reads after the loop. A revision is a second include of the bundled `archon-deliver-block`, given the pull
  request's number, so it continues the same PR; the block is composed, never forked.
- **Stale pull-request description (v0.12.1, PILOT-219).** The bundled delivery publishes the PR description only
  when it opens the pull request, so corrections later rounds write to the run's body files never reached the live
  PR, and the squash commit carries the live description. `pr-body-sync`, after `deliver` and before `pr-state`,
  takes the run's latest body and, when it differs from the live description, replaces it with `gh pr edit` and reads
  it back. The latest body is this run's `pr-body.md`, unless the run opened the PR with it and no round rewrote it
  since (it is not newer than the bundled `pr-create-started` marker); a run that continues an existing pull request
  writes no marker, and the bundled publish never puts its `pr-body.md` on that PR. The bundled `update-pr-body`
  node builds `pr-body-final.*` from the stale live description, so everything it added is dropped when
  `pr-body.md` wins: its claim fixes, its "Left open" section and a closing keyword it set. The body's own "After
  merge (operator)" section is what carries operator checks. Otherwise it is the newest of `pr-body-final.md`, the
  `body` of `pr-body-final.json` and `pr-body.md`. It never blanks a description (no or an empty body file is
  skipped), and it overwrites a live edit made after the bundled `update-pr-body` node ran. The Archon check fails when the pinned binary stops naming these files or the marker.
  `merge-gate` refuses when the description could not be republished. Per-round reviews inside the deliver block
  still read the live description; only a sentence in the deliver work order tells them not to block on a stale
  one, which is not enforced.
- **Review rounds that narrow one invariant (v0.12.1, PILOT-300).** The bundled block owns the rounds and the
  synthesizer returns `replan` for a blocker raised a second time, so the factory cannot stop the loop at round 3. It
  acts once the block has ended (§6): `review-state` reads the round from the deliver report's
  `Not ready: Round <N>: ` summary, the PR head, its checks, the canonical review comment
  (`<!-- archon-review-report -->`, `Reviewed commit: `), `review/findings.json` and the latest review round, the
  highest `review/report-round-N.md` (a finding's `round` counts review rounds, not delivery rounds);
  `followup-judge` judges the open blockers; `review-followup` decides and writes, and every node that read the
  deliver report reads its report instead. When `review-state` or `followup-judge` fails, Archon skips
  `review-followup`, so the report quotes the deliver report itself, ending in
  `Not followed up: review-state or followup-judge failed.` The deliver report has no field for the contract items
  left open, so they are read from its `Left open, so the pull request does not close its issue` bullets. The Archon
  check fails when the pinned binary stops embedding any of this text (`BUNDLED_LITERALS` in
  `scripts/_lib/follow-up.ts`).

## 10. Testing

```sh
bash scripts/ci/check.sh factory   # the factory's bun unit tests
bash scripts/ci/check.sh archon    # install + validate + fixtures + trace assertions + dry runs, on the pinned version
```

`check.sh archon` downloads the pinned Archon v0.12.1 release binary into `.tools/bin/` (gitignored, sha256-checked,
pinned in `scripts/ci/tools.sh`) and never installs it. Every Archon call in the check uses a throwaway
`ARCHON_HOME`, so it never reads or writes your live `~/.archon`; the check first runs `archon provider add claude`
in that home. It then runs `install.sh`, `archon workflow test factory` (nineteen fixtures; each stubs the inner nodes of
`archon-plan-block` and `archon-deliver-block`), and asserts on each fixture's dry-run trace: `merge-gate` executes in
every fixture and `pr-state`, `pr-body-sync`, `review-state` and `followup-judge` are stubbed or skipped, because `workflow test factory` also runs on an operator's host
with a real `gh`; `sync-base` is stubbed in every fixture, because it fetches and resets the checkout; `rag-context`
executes in every fixture as a dry run (no request) before the plan, and the report records `rag_status` `dry-run`;
`claude-auth` (before `profile-check`) and `claude-auth-scan` (before the report) run as dry runs in every fixture,
and the claude-login-expired fixture stops at `claude-auth-stop` before the profile;
in the red fixture the delivery ends ready and `merge-gate` refuses on its own test run, so `merge` is skipped; the environment-red fixture is handed on to review and CI, defers lint to the PR's passing `Lint` check
and merges; in the interim-verdict fixture the delivery ends `review_open`, `pr-state` and `merge-gate` are skipped,
and the report quotes `review_open`; in the merge-refused-by-github fixture `merge` reports gh's refusal, `deploy` is
skipped and the report carries gh's words; in the pr-body-sync-failed fixture `merge-gate` refuses the description
that could not be republished. `review-followup` executes in every fixture and passes every other delivery through;
in the review-followup-ready fixture a round-3 `replan` whose only open blocker R6 re-raises a round-2 finding on a
narrower case is followed up with a dry-run card and merges, and the report names the card; in the
review-followup-new-defect fixture the judge calls R6 new, so the run ends not delivered and the report quotes
`replan` and `Not followed up:`. Every other fixture skips the retry of a failed delivery (`redeliver`) and
`last-delivery` passes its delivery through; in the delivery-failed-then-delivered fixture the first report is stubbed
`failed`, the retry delivers on the same pull request and the run merges with `Retried the delivery once:` in the
report; in the delivery-failed-twice fixture the review's `route` gets prose instead of JSON, both deliveries fail,
no third one runs and the run ends not delivered. `visual-scope` executes in every fixture that is not visual, and the visual gate is
skipped there. The three visual fixtures stub `visual-scope` visual, with its folder pointed at screenshots
committed beside the fixtures. In the approved fixture `visual-shots` lists them as links at the head and the run
merges. In the revised fixture a revision delivers on the same pull request before the gate, then approve merges.
A dry run executes one loop iteration only, so that fixture stubs `visual-turn` as round 2 after a
`needs-revision` answer. In the aborted fixture the run stops before the merge path with the operator's words. It
runs the green fixture again with `pr-body-sync`, `pr-state`, `merge-gate` and `merge`
executing for real against the engine's own deliver output (a fake `gh` answers for the PR, a local bare repository
is `origin`) — once with a readable merge commit, where `pr-body-sync` replaces a stale description before `pr-state`
and the ready delivery skips `review-state` and passes `review-followup` untouched, once with one GitHub has not published yet, which must end
`cancelled` with a report and no deploy — and four more that must each end `cancelled` with a report: a failed edit of the description, which
`merge-gate` refuses, `gh pr merge`
refusing the merge, the pull request reading back not `MERGED` after the merge, and GitHub reporting the pull request
as conflicting with its base (refused by `merge-gate` before any merge). Then it runs it with `sync-base` executing for
real in a run worktree cut from `origin/main` of a scratch repository whose `develop` has diverged: the run branch must
be at `develop` before the plan starts. It runs the green fixture once more with a UI task that names no visual
reference: `visual-scope` executes, `abort-visual-scope` cancels the run, and neither the plan nor the delivery
starts. Last, it dry-runs every
`orchestration/workflows/*.yaml` with its stubs from `orchestration/tests/dry-run/<name>.stubs.yaml` — a new workflow
without a stub file fails the check.

## 11. Other packs

The `mvp-ops` pack (the `post-merge` workflow) is versioned in the private plan repository `1_mvp_prompt` under
`orchestration/` and installed by that repository's own `install.sh`. It is not managed here, and this repository's
installer never touches it. The helper it calls after a merge is `bin/rag reindex` (or the installed
`~/.archon/workflows/sdlc-factory/factory/scripts/rag-cli.ts` run with `bun`): it refreshes the `mvp-rag` index and
only warns when the server is unavailable. The Claude login checks are the same kind of helper:
`bun ~/.archon/workflows/sdlc-factory/factory/scripts/claude-auth.ts preflight post-merge` as its first node, and
`… claude-auth.ts scan post-merge` in a final `all_done` node. Each prints one JSON line
`{status, node, alert, message}` (`status` is `ok`, `auth_failed`, `unknown` or `dry-run`) and always exits 0; on
`auth_failed` it has already alerted `MVP_VPN_ALERTS` once for the run (`ARTIFACTS_DIR` must end in the run id).
Wiring them into `post-merge` is that repository's change.

## 12. From a Claude Code chat

A new chat does not remember this work; give it the context in one message:

```text
Read orchestration/docs/archon-factory.md in the 1_mvp_sdlc checkout.
Run the factory for the project <project checkout> with the task: "<the task>".
Run the commands through Bash in the background with a log in ~/archon-logs/.
At each gate show me the summary and wait for my approve. At the end show me the report.
```
