import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Decision } from "./act.ts";
import { alreadyActed, appendLedger, ledgerPath } from "./ledger.ts";
import { queueBrief, queueDir, type QueuedTask, resolveRepo, stageLog, stageResult } from "./queue.ts";
import type { RunView } from "./runs.ts";
import { copyLocalSettings, pluginDirs, type StageResult, stagesDir } from "./stage-run.ts";
import { obj, objs, trello } from "./trello.ts";

export type ExecResult = { code: number; stdout: string; stderr: string };

export type IntakeDeps = { exec: (argv: string[], cwd: string) => ExecResult; now?: () => number };

export const HINT = "Формат: /task <be|fe|sdlc> <текст>, наприклад: /task fe Додати кнопку «Вийти» в меню";

export const BE = "1_mvp_pilot_be";
export const FE = "1_mvp_pilot_fe";
const WORKFLOW = "sdlc-stage";
// A task whose dependencies are unfinished is briefed again at most this often.
const RETRY_MS = 15 * 60_000;
// Dots, not dashes, part the name: the ledger redacts a long mixed-case run of letters, digits and dashes.
const BRIEF = /^sdlc-stage\.PILOT-(\d+)\.([a-z-]+)\.(\d+)\.md$/;

// The plugin's stage map (templates/claude/rules/git.md): the command a stage runs and the `stage-pr` stage its docs PR
// is opened under. feature-start hands over to /sdlc:interview, whose PR is `brief`; task-cards opens `tasks-2`.
// tests/intake.test.ts holds this map to git.md.
export const STAGES = [
  { id: "feature-start", pr: "brief", command: (c: Chain) => `/mvp-sdlc:feature-start ${c.cardId}` },
  { id: "prd", pr: "prd", command: (c: Chain) => `/sdlc:write-prd ${c.slug}` },
  { id: "architecture", pr: "sad", command: (c: Chain) => `/sdlc:architecture-design ${c.slug}` },
  { id: "contracts", pr: "contracts", command: (c: Chain) => `/sdlc:api-forge ${c.slug}` },
  { id: "tasks", pr: "tasks", command: (c: Chain) => `/sdlc:break-tasks ${c.slug}` },
  { id: "task-cards", pr: "tasks", command: (c: Chain) => `/mvp-sdlc:task-cards ${c.slug}` },
  { id: "spec", pr: "spec", command: (c: Chain) => `/mvp-sdlc:sync-spec ${c.slug}` },
] as const;

type Stage = (typeof STAGES)[number];
type StageId = Stage["id"];
type Kind = "be" | "fe" | "sdlc";

// One `/task` feature on its way through the stages; `card` is `PILOT-<n>` and the key in `stages.json`.
// `briefed` and `waiting` are the task ids of tasks.json queued so far and those whose dependencies are unfinished.
export type Chain = {
  card: string;
  cardId: string;
  slug: string;
  kind: "be" | "fe";
  text: string;
  stage: StageId;
  attempt: number;
  state: "queued" | "review" | "briefs" | "done" | "stopped";
  pr?: string;
  branch?: string;
  feedback?: string;
  briefed?: string[];
  waiting?: string[];
  checkedAt?: number;
  created: string;
};

type State = { chains: Record<string, Chain> };

const stagesOf = (kind: Chain["kind"]): Stage[] => STAGES.filter((s) => kind === "fe" || s.id !== "spec");
const stageOf = (id: StageId): Stage => STAGES.find((s) => s.id === id) as Stage;
const repoOfStage = (id: StageId) => (id === "spec" ? FE : BE);
const runIdOf = (c: Chain) => `stage:${c.card}/${c.stage}`;
const briefName = (c: Chain) => `sdlc-stage.${c.card}.${c.stage}.${c.attempt}.md`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function statePath(): string {
  return join(dirname(ledgerPath()), "stages.json");
}

