import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { runDetached } from "./act.ts";
import { alreadyActed, appendLedger, ledgerPath } from "./ledger.ts";
import { archonHome, type PostMergeDeps } from "./postmerge.ts";
import { canStart, hostShortfall, readHost, slotFree } from "./resources.ts";
import { isForbiddenRepo, repoOf, type RunView } from "./runs.ts";

// `repo` is `<owner>/<repo>` and `cwd` its Archon `source` checkout; both are empty when the owner is not unique.
export type QueuedTask = { repo: string; cwd: string; briefFile: string; card: string };

export type QueueDeps = Pick<PostMergeDeps, "launch" | "host">;

const SDLC_REPO = "1_mvp_sdlc";
const STARTED = "started";
// A launched brief that no Archon run shows within this time stops holding a slot.
const UNSEEN_MS = 15 * 60_000;
// Appended to the factory message of a launched brief. Archon stores the message verbatim and never rewrites it, so the
// marker links the brief to exactly its own run, whatever other runs share the text.
const MARKER = "sdlc-autopilot-launch: ";
const LAUNCHED = /^launch-([0-9a-f-]{36})--(.+\.md)$/;

const URL = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;
// A relative slash path, or a bare file name with a letter-led extension; absolute, home and `$VAR` paths are skipped.
const PATH = /(?<![\w./~$-])((?:[\w.-]+\/)+[\w.-]*|[\w-][\w.-]+\.[A-Za-z]\w*)/g;

export function queueDir(): string {
  return process.env.SDLC_AUTOPILOT_QUEUE || join(homedir(), ".config", "sdlc-autopilot", "queue");
}

function workspaces(): string {
  return join(archonHome(), "workspaces");
}

function dirs(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
}

function resolveRepo(name: string): { repo: string; cwd: string } {
  const owners = dirs(workspaces()).filter((o) => existsSync(join(workspaces(), o, name, "source")));
  if (owners.length !== 1) return { repo: "", cwd: "" };
  return { repo: `${owners[0]}/${name}`, cwd: join(workspaces(), owners[0], name, "source") };
}

// Owner and repo names Archon knows, so `owner/repo` references in a brief are not taken for paths.
function knownNames(): Set<string> {
  const known = new Set<string>();
  for (const owner of dirs(workspaces())) {
    const repos = dirs(join(workspaces(), owner)).filter((r) => existsSync(join(workspaces(), owner, r, "source")));
    if (repos.length > 0) known.add(owner);
    for (const r of repos) known.add(r);
  }
  return known;
}

function task(briefFile: string): QueuedTask {
  return {
    ...resolveRepo(basename(dirname(briefFile))),
    briefFile,
    card: readFileSync(briefFile, "utf8").match(/PILOT-\d+/)?.[0] ?? "",
  };
}

// `1_mvp_sdlc` briefs first, then every brief oldest first.
export function nextTasks(): QueuedTask[] {
  const files = dirs(queueDir()).filter((d) => d !== STARTED).flatMap((d) =>
    readdirSync(join(queueDir(), d), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => ({ dir: d, path: join(queueDir(), d, e.name), mtime: statSync(join(queueDir(), d, e.name)).mtimeMs })));
  files.sort((a, b) =>
    Number(b.dir === SDLC_REPO) - Number(a.dir === SDLC_REPO) || a.mtime - b.mtime || a.path.localeCompare(b.path));
  return files.map((f) => task(f.path));
}

export function pathTokens(text: string, known: Set<string>): string[] {
  const tokens = new Set<string>();
  for (const [raw] of text.replace(URL, " ").matchAll(PATH)) {
    const segments = raw.replace(/\.+$/, "").replace(/^\.\//, "").split("/").filter(Boolean);
    if (segments.length === 0 || segments.some((s) => s === "." || s === "..")) continue;
    if (segments.length > 1 && (known.has(segments[0]) || known.has(segments[1]))) continue;
    tokens.add(segments.join("/"));
  }
  return [...tokens];
}

// A side that names no path may touch anything, so it overlaps everything.
export function pathsOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  return a.some((x) => b.some((y) => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));
}

function ledger(runId: string, eventId: string, rule: string, action: "launch-task" | "escalate", text: string): number {
  appendLedger({
    ts: new Date().toISOString(), run_id: runId, workflow: "factory", kind: "queue", rule, action,
    evidence: { event_id: eventId, text },
  });
  return 1;
}

