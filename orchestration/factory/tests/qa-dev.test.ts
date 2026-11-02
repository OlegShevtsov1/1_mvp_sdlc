import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  E2E_POLL_MS, E2E_WAIT_MS, FILES, alertText, collectEvidence, deployRunUrl, matchPages, qaMessage, runSha,
  type E2eRun, type EvidenceInput, type QaDeps,
} from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/qa-evidence.ts";

const SCRIPT = join(import.meta.dir, "..", ".archon", "workflows", "sdlc-factory", "factory", "scripts", "qa-dev.ts");
const PR_URL = "https://github.com/example/fe/pull/3";
const MERGE = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
const E = "e".repeat(40);
const MAIN = "f".repeat(40);
const DASHBOARD = "https://app.dev.example.com/dashboard";
const SETTINGS = "https://app.dev.example.com/settings";
const DEPLOY_RUN = "https://github.com/example/fe/actions/runs/111";
const qaDev = (e2e_workflow = "Dev Journey") => JSON.stringify({
  e2e_workflow,
  pages: [{ glob: "src/pages/dashboard/**", url: DASHBOARD }, { glob: "src/pages/settings/**", url: SETTINGS }],
});

const run = (sha: string, over: Partial<E2eRun> = {}): E2eRun => ({
  databaseId: Number.parseInt(sha.slice(0, 4), 16), status: "completed", conclusion: "success", headSha: MAIN,
  displayTitle: `Dev Journey sha-${sha}`, url: `https://github.com/example/fe/actions/runs/${sha.slice(0, 6)}`,
  createdAt: "2026-11-01T10:00:00Z", ...over,
});

function input(over: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    qaDev: qaDev(), prUrl: PR_URL, mergeSha: MERGE, deployed: "true",
    deployLog: `waiting for Dev Deploy sha-${MERGE}\n${DEPLOY_RUN}\n`, deployLogPath: "/run/deploy.log",
    healthy: "true", lastStatus: "200", healthUrl: "https://app.dev.example.com/health", rollback: "false",
    artifactsDir: mkdtempSync(join(tmpdir(), "qa-dev-art-")), ...over,
  };
}

// polls: the e2e run lists gh answers, one per `gh run list` (the last repeats).
function fake(o: { polls?: E2eRun[][]; compare?: Record<string, string>; files?: string[]; ghFails?: RegExp } = {}) {
  const calls = { gh: [] as string[][], shots: [] as { url: string; width: number; height: number; file: string }[], sleeps: 0 };
  let clock = 0, poll = 0;
  const deps: QaDeps = {
    gh(args) {
      calls.gh.push(args);
      if (o.ghFails?.test(args.join(" "))) return { ok: false, out: "", err: "HTTP 502" };
      if (args[0] === "pr") return { ok: true, out: JSON.stringify({ files: (o.files ?? ["src/pages/dashboard/a/b.tsx"]).map((path) => ({ path })) }), err: "" };
      if (args[0] === "run") {
        const polls = o.polls ?? [[run(MERGE)]];
        return { ok: true, out: JSON.stringify(polls[Math.min(poll++, polls.length - 1)]), err: "" };
      }
      const sha = args[1].split("...")[1];
      return { ok: true, out: o.compare?.[sha] ?? "behind", err: "" };
    },
    shoot(url, width, height, file) {
      calls.shots.push({ url, width, height, file });
      writeFileSync(file, "png");
      return { ok: true, err: "" };
    },
    sleep: async (ms) => { calls.sleeps++; clock += ms; },
    now: () => clock,
    log: () => {},
  };
  return { deps, calls };
}

const evidenceFile = (dir: string) => join(dir, FILES.evidence);
const readEvidence = (dir: string) => JSON.parse(readFileSync(evidenceFile(dir), "utf8"));

