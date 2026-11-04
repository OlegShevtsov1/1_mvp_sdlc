import type { RespondAction } from "./act.ts";
import { redact } from "./ledger.ts";
import { INSTALL_WAIT_EXHAUSTED } from "./policy.ts";
import type { TransientClass } from "./transient.ts";

// Telegram refuses a message over 4096 characters; the margin carries the resolution line an answer appends.
export const MAX_TEXT = 4000;
export const MAX_VISIBLE = 1000;

// One escalation ledger line with what the supervisor knows about its run; "" where nothing is known.
export type Escalation = {
  workflow: string;
  runId: string;
  repo: string;
  runMessage: string;
  kind: string;
  rule: string;
  // The pause or error text Archon rendered, and the supervisor's reason for escalating it.
  text: string;
  reason: string;
  // The PR title post-merge's `fetch` read, and the number of the run's last post-merge step.
  prTitle: string;
  lastStep: string;
  // The paused post-merge step's text from the run's `steps.json`, "" when unknown.
  stepText: string;
};

const TRANSIENT: Record<TransientClass, string> = {
  "session-limit": "закінчився ліміт сесії Claude",
  oauth: "сплив вхід у Claude",
  "github-5xx": "GitHub відповідав помилкою сервера",
  network: "збій мережі",
  sigterm: "процес зупинено сигналом SIGTERM",
  "first-event-timeout": "Claude не відповів вчасно",
  "db-locked": "база Archon була заблокована",
};

const isTransient = (kind: string): kind is TransientClass => Object.hasOwn(TRANSIENT, kind);

const LABELS: Record<RespondAction, string> = {
  approve: "✅ Прийняти",
  skip: "⏭ Пропустити крок",
  abort: "⛔ Зупинити",
  retry: "🔁 Чекати ще",
  reject: "↩️ Повернути",
  ok: "✅ Прийнято",
};

const TOASTS: Record<RespondAction, string> = {
  approve: "✅ Прийнято, виконую",
  skip: "⏭ Пропускаю крок",
  abort: "⛔ Зупиняю",
  retry: "🔁 Чекаю далі",
  reject: "↩️ Повертаю на доопрацювання",
  ok: "✅ Прийнято",
};

export const ANSWERED_TOAST = "Це питання вже вирішене";
export const RETRY_TOAST = "⚠️ Не вдалося прочитати стан — натисніть ще раз";
export const REASON_TOAST = "↩️ Напиши відповіддю, що змінити";

const RESOLVED: Record<string, string> = {
  approve: "прийнято",
  approved: "прийнято",
  skip: "пропущено",
  abort: "зупинено",
  rejected: "зупинено",
  retry: "продовжено",
  "needs-revision": "повернуто на доопрацювання",
  reject: "повернуто на доопрацювання",
  ok: "прийнято",
};

// Every pause text the packs render ends with the decision legend; the buttons replace it.
const LEGEND = /^(approve|skip|abort|retry|needs-revision|reject|ok)\s+→/;

// Telegram's HTML mode needs only these three; `"` stays literal so quoted answers read as written.
export function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// Cuts escaped text without leaving half an entity behind.
function clip(html: string, max: number): string {
  if (html.length <= max) return html;
  return `${html.slice(0, max - 1).replace(/&[a-z]*$/, "")}…`;
}

export const plain = (s: string, max: number) => clip(escapeHtml(redact(s)), max);

export function shortId(id: string): string {
  return /^[0-9a-f]{8}-/.test(id) ? id.slice(0, 8) : id;
}

export function field(text: string, name: string): string {
  return text.split("\n").find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2).trim() ?? "";
}

export function firstSentence(s: string): string {
  const text = s.trim().replace(/\s*— потрібне рішення оператора\.?$/, "");
  return text.match(/^.+?[.!?](?=\s|$)/s)?.[0] ?? text;
}

export function subject(e: Escalation): string {
  const release = e.prTitle.match(/\bRelease v?(\d+\.\d+\.\d+)/i)?.[1];
  if (release && /(^|\s)run=PILOT\d+(\s|$)/.test(e.runMessage)) {
    const short = e.repo.split("/")[1]?.replace(/^\d+_mvp_/, "");
    return short ? `реліз ${short} v${release}` : `реліз v${release}`;
  }
  if (/^PILOT-\d+:/.test(e.prTitle)) return e.prTitle;
  const factoryTitle = e.runMessage.match(/PR title «([^»]+)»/)?.[1];
  if (factoryTitle) return factoryTitle;
  const stage = e.runId.match(/^stage:(PILOT-\d+)\/([\w-]+)$/);
  if (stage) return `${stage[1]}: стадія ${stage[2]}`;
  return `${e.workflow} ${e.repo}`.trim();
}

// Telegram shows the step line in full, so a long heading is shortened here, at a word boundary.
const MAX_STEP = 90;
// The post-merge pack cuts a step title to this many UTF-16 units, often mid-word.
const PACK_TITLE_CUT = 100;

