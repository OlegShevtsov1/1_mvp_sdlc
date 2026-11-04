import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readEnvFile } from "./envfile.ts";
import { FE } from "./intake.ts";
import type { Shot } from "./qa.ts";
import { stageResult } from "./queue.ts";
import type { ReleaseResult } from "./release.ts";
import { type StageResult, stagesDir } from "./stage-run.ts";

// One release brief as release.ts writes it; `version` only on a rerun, whose first launch merged the prep PR.
export type ReleaseBrief = { source: string; base: string; card: string; mirror: string; version: string };

export type Run = { code: number; stdout: string; stderr: string };

export type RunnerDeps = {
  exec: (argv: string[], cwd: string, env: Record<string, string>, timeoutMs: number) => Run;
  sleep: (ms: number) => void;
};

const GIT_MS = 120_000;
const PREP_MS = 10 * 60_000;
const CHECKS_MS = 30 * 60_000;
const GH_MS = 60_000;
// The queue stops holding a slot for a launch after 4 h; prep, checks and ship together stay below that.
const SHIP_MS = 3 * 3_600_000;
const ROLLBACK_MS = 30 * 60_000;
const SHOT_MS = 60_000;
// The factory's qa-dev.ts viewports, so a page on prod is seen as it was on dev.
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 360, height: 800 }] as const;
const SHIPPED = /^shipped: v\d+\.\d+\.\d+ ([0-9a-f]{40})$/;
// A PR just opened reports no checks until CI registers them.
const NO_CHECKS_TRIES = 20;
const NO_CHECKS_MS = 30_000;
const PREP = /^prep: \S+ (\d+\.\d+\.\d+) #(\d+)$/m;
// scripts/next-version.sh of both templates: only chore, docs, ci, refactor and test since the previous tag.
export const NOTHING_TO_RELEASE = 3;
export const UNCHANGED = "unchanged: nothing to release since the last tag";

export function parseReleaseBrief(text: string): ReleaseBrief | null {
  const lines = text.split("\n");
  const field = (name: string) => lines.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2).trim() ?? "";
  const brief = {
    source: field("Repo-dir"), base: field("Base"), card: field("Card"), mirror: field("Mirror"), version: field("Version"),
  };
  return brief.source && brief.base && /^PILOT-\d+$/.test(brief.card) ? brief : null;
}

// A worktree of `source` at the fresh origin/<base>: `fresh` makes it again on each call and says why it could not, ""
// once it is there; `remove` takes it away if it is there.
function worktree(deps: RunnerDeps, source: string, base: string, wt: string) {
  const git = (...args: string[]) => deps.exec(["git", "-C", source, ...args], source, {}, GIT_MS).code;
  const remove = () => {
    if (existsSync(wt)) git("worktree", "remove", "--force", wt);
  };
  const fresh = (): string => {
    remove();
    if (git("fetch", "-q", "origin", base) !== 0) return `git fetch origin ${base} не вдався`;
    if (git("worktree", "add", "-q", "--detach", wt, `origin/${base}`) !== 0) return `git worktree add ${wt} не вдався`;
    return "";
  };
  return { fresh, remove };
}

// `bin/release ship` logs, on stderr only, the tag it ships over (`none` for a first release) and be's irreversible
// migrations since it; tests/release.test.ts holds both templates to these lines. Without the shipping line neither
// is known, and a QA prod reject then refuses to roll back.
const SHIPPING = /^release: shipping v\d+\.\d+\.\d+ = [0-9a-f]{40} \(\S+\), previous (v\d+\.\d+\.\d+|none), deploy repo \S+$/;
const IRREVERSIBLE = /^release: irreversible migrations since v\S+: (.+)$/;

function shipMeta(stderr: string): Pick<ReleaseResult, "previous" | "irreversible"> {
  const lines = stderr.split("\n").map((l) => l.trim());
  const previous = lines.map((l) => l.match(SHIPPING)?.[1]).find(Boolean);
  if (!previous) return {};
  const irreversible = lines.map((l) => l.match(IRREVERSIBLE)?.[1]).find(Boolean)?.split(" ").filter(Boolean) ?? [];
  return { previous: previous === "none" ? "" : previous, irreversible };
}

