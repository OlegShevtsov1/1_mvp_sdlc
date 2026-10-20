# Project templates

`project-be/` and `project-fe/` are the first commit of a new project's backend and frontend repositories: the
process, deploy and observability scaffolding of the pilot release (Kamal dev/prod configs reading
`config/project.env`, deploy/rollback/promote/manage scripts and guards, health, the error tunnel, GlitchTip smoke,
the full workflow set of the develop branch model, release tooling, `.claude/` guards, the PR template with its
`Type:` line), without the pilot's business code. Each directory is a full repository tree: what you see is what the
new repository contains after rendering. `github/` holds the C1 pull request template and is not rendered.

## Sources

| What | Repository | Ref | Commit |
|---|---|---|---|
| Backend | `OlegShevtsov1/1_mvp_pilot_be` | tag `v0.1.0` | `01294772d16773e4c2f40d5a200c80c71a2e1fc4` |
| Backend AI review (landed on `develop` after the tag) | `OlegShevtsov1/1_mvp_pilot_be` | `develop` commit | `04c85d797a6de20ef35cd9307198c20e2a7753e5`: only `.github/workflows/ai-review.yml`, `bin/ai-review-gate`, `bin/ai-review-skip`, `spec/deploy/ai_review_workflow_spec.rb`, `spec/support/github_expression.rb` |
| Frontend | `OlegShevtsov1/1_mvp_pilot_fe` | `main`; tag `v0.1.0` goes on this commit once the backend is on prod | `bbd51899a93acafe37d92a97afb6065af025f487` |

## Rendering

```sh
bin/render-template <be|fe> <name> <dest>
```

`<name>` is the project name: `^[a-z][a-z0-9]{1,15}$` (lowercase letters and digits, 2–16 characters, a leading
letter because it becomes a Ruby module). Every value below is derived from it:

| Placeholder | Value | For `tplcheck` |
|---|---|---|
| `{{PROJECT_NAME}}` | `<name>` | `tplcheck` |
| `{{PROJECT_ZONE}}` | `<name>.up.km.ua` | `tplcheck.up.km.ua` |
| `{{APP_MODULE}}` | `<name>` with the first letter capitalised (Ruby module, UI title) | `Tplcheck` |
| `{{REPO_BE}}` | `OlegShevtsov1/1_mvp_<name>_be` | `OlegShevtsov1/1_mvp_tplcheck_be` |
| `{{REPO_FE}}` | `OlegShevtsov1/1_mvp_<name>_fe` | `OlegShevtsov1/1_mvp_tplcheck_fe` |
| `{{SDLC_VERSION}}` | the 12-character commit of this repository the renderer ran from | |

Rules:

- Placeholders may appear in any text file. Any other `{{UPPER_CASE}}` token refuses the whole render (exit 2,
  `<file>:<line>` per hit, nothing written). GitHub expressions and Docker `--format` strings are not placeholders and
  are copied unchanged; so are files that are not UTF-8.
- A file ending in `.tmpl` loses the suffix (`config/project.env.tmpl` → `config/project.env`).
- Executable bits are preserved. Symlinks are refused.
- `<dest>` may be missing, empty or hold only `.git` (a fresh clone): the render is written there. If it already holds
  exactly this render, the renderer prints `unchanged` and exits 0. Anything else is refused (exit 1) and left as is.

Deliberately not placeholders:

- `PROD_VPN_IP`: a GitHub secret that `project-add` (S5) sets; never a file or a template value.
- The ticket key: `<KEY>` is `PROJECT_NAME` from `config/project.env` in capitals (the Trello board name).
  `bin/pr-conventions-check` (be) and `scripts/pr-conventions.sh` (fe) derive it at run time; prose says `<KEY>-<n>`.
- Telegram secret names: `TELEGRAM_DEV_ALERTS_*` and `TELEGRAM_PROD_ALERTS_*` with topics `DEV_ALERTS` and
  `PROD_ALERTS`, the same in every project (secrets are repository-scoped). The shared `notify-telegram` action
  builds the secret names from the topic.
- The shared composite actions of `OlegShevtsov1/1_mvp_infra` (`vpn-up`, `vpn-down`, `notify-telegram`) stay verbatim.

## What is not carried

Backend: models, the `api/` controllers, serializers, services, validators, exceptions and their specs, factories and
schemas; Devise, CanCanCan, token authentication, Redis session store, Active Model Serializers, Bullet,
Shoulda-Matchers, FactoryBot, rails-controller-testing and Overcommit (gems, initializers, locale, config lines);
`config/initializers/redis.rb` (only business code used it); all migrations, the schema (now empty at version 0) and
seeds; `config/credentials.yml.enc` (tied to the pilot's master key; production reads `SECRET_KEY_BASE`); `.docker/`,
`docker-compose.yml`, `.env.example`, `.overcommit.yml`, `TASK_DEFINITION.md`; the pilot's README, CONTEXT, CHANGELOG
history and architecture map content. `bin/swagger_smoke` keeps its framework and only the health and Swagger checks.
`Gemfile.lock` is the pilot's lock with the removed gems dropped; no other gem changed.

Frontend: the pilot frontend is already a scaffold, so only `docs/ai-review-checks.md`,
`docs/git-branching-checks.md`, `docs/sdlc-bootstrap-checks.md` and the README, CONTEXT, CHANGELOG history and
architecture map content are dropped. `deploy/min-be-version` is `v0.1.0`, the first backend release of a new project.

Beszel: the backend's prod `config/deploy.yml` has a `beszel-agent` accessory (host network, read-only Docker socket,
`KEY` from `BESZEL_HUB_KEY`). The frontend has none: it shares the prod host with the backend, and one host runs one
agent. Dev hosts get their agent from `1_mvp_infra`, not from Kamal.

