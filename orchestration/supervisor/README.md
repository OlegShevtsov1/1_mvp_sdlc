# sdlc-autopilot supervisor

`sdlc-autopilot` answers the routine pauses of Archon runs so the operator only sees what needs a person. It is a
bun service with no LLM in its decisions: every answer follows a rule in [`policy.yaml`](policy.yaml), and a pause
that no rule answers escalates to the operator.

`install.sh` copies this directory to `~/.archon/supervisor` and renders the systemd user unit
`sdlc-autopilot.service` without enabling it. The unit's `PATH` carries the operator's login PATH and the
rbenv/nvm/pyenv/tfenv directories that exist, so the runs the supervisor starts find `ruby`, `bundle` and `node`
([details](../docs/archon-factory.md#2-install-update-and-roll-back)).

## The tick

Every 30 s the supervisor opens `~/.archon/archon.db` read-only (it never writes to Archon's database) and reads the
open runs and the runs that finished in the last 24 h. Each paused run's open pause is classified:

| Workflow / node | Kind |
| --- | --- |
| `factory` / `plan-gate` | `plan-gate` |
| `post-merge` / `install-gate` | `install-gate` |
| `post-merge` / `gate` | `post-merge-gate` |
| `factory` / `pr-approve` | `pr-approve` |
| `factory` / `qa-dev` | `qa-dev` |
| anything else | `other` |

A pause is judged once: when the ledger already has a line for its `(run_id, event_id)`, it is skipped. Pauses that
existed before the supervisor started are judged on its first tick.

A failed run is not a pause: the `transient-resume` rule resumes it with backoff or escalates it (PILOT-508). After
the pauses, the tick launches `post-merge` for merged PRs of finished factory runs (PILOT-510), queues or advances
the automatic release (PILOT-613, [Releases](#releases)), then starts queued briefs (PILOT-511). This README describes
the gate rules, post-merge launches, the queue, the `/task` chain and releases.

## The ledger

`~/.local/state/sdlc-autopilot/ledger.jsonl` (override: `SDLC_AUTOPILOT_LEDGER`) gets one JSON line per decision:
`{ts, run_id, workflow, kind, rule, action, evidence: {event_id, node, text, message}}`. `rule` names the rule that
decided; `action` of a gate decision is `approve` (`plan-gate`, `post-merge-allowlist`), `retry` or `escalate`; for
`approve` and `retry` it records that the respond was dispatched, not its outcome. `evidence.text` is the pause or error text Archon shows, and
`evidence.message` the decision's own text for the operator, the reason of an escalation. An answer the operator gave
through a Telegram button is a line with `rule: operator` and the pause's decision as `action`: `approve`, `retry`,
`skip`, `abort`, `reject` (its `evidence.text` is the operator's reason) or `ok` (QA dev accepted). A QA dev answer
whose Trello move or fix task failed adds an escalation under the same pause, rule `qa-dev-trello` or `qa-dev-fix`.
The QA prod card's answer is such a line too, `{run_id: release:<id>, kind: qa-prod, action: ok|reject}`: the journal
entry of a release accepted or rejected on prod ([QA prod](#qa-prod)).

## Answering a pause

An `approve` or `retry` runs `archon workflow respond <run-id> <approve|retry> --occurrence <pause-id> -- <text>`
detached (own session, stdin `/dev/null`, no `timeout`) in the run's own working directory, logging to
`~/.local/state/sdlc-autopilot/logs/<run-id>.log`. `--occurrence` pins the answer to the pause the policy judged: if
the operator answered it first, Archon refuses. A pause whose run metadata names no occurrence is not answered, and
neither is one whose respond cannot be started: the decision is recorded as an escalation instead. A respond that starts but then fails is not detected: its pause stays open with its ledger line
written, and its log holds the error. The text goes after `--`, because Archon refuses a positional argument that starts
with `-` as an unknown option, and an operator's reason may well start with one.

## Telegram

Every escalation goes to the operator as one Telegram message, sent by `@mvp_vpn_alerts_bot`, the bot this repo's
harness already alerts through. The supervisor reads `TELEGRAM_MVP_VPN_ALERTS_BOT_TOKEN`,
`TELEGRAM_MVP_VPN_ALERTS_CHAT_ID` and the optional `TELEGRAM_MVP_VPN_ALERTS_THREAD_ID` (the topic) from
`~/.config/telegram-bots/.env` (override: `SDLC_AUTOPILOT_TELEGRAM_ENV`) on every call; without the token or the chat
id it logs `Telegram disabled` at start and sends nothing. The token is never written to the ledger, the state file
or the journal: every Telegram error is logged with the token masked.

After its decisions, each tick sends every `escalate` ledger line of the last 24 h that it has not sent yet, whichever
part of the supervisor wrote it. A line counts as sent once Telegram accepted it, so a send that fails is retried on
the next tick; a crash right after a send can send that one message again. The message is HTML in plain Ukrainian,
built by fixed rules in `src/humanize.ts`:

- one header, `🟡 Потрібне твоє рішення: …`, naming the release (`реліз sdlc v0.9.3`, from the PR title post-merge's
  `fetch` read), the card (`PILOT-<n>: …`) or else the workflow and repository;
- the step in words: `Крок <n> з <last>: <title>` on a post-merge gate (the plan's own step numbers, the last one from
  the run's `steps.json`; the title is the step's full heading from `steps.json`, shortened at a word boundary with `…`
  so that the line is at most 90 characters), `План задачі готовий до перевірки` on a plan gate, `Встановлення чекає, поки завершиться
  прогін фабрики` on an install gate;
- `Що сталося:` — one sentence by pause type, with the value a failed check observed when it can be read (`GitHub
  відповів "не знайдено"` for HTTP 404, `команда завершилась з кодом N`);
- `Що рекомендую:` only where a rule gives one: on a checkout step, `онови плагін mvp-sdlc у be і fe (claude plugin
  update mvp-sdlc@mvp --scope project) …` when the step runs `claude plugin update`, else `виконай команди кроку у
  своєму терміналі (деталі нижче) …`, with the step's text from `steps.json` added to the collapsed block; on an
  install gate out of retries, to wait;
- the original pause text in a collapsed block, without the pack's own header, the `$ARTIFACTS_DIR` lines and the
  decision legend; the block is cut with `…` so the message stays under Telegram's 4096 characters.

The factory's PR approval wait (`pr-approve`, `merge_approval: operator`) is a card instead: the header `🟡 PR готовий:
<PR title>`, a line with the link `PR #<n>`, `Diff: <n> файлів, +a −d` and `Checks: <n> ✅`, `Що сталося:` (CI green and
the review ready, with the round, or the review's reason it is not ready), `Підсумок:` (the factory's summary) and
`Що рекомендую:` (whether to approve or to return, and that the last round's return stops the run). The collapsed
block holds the run, the round line and the `Review:` line. A pause text without a `PR:` line of the shape
`https://github.com/<owner>/<repo>/pull/<n>` is sent as an ordinary escalation, still with the pause's buttons.

The factory's QA dev wait (`qa-dev`, a profile's `qa_dev`, after a green deploy) is a card «На dev готово» too. First
the screenshots go out as one album (`sendMediaGroup`, captioned `<page> · <width>px`): at most the first 6, read only
from the run's own `~/.archon/workspaces/<repo>/artifacts/runs/<run-id>/qa-dev.json`, only when its `sha` is the open
pause's `SHA:`, and only PNG files under that run's `qa-dev/`. Then the card, as a reply to the album: the header
`🟡 На dev готово: <title>`, a line with the links `dev`, `e2e: ✅ прогін` (or `не налаштовано`) and `PR #<n>`,
`Що сталося:` (deployed to dev, the short commit, the e2e state), a screenshots line (how many were sent and, past 6,
how many were left out; that there are none; or that they could not be read or sent) and `Що рекомендую:`. The
collapsed block holds the run and the `URL:`, `SHA:`, `PR:`, `E2E:` and `Shots:` lines. A refused album is logged and
the card still goes out. The album goes only with the policy's first escalation of the pause; a re-escalation after a
failed respond repeats the card alone, and so does the retry of a card whose own send failed (it still replies to
the album already sent). A pause text without a `URL:` line is sent as an ordinary escalation.
`✅ Прийнято` answers `ok` and moves the task's Trello card to `Ready to Release`: the card is the first card link in the
run's message, else its first `PILOT-<n>` (the board's card number), on the board `TRELLO_BOARD_ID`, with
`TRELLO_API_KEY` and `TRELLO_TOKEN` from `~/.config/trello/.env` (override: `SDLC_AUTOPILOT_TRELLO_ENV`; API base
override: `SDLC_AUTOPILOT_TRELLO_API`), sent in an `Authorization` header only. `↩️ Є зауваження` asks for the text the
way `↩️ Повернути` does, answers `reject` with it, and writes the fix brief
`queue/<repo>/fix-PILOT-<n>-<run8>.md`: `Fix for PILOT-<n>: <text>`, then the repository, the card link, the original
PR, the commit and URL on dev, and the original task's paths, so the queue holds it behind any open run that shares
them. The card's close note gains a line on the move or the queued file. A move or a brief that fails is escalated as
its own message, rule `qa-dev-trello` or `qa-dev-fix`, without buttons: the pause is already answered.

A shipped release's QA prod wait (`qa-prod`, [QA prod](#qa-prod)) is a card «На prod» the same way: its album holds the
release's prod screenshots, read only from `releases.json` and only PNG files under
`~/.local/state/sdlc-autopilot/release-shots/<id>/`; the header is `🟡 На prod: реліз <id> (<features>)`, then a
link per shipped repo (`be v0.5.0 · fe v0.6.0`, to the URL bin/release's smoke checks), `Що сталося:` (deployed to
prod with smoke and e2e green, each version and short commit), the screenshots line (`реліз не змінив сторінок із
профілю` when there are none) and `Що рекомендую:`. Its buttons are `✅ OK` and `↩️ Reject`; Reject asks for the text
like `↩️ Повернути`, and its toast is `↩️ Відкочую prod і ставлю fix-задачу`.

When the line is about the run's open pause, the message carries one button per decision the pause itself declares:
`✅ Прийняти` (`✅ Готово` on a checkout step, `✅ Апрув` on a PR card), `⏭ Пропустити крок`, `⛔ Зупинити`,
`🔁 Чекати ще`, `✅ Прийнято` (`ok`; `✅ OK` on a QA prod card), and `↩️ Повернути` on a PR card (`↩️ Є зауваження` on a
QA dev card, `↩️ Reject` on a QA prod card) only (another
gate's `reject` may cancel its run, so it gets no button). A line about a pause the operator already answered by
button gets no buttons.
The plan gate's `needs-revision` needs a feedback text and stays an `archon workflow respond` by hand.

`↩️ Повернути` responds nothing by itself: its toast is `↩️ Напиши відповіддю, що змінити`, and the bot sends
`↩️ Що змінити? …` as a ForceReply to the card. Only a reply to that prompt counts as the reason, whatever it says;
the respond is then `reject` with the reply's text, the bot answers the reply with `↩️ Повертаю на доопрацювання`, and
the card closes with `✅ Вирішено: повернуто на доопрацювання (кнопкою)`. A reply without text (blank, a sticker)
answers nothing and is asked again with a new prompt; any other message in the chat is not a reason. A reply after
the pause was answered gets `Це питання вже вирішене`.

A button press runs `archon workflow respond <run-id> <decision> --occurrence <pause-id> -- <text>` the way a policy
answer does and writes the `rule: operator` ledger line. It is answered only on the pause the message was sent for,
while that pause is still open, once, and only with a decision of that pause; a respond that cannot start is escalated
again with the buttons. Once the pause is answered — by a button, outside Telegram (`approval_received` or
`wait_answered` in Archon's events), or because the run moved on — the message is edited once: it keeps its text, gets
`✅ Вирішено: прийнято|пропущено|зупинено|продовжено (кнопкою|поза Telegram)` and loses its buttons. The tick reads
the runs again right before it sends, so a pause answered during the tick is not sent with live buttons. An edit that
failed is retried on the next tick, unless Telegram refused it with a client error other than 429. Each close is
logged as `Telegram message <id> of <run> closed: …`. `/status` in the chat answers with a digest: the
running runs, the runs waiting for the operator, the queued briefs and the next one to start, as of the last tick.
`/task <be|fe|sdlc> <text>` starts a task, answered as a reply to it (see
[`/task` and the SDLC stage chain](#task-and-the-sdlc-stage-chain)).

Updates are read by their own loop next to the tick, by `getUpdates` long polling (25 s), so a press arrives within
about a second, and only from the operator's chat; updates from any other chat are dropped without a reply. Every
press is answered at once, within Telegram's ~15 s window for a button, with a toast: `✅ Прийнято, виконую`,
`⏭ Пропускаю крок`, `⛔ Зупиняю`, `🔁 Чекаю далі` or `✅ Прийнято`, then the respond runs. Only the first press on an open pause
acts; a press on a pause that is no longer open or was already answered gets `Це питання вже вирішене`, and a button
the pause does not declare `Кнопка вже не діє`. A press whose run or ledger could not be read gets
`⚠️ Не вдалося прочитати стан — натисніть ще раз` and keeps its buttons. A failed poll is retried after 5 s, 15 s, then every 60 s, without
holding back the tick. Another `getUpdates` reader of the same bot, such as a manual topic lookup with `curl`, makes
the loop's polls fail (Telegram answers `409 Conflict`) and takes the updates away from the supervisor while it runs.

The update offset, the sent lines, the messages with open buttons (with the HTML each was sent with) and the open
`Що змінити?` prompts (`replies`, by the prompt's message id, dropped when their card closes) and the albums whose
card is not out yet (`albums`, by run and pause, dropped once the card is sent or the pause closes) are kept in
`~/.local/state/sdlc-autopilot/telegram.json`, next to the ledger. Deleting it re-sends the escalations of the last
24 h.

## Post-merge launches

The tick looks at the factory runs that finished (completed or cancelled) in the last 14 days and whose report has a
`pr_url`, and asks `gh` which of those PRs are merged. A merged PR is owed one `post-merge` run only when GitHub merged
it at or after the cutoff: `post_merge.since` in `policy.yaml` (an ISO timestamp with `Z` or `±hh:mm`; any other value
stops the supervisor at start), else the supervisor's first start. The first start is written once to
`~/.local/state/sdlc-autopilot/state.json` (`first_start`) on the first tick and never moved; deleting the file makes
the next start the cutoff. So enabling the supervisor never re-runs post-merge for PRs merged before.

A PR is not launched again when the ledger already has its launch, or when any `post-merge` run, failed ones included,
names it: by a `github.com/<owner>/<repo>/pull/<n>` URL anywhere in its message, by `<owner>/<repo>#<n>`, or by a
`#<n>`, `pr=<n>` or `pr=#<n>` token in a run whose working path is in the same repo. A PR in a repo outside the
supervisor's bounds escalates once (`post-merge-forbidden-repo`), and so does one whose title has no `PILOT-<n>:`
prefix (`post-merge-no-card`) or whose launch fails (`post-merge-launch-failed`). A launch waits for the limits below.

## Queue and limits

A ready brief is a file `~/.config/sdlc-autopilot/queue/<repo>/<name>.md` (override: `SDLC_AUTOPILOT_QUEUE`), where
`<repo>` names a repo Archon has one `workspaces/<owner>/<repo>/source` checkout of. The tick starts briefs in order —
`1_mvp_sdlc` first, then oldest first — as a detached `archon workflow run factory --cwd <source> <message>`, where
the message is the brief text followed by a line `sdlc-autopilot-launch: <uuid>`.

Every run the supervisor starts, post-merge and queued briefs alike, needs a free slot and an idle enough host, set
by the top-level `limits` block of `policy.yaml`: `max_runs` (5) pending or running runs in all, `max_runs_per_repo`
(3) in the repo, `MemAvailable` ≥ `min_mem_available_mb` (800) and load1 ≤ `max_load1` (8). Paused runs take no
slot. A transient resume waits for the same host threshold. A tick that defers a brief or a post-merge launch only
for the host prints the limit and the measured value to the journal, e.g. `1 queued brief(s) wait for host
resources: MemAvailable 700 MB < 800 MB`. A missing or non-positive limit stops the supervisor at
start. Besides, a brief does not start while a factory run of the same repo is open (pending, running or paused)
whose message names an overlapping repo-relative path: the same path, or one under a named directory
(`CHANGELOG.md` included). URLs, absolute, `~` and `$VAR` paths and `owner/repo` names do not count,
and a brief that names no path runs alone in its repo. A 1_mvp_sdlc task records its change in its own fragment
`changelog.d/PILOT-<n>.md`, not in `CHANGELOG.md`, so briefs that name their fragments do not overlap.

A started brief is moved to `queue/started/<repo>/launch-<uuid>--<name>.md` before the launch and renamed
`<run-id>--<name>.md` once the factory run whose message carries its `sdlc-autopilot-launch: <uuid>` line shows up
in Archon. Until then it holds a slot as a pending run. Each start is a ledger line with `kind: queue`,
`rule: queue-launch`, `action: launch-task` and the pseudo run id `queue:<repo>/<name>`. These escalate once, under
the same pseudo run id:

| Rule | Situation |
| --- | --- |
| `queue-forbidden-repo` | The repo is `1_hrss_pilot` or `pilot-srv-*` |
| `queue-unknown-repo` | Archon has no single `workspaces/*/<repo>/source` |
| `queue-no-card` | The brief text names no `PILOT-<n>` card |
| `queue-launch-failed` | The launch could not be started; the brief goes back to the queue under its name |
| `queue-launch-unseen` | No run carrying the marker shows up within 15 minutes; the brief stops holding a slot |

Once a day the supervisor removes test leftovers older than 24 h: `~/.cache/orchestration-tests/run-*` and
`/tmp/bun-*`, never following symlinks.

## `/task` and the SDLC stage chain

`/task <be|fe|sdlc> <text>` in the operator's chat creates a Trello card in the list `Backlog` of the be checkout's
board, as `feature-start` resolves it: `TRELLO_BOARD_ID_<PROJECT_NAME of config/project.env>`, else `TRELLO_BOARD_ID`
(the same `~/.config/trello/.env` as the QA dev OK; `/task sdlc` takes `TRELLO_BOARD_ID`), with the text's first line as its title and the whole text as its
description, then renames it `t<n>: <title>`, where `<n>` is the card's number: `feature-start` takes only cards named
`<slug>: <title>`, and `t<n>` is always a valid, unique slug. A card created but not renamed is reported as such and
queues nothing, so the operator renames it rather than send the task again. `/task` without a kind, with an unknown kind or without
text gets the reply `Формат: /task <be|fe|sdlc> <текст>, …` and creates nothing; a message from any other chat is
dropped, as every update is. `sdlc` only gets its card: a Claude session in `1_mvp_sdlc` turns it into a harness task.
`be` and `fe` start a chain of stages in `1_mvp_pilot_be`, one docs pull request per stage, with the commands of the
`mvp-sdlc` plugin's stage map:

| Stage | Command | `stage-pr` stage | Repo |
| --- | --- | --- | --- |
| `feature-start` | `/mvp-sdlc:feature-start <card id>`, which hands over to `/sdlc:interview` | `brief` | be |
| `prd` | `/sdlc:write-prd t<n>` | `prd` | be |
| `architecture` | `/sdlc:architecture-design t<n>` | `sad` | be |
| `contracts` | `/sdlc:api-forge t<n>` | `contracts` | be |
| `tasks` | `/sdlc:break-tasks t<n>` | `tasks` | be |
| `task-cards` | `/mvp-sdlc:task-cards t<n>` | `tasks` (`tasks-2`) | be |
| `spec` (`fe` only) | `/mvp-sdlc:sync-spec t<n>` from the be checkout at `origin/<be base>` | `spec` | fe |

Each stage is a brief `queue/<repo>/sdlc-stage.PILOT-<n>.<stage>.<attempt>.md` and takes a run slot like any brief.
The queue launches it, only while its chain waits for exactly that stage and attempt, as `bun src/stage-run.ts
<started file>` instead of a factory run, and moves it to `queue/started/<repo>/stage-<uuid>--<name>.md`; a brief of
that name the chain does not wait for is a factory brief. `stage-run.ts` fetches the base branch of the repo's
factory profile (`repo.base_branch`) into the Archon `source` checkout and adds a worktree
`~/.local/state/sdlc-autopilot/stages/<started name>` at `origin/<base>`, or on a rerun at the stage's PR branch, so
the operator's checkout and its current branch are never touched. It copies `.claude/sdlc.local.md` into it and runs
`claude -p <command> --append-system-prompt <autopilot prompt> --permission-mode bypassPermissions
--disallowed-tools AskUserQuestion,ExitPlanMode --plugin-dir <sdlc> --plugin-dir <mvp-sdlc> --output-format json`
(3 h at most), with the plugins' install paths the checkout's own entries in `~/.claude/plugins/installed_plugins.json`
name (override: `SDLC_AUTOPILOT_CLAUDE_PLUGINS`). The autopilot prompt (operator decision Q1 = a) says nobody is
present: the task text is the answer to the skill's questions, every checkpoint takes the recommended option, every
assumption goes under `## Open question / assumption` in the stage document, the operator's approval of the docs PR
stands for the skill's confirmations, and the session runs this one stage and ends with `stage-pr`, never merging or
pushing to `develop` or `main`. The worktree is always removed, and `<started file>.result.json` records the exit. The
output goes to `~/.local/state/sdlc-autopilot/logs/stage.<repo>.<name>.log`. A running stage holds its slot until the
result exists, for at most 4 h.

On the next tick, a stage that exited 0 is matched to its one open pull request from
`feature/PILOT-<n>-t<n>-<stage>[-2..-9]`. While its checks are pending nothing is sent; once they pass, the stage is
a pause `pr-approve` of the pseudo run `stage:PILOT-<n>/<stage>` (workflow `sdlc-stage`) at the PR's head, and the
`pr-approve` rule sends it as the «PR готовий» card. A card stays open while the PR cannot be read or its checks run
again. `✅ Апрув` reads the PR's head and checks again: if the head moved since the card or the checks are not green,
nothing is merged, the press is escalated again, and the next tick sends a card for the new head. Otherwise the
supervisor runs `gh pr merge --squash --match-head-commit <head>` and queues the next stage. `↩️ Повернути` asks for the
reason like any PR card and reruns the stage on its PR branch with `Return comment: <text>` in the prompt, so
`stage-pr` adds a commit to the same pull request. The label `operator-approved` on a green head approves it the same
way, and a pull request merged on GitHub advances the chain too. The close note of the card names what followed:
the next stage queued, the stage rerun, or the task briefs.

After the last stage (`task-cards` for `be`, `spec` for `fe`) the supervisor reads
`docs/features/t<n>/tasks/tasks.json` from the be checkout's `origin/<base>`, and for each task not `done` runs the
plugin's `task-brief t<n> <id>` in a fresh worktree of the task's repo (`--from <be source>` for an fe task) and queues
its output as `queue/<repo>/task-PILOT-<n>-<id>.md`. A task that `depends on unfinished` tasks waits and is tried
again every 15 minutes until every task is queued; the queue's path-overlap hold orders the rest.

The chains are kept in `~/.local/state/sdlc-autopilot/stages.json`, next to the ledger. These escalate once and,
except `stage-ci-red` and `stage-task-brief`, stop the chain; their pseudo run id is `stage:PILOT-<n>/<stage>`
(`stage:PILOT-<n>/briefs` for task briefs) and their kind `stage`:

| Rule | Situation |
| --- | --- |
| `stage-failed` | The stage session exited non-zero, its brief could not be read, its plugins are not installed for the checkout, or the next stage could not be queued; the message names the log |
| `stage-no-pr` | The stage finished, but not exactly one open pull request comes from its branch |
| `stage-ci-red` | The stage PR's checks failed on its head; no card until a green head |
| `stage-pr-closed` | The stage PR was closed without a merge |
| `stage-merge-failed` | The PR carries `operator-approved`, but GitHub refused the merge |
| `stage-task-brief` | `task-brief` refused a task for another reason than its dependencies, or tasks.json could not be read |
| `queue-stage-hung` | A launched stage wrote no result within 4 h |

A GitHub read that fails is logged and tried again on the next tick. After a revert of this feature, delete any
`queue/*/sdlc-stage.*.md` left: without the chain they would launch as factory briefs.

## Releases

Decision 29 A: prod deploys by itself once every task of a feature passed QA on dev; smoke prod and the automatic
rollback of `bin/release` are the safeguards, not an operator's confirmation. Only with the `release` rule in
`policy.yaml`; without it nothing is released automatically.

Each tick, before the queue starts briefs, the supervisor takes the `/task` chains in state `done` (every task briefed)
that no release names yet, reads each one's `docs/features/t<n>/tasks/tasks.json` from the be checkout's
`origin/<base>` and the be board (`GET /boards/<b>/lists`, `GET /boards/<b>/cards`, the board `/task` uses). A
feature is ready when the card of every task — its `trello_card_id_short`, else the feature's own card — is in
`Ready to Release`, where `✅ Прийнято` on its QA dev card moved it. A card in any other list or not on the board holds
the feature back, and so does a task of a repo other than `1_mvp_pilot_be` and `1_mvp_pilot_fe`. A failed git or
Trello read, or a feature whose `tasks.json` cannot be read, is logged and tried again on the next tick.

There is one release at a time, `release:<id>` in the ledger. Every feature ready in the same tick goes into one new
release, and a feature ready while the release's first brief still waits in the queue joins it: the brief is rewritten
and its card renamed, since `prep` has not yet taken develop's changelog. A feature ready later, or one that would put
be in front of an fe brief already queued, waits for the next release; a repo where that release finds nothing new
since the last tag (the feature's work went out with the release before) is skipped as `unchanged`. The release ships the repos its features'
tasks touch, be first: for each it creates a card `Release <repo> for PILOT-a, PILOT-b` in `Ready to Release` on the
be board and queues `queue/<repo>/sdlc-release.<id>.<attempt>.md`:

```
PILOT-<release card>: Release <repo> for PILOT-a, PILOT-b
Repo-dir: <source checkout>
Base: <base>
Card: PILOT-<release card>
Mirror: <mirror_owner>/<repo>
Features: PILOT-a, PILOT-b
Release: <id>
```

fe is queued only after be shipped or was skipped. The brief names no repo-relative path, so the queue holds it while any factory run
of its repo is open. The queue launches it, only while the open release waits for exactly that file, as `bun
src/release-run.ts <started file>`; any other file of that name is a factory brief. `release-run.ts` runs no LLM: in a
worktree `~/.local/state/sdlc-autopilot/stages/release-<started name>` of the Archon source at `origin/<base>` it
ends with `unchanged: nothing to release since the last tag` when `scripts/next-version.sh origin/<base>` exits 3
(both templates' contract for "only chore, docs, ci, refactor and test since the previous tag"),
otherwise runs `RELEASE_CARD=<card> RELEASE_MIRROR_REPO=<mirror> bin/release prep`, watches the release-prep PR's checks (`gh pr
checks --watch`, 30 min), squash-merges it with `--match-head-commit` and the subject `<title> (#<n>)` that `bin/release
ship` requires, then runs `bin/release ship v<X.Y.Z>` (3 h at most) from a new worktree at the merged base. Nothing is
merged or shipped after a red prep or red checks. The worktree is always removed; `<started file>.result.json` holds
the exit, the version once its release-prep PR is merged and the stdout lines of `bin/release`, and the output goes to
`~/.local/state/sdlc-autopilot/logs/stage.<repo>.<name>.log`.

Releases are kept in `~/.local/state/sdlc-autopilot/releases.json`. On the next tick the result decides:

| Result | Release | Ledger rule |
| --- | --- | --- |
| exit 0 with `shipped: vX.Y.Z <sha>` | the repo shipped; fe is queued next, or the release is `shipped` | `release-shipped` |
| exit 0 with `unchanged:` | the repo is skipped; fe is queued next, or the release is `shipped` | `release-unchanged` |
| fe exit 75 (be on prod below `deploy/min-be-version`), launches 1–2 | queued again as `<attempt + 1>` with `Version:`, shipping the version already merged | — |
| exit 3 | `stopped`, prod rolled back to the previous tag | `release-rolled-back` |
| exit 4 | `stopped`, irreversible migration, nothing rolled back | `release-no-rollback` |
| exit 5 | `stopped`, the rollback did not verify | `release-rollback-failed` |
| any other exit once the release-prep PR is merged (fe exit 75 on the 3rd launch included) | `stopped`: develop has the `[X.Y.Z]` section but no tag, so the next prep would fail | `release-unfinished` |
| exit 1 or exit 0 without `shipped:` before the merge | `failed`, prod untouched | `release-failed` |
| any other exit | `stopped` | `release-failed` |

Every row but the first three escalates once with the `bin/release` lines and the log. Features of a `failed` or
`stopped` release are never released again automatically; a `failed` release lets the next ready features start a new
release. A `stopped` release holds every automatic release, since a person must judge prod first: a rolled-back
release's code is still on develop and the next release would deploy it again, and an unfinished one needs `bin/release
ship v<X.Y.Z>` by hand. Once done, set its `state` to `closed` in `releases.json`. An unreadable `releases.json` is
logged each tick and never overwritten; nothing is released until it is fixed, and a release brief the queue reaches
meanwhile launches as a factory brief, like any file of that name the open release does not wait for. `release-queued` lines record each queued or rewritten brief. After a revert of this
feature, delete any `queue/*/sdlc-release.*.md` left: without the release they would launch as factory briefs.

### QA prod

A release that shipped at least one repo asks the operator to check prod: once it is `shipped`, a `qa-prod` escalation
(`run_id release:<id>`, event `release:<id>@qa-prod`) sends the card «На prod» with `✅ OK` and `↩️ Reject`
([Telegram](#telegram)). A release that shipped nothing (every repo `unchanged`) sends none. The card's pause text
holds one line per shipped repo, `Shipped: <repo> v<X.Y.Z> <sha> <url> previous <tag|none|?>`, then `Features:` and
`Release:`. After a ship that exited 0 with `shipped:`, `release-run.ts` reads from `bin/release ship`'s stderr the
tag it shipped over (`release: shipping … previous <tag|none> …`) and be's irreversible migrations since it
(`release: irreversible migrations since <tag>: <files>`), and shoots, at 1440×900 and 360×800 with the checkout's
`node_modules/.bin/playwright`, every `qa_dev.pages` entry of the profile whose glob matches a file changed since that
tag, at its prod URL (`<x>.dev.<PROJECT_ZONE>` → `<x>.<PROJECT_ZONE>`; a page on any other host is skipped). A shot
that fails is left out and never changes the exit. The next tick moves the shots to `release-shots/<id>/<repo>/`.

While a release waits for this answer, no new release starts: Reject rolls back to the tag before this release, which
is right only while it is the newest on prod. Features ready meanwhile start the next release after OK.

- `✅ OK` records `qa: ok` in `releases.json` and moves every card of the release (its task cards, its feature cards
  and its release cards) to `Done` on the be board; a card already there is skipped. The close note names the cards.
- `↩️ Reject` takes the operator's text, sets `qa: reject` and `state: stopped` (develop still holds the rejected
  code, so the release holds every automatic release until the operator closes it, as above), and queues one fix
  brief `queue/<repo>/fix-release-<id>.md`, in fe when the release shipped fe, else in be: `Fix for <first feature
  card>: <text>`, then the repository, `Release:`, `Features:`, a `Shipped:` line per shipped repo (version, sha, prod
  URL, release card), `Rollback:` (the targets, or `none — <why>`) and `If the cause is in <other repo>, say so in the
  plan.` It then writes the job `~/.local/state/sdlc-autopilot/rollbacks/release-<id>.json` and launches `bun
  src/release-run.ts rollback <job>` at once, detached, logging to `logs/rollback.release-<id>.log`: a queued brief
  could wait hours behind unrelated runs. The job rolls back each shipped repo to the tag before the release, fe
  first so that fe never runs against an older be than its `min-be-version`: in a fresh worktree
  `stages/release-rollback-<id>-<repo>` at `origin/<base>`, `bin/release rollback <tag>` (30 min at most), stopping at
  the first that does not verify; `<job>.result.json` holds the exit, the error and the `rolled back:` lines.
- No rollback is launched at all when a shipped repo has an irreversible migration, when bin/release did not name its
  previous tag, or when it had none (a first release): the code of the previous tag cannot run on the new schema, or
  there is nothing to roll back to. Prod stays on the new release; the escalation says why and asks to fix forward or
  to decide the rollback by hand.

| Event | Release | Ledger rule |
| --- | --- | --- |
| the release shipped a repo | waits for the QA prod answer | `qa-prod` (the card) |
| OK, but a card was not moved | `qa: ok` | `qa-prod-trello` |
| Reject, but the fix brief could not be written | `stopped` | `qa-prod-fix` |
| Reject on an irreversible migration or an unknown or missing previous tag | `stopped`, nothing rolled back | `qa-prod-no-rollback` |
| the rollback job exited 0 | `stopped`, prod on the previous tags | `qa-prod-rolled-back` |
| the rollback job exited non-zero, or could not be launched | `stopped`, prod state unknown | `qa-prod-rollback-failed` |

Every row escalates once; all but the first carry no buttons. A rollback whose process died without a result stays
`running` in `releases.json`; the release is already `stopped`, so nothing automatic follows. After a revert of this
feature, any `queue/*/fix-release-*.md` left are ordinary factory briefs, with nothing to clean up.

## Rules

### plan-gate

Reads the plan's structured output (`ready`, `open_questions`) from the factory's `plan` node, because the gate text
does not carry the open questions. Fields: `approve_text`, `open_question_prefix`.

| Situation | Decision |
| --- | --- |
| The plan output cannot be read | escalate |
| `ready` is not `true` | escalate |
| An open question does not start with `open_question_prefix` (`Non-blocking`, case-sensitive, leading spaces ignored) | escalate, quoting the question |
| Otherwise, including no open questions | approve with `approve_text` |

### install-gate

The post-merge install waits while runs of the package being installed are active, and asks to `retry` or `abort`
every 15 minutes. Field: `max_retries` (4, ≈1 h).

| Situation | Decision |
| --- | --- |
| A blocker on the `Блокують:` line is not a factory run the supervisor sees as pending, running or paused (another workflow, an unread run list, a finished run), or the line names none | escalate |
| The gate has already been retried `max_retries` times (its loop iteration is above `max_retries`) | escalate |
| Otherwise | retry |

### post-merge-gate

A post-merge gate escalates with rule `post-merge-gate` unless [`post-merge-allowlist`](#post-merge-allowlist)
approves it, naming the step's `Крок:` label and its `Тип`, and in parentheses why the allowlist did not approve it.
`checkout` and `mismatch` gates always escalate. An `approved-by: decision-<N>` marker is not honoured; its Telegram
message's buttons answer it. The rule has no fields and no `policy.yaml` entry.

### pr-approve

The factory's PR approval wait always goes to the operator: the rule escalates it with the reason `PR чекає апруву
оператора`, and Telegram sends it as a PR card. Field: `action`, whose only value is `escalate-as-card`. Without the
rule the pause still escalates, as `default-escalate`.

### qa-dev

The factory's QA dev wait always goes to the operator: the rule escalates it with the reason `Робота на dev чекає
перевірки оператора`, and Telegram sends it as a QA card with its screenshots. Field: `action`, whose only value is
`escalate-as-card`. Without the rule the pause still escalates, as `default-escalate`, with its buttons.

### release

Turns automatic releases on ([Releases](#releases)). Field: `mirror_owner`, the owner of the public mirrors prod
deploys from (`<mirror_owner>/<repo>`, `RELEASE_MIRROR_REPO` of `bin/release`). A second `release` rule or a missing
`mirror_owner` stops the supervisor at start.

### post-merge-allowlist

Approves a release step whose only write is one line of [`scripts/release.sh`](../../scripts/release.README.md).
Fields: `repo` (`owner/name`: only runs whose worktree is in this repo's Archon workspace are judged) and
`subcommands` (a non-empty subset of `merge-release-pr`, `tag`, `mirror`, `install`, `verify`, `plugin`, the subcommands
`release.sh` has; `policy.yaml` can narrow the list, never extend it). The step is read from the run's own
`<ARCHON_HOME>/workspaces/<repo>/artifacts/runs/<run_id>/steps.json`, by the number in the pause's `Крок: <n> — …`:
the commands the PR author wrote, never the agent's ledger prose.

| Situation | Decision |
| --- | --- |
| The rule is missing, `Тип` is not `approval` or `manual` (`mismatch`, `checkout`), or the run is in another repo | escalate |
| The step cannot be read from `steps.json` | escalate |
| The ledger already has a `post-merge-allowlist` approve for this run and step | escalate |
| The step text is not the bold title, exactly one fenced block (`bash`, `sh`, `shell` or none) and, from `Expected:` on, list items | escalate |
| A command is unparsable, denied, or not on the allowlist, or the block does not have exactly one release line | escalate, naming the command |
| Otherwise | approve with `Approved by sdlc-autopilot policy post-merge-allowlist: <command> → <entry>; …` |

The block is read line by line, `\`-continuations joined, blank and `#` lines dropped, and split into commands on
`;`, `&&`, `||` and `|`, quotes removed. A line is unparsable when it has a command substitution (`` ` `` or `$(`),
a subshell or group (`(`, `{`), a redirection other than `2>&1`, `>/dev/null`, `2>/dev/null` and `&>/dev/null`, a
glob, a lone `&`, `$` outside double quotes (`$?` aside) or an unclosed quote. Every word of every command is
checked against `rm`, `rmdir`, `reset`, `delete`, `destroy`, `--delete`, `-f`, `-rf`, `-fr`, `-Rf` and anything
containing `--force`. A word with a variable reaches a command other than `echo`, `test`, `grep`, `jq` and `cat` only
when the whole word is `$?` or `"$NAME"` of a name the step assigned; `"$A--output=x"` or `"-$X"` could be any flag.
Each command must then be one of:

| Entry | Command |
| --- | --- |
| `release.sh <subcommand>` | exactly `bash scripts/release.sh <subcommand> v<X.Y.Z>`, `<subcommand>` in `subcommands`; exactly one per step |
| `cd run worktree` | exactly `cd <the run's worktree>` |
| `assignment` | only `NAME=value` words, with a short local name (one to three letters or digits, not `IFS`, `ENV`, `PWD`, `TMP` or `PS1`–`PS4`) and a value that is `$?` or a literal that does not start with `-`: an assignment to `PATH`, `BASH_ENV` or `GIT_*` would change what the release line runs |
| `read-only <name>` | `gh pr view\|list\|checks`; `gh api` without a method other than `GET` and without `-F`, `-f`, `--field`, `--raw-field` or `--input`; `git fetch\|log\|rev-parse\|show\|diff\|status` directly after `git` and without an option that abbreviates `--output`, `--upload-pack` or `--exec`; `echo`, `test`, `grep`, `jq`, `cat` |

The approve text is the ledger line's `evidence.message`, so the ledger names the matched entry of every command. The
matcher is `src/allowlist.ts`; `policy.yaml` lists the entries for the operator.

A step is approved at most once per run: a step that pauses again after its approve (an `install` that still waits
for factory runs, say) goes to the operator instead of running again.

Design note: on 2026-11-01 the operator decided that the supervisor approves routine release steps by itself
(PILOT-545). This replaces PILOT-509 round 3, under which every post-merge gate escalated because no list of
destructive words can be complete. That reason still holds for free step text, so free text is never approved:
the real v0.9.x steps used `cd`, `$(…)`, subshells, loops, `rm -rf` and `worktree remove --force`, and no argv
allowlist can judge them. The release logic moved into reviewed, tested code instead (`scripts/release.sh`), and an
approve covers only a step whose one write is a line of it. The `approved-by` marker is still not honoured.

### default-escalate

A pause of kind `other`, or a plan or install gate whose rule is missing from `policy.yaml`, escalates with rule
`default-escalate`.

`policy.yaml` is validated at start: a gate rule with a missing or mistyped field, or defined twice, stops the
supervisor. Entries with other ids are left to their own readers.