export function readChains(): State {
  try {
    const s = JSON.parse(readFileSync(statePath(), "utf8")) as Partial<State>;
    return { chains: s.chains && typeof s.chains === "object" ? s.chains : {} };
  } catch {
    return { chains: {} };
  }
}

function updateChains(change: (s: State) => void): void {
  const s = readChains();
  change(s);
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

const saveChain = (c: Chain) => updateChains((s) => void (s.chains[c.card] = c));

export function parseTask(text: string): { kind: Kind; text: string } | null {
  const m = text.trim().match(/^\/task(?:@\w+)?\s+(be|fe|sdlc)\s+(\S[\s\S]*)$/);
  return m ? { kind: m[1] as Kind, text: m[2].trim() } : null;
}

// The base branch the factory profile of the checkout names; the stage branches start from it.
function baseBranch(source: string): string {
  try {
    const p = Bun.YAML.parse(readFileSync(join(source, ".archon", "factory-profile.yaml"), "utf8")) as
      { repo?: { base_branch?: unknown } } | null;
    return typeof p?.repo?.base_branch === "string" ? p.repo.base_branch : "";
  } catch {
    return "";
  }
}

// The source checkout of `repo` and its base branch, or why there is none.
export function checkout(repo: string): { cwd: string; repo: string; base: string } | string {
  const r = resolveRepo(repo);
  if (!r.cwd) return `в Archon немає одного workspaces/*/${repo}/source`;
  const base = baseBranch(r.cwd);
  return base ? { ...r, base } : `у ${repo}/.archon/factory-profile.yaml немає repo.base_branch`;
}

// A card in Backlog named `t<idShort>: <first line>`: feature-start takes only `<slug>: <title>`, and a slug made from
// Ukrainian text could be empty. `source` is the checkout whose project board feature-start reads; otherwise the reply.
async function createCard(text: string, source?: string): Promise<{ id: string; number: number } | string> {
  const t = trello(source);
  if (typeof t === "string") return `⚠️ Картку не створено: ${t}`;
  let card: Record<string, unknown> = {};
  const title = text.split("\n")[0].trim().slice(0, 100);
  try {
    const backlog = objs(await t.call("GET", `/boards/${t.board}/lists?fields=name`)).find((l) => l.name === "Backlog");
    if (typeof backlog?.id !== "string") return "⚠️ Картку не створено: на дошці немає списку Backlog";
    card = obj(await t.call("POST", "/cards", { idList: backlog.id, name: title, desc: text }));
  } catch (e) {
    return `⚠️ Картку не створено: ${t.scrub(message(e))}`;
  }
  if (typeof card.id !== "string" || typeof card.idShort !== "number") {
    return "⚠️ Trello не повернув id картки: перевірте Backlog, перш ніж ставити задачу знову.";
  }
  const name = `t${card.idShort}: ${title}`;
  try {
    await t.call("PUT", `/cards/${encodeURIComponent(card.id)}`, { name });
  } catch (e) {
    return `⚠️ Картку PILOT-${card.idShort} створено в Backlog, але не перейменовано на «${name}»: ` +
      `${t.scrub(message(e))}. Задачу не поставлено; не ставте її знову, а перейменуйте картку вручну.`;
  }
  return { id: card.id, number: card.idShort };
}

// The headless session's instructions (operator decision Q1 = a): nobody answers it, so it decides at every checkpoint
// and records what it assumed; the operator's approval of the docs PR stands for the skill's confirmations.
function autopilotPrompt(c: Chain, be: { cwd: string; base: string }): string {
  const stage = stageOf(c.stage);
  return [
    "Nobody is present in this session: the sdlc-autopilot supervisor runs it headless for one SDLC stage.",
    "",
    "The operator's task, in their own words. Take it as the user's answer to every question the skill would ask:",
    "<task>",
    c.text,
    "</task>",
    "",
    "Rules:",
    `- Run exactly this one stage: ${stage.command(c)}. Never start the next stage, never run gh pr merge, never push to ` +
    "develop or main.",
    "- At every checkpoint or confirmation the skill asks for, pick the recommended option yourself. Never call " +
    "AskUserQuestion or ExitPlanMode.",
    "- Write every assumption you make in place of an answer under a heading `## Open question / assumption` in the " +
    "stage's document.",
    "- The operator approves the stage by approving its docs pull request in Telegram; that approval stands for the " +
    "skill's own confirmations.",
    `- Finish with stage-pr ${c.slug} ${stage.pr} --message "<commit message>" <the stage's files>, and stop once it ` +
    "prints the `pr:` line.",
    ...(c.stage === "spec"
      ? [`- Copy the spec with --from ${be.cwd} --ref origin/${be.base}: the backend's docs are not released yet.`]
      : []),
    ...(c.feedback
      ? [
        "",
        `Return comment: ${c.feedback}`,
        "The operator returned this stage's pull request with the comment above. Take it as more answers and revise the " +
        "documents already on this branch; stage-pr adds the commit to the open pull request.",
      ]
      : []),
  ].join("\n");
}

// Queues the chain's current stage in its repo's queue; the brief's first line names the card, as the queue needs.
function queueStage(c: Chain): string {
  const repo = checkout(repoOfStage(c.stage));
  if (typeof repo === "string") throw new Error(repo);
  const be = checkout(BE);
  if (typeof be === "string") throw new Error(be);
  const text = [
    `${c.card}: SDLC stage ${c.stage} of ${c.slug} (attempt ${c.attempt})`,
    `Repo-dir: ${repo.cwd}`,
    `Base: ${repo.base}`,
    `Command: ${stageOf(c.stage).command(c)}`,
    `Paths: docs/features/${c.slug}/`,
    ...(c.branch && c.attempt > 1 ? [`Branch: ${c.branch}`] : []),
    "---",
    autopilotPrompt(c, be),
    "",
  ].join("\n");
  return queueBrief(repoOfStage(c.stage), briefName(c), text);
}

// `/task <be|fe|sdlc> <text>` from the operator's chat: the reply to send. be and fe start the stage chain in the
// backend (the fe spec is synced from it last); sdlc only gets its card.
export async function taskCommand(text: string, deps: Pick<IntakeDeps, "now"> = {}): Promise<string> {
  const task = parseTask(text);
  if (!task) return HINT;
  let source: string | undefined;
  if (task.kind !== "sdlc") {
    for (const repo of task.kind === "fe" ? [BE, FE] : [BE]) {
      const found = checkout(repo);
      if (typeof found === "string") return `⚠️ Задачу не поставлено: ${found}.`;
      source ??= found.cwd;
    }
  }
  const card = await createCard(task.text, source);
  if (typeof card === "string") return card;
  const name = `PILOT-${card.number}`;
  if (task.kind === "sdlc") {
    return `🗂 Картку ${name} створено в Backlog. Брифу немає: задачу харнесу формулює Claude-сесія в 1_mvp_sdlc з цієї картки.`;
  }
  const chain: Chain = {
    card: name, cardId: card.id, slug: `t${card.number}`, kind: task.kind, text: task.text, stage: "feature-start",
    attempt: 1, state: "queued", created: new Date((deps.now ?? Date.now)()).toISOString(),
  };
  try {
    saveChain(chain);
    queueStage(chain);
  } catch (e) {
    updateChains((s) => void (s.chains[name] = { ...chain, state: "stopped" }));
    return `⚠️ Картку ${name} створено, але стадію feature-start не поставлено в чергу: ${message(e)}`;
  }
  return `🗂 Картку ${name} (${chain.slug}) створено в Backlog. 📥 Стадія feature-start у черзі ${BE}.`;
}

// The argv the queue launches a stage brief with, only for the brief its chain waits for; any other file, a
// hand-written one named like a stage brief included, stays a factory brief.
export function stageArgv(t: QueuedTask, started: string): string[] | null {
  const [, n, stage, attempt] = basename(t.briefFile).match(BRIEF) ?? [];
  const c = n ? readChains().chains[`PILOT-${n}`] : undefined;
  if (!c || c.state !== "queued" || c.stage !== stage || c.attempt !== Number(attempt)) return null;
  return ["bun", join(import.meta.dir, "stage-run.ts"), started];
}

let cached: RunView[] = [];

// The stage PRs waiting for the operator, as the last refresh saw them.
export function stageViews(): RunView[] {
  return cached;
}

function escalate(runId: string, eventId: string, rule: string, text: string): number {
  if (alreadyActed(runId, eventId)) return 0;
  appendLedger({
    ts: new Date().toISOString(), run_id: runId, workflow: WORKFLOW, kind: "stage", rule, action: "escalate",
    evidence: { event_id: eventId, message: text },
  });
  return 1;
}

function json(r: ExecResult): unknown {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return undefined;
  }
}

