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
| anything else | `other` |

A pause is judged once: when the ledger already has a line for its `(run_id, event_id)`, it is skipped. Pauses that
existed before the supervisor started are judged on its first tick.

A failed run is not a pause: the `transient-resume` rule resumes it with backoff or escalates it (PILOT-508). After
the pauses, the tick launches `post-merge` for merged PRs of finished factory runs (PILOT-510), then starts queued
briefs (PILOT-511). This README describes the gate rules, post-merge launches and the queue.

## The ledger

`~/.local/state/sdlc-autopilot/ledger.jsonl` (override: `SDLC_AUTOPILOT_LEDGER`) gets one JSON line per decision:
`{ts, run_id, workflow, kind, rule, action, evidence: {event_id, node, text, message}}`. `rule` names the rule that
decided; `action` of a gate decision is `approve` (`plan-gate`, `post-merge-allowlist`), `retry` or `escalate`; for
`approve` and `retry` it records that the respond was dispatched, not its outcome. `evidence.text` is the pause or error text Archon shows, and
`evidence.message` the decision's own text for the operator, the reason of an escalation. An answer the operator gave
through a Telegram button is a line with `rule: operator` and the pause's decision as `action`: `approve`, `retry`,
`skip` or `abort`.

## Answering a pause

An `approve` or `retry` runs `archon workflow respond <run-id> <approve|retry> <text> --occurrence <pause-id>`
detached (own session, stdin `/dev/null`, no `timeout`) in the run's own working directory, logging to
`~/.local/state/sdlc-autopilot/logs/<run-id>.log`. `--occurrence` pins the answer to the pause the policy judged: if
the operator answered it first, Archon refuses. A pause whose run metadata names no occurrence is not answered, and
neither is one whose respond cannot be started: the decision is recorded as an escalation instead. A respond that starts but then fails is not detected: its pause stays open with its ledger line
written, and its log holds the error.

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
  the run's `steps.json`), `План задачі готовий до перевірки` on a plan gate, `Встановлення чекає, поки завершиться
  прогін фабрики` on an install gate;
- `Що сталося:` — one sentence by pause type, with the value a failed check observed when it can be read (`GitHub
  відповів "не знайдено"` for HTTP 404, `команда завершилась з кодом N`);
- `Що рекомендую:` only where a rule gives one (a checkout step, an install gate out of retries);
- the original pause text in a collapsed block, without the pack's own header, the `$ARTIFACTS_DIR` lines and the
  decision legend; the block is cut with `…` so the message stays under Telegram's 4096 characters.

When the line is about the run's open pause, the message carries one button per decision the pause itself declares:
`✅ Прийняти` (`✅ Готово` on a checkout step), `⏭ Пропустити крок`, `⛔ Зупинити`, `🔁 Чекати ще`. The plan gate's
`needs-revision` needs a feedback text and stays an `archon workflow respond` by hand.

A button press runs `archon workflow respond <run-id> <decision> <text> --occurrence <pause-id>` the way a policy
answer does and writes the `rule: operator` ledger line. It is answered only on the pause the message was sent for,
while that pause is still open, once, and only with a decision of that pause; a respond that cannot start is escalated
again with the buttons. Once the pause is answered — by a button, outside Telegram (`approval_received` or
`wait_answered` in Archon's events), or because the run moved on — the message is edited once: it keeps its text, gets
`✅ Вирішено: прийнято|пропущено|зупинено|продовжено (кнопкою|поза Telegram)` and loses its buttons. `/status` in the chat answers with a digest: the
running runs, the runs waiting for the operator, the queued briefs and the next one to start, as of the last tick.

Updates are read by their own loop next to the tick, by `getUpdates` long polling (25 s), so a press arrives within
about a second, and only from the operator's chat; updates from any other chat are dropped without a reply. Every
press is answered at once, within Telegram's ~15 s window for a button, with a toast: `✅ Прийнято, виконую`,
`⏭ Пропускаю крок`, `⛔ Зупиняю` or `🔁 Чекаю далі`, then the respond runs. Only the first press on an open pause
acts; a press on a pause that is no longer open or was already answered gets `Це питання вже вирішене`, and a button
the pause does not declare `Кнопка вже не діє`. A press whose run or ledger could not be read gets
`⚠️ Не вдалося прочитати стан — натисніть ще раз` and keeps its buttons. A failed poll is retried after 5 s, 15 s, then every 60 s, without
holding back the tick. Another `getUpdates` reader of the same bot, such as a manual topic lookup with `curl`, makes
the loop's polls fail (Telegram answers `409 Conflict`) and takes the updates away from the supervisor while it runs.

The update offset, the sent lines and the messages with open buttons (with the HTML each was sent with) are kept in
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
and a brief that names no path runs alone in its repo.

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

### post-merge-allowlist

Approves a release step whose only write is one line of [`scripts/release.sh`](../../scripts/release.README.md).
Fields: `repo` (`owner/name`: only runs whose worktree is in this repo's Archon workspace are judged) and
`subcommands` (a non-empty subset of `merge-release-pr`, `tag`, `mirror`, `install`, `verify`, the subcommands
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
