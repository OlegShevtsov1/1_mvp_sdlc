import { readFileSync } from "node:fs";
import { join } from "node:path";
import { archonHome } from "./postmerge.ts";
import { repoOf } from "./runs.ts";

// The subcommands of scripts/release.sh; policy.yaml may narrow the list, never extend it.
export const RELEASE_SUBCOMMANDS = ["merge-release-pr", "tag", "mirror", "install", "verify"] as const;
export type ReleaseSubcommand = (typeof RELEASE_SUBCOMMANDS)[number];

export const isReleaseSubcommand = (s: unknown): s is ReleaseSubcommand =>
  RELEASE_SUBCOMMANDS.some((x) => x === s);

export type PostMergeStep = { n: string; title: string; text: string };

// post-merge's `steps.json` of a run in an Archon workspace, "" for a run outside `~/.archon/workspaces`.
export function stepsFile(runId: string, cwd: string): string {
  const repo = repoOf(cwd);
  return repo ? join(archonHome(), "workspaces", repo, "artifacts", "runs", runId, "steps.json") : "";
}

export function readStep(runId: string, cwd: string, n: string): PostMergeStep | undefined {
  const path = stepsFile(runId, cwd);
  if (!path) return undefined;
  try {
    const steps = (JSON.parse(readFileSync(path, "utf8")) as { steps?: unknown }).steps;
    if (!Array.isArray(steps)) return undefined;
    const step = steps.find((s: { n?: unknown } | null) => String(s?.n) === n) as Record<string, unknown> | undefined;
    if (typeof step?.title !== "string" || typeof step.text !== "string") return undefined;
    return { n, title: step.title, text: step.text };
  } catch {
    return undefined;
  }
}

export type StepMatch =
  | { ok: true; matched: { command: string; entry: string }[] }
  | { ok: false; reason: string };

class Unparsable extends Error {}

const fail = (reason: string): StepMatch => ({ ok: false, reason });

