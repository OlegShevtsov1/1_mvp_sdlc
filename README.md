# 1_mvp_sdlc

An AI-driven software delivery process for small product teams, packaged as code: Claude Code plugins that take an
idea through specification, architecture and tasks, and an [Archon](https://github.com/coleam00/Archon) workflow
("the factory") that turns each task into a tested, reviewed, merged and deployed pull request. It was built to deliver
the Pilot application below end to end, and it is reused by every project that follows the same conventions
(trunk with a `develop` branch, TDD commit order, tag-only production releases, health checks and rollback).

## Live

Built and operated with this toolkit:

- **Pilot app (prod):** <https://app.pilot.up.km.ua> · API <https://pilot.up.km.ua/health> · Swagger <https://pilot.up.km.ua/api-docs/index.html>
- **Pilot app (dev):** <https://app.dev.pilot.up.km.ua> · API <https://dev.pilot.up.km.ua/health>
- Repositories: [1_mvp_pilot_be](https://github.com/OlegShevtsov1/1_mvp_pilot_be) (Rails API) ·
  [1_mvp_pilot_fe](https://github.com/OlegShevtsov1/1_mvp_pilot_fe) (React SPA)

## How the AI process works

1. **Specify.** The course plugin `sdlc` (`/sdlc:interview`, `/sdlc:write-prd`, `/sdlc:architecture-design`,
   `/sdlc:generate-data-model`, `/sdlc:break-tasks`, ...) produces the feature artefacts in the project repository:
   idea brief, PRD, C4 architecture and ADRs, data model, task briefs. The `mvp-sdlc` plugin adapts it to Rails and
   to the two-repository setup (`rails-data-model`, `sync-spec`, `task-brief`, `feature-start` from a Trello card) and
   adds deterministic guards: a phase gate that refuses to skip a step, hooks that protect `main`, secrets and
   published tags, and branch-name and PR-convention checks.
2. **Build.** Each task is handed to the Archon `factory` workflow: plan (approved by a person) → tests first →
   implementation → multi-lens review (code, tests, docs, seams; P0/P1 findings block) → merge gate (CI green,
   conventions) → squash merge into `develop` → automatic dev deploy → health check → rollback on a red health check
   → report. The workflow pack and its operator guide are in [orchestration/](orchestration/docs/archon-factory.md).
3. **Release.** A person merges `develop` into `main` and tags an annotated `vX.Y.Z`; CI builds the release notes
   from the CHANGELOG and production is deployed only from that tag, then watched for ten minutes. The process
   documents are in [docs/sdlc/](docs/sdlc/README.md) (phases and gates, DoR/DoD, TDD, git and review, releases,
   agent security, observability, metrics).

The history of the plan runs that delivered this repository is in [docs/delivery-history.md](docs/delivery-history.md).

## Plugins

This repository is the Claude Code plugin marketplace `mvp` (`.claude-plugin/marketplace.json`).

- `plugins/sdlc/` is the course plugin, copied from upstream unchanged and never edited; source, version, tree sha256
  and the update procedure are in [plugins/sdlc/UPSTREAM.md](plugins/sdlc/UPSTREAM.md). Adaptations go to
  `plugins/mvp-sdlc/`.
- `plugins/mvp-sdlc/` (0.1.1) holds the pilot's adaptations: `rails-data-model` (Rails/ActiveRecord instead of
  SQL-first), `feature-start` (a feature starts from a Trello card), `sync-spec` (backend → frontend spec copy),
  `task-brief` (generated factory task texts), `bootstrap-project` (app-repo `.claude/` setup), and deterministic
  guards: the phase gate `sdlc-gate`, `lint-prd`, script-only `state.json`, and hooks that protect `main`, secrets
  and published tags. Details and the gate table: [plugins/mvp-sdlc/README.md](plugins/mvp-sdlc/README.md).
- `plugins/contracts.yaml` is the agent tool contract; `scripts/lint_plugins.py` enforces it together with skill
  frontmatter, hook definitions, marketplace/manifest versions and the vendored tree sha256 (evals layer 0,
  blocking in CI).
- Project repositories enable the plugin through a committed `.claude/settings.json`: `extraKnownMarketplaces` →
  `OlegShevtsov1/1_mvp_sdlc` and `enabledPlugins."sdlc@mvp": true` plus `"mvp-sdlc@mvp": true`, written by
  `bootstrap-project` (project scope only, never user scope).
- Plugin skills are for interactive Claude Code sessions. An unattended Archon run sees the plugin's agents but not
  its `/sdlc:*` skills (checked with `orchestration/workflows/plugin-probe.yaml`), so the factory never relies on them.

## Orchestration

- `orchestration/factory/` is the Archon `factory` workflow pack (plan → build → review → merge → deploy → health →
  rollback → report), imported with its history; its own [README](orchestration/factory/README.md) describes it.
- `orchestration/workflows/` holds the single-file workflows `plan-review` and `plugin-probe`.
- `./install.sh` installs all of them into `~/.archon/workflows`, backing up what it replaces, and validates them.
- The operator guide — requirements, install and rollback, tasks, gates, results, troubleshooting — is
  [orchestration/docs/archon-factory.md](orchestration/docs/archon-factory.md).
- The `mvp-ops` post-merge pack (operator steps after a merge) is versioned in a private planning repository.

## Checks

```sh
bash scripts/ci/check.sh            # everything CI runs
bash scripts/ci/check.sh --list     # the checks it knows; each has its own CI step
bash scripts/ci/check.sh hygiene    # one check
bash scripts/ci/check.sh plugins    # plugin lint, evals layer 0, eval runner tests (python3 >= 3.8, stdlib only)
bash scripts/ci/check.sh mvp_sdlc   # mvp-sdlc plugin tests: hooks, phase gate, scripts
bash scripts/ci/check.sh docs       # SDLC docs: links, references that exist, English only
bash scripts/ci/check.sh factory    # the factory's bun unit tests (bun >= 1.2.21)
bash scripts/ci/check.sh archon     # install, validate, fixtures and dry runs on Archon v0.10.1 and v0.11.1 (bun, uv)
```

`check.sh` runs locally exactly what CI runs. `scripts/ci/tools.sh` fetches the pinned actionlint and gitleaks
releases into `.tools/` (gitignored) and verifies their sha256; Linux x86_64 only. `tools.sh archon` does the same
for the two Archon release binaries the `archon` check runs (`.tools/bin/archon-<version>`); they are never installed,
and the check runs them with a throwaway `ARCHON_HOME`. Dependabot only updates GitHub Actions, so bump these pins
by hand in `scripts/ci/tools.sh`.

The hygiene check and gitleaks look at tracked files and committed history, so run the checks after committing.

`scripts/ci/hygiene-check.sh` is the public-repo rule shared with the app repositories. Tracked files must not
contain: internal or private IP addresses, internal hostnames, AWS account IDs, Route53 hosted zone IDs,
Trello or Notion links or IDs, Telegram links or chat IDs, or local home directory paths. It prints only `file:line`,
never the matching text. Three exceptions: `scripts/ci/notify-telegram.sh` may name the Telegram Bot API host,
`plugins/mvp-sdlc/bin/feature-start` may name the Trello API host, and the vendored
`plugins/sdlc/skills/generate-data-model/SKILL.md` is exempt from the 12-digit rule only (a UUID example).

### LLM evals

`make eval` runs the `mvp-sdlc` eval cases (evals layer 1) through `claude plugin eval` and writes
`eval/results/<version>.json`. It makes model calls, so it runs by hand before a `mvp-sdlc` version bump and never
in CI. It needs Claude Code (logged in), `bwrap`, `socat` and `make`. Details:
[plugins/mvp-sdlc/evals/README.md](plugins/mvp-sdlc/evals/README.md).

## main-guard

`.github/workflows/main-guard.yml` runs on every push to `main` and checks, through the GitHub API, that the commit
came from a merged pull request. If not, the run fails and an alert goes to the `MVP_VPN_ALERTS` Telegram topic.
Check any commit by hand with `gh workflow run main-guard.yml -f sha=<commit>`.

Without the repository secrets `TELEGRAM_MVP_VPN_ALERTS_BOT_TOKEN`, `TELEGRAM_MVP_VPN_ALERTS_CHAT_ID` and
`TELEGRAM_MVP_VPN_ALERTS_THREAD_ID` the Telegram alert is skipped and a violation only shows up as a failed run.

## License

MIT, see [LICENSE](LICENSE). The vendored course plugin under `plugins/sdlc/` keeps its own upstream MIT
license.
