# project-add: a new project from one command

`bin/project-add <name>` turns a project name into a working project (S5 of the SDLC addendum): the registry entry
and infrastructure in `1_mvp_infra`, the backend and frontend repositories rendered from
[the templates](../templates/README.md) with `main` and `develop`, their GitHub environments and secrets, the alert
topics in Telegram, the Trello board, the Notion page, a plugin check and a report. It runs from a checkout of this
repository on the operator's machine, stops where only the operator can act, and continues from the same step on
the next run.

```sh
bin/project-add --dry-run <name>      # the plan for <name>; calls nothing, writes nothing
bin/project-add <name>                # run, or continue after a pause
bin/project-add <name> --step <id>    # run one step again (every earlier step must be done)
bin/project-add --undo <name>         # vpnctl project remove, then a checklist of what to delete by hand
```

Exit codes: `0` done (or dry run, or undone), `1` stopped (`STOP …` says why), `2` usage or a refused `--step`,
`3` paused for the operator (`PAUSE …` says exactly what to do).

## Prerequisites

Once, before the first project:

- **Notion**: create a top-level page titled exactly `PROJECTS`; on it, ••• → Connections → add the integration
  `PILOT`. The integration can create pages only where it already has access.
- **1_mvp_infra**: its `bin/` on `PATH`, the checkout on `env/dev` with a clean tree. project-add finds the checkout
  through `vpnctl` and reads its `scripts/projects.py`.
- **`~/.config/project-add/.env`** (mode 600): `PROJECT_ADD_DEV_SSH=<ssh destination of the dev host>`, for
  example a `Host` alias from `~/.ssh/config`.

Credentials, read from the environment first, then from these files (the same ones the other tools use):

| File | Keys |
|---|---|
| `~/.config/trello/.env` | `TRELLO_API_KEY`, `TRELLO_TOKEN` |
| `~/.config/notion/.env` | `NOTION_TOKEN` |
| `~/.config/telegram-bots/.env` | `TELEGRAM_MVP_VPN_ALERTS_BOT_TOKEN`, `TELEGRAM_MVP_VPN_ALERTS_CHAT_ID` (and `_THREAD_ID`) |
| `~/.config/mvp-rag/.env` | `RAG_MCP_URL`, `RAG_MCP_TOKEN` |

`gh` must be logged in as the account that owns the project repositories, with the `repo` and `workflow` scopes;
`aws` must have a session for `AWS_PROFILE` (default `hs-action`, as `vpnctl`). Other settings:
`PROJECT_ADD_REPOS_DIR` (where the clones go, default `~/projects/mvp`), `PROJECT_ADD_MERGE_WAIT` (seconds to wait
for the registry PR merge, default 600), `PROJECT_ADD_POLL_SECONDS` (default 10).

## The steps

| # | Step | What it does | Where it pauses |
|---|---|---|---|
| 0 | `preflight` | Read-only probes: the name (format, reserved names, not `protected`), `gh` account and scopes, `aws sts get-caller-identity`, a call to the Trello, Notion and Telegram APIs, the RAG settings, at least 1.5 GB available on the dev host (R-A8), a free VPN octet 70–99. Every failure is listed; nothing is written. | — |
| 1 | `infra` | `vpnctl project add <name>` (registry PR), waits for its merge on `env/dev`, fast-forwards the local checkout, `vpnctl project bootstrap <name>`. | The PR is not merged yet: merge it after review. Bootstrap waits for the DNS delegation: `vpnctl project delegate <name>` (MFA, type `DELEGATE-<name>`). |
| 2 | `repos` | Creates `1_mvp_<name>_be` and `1_mvp_<name>_fe` (private), clones them, renders the templates, makes the first commit (`Type: chore`), pushes it to `main` and creates `develop` from the same commit (decision 24), `gh repo set-default`. | Before the push: it prints both clones and the commit and asks you to type `PUSH-<name>` (R-C4: the only direct push to `main`). |
| 3 | `github` | Environments `dev` and `prod`; waits until `develop-guard.yml` and `pr-conventions-check.yml` are active; sets every secret below it can source. | — |
| 4 | `telegram` | Checks the project's alerts bot (admin in the alerts group, can manage topics), creates the topics `<name>_prod_alerts` and `<name>_dev_alerts`, writes `TELEGRAM_<NAME>_{PROD,DEV}_ALERTS_{BOT_TOKEN,CHAT_ID,THREAD_ID}` into `~/.config/telegram-bots/.env`, sets the `TELEGRAM_*` secrets. | No token for the bot: BotFather `/newbot` → `<name>_alerts_bot` (R-A6), add it to the alerts group as an administrator with "Manage topics", add the line `TELEGRAM_<NAME>_PROD_ALERTS_BOT_TOKEN=<token>` to the file. The bot is not a member or not an administrator with "Manage topics": make it one; no new bot, no new token. If the bot cannot be checked (a revoked token, Telegram or the network failing), it stops with the cause instead (exit 1): replace a revoked token on its line, otherwise run again. |
| 5 | `trello` | Board `<NAME>` with the lists of `bin/board-lists` in order and the labels `feature`, `task`, `hotfix`, `run`; writes `TRELLO_BOARD_ID_<NAME>` into `~/.config/trello/.env`. | — |
| 6 | `notion` | Page `<NAME>` under `PROJECTS`, then `GET /v1/pages/<id>` must answer 200 (R-A7). | `PROJECTS` is missing or not shared with the integration (see Prerequisites). |
| 7 | `plugins` | `claude plugin list --json` in each clone: every plugin its `.claude/settings.json` lists under `enabledPlugins` (`sdlc@mvp`, `mvp-sdlc@mvp`) enabled for that project. A miss is recorded and reported; the run goes on. | — |
| 8 | `report` | A ✅/❌ table of the steps, the links (repositories, board, page), the topics, the dev and prod addresses and the manual steps left; printed, posted to the `MVP_VPN_ALERTS` topic through `scripts/ci/notify-telegram.sh` and appended to the project's Notion page. | — |

