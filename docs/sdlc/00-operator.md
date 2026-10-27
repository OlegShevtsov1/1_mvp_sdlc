# Operator guide: your steps at every stage

What **you** type and do at each stage of a feature, in plain words. It assumes the pilot CI/CD plan and the SDLC
addendum runs listed as done in [README.md](README.md); anything that a later run still has to deliver is marked
**planned** with that run's ID, together with what to do until then. The reference behind every step is in the
numbered sections ([00-model.md](00-model.md) first). Course basis: SDLC phases, gates and artifacts (M6.1).

Status when this page was written: the pilot runs on dev and prod with GlitchTip, monitoring and drilled backups;
this repository ships both plugins (S2, S3). Not yet done: the brownfield start of the app repositories (C2, C3:
`.claude/` setup, architecture map, `main-guard.yml`, the PR template), releases from tags (C4, C5), evals (C6). Until C2 and C3 are merged, a feature cannot start: section 1 lists what they bring.

## The main idea in one minute

- Work on a feature is split into **phases**. Each phase produces a **document** in the backend repository, under
  `docs/features/<slug>/`.
- Between phases there is a **gate**: you read the document and say "go on" or "fix this". A gate is passed when the
  document has `status: Approved` (or `Confirmed`, `Accepted`) and its docs pull request is merged; the `sdlc-gate`
  check refuses to start the next phase otherwise.
