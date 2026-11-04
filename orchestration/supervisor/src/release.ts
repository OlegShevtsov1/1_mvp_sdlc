import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type Decision, runDetached } from "./act.ts";
import { BE, type Chain, checkout, FE, type IntakeDeps, readChains } from "./intake.ts";
import { alreadyActed, appendLedger, ledgerPath } from "./ledger.ts";
import { inside, MAX_SHOTS, READY_TO_RELEASE, type Shot } from "./qa.ts";
import { type RollbackJob, type RollbackResult, UNCHANGED } from "./release-run.ts";
import type { RunView } from "./runs.ts";
import { queueBrief, queueDir, type QueuedTask, stageLog, stageResult } from "./queue.ts";
import type { StageResult } from "./stage-run.ts";
import { obj, objs, type Trello, trello } from "./trello.ts";

export type ReleaseRule = { mirrorOwner: string };

// One repo's part of a release: its own Trello card and `bin/release` run; `attempt` grows only on fe's exit 75, whose
// rerun ships the `version` its first run's prep merged. `unchanged`: the repo had nothing to release since its last
// tag, so the features' work there already went out with an earlier release.
// A shipped step also keeps what a QA prod reject needs: the tag it shipped over (`previous`, "" for a first release),
// its irreversible migrations, both unknown when bin/release did not say, and the mirror it shipped through; and what
// the QA prod card shows: the prod URL and the screenshots under the state dir's release-shots/.
export type ReleaseStep = {
  repo: string; card: string; cardId: string; attempt: number; state: "queued" | "shipped" | "unchanged"; version?: string;
  sha?: string; mirror?: string; previous?: string; irreversible?: string[]; url?: string; shots?: Shot[];
  shotsTotal?: number;
};

// `features` are the `/task` chains' cards, `tasks` their task cards; `repos` the repos their tasks touch, be first. At
// most one is `open`; a `stopped` one holds every automatic release until the operator sets it to `closed`. `qa` is
// the operator's answer on the QA prod card, `fix` the `<repo>/<name>` of the brief a reject queued and `rollback` how
// that reject's rollback went.
export type Release = {
  id: number;
  state: "open" | "shipped" | "failed" | "stopped" | "closed";
  features: string[];
  tasks?: string[];
  repos: string[];
  steps: ReleaseStep[];
  created: string;
  qa?: "ok" | "reject";
  fix?: string;
  rollback?: { state: "running" | "done" | "failed" | "refused"; reason?: string };
};

type State = { releases: Release[] };

// What `release-run.ts` leaves next to the started brief: the stage result, the version whose release-prep PR is
// merged ("" while none is) and the stdout lines of `bin/release` (`prep:`, `shipped:`, `red:`, `rolled back:`,
// `no auto-rollback:`), or the runner's own UNCHANGED line. A shipped result adds the step's QA prod fields, its
// screenshots still in `<started>.shots/`.
export type ReleaseResult = StageResult & { version: string; lines: string[] } &
  Pick<ReleaseStep, "previous" | "irreversible" | "url" | "shots" | "shotsTotal">;

export type QaProdDeps = { launch: (argv: string[], cwd: string, logFile: string) => void };


const ORDER = [BE, FE];
export const RELEASE_WORKFLOW = "release";
const QA_PROD = "qa-prod";
const DONE = "Done";
const BRIEF = /^sdlc-release\.(\d+)\.(\d+)\.md$/;
// fe's `bin/release ship` exits 75 while be on prod is still below `deploy/min-be-version`: the step is launched again,
// at most MAX_ATTEMPTS times in all.
const BE_WAIT = 75;
const MAX_ATTEMPTS = 3;
const SHIPPED = /^shipped: v(\d+\.\d+\.\d+) ([0-9a-f]{40})$/;
const OPERATOR = "потрібне рішення оператора.";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const runIdOf = (r: Release) => `release:${r.id}`;
const briefName = (r: Release, s: ReleaseStep) => `sdlc-release.${r.id}.${s.attempt}.md`;
const cardName = (r: Release, repo: string) => `Release ${repo} for ${r.features.join(", ")}`;

export function releaseRule(rules: unknown[]): ReleaseRule | null {
  const found = rules.map(obj).filter((r) => r.id === "release");
  if (found.length === 0) return null;
  if (found.length > 1) throw new Error("policy: rule release is defined twice");
  const owner = found[0].mirror_owner;
  if (typeof owner !== "string" || !/^[\w.-]+$/.test(owner)) throw new Error("policy: rule release is malformed");
  return { mirrorOwner: owner };
}

