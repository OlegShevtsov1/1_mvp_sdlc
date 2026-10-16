# Archon SDLC Factory — design spec

Date: 2026-09-20
Status: approved by the user (design confirmed in session, step 5.1 of the handoff)
Verified against: Archon CLI v0.10.1 (binary build, commit 9820785c), source at
`coleam00/Archon` main as of 2026-09-20.

## 1. Goal

A "robot foreman" for one-person projects. The operator says "build X". The
robot:

1. On first use asks a fixed set of questions (stack, repository, deploy,
   monitoring, access), saves the answers in the target repository, and never
   asks again.
2. Shows a plan and waits for "ok".
3. Then, without further approval: implements to green tests, opens a draft PR,
   reviews it in several lenses, corrects findings, waits for CI, flips the PR
   ready, merges it, deploys to the operator's own infrastructure, polls a health
   URL, asks the operator's error-monitoring service (Sentry / Datadog / Grafana
   via MCP) whether new errors appeared, and rolls back automatically when
   health or monitoring is red.
4. Ends with an honest structured report. A rolled-back deploy is a run whose
   authored outcome is `failed`, never a silent success.

## 2. Decisions already taken by the user

| Topic | Decision |
|---|---|
| Product class | A harness (runtime running agents through a DAG with gates), not a skill pack, not SaaS |
| Harness | Archon (MIT) |
| Human gates | Exactly two: after intake (confirm profile) and after plan. Merge and deploy run without approval |
| Infra / monitoring / stack | No preference. Everything configurable through a per-project profile |
| Intake questions | A fixed, configurable template is acceptable |
| Approach | A: compose the reference `sdlc` pack (`archon-plan`, `archon-deliver`) via `include:`; write only what is missing |

## 3. Where things live

### 3.1 Source repository (this repo)

```
archon-sdlc-factory/
├── README.md                     # what it is, install, first run, gate commands
├── install.sh                    # copies the package into ~/.archon/workflows/sdlc-factory/ and validates
├── .archon/workflows/sdlc-factory/factory/   # the Archon package (one workflow, packaged layout).
│   │                             # Living under .archon/workflows/ lets `archon validate` and
│   │                             # `workflow test` find it in this repo while developing.
│   ├── factory.yaml
│   ├── commands/
│   │   ├── intake.md             # the interview prompt
│   │   └── monitor.md            # the monitoring-check prompt
│   ├── scripts/                  # deterministic TypeScript on Bun
│   │   ├── _lib/                 # shared modules (not script targets)
│   │   │   ├── io.ts             # print JSON, exitCode discipline
│   │   │   ├── gate.ts           # parse a gate's output (JSON or dry-run "approved")
│   │   │   ├── profile.ts        # profile schema, validation, flattening, YAML serialising
│   │   │   ├── exec.ts           # run a shell command, log to a file, redact secrets
│   │   │   ├── rollback-decision.ts
│   │   │   └── report.ts         # build the terminal report document
│   │   ├── gate-round.ts         # used by profile-round and plan-round nodes
│   │   ├── write-profile.ts
│   │   ├── load-profile.ts
│   │   ├── deploy.ts
│   │   ├── rollback.ts
│   │   ├── decide-rollback.ts
│   │   └── report.ts
│   └── fixtures/                 # dry-run fixtures for `archon workflow test`
│       ├── fresh-profile.stubs.yaml
│       ├── existing-profile.stubs.yaml
│       ├── red-health-rollback.stubs.yaml
│       ├── monitor-errors-rollback.stubs.yaml
│       └── deploy-failed.stubs.yaml
├── tests/                        # bun test — unit tests for scripts/_lib
├── package.json                  # "test": "bun test" (no dependencies)
├── examples/
│   ├── factory-profile.example.yaml
│   └── mcp/
│       ├── monitoring.sentry.example.json
│       └── monitoring.datadog.example.json
└── docs/superpowers/
    ├── specs/2026-09-20-archon-sdlc-factory-design.md   # this file
    └── plans/                                            # implementation plan (next step)
```

### 3.2 Installed location