// A launched brief waits in `started/<repo>/` as `launch-<launch-id>--<file>` until the factory run whose message
// carries its marker shows up in Archon; it is then renamed `<run-id>--<file>`. Until then it holds a slot as a pending
// run, for at most `UNSEEN_MS`.
export function inFlight(runs: RunView[], now = Date.now()): { views: RunView[]; written: number } {
  const views: RunView[] = [];
  let written = 0;
  const started = join(queueDir(), STARTED);
  for (const dir of dirs(started)) {
    for (const launchedName of readdirSync(join(started, dir))) {
      const [, launchId, name] = launchedName.match(LAUNCHED) ?? [];
      if (!launchId || !name) continue;
      const path = join(started, dir, launchedName);
      const run = runs.find((r) => r.workflow === "factory" && r.message.includes(`${MARKER}${launchId}`));
      if (run) {
        renameSync(path, join(started, dir, `${run.id}--${name}`));
        continue;
      }
      const runId = `queue:${dir}/${name}`;
      const mtime = Math.trunc(statSync(path).mtimeMs);
      if (now - mtime < UNSEEN_MS) {
        const text = readFileSync(path, "utf8").trim();
        views.push({ id: runId, workflow: "factory", status: "pending", cwd: resolveRepo(dir).cwd, message: text });
      } else if (!alreadyActed(runId, `${runId}@unseen@${mtime}`)) {
        written += ledger(runId, `${runId}@unseen@${mtime}`, "queue-launch-unseen", "escalate",
          `Бриф ${dir}/${name} запущено, але за 15 хв в Archon не зʼявився його прогін factory — перевірте лог запуску.`);
      }
    }
  }
  return { views, written };
}

// Starts queued briefs while `canStart` allows, pushing each onto `active` and `open`. A brief does not start while an
// `open` factory run of its repo, a paused one included, names an overlapping repo-relative path: the paused run
// edits the same files once it resumes.
export function startQueued(active: RunView[], open: RunView[], deps: QueueDeps): number {
  const known = knownNames();
  let written = 0;
  let deferred = 0;
  let hostDeferred = 0;
  let shortfall: string | null = null;
  for (const t of nextTasks()) {
    const dir = basename(dirname(t.briefFile));
    const file = basename(t.briefFile);
    const runId = `queue:${dir}/${file}`;
    const stat = statSync(t.briefFile);
    const eventId = `${runId}@${Math.trunc(stat.mtimeMs)}`;
    if (alreadyActed(runId, eventId)) continue;

    if (isForbiddenRepo(`x/${dir}`)) {
      written += ledger(runId, eventId, "queue-forbidden-repo", "escalate",
        `Бриф ${dir}/${file} не запущено: репозиторій ${dir} поза межами супервізора.`);
      continue;
    }
    if (!t.repo) {
      written += ledger(runId, eventId, "queue-unknown-repo", "escalate",
        `Бриф ${dir}/${file} не запущено: в Archon немає одного workspaces/*/${dir}/source.`);
      continue;
    }
    if (!t.card) {
      written += ledger(runId, eventId, "queue-no-card", "escalate",
        `Бриф ${dir}/${file} не запущено: у тексті немає картки PILOT-<n>.`);
      continue;
    }
    const text = readFileSync(t.briefFile, "utf8").trim();
    const paths = pathTokens(text, known);
    const blocked = open.some((r) =>
      r.workflow === "factory" && repoOf(r.cwd) === t.repo && pathsOverlap(paths, pathTokens(r.message, known)));
    const host = deps.host();
    if (blocked || !canStart(t.repo, active, host)) {
      const missed = !blocked && slotFree(t.repo, active) ? hostShortfall(host) : null;
      if (missed) {
        hostDeferred++;
        shortfall = missed;
      } else deferred++;
      continue;
    }

    const launchId = crypto.randomUUID();
    const startedFile = join(queueDir(), STARTED, dir, `launch-${launchId}--${file}`);
    mkdirSync(dirname(startedFile), { recursive: true });
    // Moved before the spawn, so a crash right after it can never launch the brief twice.
    renameSync(t.briefFile, startedFile);
    try {
      const message = `${text}\n\n${MARKER}${launchId}`;
      deps.launch(["archon", "workflow", "run", "factory", "--cwd", realpathSync(t.cwd), message], t.cwd,
        join(dirname(ledgerPath()), "logs", `factory-${dir}-${file.replace(/\.md$/, "")}.log`));
    } catch (e) {
      renameSync(startedFile, t.briefFile);
      utimesSync(t.briefFile, stat.atime, stat.mtime);
      written += ledger(runId, eventId, "queue-launch-failed", "escalate",
        `Бриф ${dir}/${file} не запущено: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const now = new Date();
    utimesSync(startedFile, now, now);
    written += ledger(runId, eventId, "queue-launch", "launch-task", `${t.card} ${dir}/${file}`);
    const view: RunView = { id: runId, workflow: "factory", status: "pending", cwd: t.cwd, message: text };
    active.push(view);
    open.push(view);
  }
  if (hostDeferred > 0) console.log(`sdlc-autopilot: ${hostDeferred} queued brief(s) wait for host resources: ${shortfall}`);
  if (deferred > 0) console.log(`sdlc-autopilot: ${deferred} queued brief(s) wait for run slots or overlapping runs`);
  return written;
}

export const realQueueDeps: QueueDeps = { launch: runDetached, host: readHost };