## Checks

- **Fast, in CI:** `.github/workflows/templates.yml` runs `bash scripts/ci/check.sh templates` on pull requests that
  touch the templates or the renderer: the renderer's tests, then for `be` and `fe` a `tplcheck` render with no
  placeholder left, no word `pilot`, `gitleaks dir` clean and `actionlint` clean.
- **Full, by hand before a template change is relied on:** render `tplcheck` into an empty directory, then commit the
  render there (`git init -q && git add -A && git commit -qm render`; Kamal takes its version from the commit).
  - Backend, Ruby from `.ruby-version`, with throwaway `postgres:16-alpine` and `redis:7-alpine` containers and the DB
    and Redis variables of the RSpec job in `.github/workflows/rails-test.yml` pointed at them: `bundle install`,
    `bundle exec rails db:create db:schema:load`, `bundle exec rspec`, `bundle exec rubocop`,
    `bundle exec brakeman --no-pager -q`, `bundle exec bundler-audit check --update`,
    `DEV_HOST=dev.example.test KAMAL_REGISTRY_SERVER=registry.example.test bundle exec kamal config -c config/deploy.dev.yml`,
    `PROD_VPN_IP=prod.example.test KAMAL_REGISTRY_SERVER=registry.example.test bundle exec kamal config -c config/deploy.yml`.
    The backend Kamal configs are self-contained: always `-c`, never `-d`.
  - Frontend, Node from `.nvmrc`: `npm ci`, `npm run lint`, `npm test`, `npm run build`, then
    `DEV_HOST=dev.example.test ECR_REGISTRY=registry.example.test kamal config -d dev` (the frontend uses destinations).
  - Tick the `## Template inventory` checklist in each rendered README.

## Parity with the pilot workflows

Procedure: render `pilot` for each kind, extract the pilot's workflows and compare them.

```sh
bin/render-template be pilot /tmp/parity/render-be
bin/render-template fe pilot /tmp/parity/render-fe
mkdir -p /tmp/parity/pilot-be /tmp/parity/pilot-fe
git -C <path to 1_mvp_pilot_be clone> archive 01294772d16773e4c2f40d5a200c80c71a2e1fc4 .github/workflows | tar -x -C /tmp/parity/pilot-be
git -C <path to 1_mvp_pilot_be clone> archive 04c85d797a6de20ef35cd9307198c20e2a7753e5 .github/workflows/ai-review.yml | tar -x -C /tmp/parity/pilot-be
git -C <path to 1_mvp_pilot_fe clone> archive bbd51899a93acafe37d92a97afb6065af025f487 .github/workflows | tar -x -C /tmp/parity/pilot-fe
diff -ru /tmp/parity/pilot-be/.github/workflows /tmp/parity/render-be/.github/workflows
diff -ru /tmp/parity/pilot-fe/.github/workflows /tmp/parity/render-fe/.github/workflows
```

Every hunk must be one of the rows below; files not listed are identical.

| Repo | Workflow | Difference | Why |
|---|---|---|---|
| be, fe | `dev-deploy.yml`, `kamal-deploy.yml`, `kamal-manage.yml`, `release.yml`, `main-guard.yml`, `develop-guard.yml` | `TELEGRAM_PILOT_{DEV,PROD}_ALERTS_*` → `TELEGRAM_{DEV,PROD}_ALERTS_*` in `env:` and the preflight `required` lists; `topic:` `PILOT_DEV_ALERTS` → `DEV_ALERTS`, `PILOT_PROD_ALERTS` → `PROD_ALERTS` | the project prefix carries nothing in repository-scoped secrets, and no placeholder can produce an upper-case name; `project-add` (S5) sets these names |
| be | `main-guard.yml`, `develop-guard.yml` | comments say "the project's dev alerts topic" or "dev alerts", the alert step is `Alert DEV_ALERTS` | same rename |
| be, fe | `pr-conventions-check.yml` | header comment says `<KEY>-<n>:` instead of `PILOT-<n>:` | the key comes from `config/project.env` |
| be, fe | `ai-review.yml` | the "Conventions" item of the prompt says `<KEY>` and explains it | same |
| be | `ai-review.yml` | taken from `04c85d79`, not the tag; the security item no longer names CanCanCan and the authentication hard rule | the AI review landed after the tag; the template has neither CanCanCan nor that rule |

No actionlint fix was needed.

## Updating from a newer pilot release

1. Pick the new release commits and update the Sources table.
2. Take the changed process, deploy and observability files with `git -C <path to clone> show <commit>:<path>`,
   apply the same substitutions (placeholders, `<KEY>`, Telegram names), and leave business code out.
3. Run the fast check and the full check above; fix the templates until both pass.
4. Redo the parity diff and update the table: every hunk needs a row with its reason.