function gh(deps: IntakeDeps, cwd: string, ...args: string[]): ExecResult {
  return deps.exec(["gh", ...args], cwd);
}

// The finished launch of the chain's current brief: its started file and result; undefined while it runs.
function finished(c: Chain): { path: string; result: Partial<StageResult> } | undefined {
  const dir = join(queueDir(), "started", repoOfStage(c.stage));
  const name = existsSync(dir)
    ? readdirSync(dir).find((f) => f.startsWith("stage-") && f.endsWith(`--${briefName(c)}`))
    : undefined;
  if (!name || !existsSync(stageResult(join(dir, name)))) return undefined;
  const path = join(dir, name);
  try {
    return { path, result: JSON.parse(readFileSync(stageResult(path), "utf8")) as Partial<StageResult> };
  } catch (e) {
    return { path, result: { exit: 1, error: `результат стадії не прочитано: ${message(e)}` } };
  }
}

const logOf = (c: Chain) => stageLog(repoOfStage(c.stage), briefName(c));

type Pr = {
  state: string; head: string; title: string; summary: string; files: number; add: number; del: number; labels: string[];
};

function readPr(deps: IntakeDeps, cwd: string, url: string): Pr | string {
  const r = gh(deps, cwd, "pr", "view", url, "--json", "state,headRefOid,title,body,changedFiles,additions,deletions,labels");
  const p = obj(json(r));
  if (r.code !== 0 || typeof p.state !== "string" || typeof p.headRefOid !== "string") {
    return `gh pr view ${url}: ${r.stderr.trim() || `код ${r.code}`}`;
  }
  const summary = String(p.body ?? "").split("\n").map((l) => l.trim()).find((l) => l && !/^Type:/.test(l)) ?? "";
  return {
    state: p.state, head: p.headRefOid, title: String(p.title ?? ""), summary, files: Number(p.changedFiles ?? 0),
    add: Number(p.additions ?? 0), del: Number(p.deletions ?? 0), labels: objs(p.labels).map((l) => String(l.name)),
  };
}

