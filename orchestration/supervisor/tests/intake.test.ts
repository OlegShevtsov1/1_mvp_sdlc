import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Chain, type ExecResult, HINT, type IntakeDeps, readChains, realIntakeDeps, refreshChains, respondStage, stageArgv,
  stageBranch, stageNote, STAGES, stageViews, taskCommand, waitsForDeps,
} from "../src/intake.ts";
import type { LedgerEntry } from "../src/ledger.ts";
import type { RunView } from "../src/runs.ts";
import { claudeArgv, parseStageBrief, runStage } from "../src/stage-run.ts";
import { trello } from "../src/trello.ts";

const CARD_ID = "5f1e2d3c4b5a69788796a5b4";
const H = "1111111111111111111111111111111111111111";
const H2 = "2222222222222222222222222222222222222222";
const PR = "https://github.com/OlegShevtsov1/1_mvp_pilot_be/pull/77";
const MINUTE = 60_000;

let dir: string;
let ledger: string;
let queue: string;
let be: string;
let fe: string;
let plugins: { sdlc: string; mvp: string };
let server: ReturnType<typeof Bun.serve>;
let trelloCalls: { method: string; path: string; body: unknown }[];
let renameFails: boolean;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supervisor-intake-"));
  ledger = join(dir, "state", "ledger.jsonl");
  queue = join(dir, "queue");
  process.env.SDLC_AUTOPILOT_LEDGER = ledger;
  process.env.SDLC_AUTOPILOT_QUEUE = queue;
  process.env.ARCHON_HOME = join(dir, "archon");
  [be, fe] = ["1_mvp_pilot_be", "1_mvp_pilot_fe"].map((repo) => {
    const source = join(dir, "archon", "workspaces", "OlegShevtsov1", repo, "source");
    mkdirSync(join(source, ".archon"), { recursive: true });
    mkdirSync(join(source, ".claude"), { recursive: true });
    writeFileSync(join(source, ".archon", "factory-profile.yaml"), "repo:\n  base_branch: develop\n");
    writeFileSync(join(source, ".claude", "sdlc.local.md"), `local settings of ${repo}\n`);
    return source;
  });
  plugins = { sdlc: join(dir, "cache", "sdlc", "4.5.1"), mvp: join(dir, "cache", "mvp-sdlc", "0.9.5") };
  for (const p of Object.values(plugins)) mkdirSync(p, { recursive: true });
  const entries = (path: string) => [be, fe].map((s) => ({ projectPath: realpathSync(s), installPath: path }));
  writeFileSync(join(dir, "plugins.json"), JSON.stringify({
    plugins: { "sdlc@mvp": entries(plugins.sdlc), "mvp-sdlc@mvp": entries(plugins.mvp) },
  }));
  process.env.SDLC_AUTOPILOT_CLAUDE_PLUGINS = join(dir, "plugins.json");
  writeFileSync(join(dir, "trello.env"), "TRELLO_API_KEY=test-key\nTRELLO_TOKEN=test-token\nTRELLO_BOARD_ID=board-1\n");
  process.env.SDLC_AUTOPILOT_TRELLO_ENV = join(dir, "trello.env");
  trelloCalls = [];
  renameFails = false;
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? undefined : await req.json();
      trelloCalls.push({ method: req.method, path: url.pathname, body });
      if (url.pathname === "/1/boards/board-1/lists" || url.pathname === "/1/boards/board-be/lists") {
        return Response.json([{ id: "list-ready", name: "Ready" }, { id: "list-backlog", name: "Backlog" }]);
      }
      if (req.method === "POST" && url.pathname === "/1/cards") return Response.json({ id: CARD_ID, idShort: 901 });
      if (req.method === "PUT" && url.pathname === `/1/cards/${CARD_ID}`) {
        return renameFails ? new Response("busy", { status: 503 }) : Response.json({ id: CARD_ID });
      }
      return new Response("not found", { status: 404 });
    },
  });
  process.env.SDLC_AUTOPILOT_TRELLO_API = `${server.url.origin}/1`;
});

afterEach(() => {
  server.stop(true);
});

const lines = (): LedgerEntry[] =>
  existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const queued = (repo: string) => (existsSync(join(queue, repo)) ? readdirSync(join(queue, repo)).sort() : []);
const brief = (repo: string, name: string) => readFileSync(join(queue, repo, name), "utf8");
const chain = (): Chain => readChains().chains["PILOT-901"];

function setChain(c: Partial<Chain>): void {
  const full: Chain = {
    card: "PILOT-901", cardId: CARD_ID, slug: "t901", kind: "be", text: "Додати темну тему", stage: "prd", attempt: 1,
    state: "review", pr: PR, branch: "feature/PILOT-901-t901-prd", created: "2026-11-02T00:00:00.000Z", ...c,
  };
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(join(dir, "state", "stages.json"), JSON.stringify({ chains: { "PILOT-901": full } }));
}