- The agent writes the documents. You **tell the idea, answer questions and approve**.
- Code is written by the Archon **factory**, test first (TDD): it opens the pull request, reviews it, merges it into
  `develop` (the app repositories' integration branch) and deploys to dev. You approve only the **task plan** before
  it starts.
- **You** merge releases (`develop` → `main`) and hotfixes into `main`; **prod** gets a release only after your typed
  confirm word.

Your role: **idea → answers → "yes" at the gates → `approve` of each task plan → release and the confirm word for
prod**.

## 1. One-time setup

Done by runs, not by you; you answer questions and approve their pull requests. Course basis: `CLAUDE.md` and the
`.claude/` layer (M4.4), plugins (M5.5).

| What appears | Why | Your part |
|---|---|---|
| This repository: the marketplace `mvp` with the course plugin `sdlc` (unchanged) and `mvp-sdlc` (our Rails and two-repo adaptations) | one source of the process for every project | done (S2, S3) |
| In `1_mvp_pilot_be` and `1_mvp_pilot_fe` (runs C2, C3): `/mvp-sdlc:bootstrap-project` writes `CLAUDE.md` (at most 200 lines, a Hard Rules block), `.claude/settings.json` (enables both plugins, deny rules), `.claude/rules/` and the local `.claude/sdlc.local.md` (test and lint commands, never committed) | the project memo and the guard rails for the agent | answer a few questions, say yes or no to every file that differs, approve the PR |
| `docs/architecture-map.md` in each app repository, written by `/sdlc:map-architecture` | the map of existing code every later phase reads | read it, approve the PR; rerun after large code changes |
| `config/project.env` with `PROJECT_NAME` and `PROJECT_ZONE` only (R-A11) | one place for the project name | approve the PR |
| `tdd-check.yml` in each app repository and the PR template from `templates/github/pull_request_template.md` | CI enforces the TDD commit order; the task Definition of Done as a checklist | approve the PR |
| The develop model in each app repository and in `1_mvp_sdlc` (decision 54): the branch `develop`, `pr-conventions-check.yml`, `develop-guard.yml` and `main-guard.yml` (decisions 24–29, [05-git-pr-review.md](05-git-pr-review.md)) | branch names, the `PILOT-<n>: <card title>` title and the `Type:` line are checked on every pull request; direct pushes are reported | done in the app repositories; in `1_mvp_sdlc` first create `develop` from `main` and finish the after-merge steps of the decision-54 PR; then merge the release and hotfix PRs into `main` yourself |
| Trello board `PILOT`, Notion page `PILOT`, the Telegram bots | already there | make sure the board has the lists of decision 53 — `Backlog`, `Ready`, `In Progress`, `Review`, `Test`, `Blocked`, `Ready to Release`, `Test after Release`, `Done` ([Board flow](03-dor-dod.md#board-flow)) — and the labels `feature`, `task`, `hotfix`, `run` (R-C11) |

Also once, on the operator machine:

- The **card link** everywhere on this page is the card's full URL from the browser address bar or the card's Share
  menu; `feature-start` also accepts the 24-character card id.
- Trello credentials for `feature-start` in `~/.config/trello/.env`: `TRELLO_API_KEY`, `TRELLO_TOKEN` and the board
  id as `TRELLO_BOARD_ID_PILOT` (the project name from `config/project.env`, upper case) or `TRELLO_BOARD_ID`. The
  command passes them to `curl` on stdin and never prints them. The factory reads the same file on the Archon host
  (only `TRELLO_BOARD_ID`) to move the task's card; without it the factory still delivers and only logs a warning.
- `RAG_MCP_URL` and `RAG_MCP_TOKEN` in the shell environment of the operator machine and the Archon host (values
  from the private infra registry and `~/.config/mvp-rag/`; never printed, never committed). They connect Claude Code
  sessions (through the `mvp-sdlc` plugin), the factory's plan stage and `bin/rag` to the project knowledge server
  `mvp-rag`; without them everything works and says mvp-rag is unavailable.
- The plugins are installed at **project scope only**, through the committed `.claude/settings.json`. The first time
  you open Claude Code in an app repository, accept the `mvp` marketplace when it asks.
- Known limitation: an unattended Archon run does **not** see a project-scope plugin (plugin probe, 2026-10-14:
  FAIL). The agreed fallback (R-B3: user scope on the operator machine) is pending a decision, because the plugin's
  hooks would then apply to every repository. Do not install it at user scope on your own. Until that is decided,
  the factory works without the `mvp-sdlc` hooks; its protection is CI, the `main-guard` workflow and the task text.

## 2. A new project

Once per project, for a project other than the pilot: `bin/project-add <name>` from a checkout of this repository
([project-add](../project-add.md) has the details). Course basis: one-time host preparation is done by a human
(M11.2); the command does the rest and stops where only you can act.

Before the first project, once: create the Notion page `PROJECTS` and connect the `PILOT` integration to it; put
`1_mvp_infra`'s `bin/` on your `PATH` (that checkout on `env/dev`); set `PROJECT_ADD_DEV_SSH` in
`~/.config/project-add/.env`. Check the plan first with `bin/project-add --dry-run <name>`: it calls nothing.

1. **Name**: lowercase Latin letters and digits, 2–16 characters, starting with a letter; not a name `1_mvp_infra`'s
   registry reserves (preflight asks the registry).
2. The nine steps, each recorded in `~/.local/state/project-add/<name>.json`; a rerun skips what is done:
   - `preflight`: read-only probes (name, `gh` account and scopes, AWS, Trello, Notion, Telegram, RAG settings,
     memory on the dev host, a free VPN address); any failure stops before anything is written.
   - `infra`: `vpnctl project add <name>` opens the registry PR; `vpnctl project bootstrap <name>` after its merge.
   - `repos`: the backend and frontend repositories from `templates/project-be/` and `templates/project-fe/`, the
     first commit on `main` and `develop` from the same commit.
   - `github`: environments `dev` and `prod`, the guard workflows active, the secrets it can source, among them
     `RAG_MCP_URL` and `RAG_MCP_TOKEN`.
   - `telegram`: topics `<name>_prod_alerts` and `<name>_dev_alerts`, their lines in `~/.config/telegram-bots/.env`
     and the `TELEGRAM_*` secrets.
   - `trello`: the board `<NAME>` with the lists of `bin/board-lists` and its labels.
   - `notion`: the page `<NAME>` under `PROJECTS`.
   - `plugins`: the two plugins enabled in each clone.
   - `report`: what was done, the links and what is left, posted to the `MVP_VPN_ALERTS` topic and the Notion page.
3. **Where it pauses for you** (exit code 3; do what it prints, then run `bin/project-add <name>` again; a failure
   that is no pause, such as a revoked bot token, stops with exit code 1 and prints its cause and remedy):
   - **Registry PR**: review and merge it in `1_mvp_infra`.
   - **DNS delegation, only from your console**: `vpnctl project delegate <name>` shows the exact NS record it will
     write; you type `DELEGATE-<name>` to go on. It never runs from GitHub Actions.
   - **First commit of the empty repositories** is the only allowed direct push to `main`, and only with your
     explicit OK (R-C4): you type `PUSH-<name>`. The guard runs on that commit are red; that is expected.
   - **Telegram bot**: with no token yet, in BotFather, `/newbot` → `@<name>_alerts_bot`; add it to the alerts
     group as an administrator who can manage topics; put its token on one line in `~/.config/telegram-bots/.env`.
     Never paste the token into a chat, an issue or a repository. When the bot exists but is not a member or not an
     administrator with "Manage topics", only make it one: no new bot, no new token.
   - **Notion**: only if the page `PROJECTS` is missing.
4. **Memory on the dev host**: at least 1.5 GB free before the project's dev stack is added (R-A8); the command
   checks it and stops if not.
5. **What stays manual**: the report lists it — the secrets it cannot source (deploy and prod SSH keys, GlitchTip,
   the frontend's read token for the backend, the AI review key), the plugin install if the check failed, the
   self-hosted runner, and the first prod deploy.
6. **Undo** a project that is not protected: `bin/project-add --undo <name>` runs `vpnctl project remove <name>`
   (you type `REMOVE-<name>`) and prints the repositories, board, page and topics to delete by hand.

After that the project lives by sections 1 and 3–7 of this page.

## 3. One feature, by size (XS, S, M+)

The size is decided during step 1: the interview, `/sdlc:classify-size` or `write-prd` proposes it, you confirm, and
it is written to `docs/features/<slug>/.size` in the brief's docs PR (course size matrix, M6.1). For XS you decide it
yourself before writing the card. `sdlc-gate` reads `.size` to know which documents a phase needs: S and XS need
no `sad.md` or ADR.

- **XS** — a small change, config or text: one PR, at most a day, no new table or API. No documents.
- **S** — a short brief and a PRD, no architecture and no task breakdown; one task per repository it touches.
- **M and larger** (M, L, XL) — the full path.

Every size starts from a Trello card and gets `docs/features/<slug>/state.json`, the machine state of the feature
that only scripts write. The slug is 2–16 lowercase letters and digits, no dashes (for example `pwreset`).
Between phases run `/clear`: one phase per session.

### Size XS

1. Card in `Backlog` named `<slug>: <title>`, label `feature`, with acceptance criteria written as
   Given / When / Then and the Definition of Done checklist from
   [03-dor-dod.md](03-dor-dod.md#definition-of-done-of-a-task) (R-C8.7).
2. In a Claude Code session in the backend repository, ask Claude to run the **command** `feature-start <card link>`
   (not the `/mvp-sdlc:feature-start` skill, which goes on into the interview). It creates `state.json` and moves the
   card to `In Progress`.
3. The factory task text is the card's acceptance criteria plus the DoD checklist, written by you; `task-brief`
   cannot generate it without a PRD and `tasks/tasks.json`. Then run the factory as in step 6 below.

### Size S

Steps 0–2 and 4–9 of the M path below, with these differences:

- step 1: pick `easy` when the interview asks for its depth (the same as `/sdlc:interview <slug> --depth=easy`);
- step 3 (architecture) is skipped; an ADR only if a decision needs one;
- step 4: `/mvp-sdlc:rails-data-model` only if the database changes; `/sdlc:api-forge` if an API changes;
  `/sdlc:plan-tests` (the test plan may stay inside the PRD);
- step 5: no `/sdlc:break-tasks` (it refuses without `sad.md` and an Accepted ADR). **Known gap:** the task is
  written by hand: ask the agent in the session to write, from the PRD, `docs/features/<slug>/tasks/tasks.json` with
  one task and one row in `docs/features/<slug>/tasks/tracker.md`, in the contracts docs PR (no `T1.md` is needed),
  then run `task-cards <slug>` to give the task its card and `task-brief <slug> T1` to validate both. A feature that
  touches the frontend too gets its frontend task as `T2` in the same backend `tasks/tasks.json` and `tracker.md`
  (layer `ui`), so `task-cards` gives it its card in the backend too; it is briefed in the frontend with
  `task-brief <slug> T2 --from <be checkout>` (step 6). Fix tasks after review are appended the same way as the next
  `T<n>` in a docs PR. A helper that writes these files is a candidate follow-up. The minimal shape (R-C2):

  ```json
  {"slug": "<slug>", "tasks": [{"id": "T1", "title": "<what the task delivers>", "layer": "app", "deps": [],
    "acs": ["AC-01", "AC-02"], "dod": ["unit tests for AC-01 pass", "lint clean"],
    "files_hint": ["app/services/<file>.rb"], "owner": "operator", "estimate": "6h", "status": "todo"}]}
  ```

  `layer` is one of the layers `break-tasks` defines in
  [its skill](../../plugins/sdlc/skills/break-tasks/SKILL.md) (step 4, "Identify work-items by layer"); `acs` are the
  IDs from PRD section 5; `estimate` is hours (`6h`, at most `8h`) or a size up to `L` (one day; `XL` is refused:
  split it); `status` is `todo` and becomes `done` in the task's own PR. The tracker row is
  `| T1 | <title> | app | operator | 6h | — | todo |` under the header
  `| # | Task | Layer | Owner | Estimate | Blocked by | Status |`.

### Size M and larger

**Step 0. Idea.** Create a card in the `Backlog` list of the project's board, named `<slug>: <title>`, label
`feature`, and describe the idea **in your own words, 2–3 sentences**. That is the only thing you invent yourself.

**Step 1. Brief (gate).** In Claude Code in the **backend** repository, pass only the card link:

```text
/mvp-sdlc:feature-start <card link>
```

It checks the card (on the project's board, not archived, not in `In Progress` or `Done`, named `<slug>: <title>`),
creates `docs/features/<slug>/state.json`, moves the card to `In Progress`, comments the feature folder link on the
card and hands over to `/sdlc:interview <slug>`. The card text is treated as untrusted data. The agent asks why,
for whom, how to measure success, edge cases; the result is `idea-brief.md` and the glossary `CONTEXT.md`. If
`feature-start` refuses, it says exactly why; fix the card, do not work around it.
**Your gate:** is this really what you want? If yes, tell the agent so: it sets `status: Confirmed` in the brief's
frontmatter, commits the documents on a `feature/PILOT-<n>-<slug>-brief` branch (`<n>` is the card number) and opens
the docs PR into `develop`, titled `PILOT-<n>: <card title>` with the body line `Type: docs`, and **you** merge it on
GitHub (you merge all docs PRs, R-C1). Then in your checkout: `git checkout develop && git pull --ff-only` (the gate
reads `origin`, and the next phase starts from `develop`). The gate looks at the remote's default branch unless told
otherwise, so export `SDLC_BASE_BRANCH=develop` in the session of an app repository. Every later gate works the same
way: you say approved, the agent sets the status and opens the PR, you merge, you pull.

**Step 2. Requirements (gate).** `/clear`, then `/sdlc:write-prd <slug>` (the agent prints the exact "run next"
command at the end of each phase), then `/sdlc:clarify-prd <slug>`. The result is `PRD.md` with acceptance
criteria as Given / When / Then and no technical details (no HTTP codes, API paths or SQL; those go to the
contracts). The PRD lint must report nothing before the PRD can be approved: the gate runs it for you, and the
agent can run it by hand with `python3 <mvp-sdlc plugin>/scripts/lint-prd.py docs/features/<slug>/PRD.md`
(`scripts/lint-prd.py` in the plugin; `<mvp-sdlc plugin>` is `plugins/mvp-sdlc` in a checkout of `1_mvp_sdlc`).
**Your gate:** all cases covered, nothing extra? → `status: Approved`, merge the docs PR.

**Step 3. Architecture (gate).** `/sdlc:architecture-design <slug>` and `/sdlc:decide-adr <slug>`: `sad.md` (how the
feature fits into the system) and `adr/NNNN-*.md` (decisions with "why").
**Your gate:** do you agree with the decisions? → ADRs `Accepted`, merge the docs PR.

**Step 4. Contracts.** In turn: `/sdlc:complete-sequence-diagrams <slug>` (flows in `sad.md`), `/mvp-sdlc:rails-data-model <slug>` (data model
and staged ActiveRecord migrations), `/sdlc:api-forge <slug>` (`contracts/openapi.yaml`, checked against the
backend's existing API description), `/sdlc:plan-tests <slug>` (which test level checks each criterion; you
confirm). You only answer when the agent asks about a disputed point.

**Step 5. Tasks.** `/sdlc:break-tasks <slug>` cuts the feature into tasks: `tasks/T<n>.md`, `tasks/tasks.json`,
`tasks/tracker.md`. A task is at most one day of work and at most 500 changed lines. Right after it, in the backend,
`/mvp-sdlc:task-cards <slug>` gives every task its own Trello card (decision 78): it shows a dry run first, then
creates each card in `Ready` with the label `task` (or adopts a card already named `<slug> T<n>: …`), records the
card in `tasks/tasks.json` and adds the task to the feature card's checklist. Then, as at every gate, the agent
opens **one contracts docs PR** with everything from steps 4 and 5 (the documents keep the status their skill
gives them; the gate for this phase is the Definition of Ready) and you merge it. If the feature touches the
frontend, sync the spec copy now (section 4). Check the Definition of Ready: the PRD approved and merged, for M+ the
SAD and an Accepted ADR merged, every task in `tasks/tasks.json` with criteria from PRD section 5 and a test level
for each, no task over a day, CI green on `main`, and `task-brief` prints the text for each task without refusing
(details: [03-dor-dod.md](03-dor-dod.md)), each with its own card. Then move the feature card to `Ready`. From
`Ready` on, the factory moves each task's card ([Board flow](03-dor-dod.md#board-flow)): you only read its comments;
the feature card follows the feature's state and you move it.

**Step 6. Code, through the factory.** For each task, in the repository that owns it:

1. Order: backend tasks first. Start a frontend task only after the backend tasks it needs are merged and healthy
   on dev, and after `sync-spec <slug> --from <be checkout> --check` exits 0 in the frontend (section 4).
2. Write the task text to a file, from the app repository's root:
   `<mvp-sdlc plugin>/bin/task-brief <slug> T<n> > /tmp/<slug>-T<n>.txt` (`<mvp-sdlc plugin>` is `plugins/mvp-sdlc`
   in a checkout of `1_mvp_sdlc`; in a Claude session `/mvp-sdlc:task-brief <slug> T<n>` prints the same text). A
   frontend task is in the backend `tasks/tasks.json`: in the frontend, after `git -C <be checkout> fetch origin`,
   add `--from <be checkout>`. The text carries the pull request title `PILOT-<task card>: <task title>` and the
   `Type:` line that `pr-conventions-check.yml` requires. A refusal is a Definition of Ready failure: fix the cause
   (finish the dependency, split the task, add the missing test level, run `task-cards`, start the feature from its
   card), never write the text by hand. A warning that the task has no card means the title falls back to the
   feature card: run `task-cards` first.
3. Start the run with that whole file, unchanged, as the message (the shell's command substitution of
   `cat /tmp/<slug>-T<n>.txt` in double quotes keeps it one argument):
   `archon workflow run factory --cwd <repo> "<the task text>"`. The command prints the run ID; later,
   `archon workflow status` lists running and paused runs with their IDs, and
   `archon workflow wait <run-id>` blocks until the run ends or needs your decision.
4. **Gate 1** (only the first time in a repository): the project profile → answer
   `archon workflow respond <run-id> approve` (or `needs-revision "what to change"`, or `abort`).
5. **Gate 2**: the task plan → read the short summary → `approve` or `needs-revision "what to change"` (or
   `abort`), with the same `archon workflow respond` command.
6. Without you: three commits on the PR branch — `test(...)` (the test fails) → `feat(...)` (it passes) →
   `refactor(...)`; review by several lenses; CI; **merge into `develop` as one squash commit**; deploy to **dev**;
   health check. If health is red, the factory rolls dev back and reports. Meanwhile the factory moves the task's
   card, the one the task text names: `Blocked` while gate 1, gate 2 or the visual gate (a UI task's screenshots,
   after CI) waits for you, `In Progress` once you approve the plan, `Review` when the PR is open, `Test` when the
   run is delivered. A PR into a base you merge by hand stays in `Review` with the comment "waits for the operator
   merge" until you merge it.
7. The agent ticks the task on the feature card's checklist; `archon workflow get <run-id>` shows the result.
8. **If the run stopped** (a red check, a `BLOCKED` question, a failed deploy): the factory moves the card back to
   `Ready` with a comment naming the reason (after a failed rollback it leaves the card in `Blocked`: dev needs you).
   Read the comment or `archon workflow get <run-id>`, and answer or fix it. Then either
   `archon workflow resume <run-id>` (continues from the completed nodes) or, if the task itself had to change,
   start a new run with the new `task-brief` text; the new run moves the card again. A run that ends
   `cancelled` with `merge refused` cannot be resumed — see [the factory guide](../../orchestration/docs/archon-factory.md).

Self-correction rule (RULE-LOOP): if review misses a serious (P0/P1) problem twice in a row, tasks labelled
`migration`, `auth` or `security` switch to manual merge (R-C1) and their review to the large model (R-C12). You
record each miss in the release's execution log; where the risk labels live is not decided yet (see the end of
this page).

**Step 7. Feature review (gate).** When every task is done, in the backend repository:
`/sdlc:review-feature <slug>`. A clean-context agent checks all the code against the PRD and the architecture.
Findings: P0 (critical), P1 (important), P2 (minor).
**Your gate:** no P0 and no P1 (P2 goes to the backlog). Otherwise: new small tasks through the factory.

**Step 8. Release.** `/sdlc:ship-feature <slug>` re-runs the checks, writes `docs/features/<slug>/CHANGELOG.md` and
`docs/features/<slug>/pr-body.md`, and proposes a PR command; it never merges. Ask the agent to open that PR as a
docs PR and merge it like any docs PR, **before** the prod deploy: its merge commit is the one you deploy.
Today prod takes a **commit**, not a tag. For a feature that touches both apps: backend first, then frontend.

1. Open the release pull request `develop` → `main` (title `PILOT-<n>: Release vX.Y.Z` with the release's own card,
   never `PILOT-0` (decision 91, [Board flow](03-dor-dod.md#board-flow)), and one `Type:` line in the body, for
   example `Type: feat`: the check requires both on every pull request) and merge it yourself with a
   **merge commit**; a pull request into `main` is never merged automatically (decision 27). A `main` commit is not
   deployed to dev by itself (decision 28): dispatch Dev Deploy on `main` with
   `gh workflow run dev-deploy.yml -R OlegShevtsov1/<repo> --ref main`, wait for it to finish green, then take its sha:
   `gh run list -R OlegShevtsov1/<repo> --workflow dev-deploy.yml --branch main --event workflow_dispatch --status success --limit 1 --json headSha`.
   The body of a release pull request also has `## Changelog` with the full section of the version from
   `CHANGELOG.md` (decision 64); in `1_mvp_sdlc` the pr-conventions check fails a `PILOT-<n>: Release vX.Y.Z` pull
   request without it.
2. Deploy it: in GitHub Actions of the app repository, `kamal-deploy.yml` → Run workflow on `main`, or
   `gh workflow run kamal-deploy.yml -R OlegShevtsov1/<repo> --ref main -f environment=prod -f version=<sha> -f confirm=prod`.
   The confirm word is `confirm=prod`; it runs only from `main`.
3. Watch the run to its end (`gh run watch`). The deploy itself checks `/health` and a read-only smoke test before it
   counts as done. Then for 10 minutes watch the project's prod Telegram topic and GlitchTip: any new prod issue
   means the hotfix path (section 5). If the backend deploy is fine and the frontend deploy fails, roll back only the
   frontend.

The agreed model (R-C9) is **planned** (C4 backend, C5 frontend): `next-version.sh` (planned, C4) proposes the
number, you push an annotated tag `vX.Y.Z` on `main`, `release.yml` (planned, C4) creates a draft GitHub Release from
the changelog that you publish, prod deploys only a tag, and `release-watch` (planned, C4) watches health and new
GlitchTip issues for 10 minutes and reports to Telegram. **Rollback is never automatic**: it is your decision.

**Step 9. After the release.** Monitoring (Gatus, Beszel, GlitchTip) and Telegram alerts stay as in the pilot plan
([08-observability.md](08-observability.md)). Metrics once per release: section 6. If the brief's success metric
did not come true, that is a new idea: back to step 0. The task and feature cards, and the release's own card, end
in `Done` through the release runs (planned, C4); until then you move them from `Test` (the release card from
`In Progress`) on and comment the links to the prod deploy runs and the merged PRs.

### Your time per feature (size M)

| Step | What you do | About |
|---|---|---|
| 0. Idea | card in Trello, 2–3 sentences | 5 min |
| 1. Brief | about 10 answers, read, merge the PR | 15–30 min |
| 2. PRD | answers, read, merge the PR | 15–30 min |
| 3. Architecture | read, approve, merge the PR | 10–20 min |
| 4–5. Contracts, tasks | confirm disputed points, merge the PR | 10 min |
| 6. Code | `approve` of each task plan | 2–5 min per task |
| 7. Feature review | read the findings | 10–15 min |
| 8. Release | run the deploy, type the confirm word, watch | 15 min |

## 4. Frontend: spec copies with sync-spec

The backend repository owns the feature documents; the frontend keeps a read-only copy (R-B2). Course basis:
contracts as the shared source (M6.6).

1. Fetch the backend checkout: `git -C <be checkout> fetch origin`.
2. In the frontend repository: `/mvp-sdlc:sync-spec <slug>` in a Claude session, or the command
   `sync-spec <slug> --from <be checkout>`. It copies `PRD.md`, `sad.md`, `adr/`, `contracts/`, `CONTEXT.md` and
   `test-plan.md` (whichever exist, so an S feature without `sad.md` is fine) from a backend commit, marks every file
   "do not edit" and records the source commit and the card number in `docs/features/<slug>/.spec-source`. The
   command reads `origin/main` unless told otherwise; the feature documents of the app repositories are on `develop`,
   so pass `--ref origin/develop` (the command: `sync-spec <slug> --from <be checkout> --ref origin/develop`).
3. Commit the copy on a `feature/PILOT-<n>-<slug>-spec` branch and merge the docs PR into `develop` (title
   `PILOT-<n>: <card title>`, body line `Type: docs`). `sync-spec` does not copy `tasks/`: frontend tasks listed in
   the backend `tasks/tasks.json` are briefed in the frontend with `task-brief <slug> T<n> --from <be checkout>`.
4. Never edit a copied file in the frontend: change the backend first, then sync again.
5. Before each frontend task and in its Definition of Done: `sync-spec <slug> --from <be checkout> --check` must exit
   0. It runs only locally: frontend CI cannot read the private backend repository.

## 5. Hotfix and rollback

When prod is broken (course: the human decides the rollback, M11.3):

1. **Roll back first if it is burning.** In GitHub Actions of the app repository run `kamal-manage.yml` with
   `action=rollback`, the confirm word `confirm=prod` and, optionally, `version` = the sha to return to (empty = the
   one before the current). From your console the same is `deploy/rollback.sh prod`.
2. Then the fix: a card labelled `hotfix`, fixed in a Claude Code session (not the factory: its base is `develop`)
   on a branch `hotfix/PILOT-<n>-<slug>` cut from `main`. Its pushes run Dev Deploy from the hotfix branch
   (decision 28). Open the pull request into `main` (title `PILOT-<n>: <card title>`, body line `Type: fix`) and
   merge it yourself; then open a second pull request from the same hotfix branch into `develop` (the back-merge)
   and merge it too. Prod as in step 8: dispatch Dev Deploy on `main`, then `kamal-deploy.yml` with that sha. Under
   the agreed model (planned, C4) that is a PATCH tag (`v1.3.0` → `v1.3.1`) and nothing reaches prod without a tag,
   a hotfix included.
3. `kamal-manage.yml` also has `status` and `logs` (no confirm), `restart` (`confirm=prod`) and `remove`
   (`confirm=remove-prod`, after a backup gate; never without a reason you can name).

## 6. Metrics once per release

`bin/sdlc-metrics` (planned, C4) will append one line per release to the execution log: lead time (from the artifact
PRs to the last task merge), task cycle time, failed factory runs, review findings P0/P1/P2, escaped defects (new
GlitchTip issues within 7 days of the release), prod rollbacks, stale documents (`status: Draft` for more than 30
days). Look at the trend, not at one number; the metrics are for the team, never per person (R-C7, course M11.6).
Until then, after each release write those numbers by hand from the factory reports, GitHub and GlitchTip into the
release's execution log, kept in Notion beside the run execution logs under the project's page (`PILOT` for the
pilot). Once a month: review them together with the RULE-LOOP and the auto-review trigger
(R-C5); details in [09-metrics.md](09-metrics.md).

## 7. Rules you never break

Course basis: deterministic guards over instructions (M5.4), untrusted agent inputs (M11.1).

- **prod only from `main`, only with your confirm word** (today a Dev-Deploy-built commit; with C4 only a tag).
  Rollback is a human decision; the AI never rolls back prod.
- **You merge docs PRs.** The factory merges code PRs after your `approve` of the task plan, green CI and its review.
- **Tests are never changed to fit the code.** If a test fails, the code or the requirement changes. If a test
  encodes a wrong acceptance criterion, the agent stops and asks you.
- **Secrets reach neither the repository nor the agent**: gitleaks in CI, deny rules in `.claude/settings.json`, the
  `block-env` hook.
- **No direct pushes to `main` or `develop`**: every change in every repository goes through a pull request
  (decision 54); the hooks and deny rules block the dangerous commands for `main`, and the `main-guard` and
  `develop-guard` workflows report any direct push to Telegram (R-C4, decision 27).
- **`state.json` is moved only by scripts**, never by you or the agent by hand.
- **Feature documents are never deleted after merge.** They are the history of the decisions.
- **DNS delegation and destroying anything: only from your console or with your OK.**
- If the agent says **BLOCKED**, it is not an error but a question for you: answer it.

## Commands to remember

```text
/sdlc:map-architecture                 once per app repository, again after large changes
/mvp-sdlc:feature-start <card link>    every new feature (backend repository)
/mvp-sdlc:sync-spec <slug>             frontend repository, when the backend documents changed
/mvp-sdlc:task-cards <slug>            one Trello card per task, after break-tasks (backend repository)
/mvp-sdlc:task-brief <slug> T<n>       the factory task text
archon workflow run factory --cwd <repo> "<the task text>"
archon workflow respond <run-id> approve
/sdlc:review-feature <slug>            when every task is done
/sdlc:ship-feature <slug>              changelog entry and PR body for the release
```

Every intermediate command is printed by the agent at the end of a phase ("run next"). Run `/clear` between phases.
The `/sdlc-<skill>` form (for example `/sdlc-write-prd`) works too; these documents write `/sdlc:<skill>` (R-C8.3).

## Not decided yet

1. **Which feature goes first** through the full pilot cycle (runs C7–C9): size S or M, backend and frontend,
   preferably with a migration and a UI change. Chosen right before C7 (R-C10, deferred; it blocks nothing else).
2. **Whether to document existing pilot code retroactively** (users, sessions): the course does not cover it; for now
   only `docs/architecture-map.md`.
3. **The unattended plugin fallback** (R-B3, see section 1).
4. **Where the risk labels `migration`, `auth`, `security` of the RULE-LOOP live** (pull request labels or Trello
   labels) and who sets them; until decided, you note the risk in the task's PR description.
5. **Aligning the card moves with the agreed flow**: `feature-start` moves the card to `In Progress` at step 1, the
   agreed flow keeps it in `Backlog` until `Ready` ([00-model.md](00-model.md#phases-and-gates-for-the-pilot)).
   From `Ready` on, the factory already follows decision 53 ([Board flow](03-dor-dod.md#board-flow)).
