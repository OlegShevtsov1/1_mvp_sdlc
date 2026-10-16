# 1_mvp_sdlc

## Live

Projects built with this SDLC:

- **Pilot app (prod):** <https://app.pilot.up.km.ua> · API <https://pilot.up.km.ua/health>
- **Pilot app (dev):** <https://app.dev.pilot.up.km.ua> · API <https://dev.pilot.up.km.ua/health>
- Repos: [1_mvp_pilot_be](https://github.com/OlegShevtsov1/1_mvp_pilot_be) · [1_mvp_pilot_fe](https://github.com/OlegShevtsov1/1_mvp_pilot_fe)

The MVP SDLC toolkit: a Claude Code plugin marketplace with the course `sdlc` plugin and the `mvp-sdlc`
adaptations, project templates, the "new project" orchestrator and the Archon orchestration (the `factory` and
`plan-review` workflows).

The repository is private today and is planned to become public as part of the portfolio publication run (PUB).
That is why the public-repo hygiene rules below apply from the very first commit.

## Status

**S3 delivered: the `mvp-sdlc` plugin 0.1.0 beside the vendored course plugin `sdlc` 4.5.1 in the marketplace
`mvp`** (S2: marketplace and layer-0 plugin lint). **C1 delivered: `docs/sdlc/`**, the SDLC process documents, starting
with [docs/sdlc/README.md](docs/sdlc/README.md). **C6 built: `mvp-sdlc` eval cases (layer 1), `make eval`; the
first pass^3 run is pending.** **S1-move delivered: the orchestration is imported** — the `factory` workflow with
its history, `plan-review`, the installer and the factory guide (see [Orchestration](#orchestration)).
**S3b delivered: the `check-branch-name` hook, `mvp-sdlc` 0.1.1.** **C1b delivered: the develop branch model in
`docs/sdlc/` and factory briefs with the `PILOT-<n>:` title and `Type:` line.**

## Planned structure

| Path | Delivered by |
|---|---|
| `README.md`, `LICENSE`, `.gitignore`, `.editorconfig` | S1-lite (this skeleton) |
| `.github/workflows/ci.yml` | S1-lite; extended by S2, S3, S1-move and later S4 |
| `.github/workflows/main-guard.yml` | S1-lite |
| `.github/dependabot.yml`, `.archon/factory-profile.yaml`, `scripts/ci/` | S1-lite |
| `install.sh`, `.archon/mcp/monitoring.json` | S1-move |
| `orchestration/factory/` | S1-move |
| `orchestration/workflows/plan-review.yaml` | S1-move |
| `orchestration/docs/archon-factory.md` | S1-move |
| `orchestration/tests/dry-run/`, `scripts/ci/archon-check.sh` (CI checks `factory`, `archon`) | S1-move |
| `.claude-plugin/marketplace.json` | S2 |
| `plugins/sdlc/` (upstream course plugin 4.5.1, unchanged) | S2 |
| `plugins/contracts.yaml`, `scripts/lint_plugins.py` (evals layer 0) | S2 |
| `scripts/test_lint_plugins.py`, `tests/fixtures/broken-agent/` | S2 |
| `orchestration/workflows/plugin-probe.yaml` | S2 |
| `plugins/mvp-sdlc/` (adaptations, hooks, phase gate; CI check `mvp_sdlc`) | S3 (delivered) |
| `plugins/mvp-sdlc/evals/` (eval cases, evals layer 1), `Makefile` (`eval`, `eval-results`) | C6 |
| `scripts/evals.py`, `scripts/test_evals.py`, `eval/results/` | C6 |
| `docs/sdlc/`, `scripts/check_links.py`, `scripts/check_docs.py` (CI check `docs`) | C1 (delivered) |
| `templates/github/pull_request_template.md` | C1 |
| `templates/project-be/`, `templates/project-fe/`, `bin/render-template` | S4 |
| `bin/project-add` | S5 |

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
- Unattended Archon probe (`orchestration/workflows/plugin-probe.yaml`), 2026-10-14, Claude Code 2.1.281,
  Archon 0.10.1: FAIL — a project-scope plugin enabled only through `.claude/settings.json` is not visible to an
  unattended run; fallback per R-B3 pending (user scope on the operator machine).

## Orchestration

- `orchestration/factory/` is the Archon `factory` workflow pack (plan → build → review → merge → deploy → health →
  rollback → report), imported with its history; its own [README](orchestration/factory/README.md) describes it.
- `orchestration/workflows/` holds the single-file workflows `plan-review` and `plugin-probe`.
- `./install.sh` installs all of them into `~/.archon/workflows`, backing up what it replaces, and validates them.
- The operator guide — requirements, install and rollback, tasks, gates, results, troubleshooting — is
  [orchestration/docs/archon-factory.md](orchestration/docs/archon-factory.md).
- The `mvp-ops` post-merge pack is not here: it is versioned in the private plan repository and installed from there.

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

**Pending operator action:** set the repository secrets `TELEGRAM_MVP_VPN_ALERTS_BOT_TOKEN`,
`TELEGRAM_MVP_VPN_ALERTS_CHAT_ID` and `TELEGRAM_MVP_VPN_ALERTS_THREAD_ID`. Until they are set the Telegram alert is
skipped and a violation only shows up as a failed run.

## License

MIT, see [LICENSE](LICENSE). The vendored course plugin under `plugins/sdlc/` (S2) keeps its own upstream MIT
license.
