import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ledgerPath } from "./ledger.ts";
import { stageResult } from "./queue.ts";

// One SDLC stage brief as intake writes it: field lines, `---`, then the autopilot prompt.
export type StageBrief = { source: string; base: string; command: string; branch: string; prompt: string };

export type StageResult = { exit: number; finished_at: string; error: string };

export type Exec = (argv: string[], cwd: string, timeoutMs?: number) => number;

// Plugins installed with project scope are registered per checkout path; a new worktree's path has none of them.
const PLUGINS = ["sdlc@mvp", "mvp-sdlc@mvp"];
const CLAUDE_MS = 3 * 3_600_000;
const GIT_MS = 120_000;
const LOCAL_SETTINGS = join(".claude", "sdlc.local.md");

export function parseStageBrief(text: string): StageBrief | null {
  const cut = text.indexOf("\n---\n");
  if (cut < 0) return null;
  const head = text.slice(0, cut).split("\n");
  const field = (name: string) => head.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2).trim() ?? "";
  const brief = {
    source: field("Repo-dir"), base: field("Base"), command: field("Command"), branch: field("Branch"),
    prompt: text.slice(cut + 5).trim(),
  };
  return brief.source && brief.base && brief.command && brief.prompt ? brief : null;
}

export function pluginsFile(): string {
  return process.env.SDLC_AUTOPILOT_CLAUDE_PLUGINS || join(homedir(), ".claude", "plugins", "installed_plugins.json");
}

// The install paths of sdlc and mvp-sdlc as the checkout `source` has them, so the stage runs the operator's versions;
// otherwise what is missing.
export function pluginDirs(source: string): string[] | string {
  let doc: { plugins?: Record<string, { projectPath?: unknown; installPath?: unknown }[]> };
  let project: string;
  try {
    doc = JSON.parse(readFileSync(pluginsFile(), "utf8")) as typeof doc;
    project = realpathSync(source);
  } catch (e) {
    return `плагіни не прочитано: ${e instanceof Error ? e.message : String(e)}`;
  }
  const dirs = PLUGINS.map((name) => {
    const entries = Array.isArray(doc.plugins?.[name]) ? doc.plugins[name] : [];
    const path = entries.find((e) => e?.projectPath === project)?.installPath;
    return typeof path === "string" && existsSync(path) ? path : "";
  });
  const missing = PLUGINS.filter((_, i) => !dirs[i]);
  return missing.length > 0 ? `у ${pluginsFile()} немає ${missing.join(", ")} для ${project}` : dirs;
}

export function claudeArgv(brief: StageBrief, plugins: string[]): string[] {
  return [
    "claude", "-p", brief.command, "--append-system-prompt", brief.prompt, "--permission-mode", "bypassPermissions",
    "--disallowed-tools", "AskUserQuestion,ExitPlanMode", ...plugins.flatMap((p) => ["--plugin-dir", p]),
    "--output-format", "json",
  ];
}

export function copyLocalSettings(source: string, wt: string): void {
  if (!existsSync(join(source, LOCAL_SETTINGS))) return;
  mkdirSync(join(wt, ".claude"), { recursive: true });
  copyFileSync(join(source, LOCAL_SETTINGS), join(wt, LOCAL_SETTINGS));
}

export function stagesDir(): string {
  return join(dirname(ledgerPath()), "stages");
}

// Runs the stage of the brief at `started` in a worktree of its own, from a fresh base or, on a rerun, from the stage's
// branch, so `stage-pr` adds to the open PR. The operator's checkout is never touched beyond its object store and
// worktree list. Always writes the result file and removes the worktree.
export function runStage(started: string, exec: Exec): StageResult {
  const finish = (exit: number, error: string): StageResult => {
    const result = { exit, finished_at: new Date().toISOString(), error };
    const path = stageResult(started);
    writeFileSync(`${path}.tmp`, `${JSON.stringify(result)}\n`);
    renameSync(`${path}.tmp`, path);
    return result;
  };
  const wt = join(stagesDir(), basename(started, ".md"));
  let git: ((...args: string[]) => number) | undefined;
  try {
    const brief = parseStageBrief(readFileSync(started, "utf8"));
    if (!brief) return finish(2, "бриф стадії без Repo-dir, Base, Command чи тексту");
    const plugins = pluginDirs(brief.source);
    if (typeof plugins === "string") return finish(2, plugins);
    git = (...args: string[]) => exec(["git", "-C", brief.source, ...args], brief.source, GIT_MS);
    mkdirSync(stagesDir(), { recursive: true });
    const ref = brief.branch ? `refs/heads/${brief.branch}` : "";
    if (git("fetch", "-q", "origin", brief.base, ...(ref ? [`${ref}:${ref}`] : [])) !== 0) {
      return finish(1, `git fetch origin ${brief.base} ${brief.branch} не вдався`.trimEnd());
    }
    const added = brief.branch
      ? git("worktree", "add", "-q", wt, brief.branch)
      : git("worktree", "add", "-q", "--detach", wt, `origin/${brief.base}`);
    if (added !== 0) return finish(1, `git worktree add ${wt} не вдався`);
    copyLocalSettings(brief.source, wt);
    const exit = exec(claudeArgv(brief, plugins), wt, CLAUDE_MS);
    return finish(exit, exit === 0 ? "" : `claude -p завершився з кодом ${exit}`);
  } catch (e) {
    return finish(1, e instanceof Error ? e.message : String(e));
  } finally {
    if (git && existsSync(wt)) git("worktree", "remove", "--force", wt);
  }
}

// Output goes to the launch log the queue opened; a process killed by the timeout has no exit code.
const realExec: Exec = (argv, cwd, timeoutMs) =>
  Bun.spawnSync(argv, { cwd, env: process.env, stdin: "ignore", stdout: "inherit", stderr: "inherit", timeout: timeoutMs })
    .exitCode ?? 124;

if (import.meta.main) {
  const started = process.argv[2];
  if (!started) throw new Error("usage: stage-run.ts <started stage brief>");
  const result = runStage(started, realExec);
  console.log(`sdlc-autopilot stage: ${basename(started)} finished with ${result.exit} ${result.error}`.trimEnd());
}