// "pass" with the number of passing checks, "pending" or "fail"; gh exits non-zero on pending and failing checks, so
// only its output is read. No checks at all is green.
type Checks = { state: "pass"; n: number } | { state: "pending" | "fail" };

function readChecks(deps: IntakeDeps, cwd: string, url: string): Checks | string {
  const r = gh(deps, cwd, "pr", "checks", url, "--json", "name,bucket");
  const checks = json(r);
  if (!Array.isArray(checks)) {
    if (/no checks reported/.test(r.stderr)) return { state: "pass", n: 0 };
    return `gh pr checks ${url}: ${r.stderr.trim() || `код ${r.code}`}`;
  }
  const buckets = objs(checks).map((c) => c.bucket);
  if (buckets.some((b) => b === "fail" || b === "cancel")) return { state: "fail" };
  if (buckets.some((b) => b === "pending")) return { state: "pending" };
  return { state: "pass", n: buckets.filter((b) => b === "pass").length };
}

// A brief still waiting in the queue would otherwise launch as a factory run once its chain no longer claims it.
function stop(c: Chain, rule: string, text: string): number {
  c.state = "stopped";
  rmSync(join(queueDir(), repoOfStage(c.stage), briefName(c)), { force: true });
  return escalate(runIdOf(c), `${runIdOf(c)}@${c.attempt}@${rule}`, rule,
    `${text} Ланцюг стадій ${c.card} зупинено — потрібне рішення оператора.`);
}