function statePath(): string {
  return join(dirname(ledgerPath()), "releases.json");
}

// No file yet is no release; an unreadable one throws, so nothing is saved over the history and its `stopped` hold.
export function readReleases(): State {
  if (!existsSync(statePath())) return { releases: [] };
  const s = JSON.parse(readFileSync(statePath(), "utf8")) as Partial<State> | null;
  if (!Array.isArray(s?.releases)) throw new Error(`${statePath()}: немає списку releases`);
  return { releases: s.releases };
}

function save(s: State): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

function ledger(r: Release, eventId: string, rule: string, action: "escalate" | "none", text: string): number {
  if (alreadyActed(runIdOf(r), eventId)) return 0;
  appendLedger({
    ts: new Date().toISOString(), run_id: runIdOf(r), workflow: RELEASE_WORKFLOW, kind: "release", rule, action,
    evidence: { event_id: eventId, message: text },
  });
  return 1;
}

type Feature = { card: string; repos: string[]; tasks: string[] };

// The board's Ready to Release list and the list of each card by number.
async function readBoard(t: Trello): Promise<{ ready: string; listOf: Map<number, unknown> }> {
  const lists = objs(await t.call("GET", `/boards/${t.board}/lists?fields=name`));
  const ready = lists.find((l) => l.name === READY_TO_RELEASE)?.id;
  if (typeof ready !== "string") throw new Error(`на дошці немає списку ${READY_TO_RELEASE}`);
  const cards = objs(await t.call("GET", `/boards/${t.board}/cards?fields=idShort,idList`));
  return { ready, listOf: new Map(cards.map((c) => [Number(c.idShort), c.idList])) };
}

// The card number and repo of every task of the feature, from tasks.json on the be checkout's base; a task without a
// card of its own is worked under the feature's card, as task-brief does.
function featureTasks(deps: IntakeDeps, be: { cwd: string; base: string }, c: Chain): { card: number; repo: string }[] {
  const path = `origin/${be.base}:docs/features/${c.slug}/tasks/tasks.json`;
  const shown = deps.exec(["git", "-C", be.cwd, "show", path], be.cwd);
  let tasks: unknown;
  try {
    tasks = obj(JSON.parse(shown.stdout)).tasks;
  } catch {
    tasks = undefined;
  }
  if (shown.code !== 0 || !Array.isArray(tasks)) throw new Error(`${path} не прочитано`);
  const own = Number(c.card.slice("PILOT-".length));
  return objs(tasks).map((t) => ({
    card: typeof t.trello_card_id_short === "number" ? t.trello_card_id_short : own, repo: String(t.repo),
  }));
}

// The features whose every task's card is in Ready to Release. A card anywhere else, or not on the board, holds its
// feature back; so does a task of a repo the release does not ship.
async function readyFeatures(deps: IntakeDeps, chains: Chain[]): Promise<Feature[]> {
  const be = checkout(BE);
  if (typeof be === "string") throw new Error(be);
  const fetched = deps.exec(["git", "-C", be.cwd, "fetch", "-q", "origin", be.base], be.cwd);
  if (fetched.code !== 0) throw new Error(`git fetch origin ${be.base}: ${fetched.stderr.trim()}`);
  const t = trello(be.cwd);
  if (typeof t === "string") throw new Error(t);
  let board: Awaited<ReturnType<typeof readBoard>>;
  try {
    board = await readBoard(t);
  } catch (e) {
    throw new Error(t.scrub(message(e)));
  }
  const ready: Feature[] = [];
  for (const c of chains) {
    let tasks: { card: number; repo: string }[];
    try {
      tasks = featureTasks(deps, be, c);
    } catch (e) {
      console.error(`sdlc-autopilot: releases: ${c.card}: ${message(e)}`);
      continue;
    }
    const repos = ORDER.filter((r) => tasks.some((task) => task.repo === r));
    if (tasks.length === 0 || tasks.some((task) => !ORDER.includes(task.repo))) continue;
    if (tasks.every((task) => board.listOf.get(task.card) === board.ready)) {
      ready.push({ card: c.card, repos, tasks: tasks.map((task) => `PILOT-${task.card}`) });
    }
  }
  return ready;
}

const cardNumber = (card: string) => Number(card.slice("PILOT-".length));
const byNumber = (a: string, b: string) => cardNumber(a) - cardNumber(b);