// The agent runs every sub-item of a step, so a step is judged only when nothing outside its one command block can
// instruct it: the bold title, blank lines, and from `Expected:` on its list items.
function commandBlock(text: string): string | undefined {
  const blocks: string[][] = [];
  let open: string[] | undefined;
  let expected = false;
  for (const line of text.split("\n")) {
    if (open) {
      if (/^```\s*$/.test(line)) open = undefined;
      else open.push(line);
    } else if (/^```(bash|sh|shell)?\s*$/.test(line) && !expected) {
      open = [];
      blocks.push(open);
    } else if (line.trim() === "") {
      continue;
    } else if (line.trim() === "Expected:") {
      expected = true;
    } else if (expected ? !/^(- |\s+\S)/.test(line) : !/^\*\*.+\*\*\s*$/.test(line)) {
      return undefined;
    }
  }
  return blocks.length === 1 && !open ? blocks[0].join("\n") : undefined;
}

// `name` is set when the whole word is one expansion, `$name`.
type Word = { text: string; expands: boolean; name?: string };

// The only redirections a line may carry; they discard output and cannot write a file.
const REDIRECTS = ["&>/dev/null", "2>/dev/null", ">/dev/null", "2>&1"];
const WORD_END = /[\s;&|]/;

// Splits one line into simple commands on `;`, `&&`, `||` and `|`, with quotes removed. Anything that would make the
// shell run or write more than these words say (substitution, a subshell, a glob, a redirection to a file, `$'…'`)
// throws Unparsable.
function simpleCommands(line: string): Word[][] {
  const commands: Word[][] = [[]];
  let word: Word | undefined;
  const add = (s: string, expands = false) => {
    word ??= { text: "", expands: false };
    if (s !== "") word.name = undefined;
    word.text += s;
    word.expands ||= expands;
  };
  const end = () => {
    if (word) commands.at(-1)?.push(word);
    word = undefined;
  };
  const dollar = (i: number): number => {
    const name = line.slice(i + 1).match(/^([A-Za-z_][A-Za-z0-9_]*|\?)/)?.[0];
    if (!name) throw new Unparsable("$ без імені змінної");
    const whole = (word?.text ?? "") === "";
    add(`$${name}`, true);
    if (whole && word) word.name = name;
    return i + name.length;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const redirect = word ? undefined : REDIRECTS.find((r) => line.startsWith(r, i));
    if (redirect && (i + redirect.length === line.length || WORD_END.test(line[i + redirect.length]))) {
      i += redirect.length - 1;
    } else if (/\s/.test(c)) {
      end();
    } else if (c === ";" || c === "|" || c === "&") {
      end();
      const double = line[i + 1] === c && c !== ";";
      if (c === "&" && !double) throw new Unparsable("&");
      if (double) i++;
      commands.push([]);
    } else if (c === "'") {
      const close = line.indexOf("'", i + 1);
      if (close < 0) throw new Unparsable("незакрита лапка");
      add(line.slice(i + 1, close));
      i = close;
    } else if (c === '"') {
      add("");
      for (i++; line[i] !== '"'; i++) {
        if (i >= line.length) throw new Unparsable("незакрита лапка");
        if (line[i] === "`") throw new Unparsable("`");
        if (line[i] === "\\" && '$`"\\'.includes(line[i + 1])) add(line[++i]);
        else if (line[i] === "$") i = dollar(i);
        else add(line[i]);
      }
    } else if (c === "\\") {
      if (i + 1 < line.length) add(line[++i]);
    } else if (c === "$") {
      if (line[i + 1] !== "?") throw new Unparsable("$ поза лапками");
      i = dollar(i);
    } else if ("`<>(){}*?[]#".includes(c)) {
      throw new Unparsable(c);
    } else {
      add(c);
    }
  }
  end();
  if (commands.some((c) => c.length === 0) && commands.length > 1) throw new Unparsable("порожня команда");
  return commands.filter((c) => c.length > 0);
}

const DENIED = new Set(["rm", "rmdir", "reset", "delete", "destroy", "--delete", "-f", "-rf", "-fr", "-Rf"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// An assignment to a name the shell or a tool reads (PATH, BASH_ENV, GIT_*, …) would change what the release line
// runs, so only short names nothing reads are plain assignments.
const LOCAL_NAME = /^([A-Z][A-Z0-9]{0,2}|[a-z][a-z0-9]{0,2})=/;
const READ_NAMES = new Set(["IFS", "ENV", "PWD", "TMP", "PS1", "PS2", "PS3", "PS4"]);
// These never write, whatever flags their words turn into.
const INERT = new Set(["echo", "test", "grep", "jq", "cat"]);
const SEMVER = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const GIT_READ = new Set(["fetch", "log", "rev-parse", "show", "diff", "status"]);
// git accepts any unambiguous prefix of a long option, so `--outp` is `--output`.
const GIT_WRITE_OPTIONS = ["output", "upload-pack", "exec"];

function gitReadOnly(args: string[]): boolean {
  if (!GIT_READ.has(args[0])) return false;
  return !args.some((a) => {
    const name = a.startsWith("--") ? a.slice(2).split("=")[0] : "";
    return name !== "" && GIT_WRITE_OPTIONS.some((o) => o.startsWith(name) || name.startsWith(o));
  });
}

// `gh api` is a GET unless a method or a field says otherwise; a short-flag cluster such as `-iXPOST` counts too.
function ghApiGet(args: string[]): boolean {
  return args.every((a, i) => {
    if (/^(-X|--method)$/.test(a)) return args[i + 1] === "GET";
    if (/^(-XGET|-X=GET|--method=GET)$/.test(a)) return true;
    if (/^--(method|field|raw-field|input)/.test(a)) return false;
    return !/^-[A-Za-z]*[XFf]/.test(a);
  });
}

function readOnly(argv: string[]): string | undefined {
  const [cmd, sub, ...rest] = argv;
  if (INERT.has(cmd)) return cmd;
  if (cmd === "gh" && sub === "pr" && ["view", "list", "checks"].includes(rest[0])) return `gh pr ${rest[0]}`;
  if (cmd === "gh" && sub === "api" && ghApiGet(rest)) return "gh api GET";
  if (cmd === "git" && sub !== undefined && gitReadOnly([sub, ...rest])) return `git ${sub}`;
  return undefined;
}

// A post-merge step is approved only when its command block, read-only commands, plain assignments and a `cd` to the
// run's own worktree aside, is exactly one `bash scripts/release.sh <subcommand> v<semver>` line: the release logic is
// then reviewed code, never free step text.
export function matchReleaseStep(text: string, opts: { cwd: string; subcommands: readonly string[] }): StepMatch {
  const block = commandBlock(text);
  if (block === undefined) return fail("крок не має форми «заголовок, один блок команд, Expected»");
  const commands: Word[][] = [];
  for (const line of block.replace(/\\\n/g, "").split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    try {
      commands.push(...simpleCommands(line));
    } catch (e) {
      if (e instanceof Unparsable) return fail(`не розібрано («${e.message}»): ${line.trim().slice(0, 200)}`);
      throw e;
    }
  }
  const matched: { command: string; entry: string }[] = [];
  let releases = 0;
  // An assignment's value is a literal that does not start with `-`, or `$?`; so a word that is only `$?` or `"$NAME"`
  // of a name this step assigned cannot become a flag. Any other expanding word (`"$A--output=x"`, `"-$X"`, `"$LESS"`)
  // could become any flag.
  const assigned = new Set(["?"]);
  const vetted = (w: Word) => !w.expands || (w.name !== undefined && assigned.has(w.name));
  for (const words of commands) {
    const argv = words.map((w) => w.text);
    const command = argv.join(" ");
    const denied = argv.find((a) => DENIED.has(a) || a.includes("--force"));
    if (denied !== undefined) return fail(`заборонено «${denied}»: ${command}`);
    let entry: string | undefined;
    if (argv.every((a) => ASSIGNMENT.test(a))) {
      const bad = words.find(({ text, expands }) => {
        const [name, value] = [text.slice(0, text.indexOf("=")), text.slice(text.indexOf("=") + 1)];
        return !LOCAL_NAME.test(text) || READ_NAMES.has(name) || value.startsWith("-") ||
          (expands && value !== "$?");
      });
      if (bad !== undefined) return fail(`присвоєння не дозволене: ${bad.text}`);
      for (const a of argv) assigned.add(a.split("=")[0]);
      entry = "assignment";
    } else if (argv.length === 2 && argv[0] === "cd" && argv[1] === opts.cwd) {
      entry = "cd run worktree";
    } else if (argv.length === 4 && argv[0] === "bash" && argv[1] === "scripts/release.sh") {
      if (opts.subcommands.includes(argv[2]) && SEMVER.test(argv[3])) {
        entry = `release.sh ${argv[2]}`;
        releases++;
      }
    } else if (!INERT.has(argv[0]) && !words.every(vetted)) {
      return fail(`слово зі змінною, яку крок не присвоїв, або з текстом при ній: ${command}`);
    } else {
      const name = readOnly(argv);
      if (name !== undefined) entry = `read-only ${name}`;
    }
    if (entry === undefined) return fail(`не в allowlist: ${command}`);
    matched.push({ command, entry });
  }
  if (releases !== 1) return fail(`рядків bash scripts/release.sh: ${releases}, потрібен рівно один`);
  return { ok: true, matched };
}