function shorten(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut.slice(0, max - 1)).replace(/[\s,;:—–-]+$/, "")}…`;
}

// The step's full bold heading; without one, the pause's title, whose last word the pack's cut may have split.
function heading(e: Escalation, title: string): string {
  const bold = e.stepText.split("\n")[0].match(/^\*\*(.+)\*\*$/)?.[1];
  if (bold) return bold;
  return title.length >= PACK_TITLE_CUT ? title.replace(/\s*\S+$/, "") : title;
}

function stepLine(e: Escalation): string {
  if (e.kind === "plan-gate") return "План задачі готовий до перевірки";
  if (e.kind === "install-gate") return "Встановлення чекає, поки завершиться прогін фабрики";
  if (e.kind !== "post-merge-gate") return "";
  const step = field(e.text, "Крок").match(/^(\d+)\s*—\s*(.*)$/);
  if (!step) return "";
  const title = heading(e, step[2]).replace(/^A\d+\s*—\s*/, "").replaceAll("🔒", "").replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ").replace(/\s+([,;:.])/g, "$1").trim();
  return shorten(`Крок ${step[1]}${e.lastStep ? ` з ${e.lastStep}` : ""}: ${title}`, MAX_STEP);
}

function observed(reason: string): string {
  const http = reason.match(/отримали HTTP (\d{3})/)?.[1];
  if (http) {
    const who = /github\.com/i.test(reason) ? "GitHub" : "сервер";
    return http === "404" ? `${who} відповів "не знайдено"` : `${who} відповів кодом ${http}`;
  }
  // rc=0 is a step that ran fine, not the value the check rejected.
  const rc = reason.match(/\brc=([1-9]\d*)/)?.[1];
  return rc ? `команда завершилась з кодом ${rc}` : "";
}

function happened(e: Escalation): string {
  if (e.rule === "transient-exhausted") {
    const n = e.reason.match(/після (\d+) спроб/)?.[1];
    const times = n ? `${n} ${/^[234]$/.test(n) ? "рази" : "разів"}` : "кілька разів";
    return `збій повторився ${times}: ${isTransient(e.kind) ? TRANSIENT[e.kind] : e.kind}.`;
  }
  if (e.rule === "install-gate" && e.reason.startsWith(INSTALL_WAIT_EXHAUSTED)) {
    return "автоматичні спроби дочекатися вичерпано, а прогін фабрики досі йде.";
  }
  if (e.rule === "default-escalate") return "для цієї паузи немає автоматичного правила.";
  const type = e.kind === "post-merge-gate" ? field(e.text, "Тип") : "";
  if (type === "mismatch") {
    const value = observed(field(e.text, "Причина"));
    return `автоматична перевірка дала не те, що очікувалось${value ? `: ${value}` : ""}.`;
  }
  if (type === "manual") return "крок потребує ручної дії.";
  if (type === "checkout") return "крок зачіпає твої локальні репозиторії, тому його робиш ти.";
  const cause = e.kind === "post-merge-gate" ? firstSentence(field(e.text, "Причина")) : "";
  return cause || firstSentence(e.reason || e.text);
}

const isCheckout = (e: Escalation) => e.kind === "post-merge-gate" && field(e.text, "Тип") === "checkout";

function recommendation(e: Escalation): string {
  if (isCheckout(e)) {
    return /\bclaude plugin update\b/.test(e.stepText)
      ? "онови плагін mvp-sdlc у be і fe (claude plugin update mvp-sdlc@mvp --scope project) і натисни «Готово»."
      : "виконай команди кроку у своєму терміналі (деталі нижче) і натисни «Готово».";
  }
  if (e.rule === "install-gate" && e.reason.startsWith(INSTALL_WAIT_EXHAUSTED)) {
    return "натисни «Чекати ще», якщо прогін фабрики має завершитись.";
  }
  return "";
}

// The pause text as Archon rendered it, without what the visible part already says: the pack's own header line, the
// artifact paths that mean nothing outside the run, and the legend the buttons replace.
function details(e: Escalation): string {
  const body: string[] = [];
  for (const [i, line] of e.text.split("\n").entries()) {
    if (LEGEND.test(line)) break;
    if (i === 0 && /потрібне рішення оператора\.?$/.test(line)) continue;
    if (!line.includes("$ARTIFACTS_DIR")) body.push(line);
  }
  // A post-merge gate's reason only restates its `Крок` and `Тип` lines.
  const reason = e.rule === "post-merge-gate" && e.text ? "" : e.reason;
  const run = `Прогін: ${e.workflow} ${shortId(e.runId)}${e.repo ? ` · ${e.repo}` : ""}`;
  // A checkout step is run by the operator, so its commands are the details the recommendation points to.
  const commands = isCheckout(e) ? e.stepText : "";
  return [run, body.join("\n").trim(), commands, reason].filter(Boolean).join("\n\n");
}

// The factory's approvalMessage names the PR by this URL; the card links only a URL of this shape.
export const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)$/;
const ROUND = /^PR APPROVAL — round (\d+) of (\d+)\./;

function files(n: string): string {
  const last = Number(n) % 10;
  const tens = Number(n) % 100;
  if (last === 1 && tens !== 11) return "файл";
  return last >= 2 && last <= 4 && (tens < 12 || tens > 14) ? "файли" : "файлів";
}

function diffLine(diff: string): string {
  const m = diff.match(/^(\d+) files?, \+(\d+) −(\d+)$/);
  return m ? `${m[1]} ${files(m[1])}, +${m[2]} −${m[3]}` : diff;
}

function checksLine(checks: string): string {
  const n = checks.match(/^(\d+) pass$/)?.[1];
  return n ? `${n} ✅` : checks;
}

export const withBlock = (visible: string, details: string) => {
  const open = "\n<blockquote expandable>";
  const close = "</blockquote>";
  const room = MAX_TEXT - visible.length - open.length - close.length;
  return `${visible}${open}${clip(escapeHtml(redact(details)), room)}${close}`;
};

// The factory's PR approval wait as a card; undefined when its text names no PR, so it reads as any other escalation.
// A failed respond re-escalates the same pause under another rule, and that is still a card.
function renderPrCard(e: Escalation): string | undefined {
  const url = field(e.text, "PR");
  const n = url.match(PR_URL)?.[1];
  if (e.kind !== "pr-approve" || !n) return undefined;
  const [, round = "", cap = ""] = e.text.split("\n")[0].match(ROUND) ?? [];
  const review = field(e.text, "Review");
  const notReady = review.match(/^not ready — (.+)$/)?.[1];
  const happened = e.rule !== "pr-approve"
    ? firstSentence(e.reason)
    : notReady
    ? `ревʼю не готове: ${notReady.replace(/[.\s]+$/, "")}.`
    : `CI зелений, ревʼю готове — PR чекає твого апруву${round ? ` (раунд ${round} з ${cap})` : ""}.`;
  const last = round !== "" && round === cap
    ? " Це останній раунд: «Повернути» зупинить прогін, PR лишиться відкритим."
    : "";
  const advice = (notReady
    ? "натисни «Повернути» і напиши, що змінити: апрув зупинить прогін без злиття."
    : "переглянь PR: «Апрув» зливає саме цей коміт, «Повернути» — напиши, що змінити.") + last;
  const summary = field(e.text, "Summary");
  const visible = [
    `🟡 <b>PR готовий: ${plain(subject(e), 120)}</b>`,
    `<a href="${url}">PR #${n}</a> · Diff: ${plain(diffLine(field(e.text, "Diff")), 30)} · ` +
    `Checks: ${plain(checksLine(field(e.text, "Checks")), 30)}`,
    `<b>Що сталося:</b> ${plain(happened, 150)}`,
    summary && `<b>Підсумок:</b> ${plain(summary, 280)}`,
    `<b>Що рекомендую:</b> ${plain(advice, 160)}`,
  ].filter(Boolean).join("\n");
  // The ledger redacts the 40-hex head, so the card does not repeat it.
  const kept = e.text.split("\n").filter((l) => ROUND.test(l) || l.startsWith("Review: "));
  const reason = e.rule === "pr-approve" ? "" : e.reason;
  const run = `Прогін: ${e.workflow} ${shortId(e.runId)}${e.repo ? ` · ${e.repo}` : ""}`;
  return withBlock(visible, [run, kept.join("\n"), reason].filter(Boolean).join("\n\n"));
}