function briefText(r: Release, s: ReleaseStep, rule: ReleaseRule): string {
  const repo = checkout(s.repo);
  if (typeof repo === "string") throw new Error(repo);
  return [
    `${s.card}: ${cardName(r, s.repo)}`,
    `Repo-dir: ${repo.cwd}`,
    `Base: ${repo.base}`,
    `Card: ${s.card}`,
    `Mirror: ${rule.mirrorOwner}/${s.repo}`,
    `Features: ${r.features.join(", ")}`,
    `Release: ${r.id}`,
    ...(s.version ? [`Version: ${s.version}`] : []),
    "",
  ].join("\n");
}

// The repo's release card in Ready to Release on the be board, then its brief. A brief that cannot be written leaves
// no step behind, so the next tick tries again.
async function queueStep(s: State, r: Release, repo: string, rule: ReleaseRule): Promise<number> {
  const be = checkout(BE);
  if (typeof be === "string") throw new Error(be);
  const t = trello(be.cwd);
  if (typeof t === "string") throw new Error(t);
  let card: Record<string, unknown>;
  try {
    const { ready } = await readBoard(t);
    card = obj(await t.call("POST", "/cards", { idList: ready, name: cardName(r, repo) }));
  } catch (e) {
    throw new Error(t.scrub(message(e)));
  }
  if (typeof card.id !== "string" || typeof card.idShort !== "number") throw new Error("Trello не повернув id картки релізу");
  const step: ReleaseStep = {
    repo, card: `PILOT-${card.idShort}`, cardId: card.id, attempt: 1, state: "queued", mirror: `${rule.mirrorOwner}/${repo}`,
  };
  queueBrief(repo, briefName(r, step), briefText(r, step, rule));
  r.steps.push(step);
  save(s);
  return ledger(r, `${runIdOf(r)}@${repo}@queued`, "release-queued", "none",
    `Реліз ${r.id} (${r.features.join(", ")}): ${repo} у черзі під карткою ${step.card}.`);
}

// Features ready while the release's first brief still waits in the queue join it: `prep` has not taken develop's
// changelog yet. A feature that would put a repo before that brief's waits for the next release.
async function fold(s: State, r: Release, ready: Feature[], rule: ReleaseRule): Promise<number> {
  const first = r.steps[0];
  const joining = ready.filter((f) => !first || ORDER.indexOf(f.repos[0]) >= ORDER.indexOf(first.repo));
  if (joining.length === 0) return 0;
  r.features = [...r.features, ...joining.map((f) => f.card)].sort(byNumber);
  r.tasks = [...new Set([...(r.tasks ?? []), ...joining.flatMap((f) => f.tasks)])].sort(byNumber);
  r.repos = ORDER.filter((repo) => r.repos.includes(repo) || joining.some((f) => f.repos.includes(repo)));
  save(s);
  if (!first) return 0;
  queueBrief(first.repo, briefName(r, first), briefText(r, first, rule));
  const be = checkout(BE);
  const t = typeof be === "string" ? be : trello(be.cwd);
  try {
    if (typeof t === "string") throw new Error(t);
    await t.call("PUT", `/cards/${encodeURIComponent(first.cardId)}`, { name: cardName(r, first.repo) });
  } catch (e) {
    console.error(`sdlc-autopilot: release ${r.id}: card ${first.card} not renamed: ${message(e)}`);
  }
  return ledger(r, `${runIdOf(r)}@${first.repo}@joined@${r.features.join(",")}`, "release-queued", "none",
    `Реліз ${r.id} тепер містить ${r.features.join(", ")}: бриф ${first.repo} переписано.`);
}

// New features join only the first brief, before its first launch: a rerun follows a prep PR already merged.
const joinable = (r: Release) =>
  r.steps.length === 0 ||
  (r.steps.length === 1 && r.steps[0].attempt === 1 &&
    existsSync(join(queueDir(), r.steps[0].repo, briefName(r, r.steps[0]))));

// The finished launch of the step's brief: its result, with the started file and result removed and its screenshots
// moved under the state dir; undefined while it runs or waits in the queue.
function takeResult(r: Release, s: ReleaseStep): Partial<ReleaseResult> | undefined {
  const dir = join(queueDir(), "started", s.repo);
  const name = existsSync(dir)
    ? readdirSync(dir).find((f) => f.startsWith("stage-") && f.endsWith(`--${briefName(r, s)}`))
    : undefined;
  if (!name || !existsSync(stageResult(join(dir, name)))) return undefined;
  const path = join(dir, name);
  let result: Partial<ReleaseResult>;
  try {
    result = JSON.parse(readFileSync(stageResult(path), "utf8")) as Partial<ReleaseResult>;
  } catch (e) {
    result = { exit: 1, error: `результат релізу не прочитано: ${message(e)}` };
  }
  if (Array.isArray(result.shots)) result.shots = keepShots(r, s, `${path}.shots`, result.shots);
  rmSync(`${path}.shots`, { recursive: true, force: true });
  rmSync(stageResult(path), { force: true });
  rmSync(path, { force: true });
  return result;
}