const slug = (url: string): string =>
  url.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "page";

// The `qa_dev.pages` of the checkout's profile whose glob matches a file changed since `previous` ("" for all of them),
// at their prod URL: the dev host `<x>.dev.<zone>` becomes `<x>.<zone>`; a page on any other host is skipped. Shot as
// the factory's qa-dev.ts shoots dev, whose code the installed supervisor cannot import. undefined when the profile,
// the zone, the changed files or Playwright cannot be read; a failed shot is left out.
function shootProd(
  deps: RunnerDeps, wt: string, source: string, previous: string | undefined, sha: string, dir: string,
): Pick<ReleaseResult, "shots" | "shotsTotal"> {
  let pages: unknown;
  try {
    const profile = Bun.YAML.parse(readFileSync(join(wt, ".archon", "factory-profile.yaml"), "utf8")) as
      { qa_dev?: { pages?: unknown } } | null;
    pages = profile?.qa_dev?.pages ?? [];
  } catch {
    return {};
  }
  const zone = projectZone(wt);
  const playwright = join(source, "node_modules", ".bin", "playwright");
  if (!Array.isArray(pages) || !zone || !existsSync(playwright)) return {};
  let files: string[] | undefined;
  if (previous) {
    const diff = deps.exec(["git", "-C", source, "diff", "--name-only", previous, sha], source, {}, GIT_MS);
    if (diff.code !== 0) return {};
    files = diff.stdout.split("\n").filter(Boolean);
  }
  const dev = `.dev.${zone}`;
  const urls = pages.flatMap((p: { glob?: unknown; url?: unknown }) => {
    if (typeof p?.glob !== "string" || typeof p.url !== "string") return [];
    let url: URL;
    try {
      url = new URL(p.url);
    } catch {
      return [];
    }
    const glob = new Bun.Glob(p.glob);
    if (!`.${url.hostname}`.endsWith(dev) || (files && !files.some((f) => glob.match(f)))) return [];
    url.hostname = `${url.hostname.slice(0, -dev.length)}.${zone}`.replace(/^\./, "");
    return [url.href];
  });
  mkdirSync(dir, { recursive: true });
  const shots: Shot[] = [];
  for (const [n, page] of urls.entries()) {
    for (const { width, height } of VIEWPORTS) {
      const path = join(dir, `${n + 1}-${slug(page)}-${width}.png`);
      const shot = deps.exec([playwright, "screenshot", "-b", "chromium", "--viewport-size", `${width}, ${height}`,
        "--wait-for-timeout", "2000", page, path], wt, {}, SHOT_MS);
      if (shot.code === 0 && existsSync(path)) shots.push({ page, width, path });
    }
  }
  return { shots, shotsTotal: urls.length * VIEWPORTS.length };
}

function projectZone(wt: string): string {
  try {
    return readEnvFile(join(wt, "config", "project.env"))?.PROJECT_ZONE ?? "";
  } catch {
    return "";
  }
}

// What bin/release's smoke checks on prod: be's /health, fe's app.
const prodUrl = (repo: string, zone: string) => (repo === FE ? `https://app.${zone}/` : `https://${zone}/health`);

