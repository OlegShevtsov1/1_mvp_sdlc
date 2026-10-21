# Delivery history

Internal run codes of the plan that built this repository (kept for traceability; not needed to use the toolkit).

## Status

**S3 delivered: the `mvp-sdlc` plugin 0.1.0 beside the vendored course plugin `sdlc` 4.5.1 in the marketplace
`mvp`** (S2: marketplace and layer-0 plugin lint). **C1 delivered: `docs/sdlc/`**, the SDLC process documents, starting
with [docs/sdlc/README.md](docs/sdlc/README.md). **C6 built: `mvp-sdlc` eval cases (layer 1), `make eval`; the
first pass^3 run is pending.** **S1-move delivered: the orchestration is imported** — the `factory` workflow with
its history, `plan-review`, the installer and the factory guide (see [Orchestration](#orchestration)).
**S3b delivered: the `check-branch-name` hook, `mvp-sdlc` 0.1.1.** **C1b delivered: the develop branch model in
`docs/sdlc/` and factory briefs with the `PILOT-<n>:` title and `Type:` line.** **S4 delivered: the project templates
`templates/project-be/` and `templates/project-fe/` from the pilot release, rendered by `bin/render-template`.** **S6 delivered: the develop branch model for this repository**
(`develop-guard.yml`, `pr-conventions-check.yml`, factory base `develop`).

## Planned structure

| Path | Delivered by |
|---|---|
| `README.md`, `LICENSE`, `.gitignore`, `.editorconfig` | S1-lite (this skeleton) |
| `.github/workflows/ci.yml` | S1-lite; extended by S2, S3, S1-move |
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
| `templates/project-be/`, `templates/project-fe/`, `templates/README.md`, `bin/render-template` | S4 |
| `.github/workflows/templates.yml`, `scripts/ci/templates-check.sh`, `scripts/test_templates.py` (CI check `templates`) | S4 |
| `bin/project-add` | S5 |