const shotsDir = (r: Release) => join(dirname(ledgerPath()), "release-shots", String(r.id));

// The started brief's screenshots go with the step's state, at their new paths; undefined when they could not move.
function keepShots(r: Release, s: ReleaseStep, from: string, shots: Shot[]): Shot[] | undefined {
  const to = join(shotsDir(r), s.repo);
  try {
    if (existsSync(from)) {
      mkdirSync(dirname(to), { recursive: true });
      rmSync(to, { recursive: true, force: true });
      renameSync(from, to);
    }
    return shots.map((shot) => ({ ...shot, path: join(to, basename(shot.path)) }));
  } catch (e) {
    console.error(`sdlc-autopilot: release ${r.id}: screenshots of ${s.repo} not kept: ${message(e)}`);
    return undefined;
  }
}

// Reads the open release's finished step: shipped or unchanged moves on to the next repo, fe waiting for be runs again,
// anything else ends the release with an escalation. A rollback, a red prod and a merged release-prep PR without its
// tag stop every automatic release: the next release would redeploy the rolled-back code or fail its prep.
async function settle(s: State, r: Release, rule: ReleaseRule): Promise<number> {
  const step = r.steps.at(-1);
  if (!step || step.state !== "queued") return 0;
  const result = takeResult(r, step);
  if (!result) return 0;
  const lines = Array.isArray(result.lines) ? result.lines.map(String) : [];
  const log = stageLog(step.repo, briefName(r, step));
  const shipped = lines.map((l) => l.match(SHIPPED)).find(Boolean);
  const event = `${runIdOf(r)}@${step.repo}@${step.attempt}`;
  const advance = async (outcome: string, text: string) => {
    const next = r.repos[r.steps.length];
    if (!next) r.state = "shipped";
    save(s);
    const written = ledger(r, `${event}@${outcome}`, outcome, "none", text);
    if (!next) return written + qaProdCard(r);
    return written + await queueStep(s, r, next, rule);
  };
  const end = (state: "failed" | "stopped", rule: string, why: string, shown: RegExp) => {
    r.state = state;
    save(s);
    const said = lines.filter((l) => shown.test(l)).join("; ") || result.error || `код ${result.exit}`;
    return ledger(r, `${event}@${rule}`, rule, "escalate",
      `Реліз ${r.id} (${r.features.join(", ")}) ${step.repo} під карткою ${step.card}: ${why} ${said}. Лог: ${log}. ` +
      `Ці фічі автоматично більше не релізяться — ${OPERATOR}`);
  };
  if (result.exit === 0 && shipped) {
    Object.assign(step, {
      state: "shipped", version: shipped[1], sha: shipped[2], previous: result.previous, irreversible: result.irreversible,
      url: result.url, shots: result.shots, shotsTotal: result.shotsTotal,
    });
    return advance("release-shipped", shipped[0]);
  }
  if (result.exit === 0 && lines.includes(UNCHANGED)) {
    step.state = "unchanged";
    return advance("release-unchanged",
      `Реліз ${r.id}: у ${step.repo} від останнього тегу немає нічого для релізу, крок пропущено.`);
  }
  if (result.exit === BE_WAIT && step.attempt < MAX_ATTEMPTS) {
    const again = { ...step, attempt: step.attempt + 1, version: result.version || undefined };
    queueBrief(step.repo, briefName(r, again), briefText(r, again, rule));
    Object.assign(step, { attempt: again.attempt, version: again.version });
    save(s);
    return 0;
  }
  if (result.exit === 3) {
    return end("stopped", "release-rolled-back", "prod червоний, відкочено на попередній тег:", /^(red|rolled back):/);
  }
  if (result.exit === 4) {
    return end("stopped", "release-no-rollback",
      "prod червоний, а реліз має незворотну міграцію, тож автовідкату не було; prod лишився на новому релізі:",
      /^(red|no auto-rollback):/);
  }
  if (result.exit === 5) {
    return end("stopped", "release-rollback-failed", "prod червоний, а відкат не підтвердився, стан prod невідомий:",
      /^(red|rolled back):/);
  }
  const merged = result.version || step.version;
  if (merged) {
    return end("stopped", "release-unfinished",
      `release-prep PR ${merged} уже злито, а bin/release ship v${merged} не завершився, тож наступний реліз ` +
      `${step.repo} не підготується, доки v${merged} не доведено вручну:`, /^\w[\w ]*:/);
  }
  if (result.exit === 0 || result.exit === 1 || result.exit === BE_WAIT) {
    return end("failed", "release-failed", "реліз не відбувся, prod не змінено:", /^\w[\w ]*:/);
  }
  return end("stopped", "release-failed", "реліз завершився невідомо як:", /^\w[\w ]*:/);
}