## State and idempotency

The state is `~/.local/state/project-add/<name>.json` (mode 600, never in git, no secret values): per step its
status (`done`, `paused`, `failed`), the time and what it created (PR, repositories, clones, board, page, topics, the
names of the secrets it set). `bin/project-add <name>` prints `already done` for the steps recorded done and runs
the first that is not. Each step also checks the remote state before acting: an existing repository, board, list,
label, page or secret is reused, never created twice; a topic is created only when its `_THREAD_ID` line is missing. A secret that is already set is never replaced, so a
generated `POSTGRES_PASSWORD` stays what the first deploy used. Once origin `main` starts at project-add's first commit
(`Rendered by bin/project-add.`), `repos` no longer renders and only completes `develop` and `gh repo set-default`,
so a live project's moved-on `main` or a failed rerun never blocks it.

## Secrets

| Secret | Repository | Scope | Source |
|---|---|---|---|
| `AWS_ROLE_ARN` | be, fe | repository | the project's OIDC role (`vpnctl project show`, `aws iam get-role`) |
| `VPN_CI_OVPN` | be, fe | repository | the `ci` VPN profile as a split tunnel (`vpnctl user get ci`, `vpnctl _split-tunnel`) |
| `RAG_MCP_URL`, `RAG_MCP_TOKEN` | be, fe | repository | the one shared mvp-rag server (decision 61 b) |
| `PROD_VPN_IP` | be, fe | `prod` | the registry (`vpnctl project show`) |
| `SENTRY_DSN` | be, fe | `dev`, `prod` | GlitchTip `<name>-be-<env>` / `<name>-fe-<env>`, read over ssh on the dev host |
| `SENTRY_ALLOWED_FE_DSN` | be | `dev`, `prod` | GlitchTip `<name>-fe-<env>` |
| `SECRET_KEY_BASE`, `POSTGRES_PASSWORD`, `SMOKE_TOKEN` | be | `dev`, `prod` | generated, one value per environment |
| `TELEGRAM_DEV_ALERTS_*` | be, fe | `dev` | step 4 |
| `TELEGRAM_PROD_ALERTS_*` | be, fe | `prod` | step 4 |
| `SRV_DEPLOY_SSH_KEY` | be, fe | repository | manual: the dev host deploy key, which has no copy |
| `PROD_SSH_KEY` | be, fe | `prod` | manual: exists after the project's prod deploy |
| `GLITCHTIP_API_TOKEN` | be, fe | `prod` | manual |
| `GLITCHTIP_API_URL`, `BE_REPO_READ_TOKEN` | fe | `prod` | manual (the token is a fine-grained PAT, which no API creates) |
| `ANTHROPIC_API_KEY` | be, fe | repository | manual |

The list is exactly the `secrets.*` names a default render of the templates' workflows reads plus the two RAG names;
the test pins it.
Values reach `gh secret set` on standard input; API tokens reach `curl` in its configuration on standard input. No
value is ever printed, put on a command line or written to the state. The template's production configuration reads
`SECRET_KEY_BASE`, so no `RAILS_MASTER_KEY` is set.

## What stays manual

The report lists it every time: the manual secrets above with their `gh secret set` command, the plugin install when
the check failed, registering a self-hosted runner for the repositories and setting `RUNS_ON`, and the first prod
deploy (P3). The `main-guard` and `develop-guard` runs on the first commit are red: that push had no pull request,
and R-C4 makes it the one exception.

## Undo

`bin/project-add --undo <name>` refuses a project whose registry entry says `protected: true` (the pilot), or whose
entry it cannot read, and does nothing else. Otherwise it runs `vpnctl project remove <name>`, which asks you to type `REMOVE-<name>`, removes what
Project Bootstrap created and opens the registry removal PR. Then it prints what project-add created and never
deletes by itself, each to delete with its own OK: the two repositories and their clones, the Trello board, the
Notion page, the Telegram topics and bot, and the `TELEGRAM_<NAME>_*` and `TRELLO_BOARD_ID_<NAME>` lines. The state
file becomes `<name>.undone.json`.

## Troubleshooting

- **`STOP preflight failed`**: fix each listed probe; nothing was written, so simply run again.
- **Paused at the registry PR**: review and merge it in `1_mvp_infra`, then run again; the wait is
  `PROJECT_ADD_MERGE_WAIT` seconds per run.
- **The local `1_mvp_infra` checkout cannot fast-forward**: switch it to a clean `env/dev` and pull, as printed.
- **Paused at the delegation**: `vpnctl project delegate <name>` from your console only, then run again.
- **`refused … differs from this render`** in `repos`: the clone or the repository already holds something
  project-add did not push; move the clone away or set `PROJECT_ADD_REPOS_DIR`, and reconcile a foreign `main` by hand.
- **`STOP 4 telegram: checking the bot of …`**: the Telegram call failed; the reason follows. Run again; a revoked
  token is replaced on its line in `~/.config/telegram-bots/.env` first.
- **A step failed after a manual fix**: `bin/project-add <name> --step <id>` runs it again.
