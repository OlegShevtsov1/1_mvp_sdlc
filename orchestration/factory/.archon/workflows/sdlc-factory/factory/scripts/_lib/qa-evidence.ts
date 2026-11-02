import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonObject } from "./io.ts";
import { validateQaDev, type QaDevConfig, type QaDevPage } from "./profile.ts";

// The wait node's id: the supervisor reads its pause by this name (E3 Task 4).
export const WAIT_NODE = "qa-dev";

// Run artifacts of the QA dev evidence. until writes the answer files (PILOT-217: a resumed loop
// hands back the wrong node's output); `shots` is the directory of the screenshots.
export const FILES = {
  evidence: "qa-dev.json",
  decision: "qa-dev.decision",
  text: "qa-dev.text",
  log: "qa-dev.log",
  alerted: "qa-dev.alerted",
  shots: "qa-dev",
} as const;

export const E2E_WAIT_MS = 20 * 60_000;
export const E2E_POLL_MS = 30_000;
export const SHOT_TIMEOUT_MS = 60_000;
export const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 360, height: 800 }] as const;
// Dev moving once while the evidence is collected starts it again for the newer commit; a second move escalates.
const MAX_PASSES = 2;

export function parseQaDev(raw: string): QaDevConfig | null | { error: string } {
  if (raw === "") return null;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { error: "it is not JSON" };
  }
  const errors: string[] = [];
  const cfg = validateQaDev(doc, errors);
  if (cfg === undefined || errors.length > 0) return { error: errors.length > 0 ? errors.join("; ") : "it is not a mapping" };
  return cfg;
}

// Each page once, in the profile's order.
export function matchPages(pages: QaDevPage[], files: string[]): QaDevPage[] {
  return pages.filter((page) => {
    const glob = new Bun.Glob(page.glob);
    return files.some((file) => glob.match(file));
  });
}

export interface E2eRun {
  databaseId: number;
  status: string;
  conclusion: string;
  headSha: string;
  displayTitle: string;
  url: string;
  createdAt: string;
}

// A workflow_run-triggered run reports the default branch's head as headSha, so its title names the
// commit it tested (`sha-<40-hex>`, the run-name convention Dev Deploy uses).
export function runSha(run: Pick<E2eRun, "displayTitle" | "headSha">): string {
  return /\bsha-([0-9a-f]{40})\b/.exec(run.displayTitle)?.[1] ?? run.headSha.toLowerCase();
}

// The newest run of the merge commit or of a commit that contains it: on a linear base that is the
// commit on dev now, and an older task's run never wins over a newer one.
export function pinRun(runs: E2eRun[], mergeSha: string, contains: (sha: string) => boolean): E2eRun | null {
  const newestFirst = [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return newestFirst.find((run) => runSha(run).startsWith(mergeSha) || contains(runSha(run))) ?? null;
}

// The Actions run a deploy log names last (fe/be wait-dev-deploy prints the Dev Deploy run's URL).
export function deployRunUrl(log: string): string {
  return log.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+/g)?.at(-1) ?? "";
}

export interface Shot {
  page: string;
  width: number;
  path: string;
}

export interface Evidence {
  status: "off" | "ready" | "escalated";
  // English, for the report; ends with the link when there is one.
  reason: string;
  // Ukrainian, for the Telegram alert: what happened, in one sentence.
  cause: string;
  link: string;
  sha: string;
  url: string;
  e2e: { conclusion: string; run_url: string };
  shots: Shot[];
}

export interface QaDeps {
  gh(args: string[]): { ok: boolean; out: string; err: string };
  shoot(url: string, width: number, height: number, file: string): { ok: boolean; err: string };
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
}

export interface EvidenceInput {
  qaDev: string;
  prUrl: string;
  mergeSha: string;
  deployed: string;
  // The deploy log's text, where the deploy run's link is read from.
  deployLog: string;
  deployLogPath: string;
  healthy: string;
  lastStatus: string;
  healthUrl: string;
  rollback: string;
  artifactsDir: string;
}