`~/.archon/workflows/sdlc-factory/factory/factory.yaml` (plus `commands/`,
`scripts/`, `fixtures/` beside it). This is Archon's packaged layout
(`<pack>/<workflow>/<one yaml>`), loaded globally and available in every
repository on the machine. Packaged commands and scripts resolve only inside
their own package, so nothing here shadows or is shadowed by the target repo.

Workflow name: `factory`. Invocation from any target repo:

```bash
archon workflow run factory --cwd /path/to/repo "Add a /health endpoint and a Dockerfile"
```

### 3.3 Project profile (in the target repository, committed)

Path: `.archon/factory-profile.yaml`. Written once by the workflow after gate 1,
committed on the run's branch, therefore lands in `main` with the first PR.

```yaml
# .archon/factory-profile.yaml — written by the factory workflow. Edit freely; the
# workflow never asks these questions again while this file exists.
version: 1
stack:
  language: python
  framework: fastapi
  test_command: "pytest -q"
  lint_command: "ruff check ."
  build_command: ""                    # empty = no build step
repo:
  remote: origin
  base_branch: main
  merge_strategy: squash               # squash | merge | rebase
deploy:
  command: "ssh deploy@vps 'cd /srv/app && git pull && docker compose up -d --build'"
  health_url: "https://app.example.com/health"
  wait_seconds: 120                    # how long health may take to turn 200
  rollback_command: "ssh deploy@vps 'cd /srv/app && git checkout HEAD~1 && docker compose up -d --build'"
monitoring:
  provider: sentry                     # sentry | datadog | grafana | none
  mcp_config: .archon/mcp/monitoring.json   # informational; the workflow uses this fixed path
  window_minutes: 10                   # how long after deploy to look for new errors
secrets:                               # NAMES only. Values come from the environment of the
  - DEPLOY_SSH_KEY_PATH                # machine that runs Archon. Never values.
  - SENTRY_AUTH_TOKEN
```

Rules:

- `secrets` holds environment-variable names only. A value that looks like a
  secret (contains `=`, whitespace, or is not `^[A-Z_][A-Z0-9_]*$`) fails
  validation.
- `deploy.command`, `deploy.rollback_command` and `stack.*_command` are single
  shell commands executed with `bash -c` on the machine running Archon. They may
  reference environment variables; they must not contain secret values.
- Monitoring MCP config lives at the fixed path `.archon/mcp/monitoring.json`
  in the target repo (gitignored, values via `$ENV_VAR` references, per Archon's
  MCP guide). The workflow cannot read `mcp:` from a runtime value, so the path
  is a convention, not a profile field. `monitoring.provider: none` or a missing
  file skips the monitoring step.

## 4. The workflow (`factory.yaml`)

### 4.1 Header

```yaml
name: factory
description: |
  Interview once, plan, deliver a reviewed PR, merge, deploy, verify health and
  monitoring, roll back on red, report honestly. Two human gates: the project
  profile and the plan.
  Use when: "build X and put it live", "factory: <task>".
  NOT for: reviewing an existing PR, or work that must not be merged/deployed.
interactive: true          # required: the workflow has approval gates
requires: [github]
inputs:
  task:
    default: ""
    description: What to build. Empty means the run's trigger message is the task.
returns: report
# outcome_field: delivered  — see §4.2 "no outcome_field in v1"
```

### 4.2 Nodes

Twelve logical steps, expressed as the nodes below. `→` marks `depends_on`.