function view(c: Chain, source: string, pr: Pr, checks: number): RunView {
  const id = runIdOf(c);
  const text = [
    `PR: ${c.pr}`,
    `Head: ${pr.head}`,
    `Diff: ${pr.files} files, +${pr.add} −${pr.del}`,
    `Checks: ${checks} pass`,
    "Review: ready",
    ...(pr.summary ? [`Summary: ${pr.summary}`] : []),
  ].join("\n");
  return {
    id, workflow: WORKFLOW, status: "paused", cwd: source,
    message: `${c.card}: SDLC-стадія ${c.stage} (спроба ${c.attempt}) · PR title «${pr.title}»`,
    pause: {
      eventId: `${id}@${pr.head}`, node: "pr-approve", kind: "pr-approve", text, occurrence: pr.head, iteration: c.attempt,
      decisions: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Return" }],
    },
  };
}

// The branches `stage-pr` opens a stage's docs PR from: `feature/PILOT-<n>-<slug>-<stage>`, then `-2` ... `-9` once the
// earlier ones are merged (its SUFFIXES).
export function stageBranch(card: string, slug: string, pr: string): RegExp {
  return new RegExp(`^feature/${card}-${slug}-${pr}(-[2-9])?$`);
}

// The stage's docs PR, opened by the session from one of its stage branches; exactly one must be open.
function findPr(deps: IntakeDeps, c: Chain, repo: { cwd: string; repo: string }): { url: string; branch: string } | string {
  const r = gh(deps, repo.cwd, "pr", "list", "--repo", repo.repo, "--state", "open", "--json", "url,headRefName",
    "--limit", "100");
  const prs = json(r);
  if (r.code !== 0 || !Array.isArray(prs)) return `gh pr list: ${r.stderr.trim() || `код ${r.code}`}`;
  const branch = stageBranch(c.card, c.slug, stageOf(c.stage).pr);
  const matches = objs(prs).filter((p) => branch.test(String(p.headRefName)));
  if (matches.length !== 1) return `${matches.length} відкритих PR з гілки feature/${c.card}-${c.slug}-${stageOf(c.stage).pr}`;
  return { url: String(matches[0].url), branch: String(matches[0].headRefName) };
}

// Each tick: a finished stage becomes a stage PR in review, a green PR in review becomes a pr-approve view the policy
// sends as a PR card, a PR merged on GitHub or labelled operator-approved advances the chain, and waiting task briefs
// are retried. A GitHub read that fails is logged and tried again on the next tick, its card kept meanwhile.
export function refreshChains(deps: IntakeDeps): { views: RunView[]; written: number } {
  const views: RunView[] = [];
  let written = 0;
  const now = (deps.now ?? Date.now)();
  for (const card of Object.keys(readChains().chains)) {
    const c = readChains().chains[card];
    try {
      written += refreshChain(c, deps, now, views);
    } catch (e) {
      console.error(`sdlc-autopilot: stage chain ${card}: ${message(e)}`);
      if (c.state === "review") keep(c, views);
    }
    saveChain(c);
  }
  cached = views;
  return { views, written };
}

// The card the last refresh showed for the chain stays open while its PR cannot be read or its checks rerun: a view
// missing from the open runs closes its card as answered, and the same event is never sent again.
function keep(c: Chain, views: RunView[]): number {
  const last = cached.find((v) => v.id === runIdOf(c));
  if (last) views.push(last);
  return 0;
}

