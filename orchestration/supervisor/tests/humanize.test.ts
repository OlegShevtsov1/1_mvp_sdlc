import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buttonLabel, type Escalation, MAX_TEXT, MAX_VISIBLE, renderEscalation, resolvedLine } from "../src/humanize.ts";

const LEGEND = [
  "",
  "approve → виконати крок (або прийняти розбіжність як OK)",
  "skip    → пропустити крок і продовжити",
  "abort   → зупинити виконання",
  "",
];

const A2 = (JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "post-merge-gate-8275c6ec.json"), "utf8")) as {
  events: { event_type: string; data: string }[];
}).events.flatMap((e) => e.event_type === "approval_requested" ? [JSON.parse(e.data).message as string] : [])[0];

const gate = (type: string, step: string, reason: string) => [
  "post-merge PILOT502 — потрібне рішення оператора.", `Крок: ${step}`, `Тип: ${type}`, `Причина: ${reason}`,
  "Журнал: $ARTIFACTS_DIR/ledger.jsonl", ...LEGEND,
].join("\n");

const base: Escalation = {
  workflow: "post-merge", runId: "8275c6ec-780e-44c4-98cc-b8e5bac0e0dc", repo: "OlegShevtsov1/1_mvp_sdlc",
  runMessage: "run=PILOT542 pr=https://github.com/OlegShevtsov1/1_mvp_sdlc/pull/111", kind: "post-merge-gate",
  rule: "post-merge-gate", text: A2,
  reason: "Крок post-merge «2 — A2 — 🔒 Annotated tag v0.9.3 on the merge commit M (shape as v0.9.2; no GitHub Release)» " +
    "(тип mismatch) схвалює лише оператор — потрібне рішення оператора.",
  prTitle: "PILOT-542: Release 0.9.3 changelog", lastStep: "9",
};

const render = (e: Partial<Escalation>, needsRevision = false) => renderEscalation({ ...base, ...e }, { needsRevision });
const visible = (html: string) => html.slice(0, html.indexOf("\n<blockquote expandable>"));
const collapsed = (html: string) => html.slice(html.indexOf("<blockquote expandable>"));