class Escalation extends Error {
  constructor(readonly en: string, readonly uk: string, readonly link: string) {
    super(en);
  }
}

const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/[0-9]+$/;
// owner/repo of the pull request, never the remote (the rule visual-shots and pr-checks follow).
export function repoOfPr(prUrl: string): string {
  return PR_URL.exec(prUrl)?.[1] ?? "";
}

const short = (sha: string): string => sha.slice(0, 7);
const text = (v: unknown): string => (typeof v === "string" ? v : "");

function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

const slug = (url: string): string =>
  url.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "page";

function parseRuns(raw: string): E2eRun[] | null {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(doc)) return null;
  return doc.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return {
      databaseId: Number(o.databaseId) || 0, status: text(o.status), conclusion: text(o.conclusion),
      headSha: text(o.headSha), displayTitle: text(o.displayTitle), url: text(o.url), createdAt: text(o.createdAt),
    };
  });
}

const off = (reason: string): Evidence => ({
  status: "off", reason, cause: "", link: "", sha: "", url: "", e2e: { conclusion: "", run_url: "" }, shots: [],
});

// Waits for the e2e of the commit on dev, shoots the pages the pull request changed and writes
// qa-dev.json. Every state it cannot read is an escalation, and an escalation leaves no qa-dev.json,
// so an older pass's evidence can never stand for this one.
export async function collectEvidence(i: EvidenceInput, deps: QaDeps): Promise<Evidence> {
  const cfg = parseQaDev(i.qaDev);
  if (cfg === null) return off("no qa_dev in the profile");
  if (i.mergeSha === "") return off("nothing was merged");
  const evidencePath = join(i.artifactsDir, FILES.evidence);
  try {
    rmSync(evidencePath, { force: true });
    if ("error" in cfg) {
      throw new Escalation(
        `the qa_dev binding from load-profile is unreadable (${cfg.error})`,
        `профіль qa_dev не читається (${cfg.error})`, "",
      );
    }
    const doc = await evidence(cfg, i, deps);
    mkdirSync(i.artifactsDir, { recursive: true });
    writeFileSync(evidencePath, JSON.stringify({ sha: doc.sha, url: doc.url, e2e: doc.e2e, shots: doc.shots }, null, 2) + "\n");
    return doc;
  } catch (e) {
    const esc = e instanceof Escalation
      ? e
      : new Escalation(`unexpected: ${e instanceof Error ? e.message : String(e)}`, "збір доказів QA dev впав з помилкою", "");
    deps.log(`escalated: ${esc.en}${esc.link ? ` ${esc.link}` : ""}`);
    return {
      status: "escalated", reason: esc.link ? `${esc.en}: ${esc.link}` : esc.en, cause: esc.uk, link: esc.link,
      sha: "", url: "", e2e: { conclusion: "", run_url: "" }, shots: [],
    };
  }
}

