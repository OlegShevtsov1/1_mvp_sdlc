# sdlc-autopilot supervisor

`sdlc-autopilot` answers the routine pauses of Archon runs so the operator only sees what needs a person. It is a
bun service with no LLM in its decisions: every answer follows a rule in [`policy.yaml`](policy.yaml), and a pause
that no rule answers escalates to the operator.

`install.sh` copies this directory to `~/.archon/supervisor` and renders the systemd user unit
`sdlc-autopilot.service` without enabling it.

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
briefs (PILOT-511). This README describes the gate rules and the queue.

## The ledger

`~/.local/state/sdlc-autopilot/ledger.jsonl` (override: `SDLC_AUTOPILOT_LEDGER`) gets one JSON line per decision:
`{ts, run_id, workflow, kind, rule, action, evidence: {event_id, node, text, message}}`. `rule` names the rule that
decided; `action` of a gate decision is `approve`, `retry` or `escalate`; for `approve` and `retry` it records that the
respond was dispatched, not its outcome. `evidence.text` is the pause or error text Archon shows, and
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
part of the supervisor wrote it: `Прогін`, `Крок` and `Причина` (`evidence.message`, else `evidence.text`), plain text
without markup. A line counts as sent once Telegram accepted it, so a send that fails is retried on the next tick; a
crash right after a send can send that one message again. When the line is about the run's open pause, the message
also carries the pause text and one button per decision the pause itself declares — `approve`/`skip`/`abort` on a
post-merge gate, `retry`/`abort` on an install gate, `approve`/`abort` on a plan gate (`needs-revision` needs a
feedback text and stays an `archon workflow respond` by hand).

A button press runs `archon workflow respond <run-id> <decision> <text> --occurrence <pause-id>` the way a policy
answer does, writes the `rule: operator` ledger line and replaces the buttons with the answer. It is answered only on
the pause the message was sent for, while that pause is still open, once, and only with a decision of that pause; a
respond that cannot start is escalated again with the buttons. `/status` in the chat answers with a digest: the
running runs, the runs waiting for the operator, the queued briefs and the next one to start. Updates are read once
per tick with `getUpdates`, so an answer takes up to 30 s, and only from the operator's chat; updates from any other
chat are dropped without a reply. Another `getUpdates` reader of the same bot, such as a manual topic lookup with
`curl`, takes the updates away from the supervisor while it runs.

The update offset, the sent lines and the messages with open buttons are kept in
`~/.local/state/sdlc-autopilot/telegram.json`, next to the ledger. Deleting it re-sends the escalations of the last
24 h.

## Queue and limits

A ready brief is a file `~/.config/sdlc-autopilot/queue/<repo>/<name>.md` (override: `SDLC_AUTOPILOT_QUEUE`), where
`<repo>` names a repo Archon has one `workspaces/<owner>/<repo>/source` checkout of. The tick starts briefs in order —
`1_mvp_sdlc` first, then oldest first — as a detached `archon workflow run factory --cwd <source> <message>`, where
the message is the brief text followed by a line `sdlc-autopilot-launch: <uuid>`.

Every run the supervisor starts, post-merge and queued briefs alike, needs a free slot and an idle enough host, set
by the top-level `limits` block of `policy.yaml`: `max_runs` (5) pending or running runs in all, `max_runs_per_repo`
(3) in the repo, `MemAvailable` ≥ `min_mem_available_mb` (1500) and load1 ≤ `max_load1` (8). Paused runs take no
slot. A transient resume waits for the same host threshold. A missing or non-positive limit stops the supervisor at
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

A post-merge step that needs a person always goes to the operator. Every post-merge gate escalates with rule
`post-merge-gate` — 🔒 (`Тип: approval`), `checkout`, `mismatch` and `manual` alike — naming the step's `Крок:` label
and its `Тип`. An `approved-by: decision-<N>` marker is not honoured, because no list of destructive words can be
complete (operator decision, PILOT-509 round 3); its Telegram message's buttons answer it. The rule has no fields
and no `policy.yaml` entry.

### default-escalate

A pause of kind `other`, or a plan or install gate whose rule is missing from `policy.yaml`, escalates with rule
`default-escalate`.

`policy.yaml` is validated at start: a gate rule with a missing or mistyped field, or defined twice, stops the
supervisor. Entries with other ids are left to their own readers.