describe("humanize", () => {
  test("the 8275c6ec A2 pause reads in plain words with its details collapsed", () => {
    const html = render({});
    expect(visible(html).split("\n")).toEqual([
      "🟡 <b>Потрібне твоє рішення: реліз sdlc v0.9.3</b>",
      "Крок 2 з 9: Annotated tag v0.9.3 on the merge commit M",
      '<b>Що сталося:</b> автоматична перевірка дала не те, що очікувалось: GitHub відповів "не знайдено".',
    ]);
    expect(collapsed(html)).toStartWith("<blockquote expandable>Прогін: post-merge 8275c6ec · OlegShevtsov1/1_mvp_sdlc\n");
    expect(collapsed(html)).toContain("Annotated tag v0.9.3");
    expect(collapsed(html)).toContain("отримали HTTP 404");
    expect(html).toEndWith("</blockquote>");
    expect(html.match(/потрібне.*рішення/gi)).toHaveLength(1);
    expect(html).not.toContain("потрібне рішення оператора");
    for (const hidden of ["execute-cycle", "$ARTIFACTS_DIR", "approve →", "skip ", "abort ", "схвалює лише оператор"]) {
      expect(html).not.toContain(hidden);
    }
    expect(visible(html)).not.toContain('{"');
  });

  test("a checkout step is the operator's, with a recommendation and a Готово button", () => {
    const e = { ...base, text: gate("checkout", "7 — A7 — Operator, by hand: update mvp-sdlc", "Крок A7 звертається до checkout.") };
    const lines = visible(renderEscalation(e, { needsRevision: false })).split("\n");
    expect(lines.slice(1)).toEqual([
      "Крок 7 з 9: Operator, by hand: update mvp-sdlc",
      "<b>Що сталося:</b> крок зачіпає твої локальні репозиторії, тому його робиш ти.",
      "<b>Що рекомендую:</b> зроби кроки вручну і натисни «Готово».",
    ]);
    expect(buttonLabel("approve", e)).toBe("✅ Готово");
    expect(buttonLabel("approve", base)).toBe("✅ Прийняти");
    expect(["skip", "abort", "retry"].map((a) => buttonLabel(a as "skip", base)))
      .toEqual(["⏭ Пропустити крок", "⛔ Зупинити", "🔁 Чекати ще"]);
  });

  test("what happened follows the pause type and the observed value", () => {
    const said = (e: Partial<Escalation>) => visible(render(e)).split("\n").find((l) => l.startsWith("<b>Що сталося"));
    expect(said({ text: gate("mismatch", "3 — A3 — Mirror", "Перевірка не пройшла: очікували rc=0, отримали rc=2.") }))
      .toContain("автоматична перевірка дала не те, що очікувалось: команда завершилась з кодом 2.");
    expect(said({ text: gate("mismatch", "3 — A3 — Mirror", "Синхронізацію виконано, rc=0. Проте скан надрукував 1.") }))
      .toEndWith("автоматична перевірка дала не те, що очікувалось.");
    expect(said({ text: gate("mismatch", "3 — A3 — Site", "url-contains https://example.org/x: отримали HTTP 404") }))
      .toContain('сервер відповів "не знайдено"');
    expect(said({ text: gate("manual", "5 — A5 — Rotate", "Потрібна дія.") })).toContain("крок потребує ручної дії.");
    expect(said({ text: gate("approval", "4 — A4 — Install", "Перелік прогонів не порожній. Оператору: дочекатися.") }))
      .toBe("<b>Що сталося:</b> Перелік прогонів не порожній.");
    expect(said({ text: gate("", "6 — A6 — Step", "") })).toBe("<b>Що сталося:</b> Крок post-merge «2 — A2 — 🔒 Annotated " +
      "tag v0.9.3 on the merge commit M (shape as v0.9.2; no GitHub Release)» (тип mismatch) схвалює лише оператор");
  });

  test("an exhausted transient failure names the failure, without a step", () => {
    const html = render({
      workflow: "factory", kind: "oauth", rule: "transient-exhausted", runMessage: "", prTitle: "", lastStep: "",
      text: "Claude Code auth failed: OAuth token expired",
      reason: "Транзієнтний збій oauth у прогоні 8275c6ec (factory) повторився після 3 спроб resume — автоматичних спроб " +
        "більше не буде. Рекомендація: claude login.",
    });
    expect(visible(html).split("\n")).toEqual([
      "🟡 <b>Потрібне твоє рішення: factory OlegShevtsov1/1_mvp_sdlc</b>",
      "<b>Що сталося:</b> збій повторився 3 рази: сплив вхід у Claude.",
    ]);
    expect(collapsed(html)).toContain("Рекомендація: claude login.");
  });

  test("an install gate out of retries recommends waiting", () => {
    const html = render({
      kind: "install-gate", rule: "install-gate", lastStep: "",
      text: "post-merge C8.Tn — встановлення чекає на завершення прогонів пакета, який встановлюється.\n" +
        "Блокують: 7bb98ecd factory\nДоказ: $ARTIFACTS_DIR/install.json\n\nretry → чекати знову\nabort → не встановлювати\n",
      reason: "Встановлення чекає вже після 6 retry (≈1 год), factory досі активний: 7bb98ecd — потрібне рішення оператора.",
    });
    expect(visible(html).split("\n").slice(1)).toEqual([
      "Встановлення чекає, поки завершиться прогін фабрики",
      "<b>Що сталося:</b> автоматичні спроби дочекатися вичерпано, а прогін фабрики досі йде.",
      "<b>Що рекомендую:</b> натисни «Чекати ще», якщо прогін фабрики має завершитись.",
    ]);
    expect(collapsed(html)).toContain("Блокують: 7bb98ecd factory");
    expect(html).not.toContain("retry →");
  });

  test("a plan gate names the card and says how to send the plan back", () => {
    const lines = visible(render({
      workflow: "factory", kind: "plan-gate", rule: "plan-gate", prTitle: "", lastStep: "", text: "GATE 2 — the plan.",
      runMessage: "Deliver the plan. PR title «PILOT-544: sdlc supervisor: plain words», trailer «Type: feat».",
      reason: "План має блокуюче відкрите питання: який бот? — потрібне рішення оператора.",
    }, true)).split("\n");
    expect(lines).toEqual([
      "🟡 <b>Потрібне твоє рішення: PILOT-544: sdlc supervisor: plain words</b>",
      "План задачі готовий до перевірки",
      "<b>Що сталося:</b> План має блокуюче відкрите питання: який бот?",
      "Повернути план на доопрацювання можна лише через archon CLI.",
    ]);
  });

  test("a long pause text fits Telegram's limit with the resolution line, without a broken entity", () => {
    const long = gate("mismatch", `1 — A1 — ${"<&>".repeat(200)}`, `отримали HTTP 500 ${"a < b & c > d ".repeat(1500)}`);
    const html = render({ text: long, prTitle: `PILOT-1: ${"&".repeat(500)}`, reason: "x".repeat(5000) });
    expect(visible(html).length).toBeLessThanOrEqual(MAX_VISIBLE);
    expect(html.length).toBeLessThanOrEqual(MAX_TEXT);
    expect(html).toEndWith("…</blockquote>");
    expect(html).not.toMatch(/&[a-z]*…/);
    expect(`${html}\n\n${resolvedLine("approve", false)}`.length).toBeLessThanOrEqual(4096);
  });

  test("the resolution line says what was decided and where", () => {
    expect(["approved", "skip", "abort", "retry"].map((d) => resolvedLine(d, false))).toEqual([
      "✅ Вирішено: прийнято (поза Telegram)", "✅ Вирішено: пропущено (поза Telegram)",
      "✅ Вирішено: зупинено (поза Telegram)", "✅ Вирішено: продовжено (поза Telegram)",
    ]);
    expect(resolvedLine(undefined, false, "cancelled")).toBe("✅ Вирішено: зупинено (поза Telegram)");
    expect(resolvedLine(undefined, false, "running")).toBe("✅ Вирішено: продовжено (поза Telegram)");
    expect(resolvedLine("approve", true)).toBe("✅ Вирішено: прийнято (кнопкою)");
  });
});