async function evidence(cfg: QaDevConfig, i: EvidenceInput, deps: QaDeps): Promise<Evidence> {
  const deployLink = deployRunUrl(i.deployLog) || i.deployLogPath;
  if (i.deployed !== "true") {
    throw new Escalation(`the deploy to dev failed (deployed ${i.deployed})`, "деплой на dev впав", deployLink);
  }
  if (i.healthy !== "true") {
    throw new Escalation(
      `health is red after the deploy (last status ${i.lastStatus || "none"})`,
      `health червоний після деплою (останній статус ${i.lastStatus || "немає"})`, i.healthUrl,
    );
  }
  if (i.rollback === "true") {
    throw new Escalation("the deploy was rolled back", "деплой відкотили", deployLink);
  }
  const repo = repoOfPr(i.prUrl);
  if (repo === "") throw new Escalation(`the pull request URL '${i.prUrl}' is not a GitHub pull request`, "немає посилання на PR", "");
  const files = changedFiles(i.prUrl, deps);
  const pages = matchPages(cfg.pages, files);
  deps.log(`${files.length} changed files, pages to shoot: ${pages.map((p) => p.url).join(", ") || "none"}`);
  const url = origin(i.healthUrl);

  if (cfg.e2e_workflow === "") {
    return { ...ready(url), sha: i.mergeSha, e2e: { conclusion: "none", run_url: "" }, shots: shootAll(pages, i.mergeSha, i.artifactsDir, deps) };
  }
  const deadline = deps.now() + E2E_WAIT_MS;
  const pins = new E2ePins(repo, cfg.e2e_workflow, i.mergeSha, deps);
  let run = await pins.waitGreen(deadline);
  for (let pass = 1; ; pass++) {
    const sha = runSha(run);
    const shots = shootAll(pages, sha, i.artifactsDir, deps);
    const now = pins.pin();
    if (now === null || runSha(now) === sha) {
      return { ...ready(url), sha, e2e: { conclusion: run.conclusion, run_url: run.url }, shots };
    }
    if (pass >= MAX_PASSES) {
      throw new Escalation(
        `dev moved to ${short(runSha(now))} while QA evidence was collected`,
        `dev змінився на ${short(runSha(now))}, поки збирались докази QA`, now.url,
      );
    }
    deps.log(`dev moved from ${short(sha)} to ${short(runSha(now))}: collecting again`);
    run = await pins.waitGreen(deadline);
  }
}

const ready = (url: string): Omit<Evidence, "sha" | "e2e" | "shots"> => ({ status: "ready", reason: "", cause: "", link: "", url });

function changedFiles(prUrl: string, deps: QaDeps): string[] {
  const r = deps.gh(["pr", "view", prUrl, "--json", "files"]);
  const files = r.ok ? parseJsonObject(r.out)?.files : undefined;
  if (!Array.isArray(files)) {
    throw new Escalation(`the pull request's changed files could not be read (${r.err || "no files in gh's answer"})`, "не вдалося прочитати змінені файли PR", prUrl);
  }
  return files.map((f) => text((f as Record<string, unknown> | null)?.path));
}

function shootAll(pages: QaDevPage[], sha: string, artifactsDir: string, deps: QaDeps): Shot[] {
  const dir = join(artifactsDir, FILES.shots);
  mkdirSync(dir, { recursive: true });
  const shots: Shot[] = [];
  for (const [n, page] of pages.entries()) {
    for (const { width, height } of VIEWPORTS) {
      const path = join(dir, `${sha.slice(0, 12)}-${n + 1}-${slug(page.url)}-${width}.png`);
      const r = deps.shoot(page.url, width, height, path);
      if (!r.ok || !existsSync(path)) {
        throw new Escalation(
          `the screenshot of ${page.url} at ${width}x${height} failed: ${r.err || "no file written"}`,
          `скриншот ${page.url} (${width}×${height}) не вдався`, page.url,
        );
      }
      deps.log(`shot ${page.url} ${width}x${height} → ${path}`);
      shots.push({ page: page.url, width, path });
    }
  }
  return shots;
}

// The e2e runs of the commit on dev, read through gh. Compare answers are cached for the node's life.
class E2ePins {
  private readonly contained = new Map<string, boolean>();
  constructor(
    private readonly repo: string,
    private readonly workflow: string,
    private readonly mergeSha: string,
    private readonly deps: QaDeps,
  ) {}

  pin(): E2eRun | null {
    const r = this.deps.gh([
      "run", "list", "-R", this.repo, "-w", this.workflow, "-L", "100",
      "--json", "databaseId,status,conclusion,headSha,displayTitle,url,createdAt",
    ]);
    const runs = r.ok ? parseRuns(r.out) : null;
    if (runs === null) {
      throw new Escalation(`the runs of e2e "${this.workflow}" could not be read (${r.err || "unreadable answer"})`, `не вдалося прочитати прогони e2e "${this.workflow}"`, "");
    }
    return pinRun(runs, this.mergeSha, (sha) => this.contains(sha));
  }