function refreshChain(c: Chain, deps: IntakeDeps, now: number, views: RunView[]): number {
  if (c.state === "briefs") return now - (c.checkedAt ?? 0) >= RETRY_MS ? queueTaskBriefs(c, deps, now) : 0;
  if (c.state !== "queued" && c.state !== "review") return 0;
  const repo = checkout(repoOfStage(c.stage));
  if (typeof repo === "string") return stop(c, "stage-failed", `Стадію ${c.stage} не перевірено: ${repo}.`);
  if (c.state === "queued") {
    const done = finished(c);
    if (!done) return 0;
    const log = logOf(c);
    rmSync(stageResult(done.path), { force: true });
    rmSync(done.path, { force: true });
    if (done.result.exit !== 0) {
      const error = done.result.error || `код ${done.result.exit}`;
      return stop(c, "stage-failed", `Стадія ${c.stage} (${c.slug}) завершилась з помилкою: ${error}. Лог: ${log}.`);
    }
    const pr = findPr(deps, c, repo);
    if (typeof pr === "string") {
      return stop(c, "stage-no-pr",
        `Стадія ${c.stage} (${c.slug}) завершилась, але її docs PR не знайдено: ${pr}. Лог: ${log}.`);
    }
    Object.assign(c, { state: "review", pr: pr.url, branch: pr.branch });
  }
  const pr = readPr(deps, repo.cwd, c.pr ?? "");
  if (typeof pr === "string") throw new Error(pr);
  if (pr.state === "MERGED") return advance(c, deps, now);
  if (pr.state === "CLOSED") return stop(c, "stage-pr-closed", `Docs PR стадії ${c.stage} ${c.pr} закрито без злиття.`);
  const checks = readChecks(deps, repo.cwd, c.pr ?? "");
  if (typeof checks === "string") throw new Error(checks);
  if (checks.state === "pending") return keep(c, views);
  if (checks.state === "fail") {
    return escalate(runIdOf(c), `${runIdOf(c)}@${pr.head}@ci`, "stage-ci-red",
      `CI docs PR стадії ${c.stage} (${c.card}) червоний: ${c.pr}. Картки з кнопками не буде, поки CI не стане ` +
      "зеленим — потрібне рішення оператора.");
  }
  if (pr.labels.includes("operator-approved")) {
    const eventId = `${runIdOf(c)}@${pr.head}`;
    try {
      merge(deps, repo.cwd, c, pr.head);
    } catch (e) {
      return escalate(runIdOf(c), `${eventId}@merge`, "stage-merge-failed",
        `Docs PR ${c.pr} має label operator-approved, але його не злито: ${message(e)} — потрібне рішення оператора.`);
    }
    appendLedger({
      ts: new Date().toISOString(), run_id: runIdOf(c), workflow: WORKFLOW, kind: "pr-approve", rule: "operator-approved",
      action: "approve", evidence: { event_id: eventId, text: `label operator-approved on ${c.pr}` },
    });
    return 1 + advance(c, deps, now);
  }
  views.push(view(c, repo.cwd, pr, checks.n));
  return 0;
}

// Squash-merges exactly the head the operator approved: GitHub refuses it if the PR moved on meanwhile.
function merge(deps: IntakeDeps, cwd: string, c: Chain, head: string): void {
  const r = gh(deps, cwd, "pr", "merge", c.pr ?? "", "--squash", "--match-head-commit", head);
  if (r.code !== 0) throw new Error(`gh pr merge ${c.pr}: ${r.stderr.trim() || `код ${r.code}`}`);
}

// The next stage is queued; after the last one, the feature's task briefs. The stage PR is merged by now, so a stage
// that cannot be queued stops the chain rather than leave it waiting for a brief that never comes.
function advance(c: Chain, deps: IntakeDeps, now: number): number {
  const stages = stagesOf(c.kind);
  const next = stages[stages.findIndex((s) => s.id === c.stage) + 1];
  if (!next) {
    Object.assign(c, { state: "briefs", briefed: [], waiting: undefined });
    return queueTaskBriefs(c, deps, now);
  }
  Object.assign(c, { stage: next.id, attempt: 1, state: "queued", pr: undefined, branch: undefined, feedback: undefined });
  try {
    queueStage(c);
  } catch (e) {
    return stop(c, "stage-failed", `Стадію ${next.id} (${c.slug}) не поставлено в чергу: ${message(e)}.`);
  }
  return 0;
}