| # | id | type | purpose |
|---|---|---|---|
| 1 | `profile-check` | bash | `{"exists": true/false}` for `.archon/factory-profile.yaml` |
| 2 | `intake-cycle` | loop_group (when `exists == false`) | body: `intake` (command) → `profile-gate` (approval, **last node**). Repeats while the operator answers `needs-revision`. Max 5 rounds |
| 3 | `profile-round` | script → [intake-cycle] | parses the gate output (whole text) into `{proceed, decision, stop_reason}` |
| 4 | `abort-profile` | cancel (when `profile-round.output.proceed == false`) | operator chose `abort` |
| 5 | `profile-write` | script (when `proceed == true`) | validates the approved draft JSON, writes YAML, `git add` + `git commit`; prints `{written, path}` |
| 6 | `load-profile` | script, `trigger_rule: none_failed_min_one_success`, → [profile-check, profile-write] | reads the YAML from the checkout, validates, prints a flat JSON of the fields downstream nodes bind |
| 7 | `plan-cycle` | loop_group → [load-profile] | body: `plan` (include `archon-plan`) → `plan-gate` (approval, last node; its message states whether the plan is `ready`). Max 3 rounds |
| 8 | `plan-round` | script → [plan-cycle] | same script as `profile-round` (`gate-round`), `{proceed, decision, stop_reason}` |
| 9 | `abort-plan` | cancel (when `plan-round.output.proceed == false`) | operator aborted |
| 10 | `deliver` | include `archon-deliver` (when `proceed == true`) | implement to green, draft PR, multi-lens review, corrections ≤5, validate, CI wait, flip ready. Returns `{pr_url}` |
| 11 | `merge` | bash → [deliver] | merge by profile strategy, delete the remote head branch, read back `MERGED`, print `{merged, merge_sha, head}` |
| 12 | `deploy` | script → [merge] | check out `merge_sha` detached, run `deploy.command`, log redacted output to `$ARTIFACTS_DIR/deploy.log`, print `{deployed, exit_code, deployed_at}`; exits 0 even when the command fails |
| 13 | `health` | bash → [deploy] (when `deployed == true`) | poll `health_url` until HTTP 200 or `wait_seconds` elapse; always exits 0; prints `{healthy, last_status, elapsed_seconds}` |
| 14 | `monitor-check` | bash → [health] (when `healthy == true`) | `{"enabled": true/false}`: provider != none AND `.archon/mcp/monitoring.json` exists |
| 15 | `monitor` | command `monitor` with `mcp: .archon/mcp/monitoring.json`, `allowed_tools: []` (when `enabled == true`) | ask the provider for new errors since deploy within `window_minutes`; prints `{status: healthy|errors|unavailable, findings}` |
| 16 | `decide-rollback` | script → [health, monitor], `trigger_rule: all_done`, bindings with `if_skipped` | `{rollback: bool, reason}`; rollback iff `healthy == false` OR `monitor.status == 'errors'`. `unavailable` and a failed deploy command never roll back |
| 17 | `rollback` | script (when `rollback == true`) | run `deploy.rollback_command`, redacted log, print `{rolled_back, exit_code}` |
| 18 | `report` | script → [merge, deploy, health, monitor, decide-rollback, rollback], `trigger_rule: none_failed_min_one_success` | terminal: `{delivered: bool, summary, pr_url, merge_sha, deploy_status, health, monitoring, rollback}`; also written to `$ARTIFACTS_DIR/report.json` |
| 19 | `not-delivered` | cancel → [report] (when `report.output.delivered == false`) | ends the run as `cancelled` with the report summary as the reason |

Notes on the shape (each verified with a probe workflow against Archon v0.10.1
on 2026-09-20):

- **Gates use the current `approval.decisions:` surface**, not the deprecated
  `on_reject`. Each gate declares `approve`, `needs-revision`, `abort`. In a
  real run the gate's output is `{decision, text}`; `text` carries the
  operator's words. Rework is wired explicitly: the gate sits inside a
  `loop_group` whose `until_bash` is `test $<gate>.output.decision != "needs-revision"`,
  and the body's first node reads `$LOOP_PREV.<gate>.output.text` as feedback
  (substituted by the real executor; left literal by the dry-run simulator,
  which is harmless).
- **The gate must be the loop body's last node** ("sole terminal sink"),
  otherwise the engine warns that the gate cannot pause the loop. So the
  joining script lives *outside* the loop and reads the loop's output, which is
  the gate's output.
- **The dry-run simulator auto-approves a gate with the plain string
  `approved`** and gates cannot be stubbed. The joining script therefore binds
  the *whole* gate output (`with: { gate: "$intake-cycle.output" }`), parses
  JSON when it is JSON, and treats the string `approved` as `approve`. Field
  access like `$intake-cycle.output.decision` would fail every fixture.