// Releases the repo of the brief at `started` with its own `bin/release`, in a worktree of the Archon source checkout
// at the fresh base: a base with nothing to release since the last tag ends with UNCHANGED, otherwise prep opens the
// release-prep PR, its checks are watched, the PR is squash-merged at the head they ran on, then ship runs from a
// worktree at the merged base and a shipped release has its changed pages shot on prod. Nothing is merged or shipped
// after a red step. Always writes the result file and removes the worktree.
export function runRelease(started: string, deps: RunnerDeps): ReleaseResult {
  const lines: string[] = [];
  let version = "";
  let shipped: Partial<ReleaseResult> = {};
  const finish = (exit: number, error: string): ReleaseResult => {
    const result = { exit, finished_at: new Date().toISOString(), error, version, lines, ...shipped };
    const path = stageResult(started);
    writeFileSync(`${path}.tmp`, `${JSON.stringify(result)}\n`);
    renameSync(`${path}.tmp`, path);
    return result;
  };
  const wt = join(stagesDir(), `release-${basename(started, ".md")}`);
  let tree: ReturnType<typeof worktree> | undefined;
  try {
    const brief = parseReleaseBrief(readFileSync(started, "utf8"));
    if (!brief) return finish(2, "бриф релізу без Repo-dir, Base чи Card");
    tree = worktree(deps, brief.source, brief.base, wt);
    mkdirSync(stagesDir(), { recursive: true });
    const release = (args: string[], ms: number): Run => {
      const r = runBinRelease(deps, wt, brief, args, ms);
      lines.push(...stdoutLines(r));
      return r;
    };
    const gh = (ms: number, ...args: string[]) => deps.exec(["gh", ...args], wt, {}, ms);

    let failed = tree.fresh();
    if (failed) return finish(1, failed);
    version = brief.version;
    if (!version) {
      const next = deps.exec([join(wt, "scripts", "next-version.sh"), `origin/${brief.base}`], wt, {}, GIT_MS);
      if (next.code === NOTHING_TO_RELEASE) {
        lines.push(UNCHANGED);
        return finish(0, "");
      }
      const prep = release(["prep"], PREP_MS);
      const m = prep.stdout.match(PREP);
      if (prep.code !== 0 || !m) return finish(prep.code || 1, `bin/release prep завершився з кодом ${prep.code}`);
      failed = mergePrep(gh, deps.sleep, m[2]);
      if (failed) return finish(1, failed);
      version = m[1];
      failed = tree.fresh();
      if (failed) return finish(1, failed);
    }
    const ship = release(["ship", `v${version}`], SHIP_MS);
    if (ship.code !== 0) return finish(ship.code, `bin/release ship v${version} завершився з кодом ${ship.code}`);
    const sha = lines.map((l) => l.match(SHIPPED)?.[1]).find(Boolean);
    if (sha) {
      const meta = shipMeta(ship.stderr);
      const zone = projectZone(wt);
      shipped = {
        ...meta, ...(zone ? { url: prodUrl(basename(dirname(started)), zone) } : {}),
        ...shootProd(deps, wt, brief.source, meta.previous, sha, `${started}.shots`),
      };
    }
    return finish(0, "");
  } catch (e) {
    return finish(1, e instanceof Error ? e.message : String(e));
  } finally {
    tree?.remove();
  }
}

function runBinRelease(deps: RunnerDeps, wt: string, brief: Pick<ReleaseBrief, "card" | "mirror">, args: string[], ms: number): Run {
  const env = { RELEASE_CARD: brief.card, ...(brief.mirror ? { RELEASE_MIRROR_REPO: brief.mirror } : {}) };
  return deps.exec([join(wt, "bin", "release"), ...args], wt, env, ms);
}

const stdoutLines = (r: Run) => r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);

// One QA prod reject's rollback as release.ts writes it: the shipped repos, fe before be, each with the tag before
// the release.
export type RollbackJob = {
  release: number;
  steps: { repo: string; source: string; base: string; card: string; mirror: string; to: string }[];
};

export type RollbackResult = StageResult & { lines: string[] };