  private contains(sha: string): boolean {
    const known = this.contained.get(sha);
    if (known !== undefined) return known;
    const r = this.deps.gh(["api", `repos/${this.repo}/compare/${this.mergeSha}...${sha}`, "--jq", ".status"]);
    // GitHub answers 404 for a commit it does not have; anything else unreadable is an unknown state.
    if (!r.ok && !/HTTP 404|Not Found/.test(r.err)) {
      throw new Escalation(`GitHub could not compare ${short(this.mergeSha)} with ${short(sha)} (${r.err})`, `GitHub не порівняв коміти ${short(this.mergeSha)} і ${short(sha)}`, "");
    }
    const yes = r.ok && (r.out === "ahead" || r.out === "identical");
    this.contained.set(sha, yes);
    return yes;
  }

  // The pinned run once it completed green; a newer containing run replaces it while waiting.
  async waitGreen(deadline: number): Promise<E2eRun> {
    let last: E2eRun | null = null;
    for (;;) {
      const run = this.pin();
      if (run !== null && run.status === "completed") {
        if (run.conclusion === "success") return run;
        throw new Escalation(
          `e2e "${this.workflow}" is red (${run.conclusion || "no conclusion"}) for ${short(runSha(run))}`,
          `e2e "${this.workflow}" червоний (${run.conclusion || "без висновку"}) для ${short(runSha(run))}`, run.url,
        );
      }
      last = run ?? last;
      if (this.deps.now() >= deadline) {
        throw new Escalation(
          last === null
            ? `no e2e "${this.workflow}" run for ${short(this.mergeSha)} within ${E2E_WAIT_MS / 60_000} min`
            : `e2e "${this.workflow}" for ${short(runSha(last))} did not finish within ${E2E_WAIT_MS / 60_000} min (${last.status})`,
          last === null
            ? `прогону e2e "${this.workflow}" для ${short(this.mergeSha)} немає за ${E2E_WAIT_MS / 60_000} хв`
            : `e2e "${this.workflow}" для ${short(runSha(last))} не завершився за ${E2E_WAIT_MS / 60_000} хв`,
          last?.url ?? "",
        );
      }
      this.deps.log(run === null ? `no e2e run for ${short(this.mergeSha)} yet` : `e2e ${run.url} is ${run.status}`);
      await this.deps.sleep(E2E_POLL_MS);
    }
  }
}

// The pause text. Its `Name: value` lines are the contract the supervisor's QA card parses (E3 Task 4).
export function qaMessage(e: Evidence, prUrl: string, evidencePath: string): string {
  return [
    "QA DEV — the work is on dev.",
    `URL: ${e.url}`,
    `SHA: ${e.sha}`,
    `PR: ${prUrl}`,
    `E2E: ${e.e2e.conclusion || "none"} ${e.e2e.run_url || "-"}`,
    `Shots: ${e.shots.length}`,
    `Evidence: ${evidencePath}`,
    "",
    "ok     → the work on dev is accepted",
    "reject → say what is wrong (free text); the supervisor queues a fix task, and this run ends",
  ].join("\n");
}

// The Telegram alert (PILOT-544 order). Plain text: notify-telegram.sh sends no parse_mode.
export function alertText(a: { repo: string; cause: string; link: string; prUrl: string; runId: string }): string {
  return [
    `🟡 Потрібне твоє рішення: QA dev, ${a.repo}`,
    `Що сталося: ${a.cause}.`,
    "Що рекомендую: відкрий прогін; поправ задачею або перезапусти фабрику. Картки QA не буде.",
    `Прогін: ${a.link || "-"}`,
    `Деталі: PR ${a.prUrl || "-"}, Archon run ${a.runId.slice(0, 8)}.`,
  ].join("\n");
}