// Each tick: the open release's finished step is read, then any QA prod rollback's result, `done` `/task` chains whose every task card is in Ready to
// Release start a release or join the one not launched yet, and the next repo's step is queued once the one before
// it shipped or had nothing to release. Without the policy's `release` rule nothing happens. A failed git or Trello read is logged and tried
// again on the next tick.
export async function refreshReleases(deps: IntakeDeps, rule: ReleaseRule): Promise<number> {
  let written = 0;
  try {
    const s = readReleases();
    let open = s.releases.find((r) => r.state === "open");
    if (open) written += await settle(s, open, rule);
    written += settleRollbacks(s);
    // A QA prod reject rolls back to the tag before its release, which is right only while that release is the newest.
    if (s.releases.some((r) => r.state === "stopped" || awaitsQa(r))) return written;
    open = s.releases.find((r) => r.state === "open");
    if (!open || joinable(open)) {
      const released = new Set(s.releases.flatMap((r) => r.features));
      const candidates = Object.values(readChains().chains).filter((c) => c.state === "done" && !released.has(c.card));
      const ready = candidates.length > 0 ? await readyFeatures(deps, candidates) : [];
      if (ready.length > 0 && !open) {
        open = {
          id: Math.max(0, ...s.releases.map((r) => r.id)) + 1, state: "open", features: [], repos: [], steps: [],
          created: new Date((deps.now ?? Date.now)()).toISOString(),
        };
        s.releases.push(open);
      }
      if (open && ready.length > 0) written += await fold(s, open, ready, rule);
    }
    const next = open?.state === "open" && open.steps.every((st) => st.state !== "queued")
      ? open.repos[open.steps.length]
      : undefined;
    if (open && next) written += await queueStep(s, open, next, rule);
  } catch (e) {
    console.error(`sdlc-autopilot: releases: ${message(e)}`);
  }
  return written;
}

// The argv the queue launches a release brief with, only for the brief the open release waits for; any other file
// named like one, or any while releases.json is unreadable, stays a factory brief.
export function releaseArgv(t: QueuedTask, started: string): string[] | null {
  const [, id, attempt] = basename(t.briefFile).match(BRIEF) ?? [];
  if (!id) return null;
  let releases: Release[];
  try {
    releases = readReleases().releases;
  } catch (e) {
    console.error(`sdlc-autopilot: releases: ${message(e)}`);
    return null;
  }
  const r = releases.find((x) => x.state === "open" && x.id === Number(id));
  const step = r?.steps.at(-1);
  if (!step || step.state !== "queued" || step.attempt !== Number(attempt) || step.repo !== basename(dirname(t.briefFile))) {
    return null;
  }
  return ["bun", join(import.meta.dir, "release-run.ts"), started];
}

const shippedSteps = (r: Release) => r.steps.filter((st) => st.state === "shipped");
const short = (repo: string) => repo.replace(/^.*_/, "");
const awaitsQa = (r: Release) => r.state === "shipped" && !r.qa && shippedSteps(r).length > 0;
const qaEvent = (r: Release) => `${runIdOf(r)}@${QA_PROD}`;

function qaProdText(r: Release): string {
  return [
    ...shippedSteps(r).map((st) =>
      `Shipped: ${st.repo} v${st.version} ${st.sha} ${st.url ?? "—"} previous ${st.previous === undefined ? "?" : st.previous || "none"}`),
    `Features: ${r.features.join(", ")}`,
    `Release: ${r.id}`,
  ].join("\n");
}