// A launch of the chain's brief that finished with `exit`.
function finishedStage(name: string, exit: number, repo = "1_mvp_pilot_be"): string {
  const path = join(queue, "started", repo, `stage-00000000-0000-4000-8000-00000000000a--${name}`);
  mkdirSync(join(queue, "started", repo), { recursive: true });
  writeFileSync(path, "brief\n");
  writeFileSync(`${path}.result.json`, JSON.stringify({ exit, finished_at: "2026-11-02T00:00:00Z", error: exit ? "claude -p завершився з кодом 1" : "" }));
  return path;
}

type GitHub = {
  prs: { url: string; headRefName: string }[];
  state: string;
  head: string;
  labels: string[];
  checks: { name: string; bucket: string }[] | "none";
  tasks?: unknown;
  // task id → stderr of a refused task-brief
  refuse?: Record<string, string>;
  mergeFails?: boolean;
};

type Fake = IntakeDeps & { calls: { argv: string[]; cwd: string }[]; gh: GitHub; clock: number };

const ok = (stdout: unknown = ""): ExecResult => ({ code: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" });

function fake(gh: Partial<GitHub> = {}): Fake {
  const f: Fake = {
    calls: [], clock: Date.parse("2026-11-02T10:00:00Z"),
    gh: { prs: [{ url: PR, headRefName: "feature/PILOT-901-t901-prd" }], state: "OPEN", head: H, labels: [], checks: [{ name: "ci", bucket: "pass" }], ...gh },
    now: () => f.clock,
    exec: (argv, cwd) => {
      f.calls.push({ argv, cwd });
      const g = f.gh;
      const cmd = argv.slice(0, 3).join(" ");
      if (cmd === "gh pr list") return ok(g.prs);
      if (cmd === "gh pr view") {
        return ok({
          state: g.state, headRefOid: g.head, title: "PILOT-901: t901: Додати темну тему — prd", body: "Type: docs\n\nThe PRD of t901.",
          changedFiles: 2, additions: 40, deletions: 0, labels: g.labels.map((name) => ({ name })),
        });
      }
      if (cmd === "gh pr checks") {
        return g.checks === "none" ? { code: 1, stdout: "", stderr: "no checks reported on the 'x' branch" } : { code: 0, stdout: JSON.stringify(g.checks), stderr: "" };
      }
      if (cmd === "gh pr merge") return g.mergeFails ? { code: 1, stdout: "", stderr: "Pull request is not mergeable" } : ok();
      if (argv[0] === "git" && argv[3] === "show") return ok(g.tasks);
      if (argv[0] === "git" && argv[3] === "worktree" && argv[4] === "add") mkdirSync(argv[argv.length - 2], { recursive: true });
      if (argv[0].endsWith("/bin/task-brief")) {
        const id = argv[2];
        const refusal = g.refuse?.[id];
        return refusal ? { code: 1, stdout: "", stderr: refusal } : ok(`PILOT-9${id.slice(1)}: brief of ${id}\n`);
      }
      return ok();
    },
  };
  return f;
}

const run = (views: RunView[]) => views[0];

describe("/task intake", () => {
  test("task command creates a card and queues feature-start", async () => {
    const reply = await taskCommand("/task be Додати темну тему\nна сторінці налаштувань");

    expect(trelloCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /1/boards/board-1/lists", "POST /1/cards", `PUT /1/cards/${CARD_ID}`,
    ]);
    expect(trelloCalls[1].body).toEqual({
      idList: "list-backlog", name: "Додати темну тему", desc: "Додати темну тему\nна сторінці налаштувань",
    });
    expect(trelloCalls[2].body).toEqual({ name: "t901: Додати темну тему" });
    expect(reply).toContain("PILOT-901");
    expect(queued("1_mvp_pilot_be")).toEqual(["sdlc-stage.PILOT-901.feature-start.1.md"]);
    const text = brief("1_mvp_pilot_be", "sdlc-stage.PILOT-901.feature-start.1.md");
    expect(text.split("\n")[0]).toContain("PILOT-901");
    expect(text).toContain(`Command: /mvp-sdlc:feature-start ${CARD_ID}\n`);
    expect(text).toContain(`Repo-dir: ${be}\nBase: develop\n`);
    expect(text).toContain("Paths: docs/features/t901/\n");
    expect(text).not.toContain("Branch:");
    expect(text).toContain("Додати темну тему\nна сторінці налаштувань");
    expect(chain()).toMatchObject({ kind: "be", stage: "feature-start", attempt: 1, state: "queued", slug: "t901", cardId: CARD_ID });

    await taskCommand("/task fe Кнопка «Вийти»");
    expect(chain()).toMatchObject({ kind: "fe", stage: "feature-start" });
    expect(queued("1_mvp_pilot_fe")).toEqual([]);

    trelloCalls = [];
    const sdlc = await taskCommand("/task sdlc Нова перевірка в CI");
    expect(trelloCalls.map((c) => c.method)).toEqual(["GET", "POST", "PUT"]);
    expect(sdlc).toContain("Claude-сесія");
    expect(queued("1_mvp_sdlc")).toEqual([]);
  });

  test("a Trello failure creates nothing and says why, without the key", async () => {
    writeFileSync(join(dir, "trello.env"), "TRELLO_API_KEY=test-key\nTRELLO_TOKEN=test-token\nTRELLO_BOARD_ID=board-2\n");
    const reply = await taskCommand("/task be Додати темну тему");
    expect(reply).toStartWith("⚠️ Картку не створено: Trello GET /boards/board-2/lists: HTTP 404");
    expect(reply).not.toContain("test-key");
    expect(queued("1_mvp_pilot_be")).toEqual([]);
    expect(readChains().chains).toEqual({});
  });

  test("a card created but not renamed is reported as created, and nothing is queued", async () => {
    renameFails = true;
    const reply = await taskCommand("/task be Додати темну тему");
    expect(reply).toStartWith("⚠️ Картку PILOT-901 створено в Backlog, але не перейменовано на «t901: Додати темну тему»: ");
    expect(reply).toContain("не ставте її знову");
    expect(queued("1_mvp_pilot_be")).toEqual([]);
    expect(readChains().chains).toEqual({});
  });

  test("the card goes to the backend project's board, as feature-start resolves it", async () => {
    mkdirSync(join(be, "config"), { recursive: true });
    writeFileSync(join(be, "config", "project.env"), "PROJECT_NAME=pilot_be\n");
    writeFileSync(join(dir, "trello.env"), "TRELLO_API_KEY=k\nTRELLO_TOKEN=t\nTRELLO_BOARD_ID=board-2\nTRELLO_BOARD_ID_PILOT_BE=board-be\n");
    await taskCommand("/task be Додати темну тему");
    expect(trelloCalls[0].path).toBe("/1/boards/board-be/lists");
    expect(chain()).toMatchObject({ state: "queued", stage: "feature-start" });
  });

  test("an empty or malformed task gets the hint and creates nothing", async () => {
    for (const text of ["/task", "/task qa x", "/task be", "/task be   "]) expect(await taskCommand(text)).toBe(HINT);
    expect(trelloCalls).toEqual([]);
  });
});

describe("stage run", () => {
  test("the headless stage runs claude -p with the autopilot prompt in its own worktree", async () => {
    setChain({ stage: "prd", state: "review" });
    respondStage(prView(H), { action: "reject", rule: "operator", text: "додай метрики" }, fake());
    const [name] = queued("1_mvp_pilot_be");
    const started = join(queue, "started", "1_mvp_pilot_be", `stage-00000000-0000-4000-8000-00000000000b--${name}`);
    mkdirSync(join(queue, "started", "1_mvp_pilot_be"), { recursive: true });
    writeFileSync(started, brief("1_mvp_pilot_be", name));
    const calls: { argv: string[]; cwd: string }[] = [];
    const result = runStage(started, (argv, cwd) => {
      calls.push({ argv, cwd });
      if (argv[3] === "worktree" && argv[4] === "add") mkdirSync(argv[6], { recursive: true });
      return 0;
    });

    expect(result.exit).toBe(0);
    const wt = join(dir, "state", "stages", `stage-00000000-0000-4000-8000-00000000000b--${name.replace(/\.md$/, "")}`);
    const branch = "feature/PILOT-901-t901-prd";
    expect(calls.map((c) => c.argv.slice(0, 4).join(" "))).toEqual([
      `git -C ${be} fetch`, `git -C ${be} worktree`, "claude -p /sdlc:write-prd t901 --append-system-prompt", `git -C ${be} worktree`,
    ]);
    expect(calls[0].argv).toEqual(["git", "-C", be, "fetch", "-q", "origin", "develop", `refs/heads/${branch}:refs/heads/${branch}`]);
    expect(calls[1].argv).toEqual(["git", "-C", be, "worktree", "add", "-q", wt, branch]);
    const claude = calls[2];
    expect(claude.cwd).toBe(wt);
    const prompt = claude.argv[4];
    expect(prompt).toContain("Return comment: додай метрики");
    expect(prompt).toContain("Never call AskUserQuestion or ExitPlanMode");
    expect(prompt).toContain("## Open question / assumption");
    expect(prompt).toContain('stage-pr t901 prd --message "<commit message>"');
    expect(claude.argv.slice(5)).toEqual([
      "--permission-mode", "bypassPermissions", "--disallowed-tools", "AskUserQuestion,ExitPlanMode",
      "--plugin-dir", plugins.sdlc, "--plugin-dir", plugins.mvp, "--output-format", "json",
    ]);
    expect(calls[3].argv).toEqual(["git", "-C", be, "worktree", "remove", "--force", wt]);
    expect(readFileSync(join(wt, ".claude", "sdlc.local.md"), "utf8")).toBe("local settings of 1_mvp_pilot_be\n");
    expect(JSON.parse(readFileSync(`${started}.result.json`, "utf8"))).toMatchObject({ exit: 0, error: "" });

    const first = parseStageBrief(brief("1_mvp_pilot_be", name).replace(/^Branch: .*\n/m, "")) ?? undefined;
    expect(first?.branch).toBe("");
    expect(claudeArgv(first!, ["a"]).slice(0, 3)).toEqual(["claude", "-p", "/sdlc:write-prd t901"]);

    writeFileSync(join(dir, "plugins.json"), JSON.stringify({ plugins: { "sdlc@mvp": [] } }));
    const none: string[][] = [];
    const missing = runStage(started, (argv) => (none.push(argv), 0));
    expect(missing.exit).toBe(2);
    expect(missing.error).toContain("sdlc@mvp, mvp-sdlc@mvp");
    expect(none).toEqual([]);
  });

  test("a stage brief that cannot be read still gets its result file", () => {
    const started = join(dir, "gone.md");
    expect(runStage(started, () => 0)).toMatchObject({ exit: 1, error: expect.stringContaining("ENOENT") });
    expect(JSON.parse(readFileSync(`${started}.result.json`, "utf8"))).toMatchObject({ exit: 1 });
  });

  test("a first attempt starts detached from a fresh base", () => {
    setChain({ stage: "prd", state: "queued", pr: undefined, branch: undefined });
    const started = join(dir, "brief.md");
    writeFileSync(started, `PILOT-901: SDLC stage prd\nRepo-dir: ${be}\nBase: develop\nCommand: /sdlc:write-prd t901\n---\nprompt\n`);
    const calls: string[][] = [];
    runStage(started, (argv) => (calls.push(argv), 0));
    expect(calls[0]).toEqual(["git", "-C", be, "fetch", "-q", "origin", "develop"]);
    expect(calls[1]).toEqual(["git", "-C", be, "worktree", "add", "-q", "--detach", join(dir, "state", "stages", "brief"), "origin/develop"]);
  });
});

function prView(head: string): RunView {
  return {
    id: "stage:PILOT-901/prd", workflow: "sdlc-stage", status: "paused", cwd: be, message: "",
    pause: { eventId: `stage:PILOT-901/prd@${head}`, node: "pr-approve", kind: "pr-approve", text: "", occurrence: head, iteration: 1, decisions: [] },
  };
}

describe("stage chain", () => {
  test("a registered stage brief is launched as a stage, any other as a factory brief", () => {
    setChain({ stage: "prd", state: "queued", attempt: 1 });
    const t = (name: string) => ({ repo: "OlegShevtsov1/1_mvp_pilot_be", cwd: be, card: "PILOT-901", briefFile: join(queue, "1_mvp_pilot_be", name) });
    expect(stageArgv(t("sdlc-stage.PILOT-901.prd.1.md"), "/s")).toEqual(["bun", expect.stringMatching(/src\/stage-run\.ts$/), "/s"]);
    expect(stageArgv(t("sdlc-stage.PILOT-901.prd.2.md"), "/s")).toBeNull();
    expect(stageArgv(t("sdlc-stage.PILOT-901.architecture.1.md"), "/s")).toBeNull();
    expect(stageArgv(t("sdlc-stage.PILOT-902.prd.1.md"), "/s")).toBeNull();
    expect(stageArgv(t("PILOT-901.md"), "/s")).toBeNull();
  });

  test("a finished stage with an open PR waits for green CI, then becomes a pr-approve view", () => {
    setChain({ stage: "prd", state: "queued", pr: undefined, branch: undefined });
    const started = finishedStage("sdlc-stage.PILOT-901.prd.1.md", 0);
    const f = fake({ checks: [{ name: "ci", bucket: "pending" }] });

    expect(refreshChains(f).views).toEqual([]);
    expect(existsSync(started)).toBe(false);
    expect(existsSync(`${started}.result.json`)).toBe(false);
    expect(chain()).toMatchObject({ state: "review", pr: PR, branch: "feature/PILOT-901-t901-prd" });

    f.gh.checks = [{ name: "ci", bucket: "pass" }, { name: "docs", bucket: "pass" }, { name: "opt", bucket: "skipping" }];
    const view = run(refreshChains(f).views);
    expect(view).toMatchObject({
      id: "stage:PILOT-901/prd", workflow: "sdlc-stage", status: "paused", cwd: be,
      pause: { eventId: `stage:PILOT-901/prd@${H}`, kind: "pr-approve", occurrence: H, decisions: [{ id: "approve" }, { id: "reject" }] },
    });
    expect(view.message).toContain("PR title «PILOT-901: t901: Додати темну тему — prd»");
    expect(view.pause?.text).toBe([
      `PR: ${PR}`, `Head: ${H}`, "Diff: 2 files, +40 −0", "Checks: 2 pass", "Review: ready", "Summary: The PRD of t901.",
    ].join("\n"));

    f.gh.checks = [{ name: "ci", bucket: "fail" }];
    expect(refreshChains(f).views).toEqual([]);
    refreshChains(f);
    expect(lines()).toMatchObject([{ run_id: "stage:PILOT-901/prd", rule: "stage-ci-red", action: "escalate" }]);
    expect(lines()[0].evidence.message).toContain(PR);
  });

  test("a failed stage or one without a PR escalates and stops the chain", () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      setChain({ stage: "prd", state: "queued", pr: undefined });
      finishedStage("sdlc-stage.PILOT-901.prd.1.md", 1);
      refreshChains(fake());
      expect(chain().state).toBe("stopped");
      expect(lines()).toMatchObject([{ run_id: "stage:PILOT-901/prd", workflow: "sdlc-stage", kind: "stage", rule: "stage-failed" }]);
      expect(lines()[0].evidence.message).toContain("logs/stage.1_mvp_pilot_be.sdlc-stage.PILOT-901.prd.1.log");
      refreshChains(fake());
      expect(lines()).toHaveLength(1);

      setChain({ stage: "architecture", state: "queued", pr: undefined });
      finishedStage("sdlc-stage.PILOT-901.architecture.1.md", 0);
      refreshChains(fake({ prs: [{ url: PR, headRefName: "feature/PILOT-901-t901-prd" }] }));
      expect(chain().state).toBe("stopped");
      expect(lines()[1]).toMatchObject({ run_id: "stage:PILOT-901/architecture", rule: "stage-no-pr", action: "escalate" });

      setChain({ stage: "prd", state: "review", attempt: 2 });
      refreshChains(fake({ state: "CLOSED" }));
      expect(chain().state).toBe("stopped");
      expect(lines()[2]).toMatchObject({ rule: "stage-pr-closed" });
    } finally {
      error.mockRestore();
    }
  });

  test("approved stage PR queues the next stage", () => {
    setChain({ stage: "prd", state: "review" });
    const f = fake();
    respondStage(prView(H), { action: "approve", rule: "operator", text: "" }, f);
    const merges = f.calls.filter((c) => c.argv.slice(0, 3).join(" ") === "gh pr merge");
    expect(merges.map((c) => c.argv)).toEqual([["gh", "pr", "merge", PR, "--squash", "--match-head-commit", H]]);
    expect(queued("1_mvp_pilot_be")).toEqual(["sdlc-stage.PILOT-901.architecture.1.md"]);
    expect(brief("1_mvp_pilot_be", "sdlc-stage.PILOT-901.architecture.1.md")).toContain("Command: /sdlc:architecture-design t901\n");
    expect(chain()).toMatchObject({ stage: "architecture", attempt: 1, state: "queued" });
    expect(chain().pr).toBeUndefined();
    expect(stageNote("stage:PILOT-901/prd")).toBe("📥 Наступна стадія architecture у черзі 1_mvp_pilot_be.");

    // A commit pushed after the card: no merge, no next stage, and the next refresh shows the new head.
    setChain({ stage: "prd", state: "review" });
    const moved = fake({ head: H2 });
    expect(() => respondStage(prView(H), { action: "approve", rule: "operator", text: "" }, moved))
      .toThrow("PR змінився після картки (1111111 → 2222222): не злито, апрув потрібен знову");
    expect(moved.calls.some((c) => c.argv[2] === "merge")).toBe(false);
    expect(queued("1_mvp_pilot_be")).toEqual(["sdlc-stage.PILOT-901.architecture.1.md"]);
    expect(chain()).toMatchObject({ stage: "prd", state: "review" });
    expect(run(refreshChains(moved).views).pause?.eventId).toBe(`stage:PILOT-901/prd@${H2}`);
  });

  test("a merged stage whose next stage cannot be queued stops the chain", () => {
    rmSync(join(fe, ".archon", "factory-profile.yaml"));
    setChain({ kind: "fe", stage: "task-cards", state: "review" });
    const view = { ...prView(H), id: "stage:PILOT-901/task-cards" };
    respondStage(view, { action: "approve", rule: "operator", text: "" }, fake());
    expect(chain()).toMatchObject({ stage: "spec", state: "stopped" });
    expect(lines()).toMatchObject([{ run_id: "stage:PILOT-901/spec", rule: "stage-failed", action: "escalate" }]);
    expect(lines()[0].evidence.message).toContain("1_mvp_pilot_fe/.archon/factory-profile.yaml");
  });

  test("return with a comment reruns the stage on its PR branch", () => {
    setChain({ stage: "prd", state: "review" });
    respondStage(prView(H), { action: "reject", rule: "operator", text: "додай метрики успіху" }, fake());
    expect(chain()).toMatchObject({ stage: "prd", attempt: 2, state: "queued", feedback: "додай метрики успіху" });
    const text = brief("1_mvp_pilot_be", "sdlc-stage.PILOT-901.prd.2.md");
    expect(text).toContain("Branch: feature/PILOT-901-t901-prd\n");
    expect(text).toContain("Return comment: додай метрики успіху");
    expect(stageNote("stage:PILOT-901/prd")).toBe("🔁 Стадію prd перезапущено із зауваженням.");
    expect(() => respondStage(prView(H), { action: "reject", rule: "operator", text: "ще" }, fake())).toThrow("вже не чекає апруву");
  });

  test("last stage queues task briefs for every task", () => {
    const tasks = (t1: string) => ({
      slug: "t901",
      tasks: [
        { id: "T1", repo: "1_mvp_pilot_be", deps: [], status: t1 },
        { id: "T2", repo: "1_mvp_pilot_fe", deps: [], status: "todo" },
        { id: "T3", repo: "1_mvp_pilot_be", deps: ["T1"], status: "todo" },
        { id: "T4", repo: "1_mvp_pilot_be", deps: [], status: "done" },
      ],
    });
    setChain({ kind: "fe", stage: "spec", state: "review", branch: "feature/PILOT-901-t901-spec" });
    const f = fake({ tasks: tasks("todo"), refuse: { T3: "task-brief: task T3 depends on unfinished T1\n" } });
    const view = { ...prView(H), id: "stage:PILOT-901/spec", cwd: fe };
    view.pause = { ...view.pause!, eventId: `stage:PILOT-901/spec@${H}` };
    respondStage(view, { action: "approve", rule: "operator", text: "" }, f);

    expect(queued("1_mvp_pilot_be")).toEqual(["task-PILOT-901-T1.md"]);
    expect(queued("1_mvp_pilot_fe")).toEqual(["task-PILOT-901-T2.md"]);
    expect(brief("1_mvp_pilot_be", "task-PILOT-901-T1.md")).toBe("PILOT-91: brief of T1\n");
    const briefs = f.calls.filter((c) => c.argv[0].endsWith("/bin/task-brief"));
    expect(briefs.map((c) => c.argv.slice(1))).toEqual([["t901", "T1"], ["t901", "T3"], ["t901", "T2", "--from", be]]);
    expect(briefs[0].argv[0]).toBe(join(plugins.mvp, "bin", "task-brief"));
    expect(f.calls.find((c) => c.argv[3] === "show")?.argv).toEqual(["git", "-C", be, "show", "origin/develop:docs/features/t901/tasks/tasks.json"]);
    expect(chain()).toMatchObject({ state: "briefs", briefed: ["T1", "T2"], waiting: ["T3"] });
    expect(stageNote("stage:PILOT-901/spec")).toBe("📥 У черзі 2 задач, ще 1 чекають залежностей.");

    f.gh.tasks = tasks("done");
    f.gh.refuse = {};
    f.clock += 10 * MINUTE;
    refreshChains(f);
    expect(queued("1_mvp_pilot_be")).toEqual(["task-PILOT-901-T1.md"]);
    f.clock += 5 * MINUTE;
    refreshChains(f);
    expect(queued("1_mvp_pilot_be")).toEqual(["task-PILOT-901-T1.md", "task-PILOT-901-T3.md"]);
    expect(chain()).toMatchObject({ state: "done", waiting: [] });
    expect(lines()).toEqual([]);
  });

  test("operator-approved label or a PR merged by hand advances the chain", () => {
    setChain({ stage: "prd", state: "review" });
    const refused = fake({ labels: ["operator-approved"], mergeFails: true });
    refreshChains(refused);
    refreshChains(refused);
    expect(chain()).toMatchObject({ stage: "prd", state: "review" });
    expect(lines()).toMatchObject([{ run_id: "stage:PILOT-901/prd", rule: "stage-merge-failed", action: "escalate" }]);
    expect(lines()[0].evidence.message).toContain("Pull request is not mergeable");
    rmSync(ledger);

    const labelled = fake({ labels: ["operator-approved"] });
    expect(refreshChains(labelled).views).toEqual([]);
    expect(labelled.calls.find((c) => c.argv[2] === "merge")?.argv).toEqual(["gh", "pr", "merge", PR, "--squash", "--match-head-commit", H]);
    expect(chain()).toMatchObject({ stage: "architecture", state: "queued" });
    expect(lines()).toMatchObject([{ run_id: "stage:PILOT-901/prd", rule: "operator-approved", action: "approve" }]);

    setChain({ stage: "contracts", state: "review" });
    const merged = fake({ state: "MERGED" });
    expect(refreshChains(merged).views).toEqual([]);
    expect(merged.calls.some((c) => c.argv[2] === "merge")).toBe(false);
    expect(chain()).toMatchObject({ stage: "tasks", state: "queued" });
    expect(queued("1_mvp_pilot_be")).toContain("sdlc-stage.PILOT-901.tasks.1.md");
  });

  test("a stage card stays open while GitHub cannot be read or CI reruns", () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      setChain({ stage: "prd", state: "review" });
      const f = fake();
      const shown = run(refreshChains(f).views);
      expect(shown.pause?.eventId).toBe(`stage:PILOT-901/prd@${H}`);
      const exec = f.exec;
      f.exec = (argv, cwd) => (argv[2] === "view" ? { code: 1, stdout: "", stderr: "HTTP 502" } : exec(argv, cwd));
      expect(refreshChains(f).views).toEqual([shown]);
      f.exec = exec;
      f.gh.checks = [{ name: "ci", bucket: "pending" }];
      expect(refreshChains(f).views).toEqual([shown]);

      expect(() => respondStage(shown, { action: "approve", rule: "operator", text: "" }, f))
        .toThrow("CI docs PR зараз не зелений: не злито, апрув потрібен знову");
      expect(f.calls.some((c) => c.argv[2] === "merge")).toBe(false);
      expect(stageViews()).toEqual([shown]);
      expect(refreshChains(f).views).toEqual([shown]);

      f.exec = (argv, cwd) => (argv[2] === "view" ? { code: 1, stdout: "", stderr: "HTTP 502" } : exec(argv, cwd));
      expect(() => respondStage(shown, { action: "approve", rule: "operator", text: "" }, f)).toThrow("HTTP 502");
      expect(stageViews()).toEqual([shown]);
      f.exec = exec;
      f.gh.checks = [{ name: "ci", bucket: "pass" }];
      f.gh.mergeFails = true;
      expect(refreshChains(f).views).toEqual([shown]);
      expect(() => respondStage(shown, { action: "approve", rule: "operator", text: "" }, f)).toThrow("not mergeable");
      expect(stageViews()).toEqual([shown]);
      expect(chain()).toMatchObject({ stage: "prd", state: "review" });
      expect(lines()).toEqual([]);

      f.gh.mergeFails = false;
      respondStage(shown, { action: "approve", rule: "operator", text: "" }, f);
      expect(stageViews()).toEqual([]);
      expect(chain()).toMatchObject({ stage: "architecture", state: "queued" });
    } finally {
      error.mockRestore();
    }
  });

  test("a be chain ends with task-cards: its task briefs follow, no spec stage", () => {
    setChain({ kind: "be", stage: "task-cards", state: "review", branch: "feature/PILOT-901-t901-tasks-2" });
    const f = fake({ tasks: { slug: "t901", tasks: [{ id: "T1", repo: "1_mvp_pilot_be", deps: [], status: "todo" }] } });
    respondStage({ ...prView(H), id: "stage:PILOT-901/task-cards" }, { action: "approve", rule: "operator", text: "" }, f);
    expect(queued("1_mvp_pilot_fe")).toEqual([]);
    expect(queued("1_mvp_pilot_be")).toEqual(["task-PILOT-901-T1.md"]);
    expect(chain()).toMatchObject({ stage: "task-cards", state: "done", briefed: ["T1"] });
  });

  test("a chain stopped before its brief launched takes the brief out of the queue", () => {
    setChain({ stage: "prd", state: "review" });
    respondStage(prView(H), { action: "reject", rule: "operator", text: "ще" }, fake());
    expect(queued("1_mvp_pilot_be")).toEqual(["sdlc-stage.PILOT-901.prd.2.md"]);
    rmSync(join(be, ".archon", "factory-profile.yaml"));
    refreshChains(fake());
    expect(chain().state).toBe("stopped");
    expect(queued("1_mvp_pilot_be")).toEqual([]);
    expect(lines()).toMatchObject([{ run_id: "stage:PILOT-901/prd", rule: "stage-failed" }]);
  });
});