describe("qa-dev evidence", () => {
  test("failed deploy or red e2e sends no QA card", async () => {
    const cases: { over: Partial<EvidenceInput>; polls?: E2eRun[][]; link: string }[] = [
      { over: { deployed: "false" }, link: DEPLOY_RUN },
      { over: { deployed: "false", deployLog: "" }, link: "/run/deploy.log" },
      { over: { healthy: "false", lastStatus: "502" }, link: "https://app.dev.example.com/health" },
      { over: { rollback: "true" }, link: DEPLOY_RUN },
      { over: {}, polls: [[run(MERGE, { conclusion: "failure" })]], link: run(MERGE).url },
    ];
    for (const c of cases) {
      const i = input(c.over);
      writeFileSync(evidenceFile(i.artifactsDir), "{\"stale\":true}");
      const { deps, calls } = fake({ polls: c.polls });
      const e = await collectEvidence(i, deps);
      expect(e.status).toBe("escalated");
      expect(e.reason).toEndWith(`: ${c.link}`);
      expect(e.link).toBe(c.link);
      expect(existsSync(evidenceFile(i.artifactsDir))).toBe(false);
      expect(calls.shots).toEqual([]);
      const alert = alertText({ repo: "example/fe", cause: e.cause, link: e.link, prUrl: PR_URL, runId: "0123456789abcdef" });
      expect(alert).toContain(`Прогін: ${c.link}`);
      expect(alert).toContain("Картки QA не буде.");
    }
    const red = await collectEvidence(input(), fake({ polls: [[run(MERGE, { conclusion: "failure" })]] }).deps);
    expect(red.reason).toBe(`e2e "Dev Journey" is red (failure) for aaaaaaa: ${run(MERGE).url}`);
  });

  test("no e2e run within the deadline, or an unreadable GitHub answer, escalates", async () => {
    const none = fake({ polls: [[]] });
    const late = await collectEvidence(input(), none.deps);
    expect(late.status).toBe("escalated");
    expect(late.reason).toBe(`no e2e "Dev Journey" run for aaaaaaa within ${E2E_WAIT_MS / 60_000} min`);
    expect(none.calls.sleeps).toBe(E2E_WAIT_MS / E2E_POLL_MS);
    for (const ghFails of [/^run list/, /^pr view/, /^api /]) {
      const i = input();
      const { deps, calls } = fake({ ghFails, polls: [[run(B, { createdAt: "2026-11-01T11:00:00Z" }), run(MERGE)]] });
      const e = await collectEvidence(i, deps);
      expect(e.status).toBe("escalated");
      expect(existsSync(evidenceFile(i.artifactsDir))).toBe(false);
      expect(calls.shots).toEqual([]);
    }
  });

  test("qa evidence pins the deployed sha", async () => {
    const a = run(MERGE, { createdAt: "2026-11-01T10:00:00Z", displayTitle: "Dev Journey", headSha: MERGE });
    const b = run(B, { createdAt: "2026-11-01T10:05:00Z" });
    const c = run(C, { createdAt: "2026-11-01T10:09:00Z" });
    const compare = { [B]: "ahead", [C]: "diverged", [D]: "ahead", [E]: "ahead" };
    const i = input();
    const { deps, calls } = fake({ compare, polls: [[a, { ...b, status: "in_progress", conclusion: "" }, c], [a, b, c]] });
    const e = await collectEvidence(i, deps);
    expect(e.status).toBe("ready");
    expect(e.sha).toBe(B);
    expect(e.e2e).toEqual({ conclusion: "success", run_url: b.url });
    expect(calls.sleeps).toBe(1);
    expect(calls.shots.every((s) => s.file.includes(`/${B.slice(0, 12)}-`))).toBe(true);
    expect(readEvidence(i.artifactsDir).sha).toBe(B);
    // Each commit is compared once for the node's life.
    expect(calls.gh.filter((g) => g[0] === "api" && g[1].endsWith(`...${B}`))).toHaveLength(1);

    // Dev moves to D after B's shots: the second pass pins D, and D's shots replace B's.
    const d = run(D, { createdAt: "2026-11-01T10:20:00Z" });
    const moved = input();
    const second = fake({ compare, polls: [[a, b, c], [a, b, c, d]] });
    const m = await collectEvidence(moved, second.deps);
    expect(m.status).toBe("ready");
    expect(m.sha).toBe(D);
    const doc = readEvidence(moved.artifactsDir);
    expect(doc.sha).toBe(D);
    expect(doc.e2e.run_url).toBe(d.url);
    expect(doc.shots.map((s: { path: string }) => s.path).every((p: string) => p.includes(`/${D.slice(0, 12)}-`))).toBe(true);

    // A third commit while collecting escalates.
    const e3 = run(E, { createdAt: "2026-11-01T10:30:00Z" });
    const twice = input();
    const third = fake({ compare, polls: [[a, b], [a, b, d], [a, b, d], [a, b, d, e3]] });
    const t = await collectEvidence(twice, third.deps);
    expect(t.status).toBe("escalated");
    expect(t.reason).toBe(`dev moved to eeeeeee while QA evidence was collected: ${e3.url}`);
    expect(existsSync(evidenceFile(twice.artifactsDir))).toBe(false);
  });

  test("only pages matching changed files are shot", async () => {
    const i = input();
    const { deps, calls } = fake({ files: ["src/pages/dashboard/a/b.tsx", "README.md"] });
    const e = await collectEvidence(i, deps);
    expect(e.status).toBe("ready");
    expect(calls.shots.map(({ url, width, height }) => ({ url, width, height }))).toEqual([
      { url: DASHBOARD, width: 1440, height: 900 },
      { url: DASHBOARD, width: 360, height: 800 },
    ]);
    expect(readEvidence(i.artifactsDir)).toEqual({
      sha: MERGE, url: "https://app.dev.example.com", e2e: { conclusion: "success", run_url: run(MERGE).url },
      shots: [
        { page: DASHBOARD, width: 1440, path: calls.shots[0].file },
        { page: DASHBOARD, width: 360, path: calls.shots[1].file },
      ],
    });

    const none = input();
    const nothing = fake({ files: ["README.md"] });
    const n = await collectEvidence(none, nothing.deps);
    expect(n.status).toBe("ready");
    expect(nothing.calls.shots).toEqual([]);
    expect(readEvidence(none.artifactsDir).shots).toEqual([]);
  });

  test("two pages whose urls slug alike get their own shot files", async () => {
    const pages = [{ glob: "src/**", url: "https://app.dev.example.com/a-b" }, { glob: "src/**", url: "https://app.dev.example.com/a/b" }];
    const { deps, calls } = fake();
    const e = await collectEvidence(input({ qaDev: JSON.stringify({ e2e_workflow: "Dev Journey", pages }) }), deps);
    expect(e.status).toBe("ready");
    expect(new Set(calls.shots.map((s) => s.file)).size).toBe(4);
  });

  test("no qa_dev profile keeps today's flow", async () => {
    const throwing: QaDeps = {
      gh: () => { throw new Error("gh called"); },
      shoot: () => { throw new Error("shoot called"); },
      sleep: () => { throw new Error("sleep called"); },
      now: () => { throw new Error("now called"); },
      log: () => { throw new Error("log called"); },
    };
    for (const over of [{ qaDev: "" }, { mergeSha: "" }, { qaDev: "", deployed: "false" }]) {
      const i = input(over);
      const e = await collectEvidence(i, throwing);
      expect(e.status).toBe("off");
      expect(existsSync(evidenceFile(i.artifactsDir))).toBe(false);
    }
  });

  test("an unreadable qa_dev binding escalates instead of passing", async () => {
    const e = await collectEvidence(input({ qaDev: "$load-profile.output.qa_dev" }), fake().deps);
    expect(e.status).toBe("escalated");
    expect(e.reason).toContain("qa_dev binding");
  });

  test("a failed screenshot escalates with the page", async () => {
    const i = input();
    const { deps } = fake();
    deps.shoot = () => ({ ok: false, err: "node_modules/.bin/playwright is missing in the checkout (run npm ci)" });
    const e = await collectEvidence(i, deps);
    expect(e.status).toBe("escalated");
    expect(e.reason).toContain("run npm ci");
    expect(existsSync(evidenceFile(i.artifactsDir))).toBe(false);
  });

  test("without an e2e workflow the merge commit is shot and the e2e is none", async () => {
    const i = input({ qaDev: qaDev("") });
    const { deps, calls } = fake();
    const e = await collectEvidence(i, deps);
    expect(e.status).toBe("ready");
    expect(e.sha).toBe(MERGE);
    expect(e.e2e).toEqual({ conclusion: "none", run_url: "" });
    expect(calls.gh.some((g) => g[0] === "run")).toBe(false);
    expect(qaMessage(e, PR_URL, "/x/qa-dev.json")).toContain("\nE2E: none -\n");
  });
});