// The escalation that sends the QA prod card, once the release shipped a repo.
function qaProdCard(r: Release): number {
  if (!awaitsQa(r) || alreadyActed(runIdOf(r), qaEvent(r))) return 0;
  appendLedger({
    ts: new Date().toISOString(), run_id: runIdOf(r), workflow: RELEASE_WORKFLOW, kind: QA_PROD, rule: QA_PROD,
    action: "escalate", evidence: {
      event_id: qaEvent(r), node: QA_PROD, text: qaProdText(r),
      message: `Реліз ${r.id} (${r.features.join(", ")}) на prod: перевір його — ${OPERATOR}`,
    },
  });
  return 1;
}

// A follow-up of the QA prod answer, under its own event: the card's pause is answered either way.
function qaProdEscalation(r: Release, rule: string, text: string): number {
  const event = `${qaEvent(r)}@${rule}`;
  if (alreadyActed(runIdOf(r), event)) return 0;
  appendLedger({
    ts: new Date().toISOString(), run_id: runIdOf(r), workflow: RELEASE_WORKFLOW, kind: QA_PROD, rule,
    action: "escalate", evidence: { event_id: event, message: text },
  });
  return 1;
}

// The QA prod cards: each shipped release the operator has not answered yet, as a paused view with no Archon run
// behind it, answered by `respondQaProd`. Read from releases.json on every call, so an answer takes the card away.
export function qaProdViews(): RunView[] {
  let releases: Release[];
  try {
    releases = readReleases().releases;
  } catch (e) {
    console.error(`sdlc-autopilot: releases: ${message(e)}`);
    return [];
  }
  return releases.filter(awaitsQa).map((r) => {
    const repo = checkout(shippedSteps(r).at(-1)?.repo ?? "");
    return {
      id: runIdOf(r), workflow: RELEASE_WORKFLOW, status: "paused", cwd: typeof repo === "string" ? "" : repo.cwd,
      message: `Release ${r.id}: ${r.features.join(", ")}`,
      pause: {
        eventId: qaEvent(r), node: QA_PROD, kind: QA_PROD, text: qaProdText(r), occurrence: runIdOf(r), iteration: 1,
        decisions: [{ id: "ok", label: "OK" }, { id: "reject", label: "Reject" }],
      },
    };
  });
}

// The prod screenshots of the release, for the card's album: the first MAX_SHOTS, only PNGs the supervisor itself
// keeps under release-shots/<id>/. null when none could be read: no step kept any, or every shot failed.
export function readReleaseShots(runId: string): { total: number; shots: Shot[] } | null {
  let r: Release | undefined;
  try {
    r = readReleases().releases.find((x) => runIdOf(x) === runId);
  } catch {
    return null;
  }
  const steps = r ? shippedSteps(r).filter((st) => Array.isArray(st.shots)) : [];
  const all = steps.flatMap((st) => st.shots ?? []);
  if (!r || steps.length === 0 || (all.length === 0 && steps.some((st) => (st.shotsTotal ?? 0) > 0))) return null;
  const shots = all.slice(0, MAX_SHOTS);
  const dir = shotsDir(r);
  return shots.every((shot) => typeof shot?.path === "string" && inside(shot.path, dir)) ? { total: all.length, shots } : null;
}

const jobPath = (r: Release) => join(dirname(ledgerPath()), "rollbacks", `release-${r.id}.json`);
const rollbackLog = (r: Release) => join(dirname(ledgerPath()), "logs", `rollback.release-${r.id}.log`);
const fixRepo = (r: Release) => (shippedSteps(r).some((st) => st.repo === FE) ? FE : BE);

function fixText(r: Release, text: string, rollback: string): string {
  const repo = fixRepo(r);
  const found = checkout(repo);
  return [
    `Fix for ${r.features[0]}: ${text}`,
    "",
    `The operator rejected release ${r.id} on prod (QA prod) with the text above. Build the fix in THIS repository ` +
    `${typeof found === "string" ? repo : found.repo}, one PR, squash.`,
    `Release: ${r.id}`,
    `Features: ${r.features.join(", ")}`,
    ...shippedSteps(r).map((st) => `Shipped: ${st.repo} v${st.version} ${st.sha} ${st.url ?? "—"} (release card ${st.card})`),
    `Rollback: ${rollback}`,
    `If the cause is in ${repo === FE ? BE : FE}, say so in the plan.`,
    "",
  ].join("\n");
}