- **`ready` from `archon-plan` is not reachable outside the loop** (only the
  last node's output is). The plan gate's message therefore states the ready
  flag and summary in words; approving a blocked plan is the operator's
  explicit choice, and `archon-deliver`'s own green gate then fails honestly.
- **Intake writes its draft as an artifact**, `$ARTIFACTS_DIR/factory-profile.json`,
  and returns an `archon_artifact` pointer to it in its `output_format`, so the
  engine refuses a verdict without the file. The gate message tells the operator
  where to read it. `profile-write` reads that file after approval.
- **No `outcome_field` in v1.** Archon v0.10.1 rejects `outcome_field` on any
  user-scoped `bash:`/`script:` node ("declares no output_format"), even a
  verbatim copy of the bundled `ship` pack; the exec-node transform in the
  released binary drops `output_format` before that check. `main` already keeps
  it. Until the next release, a red result ends the run through the
  `not-delivered` cancel node whose reason is the report summary. The
  deterministic `report` stays the source of truth and `returns: report` still
  hands a composing caller the JSON. Re-add `outcome_field: delivered` when the
  installed Archon accepts it.
- **Three nodes can block the report by failing.** `report` has
  `trigger_rule: none_failed_min_one_success`, so a *failed* upstream node stops
  it: `deliver` (bound exhaustion, a refused ready-flip), `merge` (its `exit 1`
  after a genuine `gh` failure — an unknown merge strategy, an unreadable origin
  remote, a `gh pr merge` that fails, a PR that is not `MERGED` afterwards, or a
  merge commit still unreadable after the retry loop) and `monitor` (an AI node
  that fails to produce its declared schema). In those cases the run ends
  `failed` with the failing node's own error — the more truthful message — and
  there is no `report.json`. Everything downstream of a successful merge is a
  reported state rather than a node failure and still reaches `report`: a deploy
  *command* that exits non-zero, a checkout of the merged commit that fails
  (`deployed: false`), red health, monitoring that reports errors or is
  unavailable, and a rollback command that itself fails. Same trade
  `archon-ship` makes.
- **Profile commit lands in the PR.** `profile-write` commits on the run's
  branch, so the first PR carries `.archon/factory-profile.yaml`. Acceptable and
  documented.
- **Loop body nodes are not prefixed in fixtures** (`intake`, `plan__plan`),
  while include-expanded nodes are (`deliver__impl__implement`).

### 4.3 Data contracts (producer owns the schema)

`load-profile` output (flat, so every consumer binds a top-level field):

```json
{
  "language": "python", "framework": "fastapi",
  "test_command": "pytest -q", "lint_command": "ruff check .", "build_command": "",
  "base_branch": "main", "merge_strategy": "squash",
  "deploy_command": "...", "health_url": "https://...", "wait_seconds": 120,
  "rollback_command": "...",
  "monitoring_provider": "sentry", "window_minutes": 10,
  "secret_names": ["DEPLOY_SSH_KEY_PATH", "SENTRY_AUTH_TOKEN"]
}
```

Bindings into bash use `$load-profile.output.<field>` (auto shell-quoted).
Bindings into scripts use `with:` → `INPUTS_<UPPER_SNAKE>` and are read as
literal `process.env.INPUTS_<NAME>` so Archon's load-time binding scan sees them.

`intake` output:

```json
{ "summary": "one paragraph the operator reads in the gate message",
  "open_questions": ["..."],
  "report": { "type": "archon_artifact", "run_id": "...", "path": "factory-profile.json" } }
```

`health` output: `{healthy: boolean, last_status: string, elapsed_seconds: number}`.
`monitor` output: `{status: "healthy"|"errors"|"unavailable", findings: string}`.
`decide-rollback` output: `{rollback: boolean, reason: string}`.
`report` output: `{delivered: boolean, summary: string, pr_url: string, merge_sha: string, deploy_status: string, health: string, monitoring: string, rollback: string}`.

### 4.4 Prompts

`commands/intake.md` — a fixed questionnaire. The agent first reads the
repository (manifests, CI config, Dockerfiles, existing `.archon/`, README) and
pre-fills every answer it can find, marking each as "detected" or "assumed".
Questions, in order: language and framework; test, lint, build commands;
remote and base branch; merge strategy; deploy command; health URL and wait;
rollback command; monitoring provider and window; names of environment
variables the deploy needs. It never asks for or records secret values. It
writes `factory-profile.json` and returns the summary. On a revision round it
receives the operator's feedback text and changes only what the feedback
touches.

`commands/monitor.md` — receives provider name, window, deploy timestamp,
`merge_sha`. Uses only MCP tools. Reports `errors` only for issues first seen
after the deploy timestamp; `unavailable` when the tools are missing or fail;
`healthy` otherwise. Findings are a short list with issue titles and counts,
never raw payloads.

### 4.5 Security

- Secret values never appear in YAML, prompts, artifacts, or node output.
  `exec.ts` captures both streams of the deploy/rollback command into a log
  file; before writing, every non-empty value of each variable named in
  `secret_names` is replaced with `***`. Node stdout is only the JSON document.
- `merge` reads `owner/repo` from the origin remote through the same
  normalising substitution `archon-deliver` uses, so a token-bearing remote URL
  never reaches a command line or a message.
- `monitor` runs with `allowed_tools: []` and only the declared MCP file.
- `write-profile` refuses a draft whose `secrets` entries are not bare variable
  names.

### 4.6 Operator experience (CLI)

```bash
archon workflow run factory --cwd ~/code/myapp "Add a /health endpoint"
# ... pauses at profile-gate, prints the run id and the artifact path
archon workflow respond <run-id> approve
#   or: archon workflow respond <run-id> needs-revision "deploy is via flyctl, not ssh"
#   or: archon workflow respond <run-id> abort
# ... pauses at plan-gate
archon workflow respond <run-id> approve
# ... runs to the end without further input; prints the report
```

The Web UI (`archon serve`) shows the same gates with buttons. `interactive:
true` means a fresh launch cannot use `--detach`; continuation commands can.

## 5. Testing

1. **Load-time**: `archon validate workflows factory` — schema, references,
   binding scan, include closure.
2. **Dry-run fixtures**, run by `archon workflow test factory` (no AI spend,
   gates auto-approve unless stubbed):
   - `fresh-profile`: `exists: false` → intake → approve → write → plan ready →
     approve → deliver green → merge → deploy → health 200 → monitor healthy →
     no rollback → `delivered: true`. Expect `completed`.
   - `existing-profile`: `exists: true` → intake skipped → same tail.
   - `red-health-rollback`: health `healthy: false` → monitor skipped →
     rollback runs → `delivered: false` → `not-delivered`. Expect `cancelled`.
   - `monitor-errors-rollback`: health green, monitor `errors` → rollback.
     Expect `cancelled`.
   - `deploy-failed`: deploy `deployed: false` → health, monitor, rollback
     skipped → `delivered: false`. Expect `cancelled`.
   Gate decisions (`needs-revision`, `abort`) cannot be simulated: the dry run
   auto-approves every gate. Those paths are covered by the live run.
   Composed `bash:`/`script:` nodes that arrived through `include:` must be
   stubbed (the simulation does not deliver a caller's `with:` values to them);
   this package's own pure scripts (`gate-round`, `decide-rollback`, `report`)
   run for real with `exec-code: true`, which requires the fixture's repository
   to have at least one commit.
3. **Live run** on a throwaway GitHub repository with a trivial deploy command
   (for example `echo deploy`) and a health URL that returns 200, then a second
   run with a health URL that returns 500 to see the rollback path for real.

## 6. Assumptions for v1

- GitHub with `gh` authenticated on the machine running Archon.
- Deploy and rollback are each one shell command; health is one HTTP GET.
- Monitoring is an MCP server the operator configures in
  `.archon/mcp/monitoring.json`; the workflow ships example configs for Sentry
  and Datadog but does not install servers.
- The base branch has no merge queue or required-review rule that `gh pr merge`
  cannot satisfy for the operator's own account.
- Bun ≥ 1.2.21 (for `Bun.YAML.parse`) — Archon itself requires Bun for
  `runtime: bun` scripts, and the installer on this machine provides it.

## 7. Risks — verified 2026-09-20 with a probe package (Archon v0.10.1)

| Risk | Result |
|---|---|
| `approval:` inside a `loop_group:` | Works when the gate is the body's last node. A node after the gate triggers a "sole terminal sink" warning and the gate no longer pauses the loop |
| `$LOOP_PREV.<gate>.output.text` in a command file | Accepted by validation; substituted by the real executor (`dag-executor.ts`), left literal by the dry-run simulator |
| `$ARTIFACTS_DIR`, `$<node>.output.<field>` in `approval.message` and `cancel:` | Substituted (seen in the dry-run trace) |
| Global package including bundled `archon-plan` / `archon-deliver` | Works from `~/.archon/workflows/sdlc-factory/<workflow>/`; discovered and validated from an unrelated repository |
| `scripts/_lib/*.ts` imported by relative path with `.ts` extension | Works under `exec-code: true`; not treated as script targets |
| `when: "$x.output.flag == true"` / `== false` | Works |
| `outcome_field` on an exec `returns:` node | **Rejected by v0.10.1** for user-scoped workflows; replaced by the `not-delivered` cancel node (see §4.2) |
| Gate output in dry run | Plain string `approved`; not stubbable; consumers must bind whole output |
| Fixture keys | `exec-code:` / `fixture:` keys are only accepted by `archon workflow test`; `workflow run --dry-run --stubs` wants a plain stub map |

## 8. Out of scope (v1)

Multi-service deploys, non-HTTP health checks, blue/green strategies, GitLab or
Bitbucket, secrets managers, cost budgets per run, Slack/Telegram notifications
(easy to add later with Archon's ntfy pattern), and a Web UI form for the
profile.

## 9. Live run 2026-09-23 (Task 10)

Target: private repo `OlegShevtsov1/factory-smoke` (tiny Python http.server app), deploy
via `deploy/deploy.sh` (rsync release + `docker compose up -d --build` on a lab VM
over ssh), health through a local ssh tunnel (`http://localhost:8090/health`),
monitoring `none`. Archon v0.10.1, Claude Code 2.1.259, Bun 1.4.2.

**Green run** (`7e7839b3`): intake → `needs-revision` (health URL, wait) → intake
round 2 applied the feedback → approve → profile committed → plan (Opus, 1m54s) →
approve → implement → draft PR #1 → 5-lens review → validate → CI probe → ready
flip → squash merge → deploy (20s) → health 200 → report `delivered: true` →
`completed`. Profile landed on `main` with the PR; the second run skipped intake.

**Red run** (`0c34f554`): profile health URL pointed at a dead port, wait 20s →
plan → approve → PR #2 → merge → deploy → health `000` for 20s → rollback (server
back on the previous release, new endpoint gone) → report `delivered: false` →
`cancelled` with reason `Run stopped — Not delivered: health check did not return
200 … Rollback done.`

Fixed during the live run (all committed):

| Finding | Fix |
|---|---|
| `$LOOP_PREV.<gate>.output.text` is substituted only in YAML slots, never inside a command file; intake never saw the operator's feedback | `intake` node binds `with: feedback: "$LOOP_PREV.profile-gate.output.text"`, `intake.md` reads `$INPUTS.feedback` |
| `report` failed on `$deliver.output.url` when delivery failed upstream (binding to a skipped node) | `pr_url`, `merged`, `merge_sha` bound with `if_skipped` |
| Archon's bundled `assert-changed` (runtime `uv`) needs Python ≥ 3.10; `uv` picked pyenv 3.8 | `uv python install 3.12` + `UV_PYTHON=3.12` in the shell; README section |
| The user's `~/.claude/CLAUDE.md` ("ask before push / PR") is loaded by Claude Code in every session, including Archon's; `settingSources: [project]` does NOT exclude it (verified) — the PR node refused to push/create | Exception paragraph added to the user's CLAUDE.md for working directories under `~/.archon/workspaces/`; README section |
| `archon workflow resume` refuses if anything under the run's `workflow-source` capture changed (a stray `__pycache__` from a manual `py_compile` broke it) | Never touch the capture; documented here |

Confirmed live (watchlist): gate output is `{decision, text}`; `until_bash` on the
gate works on resume; `respond needs-revision` re-runs the loop body; a resumed run
uses the config sealed at start; `gh pr merge --squash` + `mergeCommit` read-back
worked first try; deploy/rollback logs are redacted and land in the artifacts dir.