// Rolls each repo of the job back with its own `bin/release rollback <to>`, in a fresh worktree at its base, in the
// job's order, and stops at the first that does not verify: fe must never run against an older be than it needs.
// Always writes `<job>.result.json` and removes the worktrees.
export function runRollback(jobPath: string, deps: RunnerDeps): RollbackResult {
  const lines: string[] = [];
  const finish = (exit: number, error: string): RollbackResult => {
    const result = { exit, finished_at: new Date().toISOString(), error, lines };
    const path = stageResult(jobPath);
    writeFileSync(`${path}.tmp`, `${JSON.stringify(result)}\n`);
    renameSync(`${path}.tmp`, path);
    return result;
  };
  try {
    const job = JSON.parse(readFileSync(jobPath, "utf8")) as RollbackJob;
    mkdirSync(stagesDir(), { recursive: true });
    for (const step of job.steps) {
      const wt = join(stagesDir(), `release-rollback-${job.release}-${step.repo}`);
      const tree = worktree(deps, step.source, step.base, wt);
      try {
        const failed = tree.fresh();
        if (failed) return finish(1, `${step.repo}: ${failed}`);
        const r = runBinRelease(deps, wt, step, ["rollback", step.to], ROLLBACK_MS);
        lines.push(...stdoutLines(r));
        if (r.code !== 0) return finish(r.code, `${step.repo}: bin/release rollback ${step.to} завершився з кодом ${r.code}`);
      } finally {
        tree.remove();
      }
    }
    return finish(0, "");
  } catch (e) {
    return finish(1, e instanceof Error ? e.message : String(e));
  }
}

// "" once the release-prep PR is merged; otherwise why not. The squash subject is the PR title with its number,
// which `bin/release ship` requires of origin/<base>; GitHub's default for a one-commit PR is the commit's message.
function mergePrep(gh: (ms: number, ...args: string[]) => Run, sleep: (ms: number) => void, n: string): string {
  for (let tries = 1; ; tries++) {
    const checks = gh(CHECKS_MS, "pr", "checks", n, "--watch");
    if (checks.code === 0) break;
    if (!/no checks reported/.test(checks.stderr) || tries >= NO_CHECKS_TRIES) {
      return `checks release-prep PR #${n} не зелені (код ${checks.code}); нічого не злито`;
    }
    sleep(NO_CHECKS_MS);
  }
  const viewed = gh(GH_MS, "pr", "view", n, "--json", "state,headRefOid,title");
  let pr: { state?: unknown; headRefOid?: unknown; title?: unknown } = {};
  try {
    pr = JSON.parse(viewed.stdout) as typeof pr;
  } catch {
    // reported below
  }
  if (pr.state === "MERGED") return "";
  if (viewed.code !== 0 || pr.state !== "OPEN" || typeof pr.headRefOid !== "string" || typeof pr.title !== "string") {
    return `release-prep PR #${n} не прочитано або він не відкритий`;
  }
  const merged = gh(GH_MS, "pr", "merge", n, "--squash", "--match-head-commit", pr.headRefOid,
    "--subject", `${pr.title} (#${n})`);
  return merged.code === 0 ? "" : `gh pr merge #${n} завершився з кодом ${merged.code}`;
}

// stdout and stderr are kept for the result and passed on to the launch log the queue opened; a process killed by the
// timeout has no exit code.
const realExec: RunnerDeps["exec"] = (argv, cwd, env, timeoutMs) => {
  const r = Bun.spawnSync(argv, { cwd, env: { ...process.env, ...env }, stdin: "ignore", timeout: timeoutMs });
  const [stdout, stderr] = [r.stdout.toString(), r.stderr.toString()];
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  return { code: r.exitCode ?? 124, stdout, stderr };
};

if (import.meta.main) {
  const [mode, job] = process.argv.slice(2);
  const deps = { exec: realExec, sleep: Bun.sleepSync };
  if (mode === "rollback" && job) {
    const result = runRollback(job, deps);
    console.log(`sdlc-autopilot rollback: ${basename(job)} finished with ${result.exit} ${result.error}`.trimEnd());
  } else {
    const started = process.argv[2];
    if (!started || mode === "rollback") throw new Error("usage: release-run.ts <started release brief> | rollback <job>");
    const result = runRelease(started, deps);
    console.log(`sdlc-autopilot release: ${basename(started)} finished with ${result.exit} ${result.error}`.trimEnd());
  }
}
