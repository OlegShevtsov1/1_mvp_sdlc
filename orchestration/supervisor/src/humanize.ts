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
};

const TOASTS: Record<RespondAction, string> = {
  approve: "✅ Прийнято, виконую",
  skip: "⏭ Пропускаю крок",
  abort: "⛔ Зупиняю",
  retry: "🔁 Чекаю далі",
};

export const ANSWERED_TOAST = "Це питання вже вирішене";
export const RETRY_TOAST = "⚠️ Не вдалося прочитати стан — натисніть ще раз";

const RESOLVED: Record<string, string> = {
  approve: "прийнято",
  approved: "прийнято",
  skip: "пропущено",
  abort: "зупинено",
  rejected: "зупинено",
  retry: "продовжено",
  "needs-revision": "повернуто на доопрацювання",
};

// Every pause text the packs render ends with the decision legend; the buttons replace it.
const LEGEND = /^(approve|skip|abort|retry|needs-revision)\s+→/;

// Telegram's HTML mode needs only these three; `"` stays literal so quoted answers read as written.
export function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// Cuts escaped text without leaving half an entity behind.
function clip(html: string, max: number): string {
  if (html.length <= max) return html;
  return `${html.slice(0, max - 1).replace(/&[a-z]*$/, "")}…`;
}

const plain = (s: string, max: number) => clip(escapeHtml(redact(s)), max);

export function shortId(id: string): string {
  return /^[0-9a-f]{8}-/.test(id) ? id.slice(0, 8) : id;
}

function field(text: string, name: string): string {
  return text.split("\n").find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2).trim() ?? "";
}

function firstSentence(s: string): string {
  const text = s.trim().replace(/\s*— потрібне рішення оператора\.?$/, "");
  return text.match(/^.+?[.!?](?=\s|$)/s)?.[0] ?? text;
}

function subject(e: Escalation): string {
  const release = e.prTitle.match(/\bRelease v?(\d+\.\d+\.\d+)/i)?.[1];
  if (release && /(^|\s)run=PILOT\d+(\s|$)/.test(e.runMessage)) {
    const short = e.repo.split("/")[1]?.replace(/^\d+_mvp_/, "");
    return short ? `реліз ${short} v${release}` : `реліз v${release}`;
  }
  if (/^PILOT-\d+:/.test(e.prTitle)) return e.prTitle;
  const factoryTitle = e.runMessage.match(/PR title «([^»]+)»/)?.[1];
  if (factoryTitle) return factoryTitle;
  return `${e.workflow} ${e.repo}`.trim();
}

function stepLine(e: Escalation): string {
  if (e.kind === "plan-gate") return "План задачі готовий до перевірки";
  if (e.kind === "install-gate") return "Встановлення чекає, поки завершиться прогін фабрики";
  if (e.kind !== "post-merge-gate") return "";
  const step = field(e.text, "Крок").match(/^(\d+)\s*—\s*(.*)$/);
  if (!step) return "";
  const title = step[2].replace(/^A\d+\s*—\s*/, "").replaceAll("🔒", "").replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ").trim();
  return `Крок ${step[1]}${e.lastStep ? ` з ${e.lastStep}` : ""}: ${title}`;
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

function recommendation(e: Escalation): string {
  if (e.kind === "post-merge-gate" && field(e.text, "Тип") === "checkout") return "зроби кроки вручну і натисни «Готово».";
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
  return [run, body.join("\n").trim(), reason].filter(Boolean).join("\n\n");
}

export function renderEscalation(e: Escalation, opts: { needsRevision: boolean }): string {
  const step = stepLine(e);
  const advice = recommendation(e);
  const visible = [
    `🟡 <b>Потрібне твоє рішення: ${plain(subject(e), 120)}</b>`,
    step && plain(step, 170),
    `<b>Що сталося:</b> ${plain(happened(e), 300)}`,
    advice && `<b>Що рекомендую:</b> ${plain(advice, 150)}`,
    opts.needsRevision ? "Повернути план на доопрацювання можна лише через archon CLI." : "",
  ].filter(Boolean).join("\n");
  const open = "\n<blockquote expandable>";
  const close = "</blockquote>";
  const room = MAX_TEXT - visible.length - open.length - close.length;
  return `${visible}${open}${clip(escapeHtml(redact(details(e))), room)}${close}`;
}

export function buttonLabel(action: RespondAction, e: Escalation): string {
  if (action === "approve" && e.kind === "post-merge-gate" && field(e.text, "Тип") === "checkout") return "✅ Готово";
  return LABELS[action];
}

export function pressToast(action: RespondAction): string {
  return TOASTS[action];
}

// With no answer event the run moved on by itself, or was cancelled.
export function resolvedLine(decision: string | undefined, byButton: boolean, runStatus = ""): string {
  const word = decision === undefined
    ? (runStatus === "cancelled" ? "зупинено" : "продовжено")
    : (RESOLVED[decision] ?? "продовжено");
  return `✅ Вирішено: ${word} (${byButton ? "кнопкою" : "поза Telegram"})`;
}
