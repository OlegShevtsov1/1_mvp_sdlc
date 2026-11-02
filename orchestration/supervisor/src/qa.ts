import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import type { RespondAction } from "./act.ts";
import {
  type Escalation, escapeHtml, field, firstSentence, plain, PR_URL, shortId, subject, withBlock,
} from "./humanize.ts";
import { appendLedger } from "./ledger.ts";
import { archonHome } from "./postmerge.ts";
import { knownNames, pathTokens, queueBrief } from "./queue.ts";
import { type Pause, repoOf, type RunView } from "./runs.ts";
import { obj, objs, trello } from "./trello.ts";

// The most screenshots one card sends (E3 Global Constraints); Telegram's media group takes 2 to 10.
export const MAX_SHOTS = 6;
// Decision 53's list for work checked on dev that waits for the release; the factory's profile lists do not rename it.
const READY_TO_RELEASE = "Ready to Release";
const SHA = /^[0-9a-f]{40}$/;
const LINKABLE = /^https:\/\/[^\s"<>]+$/;
const CARD_LINK = /https?:\/\/(?:www\.)?trello\.com\/c\/([A-Za-z0-9]{8})(?![A-Za-z0-9])/;
const CARD_NUMBER = /PILOT-(\d+)/;

export type Shot = { page: string; width: number; path: string };

// How the card's screenshots went: sent (`sent` of `total`), none to send, or not sent; "omitted" says nothing.
export type ShotsNote = { sent: number; total: number } | "none" | "unreadable" | "failed" | "omitted";

function runDir(runId: string, repo: string): string {
  return join(archonHome(), "workspaces", repo, "artifacts", "runs", runId);
}

const isShot = (s: unknown): s is Shot => {
  const o = s as Partial<Shot> | null;
  return typeof o?.page === "string" && typeof o.width === "number" && typeof o.path === "string";
};

function inside(path: string, dir: string): boolean {
  try {
    return path.endsWith(".png") && realpathSync(path).startsWith(`${realpathSync(dir)}${sep}`);
  } catch {
    return false;
  }
}

// The supervisor uploads these files to Telegram, so it reads only its own computed path to the run's qa-dev.json,
// only when that names the commit the open pause names (an older pass's evidence never stands for a newer one), and
// only PNGs under the run's own qa-dev/ directory. `shots` is at most the first MAX_SHOTS; null when unreadable.
export function readEvidence(runId: string, repo: string, pauseText: string): { total: number; shots: Shot[] } | null {
  if (!repo) return null;
  const dir = runDir(runId, repo);
  let doc: { sha?: unknown; shots?: unknown } | null;
  try {
    doc = JSON.parse(readFileSync(join(dir, "qa-dev.json"), "utf8")) as typeof doc;
  } catch {
    return null;
  }
  const sha = field(pauseText, "SHA");
  if (!SHA.test(sha) || doc?.sha !== sha || !Array.isArray(doc.shots)) return null;
  const shots: unknown[] = doc.shots.slice(0, MAX_SHOTS);
  if (!shots.every((s) => isShot(s) && inside(s.path, join(dir, "qa-dev")))) return null;
  return { total: doc.shots.length, shots: shots as Shot[] };
}

function shotsLine(note: ShotsNote): string {
  if (note === "none") return "Скриншотів немає: PR не змінив сторінок із профілю.";
  if (note === "unreadable") return "⚠️ Скриншоти не вдалося прочитати.";
  if (note === "failed") return "⚠️ Скриншоти не вдалося надіслати.";
  if (note === "omitted") return "";
  return note.total > note.sent
    ? `Скриншоти: надіслано перші ${note.sent} з ${note.total}, ще ${note.total - note.sent} не надіслано — вони в артефактах прогону.`
    : `Скриншоти (${note.sent}) — вище.`;
}

const link = (url: string, label: string) => `<a href="${escapeHtml(url)}">${label}</a>`;

// The factory's QA dev wait as a card «На dev готово»; undefined when its text names no dev URL, so it reads as any
// other escalation. A failed respond re-escalates the same pause under rule `operator`, and that is still a card.
// `sha` is the open pause's commit: the ledger's copy of the text has it redacted.
export function renderQaCard(e: Escalation, view: { sha: string; shots: ShotsNote }): string | undefined {
  const url = field(e.text, "URL");
  if (e.kind !== "qa-dev" || (e.rule !== "qa-dev" && e.rule !== "operator") || !url) return undefined;
  const [conclusion = "", runUrl = ""] = field(e.text, "E2E").split(/\s+/);
  const run = LINKABLE.test(runUrl) ? ` ${link(runUrl, "прогін")}` : "";
  const e2e = conclusion === "success" ? `✅${run}` : conclusion === "none" ? "не налаштовано" : plain(conclusion, 30);
  const pr = field(e.text, "PR");
  const n = pr.match(PR_URL)?.[1];
  const commit = SHA.test(view.sha) ? ` (коміт ${view.sha.slice(0, 7)})` : "";
  const tested = conclusion === "success" ? "e2e зелений" : conclusion === "none" ? "e2e не налаштовано" : `e2e: ${conclusion}`;
  const happened = e.rule === "qa-dev" ? `роботу задеплоєно на dev${commit}, ${tested}.` : firstSentence(e.reason);
  const advice = "відкрий dev і перевір: «Прийнято» переносить картку в Ready to Release, «Є зауваження» — напиши, " +
    "що не так, і я поставлю fix-задачу в чергу.";
  const visible = [
    `🟡 <b>На dev готово: ${plain(subject(e), 120)}</b>`,
    [LINKABLE.test(url) ? link(url, "dev") : `dev: ${plain(url, 120)}`, `e2e: ${e2e}`, n ? link(pr, `PR #${n}`) : ""]
      .filter(Boolean).join(" · "),
    `<b>Що сталося:</b> ${plain(happened, 200)}`,
    shotsLine(view.shots),
    `<b>Що рекомендую:</b> ${plain(advice, 200)}`,
  ].filter(Boolean).join("\n");
  const kept = e.text.split("\n").filter((l) => /^(URL|SHA|PR|E2E|Shots): /.test(l));
  const reason = e.rule === "qa-dev" ? "" : e.reason;
  const header = `Прогін: ${e.workflow} ${shortId(e.runId)}${e.repo ? ` · ${e.repo}` : ""}`;
  return withBlock(visible, [header, kept.join("\n"), reason].filter(Boolean).join("\n\n"));
}

type CardRef = { link: string } | { number: number };

const cardLabel = (ref: CardRef) => ("link" in ref ? ref.link : `PILOT-${ref.number}`);

function cardRef(message: string): CardRef | undefined {
  const short = message.match(CARD_LINK)?.[1];
  if (short) return { link: short };
  const n = message.match(CARD_NUMBER)?.[1];
  return n ? { number: Number(n) } : undefined;
}

// Moves the task's card to Ready to Release; "" when done, otherwise what went wrong, scrubbed of the key and token.
async function moveToReadyToRelease(ref: CardRef): Promise<string> {
  const t = trello();
  if (typeof t === "string") return t;
  try {
    let card: Record<string, unknown> | undefined;
    if ("link" in ref) {
      card = obj(await t.call("GET", `/cards/${encodeURIComponent(ref.link)}?fields=id,idBoard,idList`));
      // TRELLO_BOARD_ID may be the board's short link, so the card is checked against the board's real id.
      const board = obj(await t.call("GET", `/boards/${t.board}?fields=id`));
      if (card.idBoard !== board.id) return "картка не на дошці з TRELLO_BOARD_ID";
    } else {
      const cards = objs(await t.call("GET", `/boards/${t.board}/cards?fields=id,idShort,idList`));
      card = cards.find((c) => c.idShort === ref.number);
      if (!card) return "картки немає на дошці";
    }
    const list = objs(await t.call("GET", `/boards/${t.board}/lists?fields=name`)).find((l) => l.name === READY_TO_RELEASE);
    if (!list) return `на дошці немає списку ${READY_TO_RELEASE}`;
    if (card.idList !== list.id) await t.call("PUT", `/cards/${encodeURIComponent(String(card.id))}`, { idList: list.id });
    return "";
  } catch (e) {
    return t.scrub(e instanceof Error ? e.message : String(e));
  }
}

// The fix task's brief carries the original task's card, link and paths, so the queue holds it behind any open run
// that shares them.
export function fixBrief(run: RunView, pause: Pause, card: string, text: string): string {
  const paths = pathTokens(run.message, knownNames());
  return [
    `Fix for ${card}: ${text}`,
    "",
    `The operator rejected ${card} on dev (QA dev) with the text above. Build the fix in THIS repository ` +
    `${repoOf(run.cwd)}, one PR, squash.`,
    `Trello: ${run.message.match(CARD_LINK)?.[0] ?? card}`,
    `Original PR: ${field(pause.text, "PR") || "—"}`,
    `On dev: ${[field(pause.text, "SHA"), field(pause.text, "URL")].filter(Boolean).join(" ") || "—"}`,
    `Paths: ${paths.join(", ") || "—"}`,
    "",
  ].join("\n");
}

// What the operator's answer to a QA dev pause does besides answering it: ok moves the task's Trello card to Ready to
// Release, reject queues a fix task with the operator's text. Returns the line the card's close note gains. A failure
// is an escalation of its own, under the same pause: the pause is answered either way.
export async function afterQaAnswer(run: RunView, pause: Pause, action: RespondAction, text: string): Promise<string> {
  const escalate = (rule: string, message: string) => appendLedger({
    ts: new Date().toISOString(), run_id: run.id, workflow: run.workflow, kind: "qa-dev", rule, action: "escalate",
    evidence: { event_id: pause.eventId, node: pause.node, message },
  });
  if (action === "ok") {
    const ref = cardRef(run.message);
    const warning = ref ? await moveToReadyToRelease(ref) : "у задачі немає картки PILOT-<n> чи посилання на неї";
    const label = ref ? cardLabel(ref) : "задачі";
    if (!warning) return `🗂 Картку ${label} перенесено в ${READY_TO_RELEASE}.`;
    escalate("qa-dev-trello", `Роботу прийнято, але картку ${label} не перенесено в ${READY_TO_RELEASE}: ${warning}. ` +
      "Перенеси її вручну — потрібне рішення оператора.");
    return `⚠️ Картку не перенесено в ${READY_TO_RELEASE} — надіслано окреме повідомлення.`;
  }
  if (action !== "reject") return "";
  const card = run.message.match(CARD_NUMBER)?.[0];
  const repoDir = repoOf(run.cwd).split("/")[1];
  let failure = !card ? "у задачі немає картки PILOT-<n>" : !repoDir ? "репозиторій прогону невідомий" : "";
  if (card && repoDir) {
    try {
      const path = queueBrief(repoDir, `fix-${card}-${shortId(run.id)}.md`, fixBrief(run, pause, card, text));
      return `📥 Fix-задачу поставлено в чергу: ${basename(dirname(path))}/${basename(path)}`;
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
  }
  escalate("qa-dev-fix", `Зауваження до ${card ?? "задачі"} передано прогону, але fix-задачу не поставлено в чергу: ` +
    `${failure}. Текст зауваження: ${text} — потрібне рішення оператора.`);
  return "⚠️ Fix-задачу не поставлено в чергу — надіслано окреме повідомлення.";
}
