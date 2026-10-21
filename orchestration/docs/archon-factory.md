# The Archon `factory` — operator guide

The `factory` is an Archon workflow that takes one task and carries it to production: it plans, writes the code,
reviews it, merges the pull request, deploys to your server, checks health and monitoring, rolls back when something
is red, and reports honestly. It stops for you twice: the project profile (first run in a repository only) and the
plan. Everything after the plan is unattended.

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
| Archon CLI **v0.10.1** (the installed version) | runs the workflows. v0.11.1 is tested in CI on every change and is **not** installed: upgrading is a separate decision |
| Bun ≥ 1.2.21 | the factory's scripts (`runtime: bun`; they parse YAML with `Bun.YAML.parse`) |
| uv and Python ≥ 3.10, with `UV_PYTHON` set (for example `3.12`) | Archon's own bundled scripts (`runtime: uv`) |
| `gh`, logged in as the repository owner (`OlegShevtsov1`) | pull requests, CI status, merge |
| Claude Code, logged in | the agent inside the AI nodes |
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

**The task's Trello card.** When the task text names a card — its card link (the card's full URL), or the
`PILOT-<n>: <card title>` line `task-brief` writes — the factory moves that card through the board
([Board flow](../../docs/sdlc/03-dor-dod.md#board-flow)). `PILOT-0` means "no card". The factory reads
`TRELLO_API_KEY`, `TRELLO_TOKEN` and `TRELLO_BOARD_ID` at run time from `~/.config/trello/.env` on the Archon host;
without that file, or when the card is not on that board, it only logs a warning and delivers as usual.

## 6. Running and the two gates

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
→ re-review → validation → CI → the factory's own merge gate → merge → deploy → health → monitoring → report.

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
| `completed`, report `status: delivered-pending-operator` | the PR's base is in the profile's `manual_merge_bases` (default `main`, decision 27). Every check was green, but the factory did **not** merge, deploy or check health; it commented `ready for the operator: …` on the PR | review and merge the PR yourself, then deploy as usual. If the summary says the notification could not be posted, the comment is missing but the PR is still waiting |
| `cancelled`, summary `merge refused (…)` | the factory's merge gate found a red check, or the PR was not open and ready, or the checkout was not the PR head. The PR is open (on Archon v0.10.1 it may already be ready for review) and was **not** merged | fix the cause and start a new run, or close the PR. `resume` does not work for `cancelled` |
| `cancelled`, summary `… is merged, but its merge commit could not be read …` | the PR **is** merged; GitHub had not published the merge commit yet, so nothing was deployed | deploy the merge commit the way the profile's deploy command does, or start a new run once `gh pr view <url> --json mergeCommit` shows it |
| `cancelled`, any other "Not delivered: …" | delivery stopped before a mergeable PR, or the deploy, health or monitoring was red (rolled back when needed) | fix the cause and start a new run |
| `paused`, `archon workflow get` shows `Wait: until …` | the deliver block is waiting for the PR's CI. On Archon v0.10.1 the run's `wait-keeper` resumes it once that time has passed | nothing. If the Archon host rebooted (the keeper died with it), run `archon workflow resume <run-id>` after the `Wait: until` time, again each time it pauses, until the run moves on. `respond`/`approve` do not apply to a time wait |
| `failed` | a node broke and the run ended without the report's verdict | `archon workflow get <run-id>` names the node; fix it; `archon workflow resume <run-id>` |

Run artifacts: `~/.archon/workspaces/<owner>/<repo>/artifacts/runs/<run-id>/` — `report.json`, `plan.md`,
`implementation.md`, `review/report.md`, `merge-gate.log`, `wait-keeper.log`, `trello.log`, `deploy.log`,
`rollback.log`.

Where the task's card ends: `Test` when delivered; `Review` with "waits for the operator merge" when the PR's base is
merged by hand; `Blocked` after a failed rollback; `Ready`, with the reason as a comment, for every other stop.
`trello.log` has one line per move, with the warning when Trello could not be reached.

## 8. Troubleshooting

- **`Executable not found in $PATH: "bun"`** on `load-profile`: bun is not on the `PATH` of the shell that started
  the run. Start it from the login shell (or `zsh -lic`).
- **`TypeError: unsupported operand type(s) for |`** in the implement step: `UV_PYTHON` was not picked up; open a new
  terminal.
- **The CI step fails with "no pull requests found for branch"**: `gh` looks at the wrong repository;
  `gh repo set-default OlegShevtsov1/<repo>`.
- **The run ends with `merge refused`**: read `merge-gate.log` in the run's artifacts. Often a check that is red on
  `main` too (lint, security audit): make CI green in a separate PR first.
- **"Workflow paused — waiting for approval" with no gate, right after `[ci-probe] Completed`**: Archon v0.10.1's CLI
  prints this for every pause, a durable time wait included, and `respond` then fails with "missing approval context".
  The run is waiting for the PR's CI; see `paused` in section 7.
- **The agent asks for permission to push or open a PR**: check the unattended-runs exception in
  `~/.claude/CLAUDE.md`.
- **Health is always red**: request the health URL from the Archon host with `curl -i`; check the route to the
  deploy server around the VPN.
- **`Permission denied` / `Repository not found` on push**: git used the wrong account; check
  `git config --show-origin --get-regexp '^url\.'`.
- **`archon validate` complains about `.archon/mcp/monitoring.json`**: create that file with `{}` in the checkout you
  validate from; runs are not affected.
- **`resume` refuses because of a digest**: never change anything inside `artifacts/runs/<id>/workflow-source/`.

## 9. Known Archon issues the factory handles

- **Merge despite red validation (Archon v0.10.1).** In the bundled `archon-deliver`, a failed `gate-validated` only
  skips `await-checks`; `flip-ready` still runs when the PR body was resynced after corrections, so the deliver block
  resolves with a ready PR. The factory's nodes cannot depend on nodes inside the deliver block, so the factory has
  its own merge guard. `pr-state` reads the PR, its CI checks and the checkout from GitHub and git; `merge-gate`
  re-runs the profile's test and build commands on the exact PR head (verified against GitHub, with no uncommitted
  changes) and `merge` runs only when it is green. The lint command runs too, unless the PR has a passing CI check
  whose name contains the word lint (`Lint`, `Rails CI / Lint`; not `Actionlint` or `ESLint`): run in the run's
  worktree, under a path that contains `.archon/`, RuboCop's excludes miss and it refused a PR whose CI Lint was green.
  **`merge-gate` refuses any red command and any failed or cancelled CI check**, including red that the deliver block
  would have accepted as `inherited` or `environment`; test and build run twice on the happy path. On v0.10.1 the PR
  may still be flipped ready before the refusal; v0.11.1 blocks the flip itself.
- **Durable CI wait never resumes (Archon v0.10.1 CLI).** While the PR's CI is still running, the bundled
  `archon-deliver`'s `await-checks` suspends the run on a five-minute `wait:` (`ci-pause`). On v0.10.1 only the
  `archon serve` continuation scan resumes such a wait; the CLI prints "Workflow paused — waiting for approval." and
  exits, and `resume` before the deadline only pauses again. The factory's `wait-keeper` node, which runs right before
  `deliver`, starts a detached keeper (`setsid`) that polls `archon workflow get <run-id> --json` once a minute and runs
  `archon workflow resume` when the run is paused on a time wait that is due. It never touches an approval pause or
  another run, logs to `wait-keeper.log`, and exits when the run ends (or after 12 h). It reports itself off on v0.11.1,
  whose CLI resumes the wait at its deadline, and in dry runs.
- **The deliver output changed shape in v0.11.1** (`{pr_url}` instead of the PR record). `pr-state` accepts both and
  `merge-gate` hands `merge` and `report` the URL and head branch read from GitHub.
- **Cascade skips in v0.11.1** would block a `none_failed_min_one_success` report after a failed delivery; `report`
  runs on `all_done`, so a failed delivery still ends `cancelled` with a report on both versions.

## 10. Testing

```sh
bash scripts/ci/check.sh factory   # the factory's bun unit tests
bash scripts/ci/check.sh archon    # install + validate + fixtures + trace assertions + dry runs, on both versions
```

`check.sh archon` downloads the pinned Archon v0.10.1 and v0.11.1 release binaries into `.tools/bin/` (gitignored,
sha256-checked, pinned in `scripts/ci/tools.sh`) and never installs them. Every Archon call in the check uses a
throwaway `ARCHON_HOME`, so it never reads or writes your live `~/.archon`. For each version it runs `install.sh`,
`archon workflow test factory` (seven fixtures; each stubs the union of both versions' inner deliver nodes), asserts on
each fixture's dry-run trace (`merge-gate` executes in every fixture and `pr-state` is stubbed, because
`workflow test factory` also runs on an operator's host with a real `gh`; the red-validation fixture fails exactly at
`deliver__gate-validated`, and on v0.10.1 `merge-gate` refuses on its own test run and `merge` is skipped; the
environment-red fixture passes `deliver__gate-validated`, defers lint to the PR's passing `Lint` check and merges),
runs the green fixture again with `pr-state`, `merge-gate` and `merge` executing for real against the engine's own
deliver output (a fake `gh` answers for the PR, a local bare repository is `origin`) — once with a readable merge
commit, once with one GitHub has not published yet, which must end `cancelled` with a report and no deploy — then
really runs (not a dry run) a probe workflow that pauses once on a durable `wait:` the way `await-checks` does: it must
complete, on v0.10.1 because `wait-keeper` resumed it (a `resume` line in `wait-keeper.log`), on v0.11.1 with the keeper
off; on v0.10.1 the same probe without the keeper must still be `paused` 15 s later. Last, it dry-runs every
`orchestration/workflows/*.yaml` with its stubs from `orchestration/tests/dry-run/<name>.stubs.yaml` — a new workflow
without a stub file fails the check.

## 11. Other packs

The `mvp-ops` pack (the `post-merge` workflow) is versioned in the private plan repository `1_mvp_prompt` under
`orchestration/` and installed by that repository's own `install.sh`. It is not managed here, and this repository's
installer never touches it.

## 12. From a Claude Code chat

A new chat does not remember this work; give it the context in one message:

```text
Read orchestration/docs/archon-factory.md in the 1_mvp_sdlc checkout.
Run the factory for the project <project checkout> with the task: "<the task>".
Run the commands through Bash in the background with a log in ~/archon-logs/.
At each gate show me the summary and wait for my approve. At the end show me the report.
```