export function renderEscalation(e: Escalation, opts: { needsRevision: boolean }): string {
  const card = renderPrCard(e);
  if (card) return card;
  const step = stepLine(e);
  const advice = recommendation(e);
  const visible = [
    `🟡 <b>Потрібне твоє рішення: ${plain(subject(e), 120)}</b>`,
    step && plain(step, 170),
    `<b>Що сталося:</b> ${plain(happened(e), 300)}`,
    advice && `<b>Що рекомендую:</b> ${plain(advice, 150)}`,
    opts.needsRevision ? "Повернути план на доопрацювання можна лише через archon CLI." : "",
  ].filter(Boolean).join("\n");
  return withBlock(visible, details(e));
}

export function buttonLabel(action: RespondAction, e: Escalation): string {
  if (action === "approve" && isCheckout(e)) return "✅ Готово";
  if (action === "approve" && e.kind === "pr-approve") return "✅ Апрув";
  if (action === "reject" && e.kind === "qa-dev") return "↩️ Є зауваження";
  if (action === "ok" && e.kind === "qa-prod") return "✅ OK";
  if (action === "reject" && e.kind === "qa-prod") return "↩️ Reject";
  return LABELS[action];
}

export function pressToast(action: RespondAction, kind = ""): string {
  if (action === "reject" && kind === "qa-prod") return "↩️ Відкочую prod і ставлю fix-задачу";
  return TOASTS[action];
}

// With no answer event the run moved on by itself, or was cancelled.
export function resolvedLine(decision: string | undefined, byButton: boolean, runStatus = ""): string {
  const word = decision === undefined
    ? (runStatus === "cancelled" ? "зупинено" : "продовжено")
    : (RESOLVED[decision] ?? "продовжено");
  return `✅ Вирішено: ${word} (${byButton ? "кнопкою" : "поза Telegram"})`;
}