// The operator's answer to a stage PR card, in place of `archon workflow respond`: approve merges the head the card
// showed and queues the next stage; reject reruns the stage on its PR branch with the operator's text. A throw is
// re-escalated by the caller, so a stale head refuses and the next refresh sends a card for the new head; any other
// refusal keeps the card's view, so the escalation keeps its buttons and a later press retries.
export function respondStage(run: RunView, d: Decision, deps: IntakeDeps): void {
  const c = readChains().chains[run.id.match(/^stage:(PILOT-\d+)\//)?.[1] ?? ""];
  const head = run.pause?.occurrence ?? "";
  if (!c || runIdOf(c) !== run.id || c.state !== "review" || !head) throw new Error(`стадія ${run.id} вже не чекає апруву`);
  const repo = checkout(repoOfStage(c.stage));
  if (typeof repo === "string") throw new Error(repo);
  if (d.action === "approve") {
    const pr = readPr(deps, repo.cwd, c.pr ?? "");
    if (typeof pr === "string") throw new Error(pr);
    if (pr.head !== head) {
      const moved = `${head.slice(0, 7)} → ${pr.head.slice(0, 7)}`;
      throw new Error(`PR змінився після картки (${moved}): не злито, апрув потрібен знову`);
    }
    const checks = readChecks(deps, repo.cwd, c.pr ?? "");
    if (typeof checks === "string") throw new Error(checks);
    if (checks.state !== "pass") throw new Error("CI docs PR зараз не зелений: не злито, апрув потрібен знову");
    merge(deps, repo.cwd, c, head);
    advance(c, deps, (deps.now ?? Date.now)());
  } else if (d.action === "reject") {
    Object.assign(c, { attempt: c.attempt + 1, state: "queued", feedback: d.text });
    queueStage(c);
  } else throw new Error(`стадія приймає лише approve або reject, не ${d.action}`);
  saveChain(c);
  cached = cached.filter((v) => v.id !== run.id);
}

// The line a stage card's close note gains once the operator's answer went through.
export function stageNote(runId: string): string {
  const c = readChains().chains[runId.match(/^stage:(PILOT-\d+)\//)?.[1] ?? ""];
  if (!c) return "";
  if (c.state === "queued" && c.attempt > 1) return `🔁 Стадію ${c.stage} перезапущено із зауваженням.`;
  if (c.state === "queued") return `📥 Наступна стадія ${c.stage} у черзі ${repoOfStage(c.stage)}.`;
  if (c.state === "briefs" || c.state === "done") {
    return `📥 У черзі ${c.briefed?.length ?? 0} задач, ще ${c.waiting?.length ?? 0} чекають залежностей.`;
  }
  return "";
}

type Task = { id: string; repo: string };

// task-brief refuses every unready task with exit 1; only this sentence tells an unfinished dependency apart, and
// tests/intake.test.ts runs the real task-brief to keep it.
export const waitsForDeps = (r: ExecResult) => r.code === 1 && /depends on unfinished/.test(r.stderr);

// tasks.json as merged into the backend's base: the tasks not done yet.
function openTasks(deps: IntakeDeps, be: { cwd: string; base: string }, slug: string): Task[] | string {
  const git = (...args: string[]) => deps.exec(["git", "-C", be.cwd, ...args], be.cwd);
  const fetched = git("fetch", "-q", "origin", be.base);
  if (fetched.code !== 0) return `git fetch origin ${be.base}: ${fetched.stderr.trim()}`;
  const shown = git("show", `origin/${be.base}:docs/features/${slug}/tasks/tasks.json`);
  const tasks = obj(json(shown)).tasks;
  if (shown.code !== 0 || !Array.isArray(tasks)) {
    return `docs/features/${slug}/tasks/tasks.json не прочитано з origin/${be.base}`;
  }
  return objs(tasks).filter((t) => t.status !== "done" && typeof t.id === "string" && typeof t.repo === "string")
    .map((t) => ({ id: String(t.id), repo: String(t.repo) }));
}

// One factory brief per task, from the plugin's task-brief run in a fresh worktree of the task's repo at its base. A
// task that depends on unfinished tasks waits and is tried again after RETRY_MS; any other refusal is escalated.
function queueTaskBriefs(c: Chain, deps: IntakeDeps, now: number): number {
  const runId = `stage:${c.card}/briefs`;
  c.checkedAt = now;
  const be = checkout(BE);
  const tasks = typeof be === "string" ? be : openTasks(deps, be, c.slug);
  if (typeof be === "string" || typeof tasks === "string") {
    return stop(c, "stage-task-brief", `Брифи задач ${c.slug} не поставлено: ${String(tasks)}.`);
  }
  const briefed = new Set(c.briefed ?? []);
  const waiting: string[] = [];
  let written = 0;
  for (const repo of [...new Set(tasks.map((t) => t.repo))]) {
    const todo = tasks.filter((t) => t.repo === repo && !briefed.has(t.id));
    if (todo.length === 0) continue;
    const out = briefRepo(deps, c, repo, todo, be.cwd);
    if (typeof out === "string") {
      written += escalate(runId, `${runId}@${repo}`, "stage-task-brief",
        `Брифи задач ${c.slug} у ${repo} не поставлено: ${out} — потрібне рішення оператора.`);
      waiting.push(...todo.map((t) => t.id));
      continue;
    }
    for (const [id, r] of out) {
      if (r.code === 0) {
        queueBrief(repo, `task-${c.card}-${id}.md`, r.stdout);
        briefed.add(id);
        c.briefed = [...briefed];
      } else if (waitsForDeps(r)) waiting.push(id);
      else {
        written += escalate(runId, `${runId}@${id}`, "stage-task-brief",
          `Бриф задачі ${id} (${c.slug}, ${repo}) не поставлено: ${r.stderr.trim() || `код ${r.code}`} — потрібне ` +
          "рішення оператора.");
      }
    }
  }
  Object.assign(c, { briefed: [...briefed], waiting, state: waiting.length > 0 ? "briefs" : "done" });
  return written;
}

function briefRepo(
  deps: IntakeDeps, c: Chain, repoName: string, todo: Task[], beSource: string,
): Map<string, ExecResult> | string {
  const repo = checkout(repoName);
  if (typeof repo === "string") return repo;
  const plugins = pluginDirs(repo.cwd);
  if (typeof plugins === "string") return plugins;
  const git = (...args: string[]) => deps.exec(["git", "-C", repo.cwd, ...args], repo.cwd);
  const wt = join(stagesDir(), `briefs-${c.card}-${repoName}`);
  mkdirSync(stagesDir(), { recursive: true });
  try {
    if (git("fetch", "-q", "origin", repo.base).code !== 0) return `git fetch origin ${repo.base} не вдався`;
    if (git("worktree", "add", "-q", "--detach", wt, `origin/${repo.base}`).code !== 0) {
      return `git worktree add ${wt} не вдався`;
    }
    copyLocalSettings(repo.cwd, wt);
    const from = repoName === BE ? [] : ["--from", beSource];
    return new Map(todo.map((t) => [t.id, deps.exec([join(plugins[1], "bin", "task-brief"), c.slug, t.id, ...from], wt)]));
  } finally {
    if (existsSync(wt)) git("worktree", "remove", "--force", wt);
  }
}

export const realIntakeDeps: IntakeDeps = {
  exec: (argv, cwd) => {
    const r = Bun.spawnSync(argv, { cwd, env: process.env, stdin: "ignore", timeout: 60_000 });
    return { code: r.exitCode ?? 124, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  },
};
