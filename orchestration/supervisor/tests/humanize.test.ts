import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buttonLabel, type Escalation, escapeHtml, MAX_TEXT, MAX_VISIBLE, renderEscalation, resolvedLine,
} from "../src/humanize.ts";
import {
  approvalMessage, type Facts, ROUND_CAP,
} from "../../factory/.archon/workflows/sdlc-factory/factory/scripts/_lib/approval.ts";

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
  prTitle: "PILOT-542: Release 0.9.3 changelog", lastStep: "9", stepText: "",
};

const PR_FIXTURE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "pr-approve-7b3c1d2e.json"), "utf8")) as {
  run: { id: string; user_message: string; metadata: string };
};
const PR_TEXT: string = JSON.parse(PR_FIXTURE.run.metadata).wait.message;

const card = (text = PR_TEXT): Escalation => ({
  workflow: "factory", runId: PR_FIXTURE.run.id, repo: "OlegShevtsov1/1_mvp_pilot_fe", runMessage: PR_FIXTURE.run.user_message,
  kind: "pr-approve", rule: "pr-approve", text, reason: "PR чекає апруву оператора — потрібне рішення оператора.",
  prTitle: "", lastStep: "", stepText: "",
});

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
      "<b>Що рекомендую:</b> виконай команди кроку у своєму терміналі (деталі нижче) і натисни «Готово».",
    ]);
    expect(buttonLabel("approve", e)).toBe("✅ Готово");
    expect(buttonLabel("approve", base)).toBe("✅ Прийняти");
    expect(["skip", "abort", "retry"].map((a) => buttonLabel(a as "skip", base)))
      .toEqual(["⏭ Пропустити крок", "⛔ Зупинити", "🔁 Чекати ще"]);
  });

  test("the e9af1deb A9 checkout step reads cut at a word boundary, with the plugin instruction", () => {
    const update = (repo: string) =>
      `(cd /home/operator/projects/mvp/${repo} && claude plugin update mvp-sdlc@mvp --scope project)`;
    const a9 = {
      ...base, lastStep: "10",
      text: gate("checkout", "9 — A9 — Operator, by hand: update mvp-sdlc in the pilot repositories and prove the " +
        "plugin cache holds 0", "Крок A9 звертається до checkout оператора."),
      stepText: [
        "**A9 — Operator, by hand: update mvp-sdlc in the pilot repositories and prove the plugin cache holds 0.9.5**",
        "", "```bash", update("1_mvp_pilot_be"), update("1_mvp_pilot_fe"), "```", "",
        "Expected:", "- both commands exit 0", "- the plugin cache holds 0.9.5",
      ].join("\n"),
    };
    const html = renderEscalation(a9, { needsRevision: false });
    expect(visible(html).split("\n").slice(1)).toEqual([
      "Крок 9 з 10: Operator, by hand: update mvp-sdlc in the pilot repositories and prove the…",
      "<b>Що сталося:</b> крок зачіпає твої локальні репозиторії, тому його робиш ти.",
      "<b>Що рекомендую:</b> онови плагін mvp-sdlc у be і fe (claude plugin update mvp-sdlc@mvp --scope project) і " +
      "натисни «Готово».",
    ]);
    expect(collapsed(html)).toContain(escapeHtml(update("1_mvp_pilot_be")));

    const step = visible(renderEscalation({ ...a9, stepText: "" }, { needsRevision: false })).split("\n")[1];
    expect(step).toBe("Крок 9 з 10: Operator, by hand: update mvp-sdlc in the pilot repositories and prove the…");
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

  test("pr-approve renders a card with the PR link, diff, checks and summary", () => {
    const html = renderEscalation(card(), { needsRevision: false });
    expect(visible(html).split("\n")).toEqual([
      "🟡 <b>PR готовий: PILOT-900: fe: dark theme toggle on the settings page</b>",
      '<a href="https://github.com/OlegShevtsov1/1_mvp_pilot_fe/pull/42">PR #42</a> · Diff: 7 файлів, +120 −8 · Checks: 9 ✅',
      "<b>Що сталося:</b> CI зелений, ревʼю готове — PR чекає твого апруву (раунд 1 з 4).",
      "<b>Підсумок:</b> The settings page gets a dark theme toggle. The choice is kept in local storage and applied " +
      "before the first paint.",
      "<b>Що рекомендую:</b> переглянь PR: «Апрув» зливає саме цей коміт, «Повернути» — напиши, що змінити.",
    ]);
    expect(collapsed(html)).toBe("<blockquote expandable>Прогін: factory 7b3c1d2e · OlegShevtsov1/1_mvp_pilot_fe\n\n" +
      "PR APPROVAL — round 1 of 4.\nReview: ready</blockquote>");
    for (const hidden of ["approve →", "reject  →", "operator-approved", "Head:"]) expect(html).not.toContain(hidden);
    expect(buttonLabel("approve", card())).toBe("✅ Апрув");
    expect(buttonLabel("reject", card())).toBe("↩️ Повернути");
    expect(buttonLabel("approve", { ...card(), kind: "plan-gate" })).toBe("✅ Прийняти");
  });

  test("a PR card says when the review is not ready and when the round is the last", () => {
    const lines = (text: string) => visible(renderEscalation(card(text), { needsRevision: false })).split("\n");
    const notReady = lines(PR_TEXT.replace("Review: ready", "Review: not ready — CI check e2e is failure on the head"));
    expect(notReady[2]).toBe("<b>Що сталося:</b> ревʼю не готове: CI check e2e is failure on the head.");
    expect(notReady[4]).toBe("<b>Що рекомендую:</b> натисни «Повернути» і напиши, що змінити: апрув зупинить прогін без злиття.");
    const last = lines(PR_TEXT.replace("round 1 of 4", "round 4 of 4"));
    expect(last[2]).toEndWith("(раунд 4 з 4).");
    expect(last[4]).toEndWith(" Це останній раунд: «Повернути» зупинить прогін, PR лишиться відкритим.");
    expect(lines(PR_TEXT.replace("Diff: 7 files", "Diff: 1 file").replace("9 pass", "3 pass"))[1])
      .toEndWith("Diff: 1 файл, +120 −8 · Checks: 3 ✅");
    expect(lines(PR_TEXT.replace("Diff: 7 files", "Diff: 22 files"))[1]).toContain("Diff: 22 файли,");
    expect(lines(PR_TEXT.replace("Diff: 7 files", "Diff: 12 files"))[1]).toContain("Diff: 12 файлів,");
  });

  test("a PR card after a failed respond says so; a pause text without a PR link reads as any escalation", () => {
    const failed = renderEscalation({
      ...card(), rule: "operator", reason: "Не вдалося виконати відповідь оператора reject: spawn failed — потрібне рішення оператора.",
    }, { needsRevision: false });
    expect(visible(failed).split("\n")[2]).toBe("<b>Що сталося:</b> Не вдалося виконати відповідь оператора reject: spawn failed");
    for (const pr of ["PR: https://evil.example/OlegShevtsov1/1_mvp_pilot_fe/pull/42", "PR: "]) {
      const html = renderEscalation(card(PR_TEXT.replace(/^PR: .*$/m, pr)), { needsRevision: false });
      expect(html).toStartWith("🟡 <b>Потрібне твоє рішення: PILOT-900:");
      expect(html).not.toContain("<a href");
    }
  });

  test("the card reads the pause text the factory writes", () => {
    const facts: Facts = {
      ready: true, reason: "", pr_url: "https://github.com/OlegShevtsov1/1_mvp_pilot_fe/pull/42", pr_number: 42,
      head_sha: "3f9c2b7a1d4e5f60718293a4b5c6d7e8f9012345", files: 7, additions: 120, deletions: 8, checks_pass: 9,
      summary: "The settings page gets a dark theme toggle.", regated: false,
    };
    const lines = (f: Facts, round: number) =>
      visible(renderEscalation(card(approvalMessage(f, round)), { needsRevision: false })).split("\n");
    const first = lines(facts, 1);
    expect(first[1]).toBe(
      '<a href="https://github.com/OlegShevtsov1/1_mvp_pilot_fe/pull/42">PR #42</a> · Diff: 7 файлів, +120 −8 · Checks: 9 ✅',
    );
    expect(first[2]).toBe(`<b>Що сталося:</b> CI зелений, ревʼю готове — PR чекає твого апруву (раунд 1 з ${ROUND_CAP}).`);
    expect(first[3]).toBe("<b>Підсумок:</b> The settings page gets a dark theme toggle.");
    const last = lines({ ...facts, ready: false, reason: "CI check e2e is failure on the head" }, ROUND_CAP);
    expect(last[2]).toBe("<b>Що сталося:</b> ревʼю не готове: CI check e2e is failure on the head.");
    expect(last[4]).toEndWith(" Це останній раунд: «Повернути» зупинить прогін, PR лишиться відкритим.");
  });

  test("a PR card with long values fits Telegram's limit", () => {
    const text = PR_TEXT.replace(/^Summary: .*$/m, `Summary: ${"<&> ".repeat(500)}`)
      .replace("Review: ready", `Review: not ready — ${"x".repeat(2000)}`).replace("9 pass", "9 pass".repeat(50));
    const html = renderEscalation({ ...card(text), runMessage: `PR title «PILOT-1: ${"&".repeat(500)}»` }, { needsRevision: false });
    expect(visible(html).length).toBeLessThanOrEqual(MAX_VISIBLE);
    expect(html.length).toBeLessThanOrEqual(MAX_TEXT);
    expect(html).not.toMatch(/&[a-z]*…/);
  });

  test("the resolution line says what was decided and where", () => {
    expect(["approved", "skip", "abort", "retry"].map((d) => resolvedLine(d, false))).toEqual([
      "✅ Вирішено: прийнято (поза Telegram)", "✅ Вирішено: пропущено (поза Telegram)",
      "✅ Вирішено: зупинено (поза Telegram)", "✅ Вирішено: продовжено (поза Telegram)",
    ]);
    expect(resolvedLine(undefined, false, "cancelled")).toBe("✅ Вирішено: зупинено (поза Telegram)");
    expect(resolvedLine(undefined, false, "running")).toBe("✅ Вирішено: продовжено (поза Telegram)");
    expect(resolvedLine("approve", true)).toBe("✅ Вирішено: прийнято (кнопкою)");
    expect(resolvedLine("reject", true)).toBe("✅ Вирішено: повернуто на доопрацювання (кнопкою)");
  });
});