// Why the release must not be rolled back on its own, "" when it may: a migration the previous tag's code cannot run
// on, or a repo whose previous tag is unknown or that had none.
function noRollback(r: Release): string {
  const steps = shippedSteps(r);
  const irreversible = steps.flatMap((st) => st.irreversible ?? []);
  if (irreversible.length > 0) {
    return `реліз додає незворотні міграції ${irreversible.join(", ")}, а код попереднього тегу на цій схемі не працює`;
  }
  const unknown = steps.filter((st) => st.previous === undefined).map((st) => st.repo);
  if (unknown.length > 0) return `bin/release не назвав попередній тег ${unknown.join(", ")}`;
  const first = steps.filter((st) => st.previous === "").map((st) => st.repo);
  return first.length > 0 ? `у ${first.join(", ")} це перший реліз, попереднього тегу немає` : "";
}

const targets = (r: Release) => shippedSteps(r).reverse().map((st) => `${short(st.repo)} → ${st.previous}`).join(", ");

// The rollback job for the shipped repos, fe before be so that fe never runs against an older be than it needs,
// launched at once: a queued brief could wait hours behind unrelated runs.
function rollBack(r: Release, deps: QaProdDeps): void {
  const why = noRollback(r);
  const features = `Реліз ${r.id} (${r.features.join(", ")})`;
  if (why) {
    r.rollback = { state: "refused", reason: why };
    qaProdEscalation(r, "qa-prod-no-rollback", `${features} відхилено на QA prod, але автовідкату не було: ${why}. ` +
      `Prod лишився на новому релізі, нічого не відкочено: виправ уперед або виріши відкат вручну — ${OPERATOR}`);
    return;
  }
  try {
    const job: RollbackJob = {
      release: r.id,
      steps: shippedSteps(r).reverse().map((st) => {
        const repo = checkout(st.repo);
        if (typeof repo === "string") throw new Error(repo);
        return { repo: st.repo, source: repo.cwd, base: repo.base, card: st.card, mirror: st.mirror ?? "", to: st.previous ?? "" };
      }),
    };
    const path = jobPath(r);
    mkdirSync(dirname(path), { recursive: true });
    rmSync(stageResult(path), { force: true });
    writeFileSync(path, `${JSON.stringify(job, null, 2)}\n`);
    deps.launch(["bun", join(import.meta.dir, "release-run.ts"), "rollback", path], dirname(path), rollbackLog(r));
    r.rollback = { state: "running" };
  } catch (e) {
    r.rollback = { state: "failed", reason: message(e) };
    qaProdEscalation(r, "qa-prod-rollback-failed", `${features} відхилено на QA prod, але відкат ${targets(r)} не ` +
      `запущено: ${message(e)}. Prod лишився на новому релізі — ${OPERATOR}`);
  }
}

function queueFix(r: Release, text: string): void {
  const why = noRollback(r);
  const name = `fix-release-${r.id}.md`;
  try {
    queueBrief(fixRepo(r), name, fixText(r, text, why ? `none — ${why}` : targets(r)));
    r.fix = `${fixRepo(r)}/${name}`;
  } catch (e) {
    qaProdEscalation(r, "qa-prod-fix", `Реліз ${r.id} відхилено на QA prod, але fix-задачу не поставлено в чергу: ` +
      `${message(e)}. Текст зауваження: ${text} — ${OPERATOR}`);
  }
}

// The operator's answer to a QA prod card, in place of `archon workflow respond`. ok records it; reject stops every
// automatic release (develop still holds the rejected code), queues one fix brief and rolls prod back, unless that is
// forbidden. Only the validation throws come before the first save, so only they leave the card answerable for the
// caller's re-escalation with buttons. A later throw (a ledger write in queueFix or rollBack) leaves the release
// stopped with qa=reject and the next releases held, the fix and rollback possibly not done: the operator acts by hand.
export function respondQaProd(run: RunView, d: Decision, deps: QaProdDeps): void {
  const s = readReleases();
  const r = s.releases.find((x) => runIdOf(x) === run.id);
  if (!r || !awaitsQa(r)) throw new Error(`реліз ${run.id} вже не чекає QA prod`);
  if (d.action !== "ok" && d.action !== "reject") throw new Error(`QA prod приймає лише ok або reject, не ${d.action}`);
  r.qa = d.action;
  if (d.action === "reject") {
    r.state = "stopped";
    save(s);
    queueFix(r, d.text);
    save(s);
    rollBack(r, deps);
  }
  save(s);
}

