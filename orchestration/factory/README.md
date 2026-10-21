# Archon SDLC Factory

## 1. What it is

A "robot foreman" for one-person projects. You say "build X", and the robot does
the rest. On the first run in a repository it asks a fixed set of questions
(stack, repository, deploy, monitoring, access), saves the answers in that
repository, and never asks again. Then it shows a plan and waits for your "ok".
After that it works without further approval: it implements the change until the
tests are green, opens a draft pull request, reviews it through several lenses,
fixes the findings, waits for CI, flips the PR to ready, merges it, deploys to
your own infrastructure, polls a health URL, asks your error-monitoring service
whether new errors appeared, and rolls back automatically when health or
monitoring is red. Every run ends with an honest report: a rolled-back deploy is
never reported as a success.

This directory is the source of one Archon workflow, named `factory`. It lives in
the `1_mvp_sdlc` repository; the operator guide is
[orchestration/docs/archon-factory.md](../docs/archon-factory.md).

## 2. Install

You need three tools first.

Bun (the script runtime):

```bash
curl -fsSL https://bun.sh/install | bash
```

Archon (the harness that runs the workflow):

```bash
curl -fsSL https://archon.diy/install | bash
```

GitHub CLI, logged in (the workflow opens and merges pull requests as you):

```bash
gh auth login
```

Then install from the repository root (not from this directory), from `main` for
production or from `develop` to test a change:

```bash
./install.sh
```