describe("mvp-sdlc plugin contracts", () => {
  const plugin = join(import.meta.dir, "..", "..", "..", "plugins", "mvp-sdlc");

  test("the stage map and the stage branches follow the plugin", () => {
    const rules = readFileSync(join(plugin, "templates", "claude", "rules", "git.md"), "utf8").replace(/\s+/g, " ");
    const opens = new Map([...rules.matchAll(/`(\/[\w:-]+)` → `([\w-]+)`/g)].map((m) => [m[1], m[2]]));
    const c = { cardId: CARD_ID, slug: "t901" } as Chain;
    for (const stage of STAGES) {
      const command = stage.command(c).split(" ")[0];
      const skill = command.match(/^\/mvp-sdlc:([\w-]+)$/)?.[1];
      if (skill) expect([command, existsSync(join(plugin, "skills", skill, "SKILL.md"))]).toEqual([command, true]);
      // feature-start hands over to /sdlc:interview, which opens the stage PR.
      const opener = stage.id === "feature-start" ? "/sdlc:interview" : command;
      expect([opener, opens.get(opener)]).toEqual([opener, stage.pr]);
    }

    const stagePr = readFileSync(join(plugin, "bin", "stage-pr"), "utf8");
    expect(stagePr).toContain('name = "feature/PILOT-{}-{}-{}".format(number, args.slug, args.stage)');
    const [, from, to] = (stagePr.match(/^SUFFIXES = range\((\d+), (\d+)\)$/m) ?? []).map(Number);
    expect(to).toBeGreaterThan(from);
    const name = "feature/PILOT-901-t901-tasks";
    const branch = stageBranch("PILOT-901", "t901", "tasks");
    expect(branch.test(name)).toBe(true);
    for (let k = from - 1; k <= to; k++) expect([k, branch.test(`${name}-${k}`)]).toEqual([k, k >= from && k < to]);
  });

  test("the card's board is the one feature-start resolves", () => {
    const env = join(dir, "trello.env");
    writeFileSync(env, "TRELLO_API_KEY=k\nTRELLO_TOKEN=t\nTRELLO_BOARD_ID=board-2\nTRELLO_BOARD_ID_PILOT_BE=board-be\n");
    const projects = [null, "PROJECT_NAME=pilot_be\n", "# PROJECT_NAME=other\n  PROJECT_NAME = 'pilot_be'  # be\n",
      "PROJECT_NAME=\"Pilot_Be\"\nPROJECT_NAME=other\n", "PROJECT_NAME=pilot_fe\n", "NAME=pilot_be\n"];
    const repos = projects.map((project, i) => {
      const repo = join(dir, `board-repo-${i}`);
      mkdirSync(join(repo, "config"), { recursive: true });
      if (project !== null) writeFileSync(join(repo, "config", "project.env"), project);
      return repo;
    });
    const resolve = [
      "import sys; sys.path.insert(0, sys.argv[1] + '/lib'); import sdlc_common",
      "fs = sdlc_common.load_script('bin/feature-start')",
      "for repo in sys.argv[3:]: print(fs.credentials(repo, {'TRELLO_ENV_FILE': sys.argv[2]})[2])",
    ].join("\n");
    const r = Bun.spawnSync(["python3", "-c", resolve, plugin, env, ...repos]);
    expect(r.stderr.toString()).toBe("");
    const theirs = r.stdout.toString().trim().split("\n");
    const ours = repos.map((repo) => {
      const t = trello(repo);
      return typeof t === "string" ? t : t.board;
    });
    expect(projects.map((p, i) => [p, ours[i]])).toEqual(projects.map((p, i) => [p, theirs[i]]));
    expect(new Set(theirs)).toEqual(new Set(["board-2", "board-be"]));
  });

  test("an unfinished dependency is told apart from task-brief's other refusals", () => {
    const repo = join(dir, "feature-repo");
    mkdirSync(join(repo, "docs", "features", "t901", "tasks"), { recursive: true });
    expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
    writeFileSync(join(repo, "docs", "features", "t901", "tasks", "tasks.json"), JSON.stringify({
      slug: "t901",
      tasks: [{ id: "T1", repo: "1_mvp_pilot_be", deps: [], status: "todo" }, { id: "T3", repo: "1_mvp_pilot_be", deps: ["T1"], status: "todo" }],
    }));
    const taskBrief = (id: string) => realIntakeDeps.exec([join(plugin, "bin", "task-brief"), "t901", id], repo);
    expect(waitsForDeps(taskBrief("T3"))).toBe(true);
    expect(waitsForDeps(taskBrief("T9"))).toBe(false);
  });
});