// Moves the cards to Done on the be board, where the release cards live; "" when done, otherwise what went wrong.
async function moveToDone(cards: string[]): Promise<string> {
  const be = checkout(BE);
  if (typeof be === "string") return be;
  const t = trello(be.cwd);
  if (typeof t === "string") return t;
  try {
    const done = objs(await t.call("GET", `/boards/${t.board}/lists?fields=name`)).find((l) => l.name === DONE)?.id;
    if (typeof done !== "string") return `на дошці немає списку ${DONE}`;
    const onBoard = objs(await t.call("GET", `/boards/${t.board}/cards?fields=id,idShort,idList`));
    const missing: string[] = [];
    for (const card of cards) {
      const found = onBoard.find((c) => c.idShort === cardNumber(card));
      if (!found) missing.push(card);
      else if (found.idList !== done) await t.call("PUT", `/cards/${encodeURIComponent(String(found.id))}`, { idList: done });
    }
    return missing.length > 0 ? `карток ${missing.join(", ")} немає на дошці` : "";
  } catch (e) {
    return t.scrub(message(e));
  }
}

// What the QA prod answer does besides answering, as the line the card's close note gains: ok moves every card of the
// release to Done; reject says how its rollback and fix brief went. A failure is an escalation of its own.
export async function afterQaProdAnswer(run: RunView, action: string): Promise<string> {
  let r: Release | undefined;
  try {
    r = readReleases().releases.find((x) => runIdOf(x) === run.id);
  } catch (e) {
    console.error(`sdlc-autopilot: releases: ${message(e)}`);
  }
  if (!r) return "";
  if (action === "ok") {
    const cards = [...new Set([...(r.tasks ?? []), ...r.features, ...r.steps.map((st) => st.card)])].sort(byNumber);
    const warning = await moveToDone(cards);
    if (!warning) return `🗂 Картки ${cards.join(", ")} перенесено в ${DONE}.`;
    qaProdEscalation(r, "qa-prod-trello", `Реліз ${r.id} прийнято на prod, але картки ${cards.join(", ")} не ` +
      `перенесено в ${DONE}: ${warning}. Перенеси їх вручну — ${OPERATOR}`);
    return `⚠️ Картки не перенесено в ${DONE} — надіслано окреме повідомлення.`;
  }
  if (action !== "reject") return "";
  const rollback = r.rollback?.state === "running"
    ? `⏪ Відкат prod запущено: ${targets(r)}.`
    : r.rollback?.state === "failed"
    ? "⚠️ Відкат prod не запущено — надіслано окреме повідомлення."
    : "⚠️ Автовідкату не буде — надіслано окреме повідомлення.";
  const fix = r.fix
    ? `📥 Fix-задачу поставлено в чергу: ${r.fix}`
    : "⚠️ Fix-задачу не поставлено в чергу — надіслано окреме повідомлення.";
  return `${rollback}\n${fix}`;
}

// A QA prod rollback that finished: verified, or not, and then prod's state is unknown. Either way a person acts next:
// the release stays stopped until the operator closes it. A result not there yet is a rollback still running.
function settleRollbacks(s: State): number {
  let written = 0;
  for (const r of s.releases) {
    const path = stageResult(jobPath(r));
    if (r.rollback?.state !== "running" || !existsSync(path)) continue;
    let result: Partial<RollbackResult>;
    try {
      result = JSON.parse(readFileSync(path, "utf8")) as Partial<RollbackResult>;
    } catch (e) {
      result = { exit: 1, error: `результат відкату не прочитано: ${message(e)}` };
    }
    const lines = Array.isArray(result.lines) ? result.lines.map(String) : [];
    const fix = r.fix ? `fix-задача ${r.fix} у черзі` : "fix-задачу не поставлено в чергу";
    const features = `Реліз ${r.id} (${r.features.join(", ")})`;
    r.rollback = { state: result.exit === 0 ? "done" : "failed" };
    save(s);
    written += result.exit === 0
      ? qaProdEscalation(r, "qa-prod-rolled-back", `${features} відхилено на QA prod і відкочено: ` +
        `${lines.filter((l) => l.startsWith("rolled back:")).join("; ")}; ${fix}. Автоматичні релізи стоять, доки ` +
        `реліз ${r.id} не закрито — ${OPERATOR}`)
      : qaProdEscalation(r, "qa-prod-rollback-failed", `${features} відхилено на QA prod, а відкат ${targets(r)} не ` +
        `підтвердився, стан prod невідомий: ${[...lines, result.error || `код ${result.exit}`].join("; ")}. Лог: ` +
        `${rollbackLog(r)}; ${fix} — ${OPERATOR}`);
  }
  return written;
}

export const realQaProdDeps: QaProdDeps = { launch: runDetached };