It backs up the previous install, copies the package into
`~/.archon/workflows/sdlc-factory/factory/` together with the repository's other
workflows, and validates each of them; a validation error exits 1. You should
see `factory  ok`. After that the workflow is available from any repository on
your machine. Backup, rollback and the installer's options are in the
[operator guide](../docs/archon-factory.md#2-install-update-and-roll-back).

## 3. First run

Run it from anywhere, pointing at the repository you want to work in:

```bash
archon workflow run factory --cwd /path/to/repo "describe the task"
```

**Gate 1 — the profile.** This happens only on the very first run in a
repository. The workflow interviews you about the project and then pauses, showing
the profile it drafted (language, framework, test/lint/build commands, base branch
and merge strategy, deploy and rollback commands, health URL, monitoring). The run
prints its run id when it pauses. You answer with one of three commands:

```bash
archon workflow respond <run-id> approve
```

```bash
archon workflow respond <run-id> needs-revision "deploy is via flyctl, not ssh"
```

```bash
archon workflow respond <run-id> abort
```

On `approve` the profile is committed as `.archon/factory-profile.yaml` on the
run's branch, so it reaches `main` with the first pull request. On
`needs-revision` the workflow asks again with your correction (up to 5 rounds).
On `abort` the run stops.

**Gate 2 — the plan.** The workflow writes an implementation plan and pauses
again. The same three responses apply, with up to 3 revision rounds.

After gate 2 the run is hands-off: implement, review, merge, deploy, health
check, monitoring check, rollback if red, report.

If you forgot the run id, list the paused runs:

```bash
archon workflow status
```

There is also a web UI, which offers the same three choices as buttons:

```bash
archon serve
```

## 4. The profile

The profile lives in the target repository at `.archon/factory-profile.yaml`. It
is committed, so it is shared and versioned with the project. Edit it by hand any
time; the workflow never asks the questions again while the file exists.

A full annotated example with every field is in
[`examples/factory-profile.example.yaml`](examples/factory-profile.example.yaml):

- `stack` — `language`, `framework`, `test_command`, `lint_command`,
  `build_command`. Any of the commands may be empty; `test_command` may be empty
  for a project that has no tests yet.
- `repo` — `remote`, `base_branch`, `merge_strategy` (`squash` | `merge` |
  `rebase`), `manual_merge_bases` — the bases whose pull requests the operator
  merges by hand. Absent means `["main"]`, so a profile whose `base_branch` is
  `main` needs `manual_merge_bases: []` for the factory to merge.
- `deploy` — `command`, `health_url`, `wait_seconds`, `rollback_command`.
  Before running `command`, the workflow checks out the merged commit inside
  Archon's own worktree, which leaves that worktree on a detached HEAD — that is
  expected, and it only guarantees that a directory-based deploy ships exactly
  what was merged.
- `monitoring` — `provider` (`sentry` | `datadog` | `grafana` | `none`),
  `mcp_config`, `window_minutes`.
- `secrets` — **names of environment variables only**, such as
  `SENTRY_AUTH_TOKEN`. Never values. The values come from the environment of the
  machine that runs Archon. An entry that is not a bare variable name fails
  validation, and the deploy and rollback logs replace the value of every listed
  variable with `***`.
- `trello` (optional) — `lists.ready`, `lists.in_progress`, `lists.review`,
  `lists.test`, `lists.blocked`: the names of the board lists the factory moves
  the task's card to; defaults `Ready`, `In Progress`, `Review`, `Test`,
  `Blocked`. A bad value falls back to its default with a warning. Credentials
  never go here: they are read at run time from `~/.config/trello/.env`.

## 5. Monitoring

Monitoring is optional. To turn it on, first make the directory in the target
repository:

```bash
mkdir -p /path/to/repo/.archon/mcp
```

Then copy one of the shipped examples to the fixed path
`.archon/mcp/monitoring.json`:

```bash
cp examples/mcp/monitoring.sentry.example.json /path/to/repo/.archon/mcp/monitoring.json
```

Now tell git about the directory. Use two lines in that repository's
`.gitignore`: the first ignores everything under `.archon/mcp/`, the second
un-ignores the `monitoring.json` name so that the harmless `{}` placeholder
described at the end of this section can be committed. The examples reference
credentials only as `$VARIABLE` names, never as values — if you ever put a
literal secret in that file, drop the second line and commit nothing from the
directory.

```bash
echo '/.archon/mcp/*' >> /path/to/repo/.gitignore
```

```bash
echo '!/.archon/mcp/monitoring.json' >> /path/to/repo/.gitignore
```

Export the variables the file refers to before starting a run. For Sentry:

```bash
export SENTRY_AUTH_TOKEN=...
```

For Datadog:

```bash
export DATADOG_API_KEY=... DATADOG_APP_KEY=...
```

Setting `monitoring.provider: none` in the profile, or simply not creating the
file, skips the monitoring step at run time. The two are checked together: if
`monitoring.provider` names a provider but `.archon/mcp/monitoring.json` is
missing, monitoring is skipped silently — the run is not failed for it, and the
report shows `monitoring: skipped`.

One wrinkle: `archon validate workflows factory` refuses to validate when the
`monitoring.json` file is missing in the current repository. Runs are not
affected, and neither is `./install.sh`. If you want `archon validate` to pass
inside a target repository that has no monitoring, put an empty placeholder
there (after the `mkdir -p` above):

```bash
echo '{}' > /path/to/repo/.archon/mcp/monitoring.json
```

## 6. What happens on red

A run is red when the health URL does not answer `200` within
`deploy.wait_seconds`, or when monitoring reports new errors in the window after
the deploy. In both cases the workflow runs `deploy.rollback_command`, and the run
ends with status `cancelled` and a reason that starts with
`Run stopped — Not delivered: …`, followed by the report summary. A deploy command
that fails outright ends the same way, without a rollback (there is nothing to
roll back to).

The merge itself is guarded. After the bundled deliver block, the `pr-state`
node reads the pull request, its CI checks and the checkout, and the
`merge-gate` node re-runs the profile's test and build commands on the exact
pull request head. The lint command runs too, unless the pull request has a
passing CI check named lint, which stands in for it. On any red command, any
failed or cancelled CI check, or when the pull request is not open and ready or
is not what the checkout holds, it refuses. The merge is skipped and the run ends
`cancelled` with `Not delivered: merge refused (…)`: the pull request stays open
and unmerged (`merge-gate.log` in the artifacts shows the checks). A delivery
that fails before a mergeable pull request also ends `cancelled` with a report.

A pull request whose base is listed in `repo.manual_merge_bases` is not merged
even when every check is green (decision 27). The factory comments on it
`ready for the operator: base … is manual`, skips deploy, health and rollback,
and the run ends `completed` with report status `delivered-pending-operator`.
The operator merges it by hand.

When the task names a Trello card, the `trello-*` nodes move it: `Blocked`
while a gate waits, `In Progress` after the plan is approved, `Review` once the
pull request exists, `Test` when delivered. A run pending the operator leaves
the card in `Review` with the comment "waits for the operator merge". A run that
stops at a gate or ends not delivered sends the card back to `Ready` with a
comment naming the reason; a failed rollback leaves it in `Blocked`. Trello never fails a run: a missing
credentials file, card or list is a warning in `trello.log` in the artifacts.

On Archon v0.10.1 the `wait-keeper` node keeps a run moving while the deliver
block waits for the pull request's CI: it resumes the run each time that durable
wait falls due (`wait-keeper.log` in the artifacts), and is off on v0.11.1.

A run that reaches its report leaves a `report.json` in its artifacts directory, plus `deploy.log`
and `rollback.log` depending on the path the run took — `rollback.log` only
exists when a rollback actually ran. To find the path:

```bash
archon workflow get <run-id>
```

**When a run ends `failed`.** Red is not the same as failed. A run ends `failed`
when a node breaks in a way the report cannot cover, and then the failing
node's own error is what to read. The same
`archon workflow get <run-id>` shows the artifacts directory and which node
failed. If the failure is inside the `merge` node, look at the pull request
before starting anything again: GitHub may have accepted the merge without
reporting the pull request as merged yet. A merge whose merge commit GitHub has
not published yet is not a failure: the run ends `cancelled`, the report says
the pull request is merged, and nothing is deployed. To continue a
failed run from the node that failed, instead of running the whole workflow
again:

```bash
archon workflow resume <run-id>
```

## 7. Testing

From the repository root. Unit tests for the package scripts:

```bash
bash scripts/ci/check.sh factory
```

The unit tests include the Trello card reference parser, the move for every
point of the run, and the Trello calls against a stubbed `fetch`.

Install, validation, the eight dry-run fixtures with trace assertions (each
Trello move at its node, in dry-run mode, with no network), and a dry
run of every other workflow, on Archon v0.10.1 and v0.11.1 (pinned binaries in
`.tools/bin`, never installed, always with a throwaway `ARCHON_HOME`; no AI
spend):

```bash
bash scripts/ci/check.sh archon
```

### Your personal Claude rules also apply inside the robot

Archon runs Claude Code unattended, and Claude Code loads your `~/.claude/CLAUDE.md`
in every session (Archon's `settingSources` setting does not exclude it — verified
with Claude Code 2.1.259). If that file says things like "ask before `git push`"
or "never create a PR without approval", the robot stops mid-run and waits for an
answer nobody can give. Add an exception to `~/.claude/CLAUDE.md`, for example:

```text
### Exception: unattended Archon workflow runs
When the working directory is under ~/.archon/workspaces/ (an Archon-managed
worktree) the workflow's own approval gates are the user's approval: commit,
push, create pull requests and merge without stopping to confirm.
```

### Python for Archon's own scripts

Archon's bundled `sdlc` pack runs some deterministic scripts with `runtime: uv`
(Python). They use syntax that needs **Python 3.10 or newer**. `uv` picks the
first `python` on your `PATH`; if that is older (pyenv 3.8, for example) the
`implement` step fails with `TypeError: unsupported operand type(s) for |`.
Fix once, without touching your default Python:

```bash
uv python install 3.12
```

```bash
echo 'export UV_PYTHON=3.12' >> ~/.zshrc
```

(and the same line in `~/.bashrc` if you use bash). Open a new shell before
running the workflow.

## 8. Known limits (v1)

- GitHub only, through an authenticated `gh` on the machine running Archon.
- Deploy and rollback are each exactly one shell command.
- The health check is one HTTP GET; non-HTTP checks are not supported.
- Monitoring works only through an MCP server you configure yourself. The package
  ships example configs for Sentry and Datadog but installs no servers.
- The base branch must be mergeable by your own GitHub account — no merge queue
  or required-review rule that `gh pr merge` cannot satisfy.
- Bun ≥ 1.2.21 is required.
- `outcome_field` is disabled until a version of Archon newer than 0.10.1 accepts
  it, so a red run shows `cancelled` rather than an authored `failed` outcome.
- Not in v1: multi-service deploys, blue/green strategies, GitLab or Bitbucket,
  secrets managers, per-run cost budgets, Slack/Telegram notifications, and a web
  UI form for the profile.