describe("qa-dev units", () => {
  test("runSha: the title's sha wins over headSha", () => {
    expect(runSha({ displayTitle: `Dev Journey sha-${B}`, headSha: MAIN })).toBe(B);
    expect(runSha({ displayTitle: "Dev Journey", headSha: MAIN.toUpperCase() })).toBe(MAIN);
  });

  test("matchPages keeps the profile's order and each page once", () => {
    const pages = [{ glob: "src/pages/dashboard/**", url: DASHBOARD }, { glob: "src/**/*.css", url: SETTINGS }];
    expect(matchPages(pages, ["src/a.css", "src/pages/dashboard/x.tsx", "src/pages/dashboard/y.tsx"])).toEqual(pages);
    expect(matchPages(pages, ["src/pages/x.tsx"])).toEqual([]);
  });

  test("deployRunUrl takes the last Actions run of the log", () => {
    expect(deployRunUrl(`${run(B).url}\nthen ${DEPLOY_RUN}/attempts/1`)).toBe(DEPLOY_RUN);
    expect(deployRunUrl("no link")).toBe("");
  });

  test("qaMessage carries the contract lines", () => {
    const e = {
      status: "ready" as const, reason: "", cause: "", link: "", sha: B, url: "https://app.dev.example.com",
      e2e: { conclusion: "success", run_url: run(B).url }, shots: [{ page: DASHBOARD, width: 1440, path: "/x/1.png" }],
    };
    const contract = qaMessage(e, PR_URL, "/x/qa-dev.json").split("\n").filter((l) => /^[A-Z][A-Za-z0-9]*: /.test(l));
    expect(contract).toEqual([
      "URL: https://app.dev.example.com",
      `SHA: ${B}`,
      `PR: ${PR_URL}`,
      `E2E: success ${run(B).url}`,
      "Shots: 1",
      "Evidence: /x/qa-dev.json",
    ]);
  });

  test("until saves the answer and ends the loop", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-dev-until-"));
    const p = Bun.spawnSync([process.execPath, SCRIPT, "until", dir, "reject", "the chart is empty"], { stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    expect(readFileSync(join(dir, FILES.decision), "utf8")).toBe("reject");
    expect(readFileSync(join(dir, FILES.text), "utf8")).toBe("the chart is empty");
    expect(readFileSync(join(dir, FILES.log), "utf8")).toContain("until: reject: the chart is empty");
  });

  test("evidence mode reads every factory.yaml binding: a failed deploy escalates and writes no qa-dev.json", () => {
    const yaml = Bun.YAML.parse(readFileSync(join(SCRIPT, "..", "..", "factory.yaml"), "utf8")) as {
      nodes: { id: string; with?: Record<string, unknown> }[];
    };
    const dir = mkdtempSync(join(tmpdir(), "qa-dev-evidence-"));
    const deployLog = join(dir, "deploy.log");
    writeFileSync(deployLog, `waiting for Dev Deploy sha-${MERGE}\n${DEPLOY_RUN}\n`);
    writeFileSync(join(dir, FILES.evidence), "{}");
    const values: Record<string, string> = {
      mode: "evidence", qa_dev: qaDev(), pr_url: PR_URL, merge_sha: MERGE, deployed: "false", deploy_log: deployLog,
      healthy: "skipped", last_status: "", health_url: "https://app.dev.example.com/health", rollback: "", secret_names: "",
    };
    const bindings = Object.keys(yaml.nodes.find((n) => n.id === "qa-dev-evidence")?.with ?? {});
    expect(bindings.toSorted()).toEqual(Object.keys(values).toSorted());
    const inputs = Object.fromEntries(Object.entries(values).map(([k, v]) => [`INPUTS_${k.toUpperCase()}`, v]));
    const p = Bun.spawnSync([process.execPath, SCRIPT], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...inputs, ARTIFACTS_DIR: dir } });
    expect(p.exitCode).toBe(0);
    const out = JSON.parse(p.stdout.toString());
    expect(out.status).toBe("escalated");
    expect(out.reason).toContain(DEPLOY_RUN);
    expect(out.alert).toBe("dry-run");
    expect(out.message).toBe("");
    expect(existsSync(join(dir, FILES.evidence))).toBe(false);
  });

  test("turn hands until_bash the bun and the script", () => {
    const p = Bun.spawnSync([process.execPath, SCRIPT], { stdout: "pipe", env: { ...process.env, INPUTS_MODE: "turn" } });
    expect(JSON.parse(p.stdout.toString())).toEqual({ script: SCRIPT, bun: process.execPath });
  });
});
