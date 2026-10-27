import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGate, roundVerdict } from "./gate.ts";
import { parseJsonObject } from "./io.ts";
import { cardLabel, parseCardRef } from "./trello.ts";

// The visual-cycle loop's until_bash ends on needs-revision once this many gate answers are
// saved, one below its max_iterations, so the cap ends typed instead of failing the loop.
export const ROUND_CAP = 4;

// Run artifacts of the visual gate. until_bash writes the three gate files (PILOT-217:
// a resumed loop hands back the wrong node's output); visual-shots writes the last two.
export const FILES = {
  decision: "visual-gate.decision",
  text: "visual-gate.text",
  decisions: "visual-gate.decisions",
  shots: "visual-shots.json",
  log: "visual.log",
} as const;

export const VARIANTS = ["desktop", "mobile", "light", "dark", "data", "empty"] as const;
const IMAGE = /\.(png|jpe?g|webp)$/i;
const OWNER_REPO = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([0-9]+)$/;

// task-brief prints `Layer: <layer>.` and every dod item as `- <item>`.
const UI_LAYER = /^\s*(?:[-*]\s+)?Layer:\s*ui\.?\s*$/im;
const REVIEW_ASKED = /^\s*(?:[-*]\s+)?Visual review:\s*(?:required|yes)\.?\s*$/im;
const REFERENCE = /^\s*(?:[-*]\s+)?Visual reference:[ \t]*(\S.*?)\s*$/im;

export interface VisualScope {
  visual: boolean;
  ready: boolean;
  reason: string;
  reference: string;
  card: string;
  screenshots_dir: string;
  brief: string;
}

export function visualBrief(reference: string, dir: string): string {
  return (
    `Visual review: this is a UI task, and after CI is green the operator reviews its screenshots before ` +
    `the merge. Build to the visual reference ${reference}. With the project's e2e tooling (Playwright ` +
    `where the project has it), shoot every screen this task changes in every variant: desktop and mobile ` +
    `viewports, light and dark themes, with data and empty (a screen with no empty state is shot with data ` +
    `only). Name each file <screen>-<desktop|mobile>-<light|dark>-<data|empty>.png and commit the files ` +
    `under ${dir}/; shoot again and commit again after any visual change. Embed every screenshot in the ` +
    `pull request description (the run's pr-body.md) as an image link ` +
    `https://github.com/<owner>/<repo>/blob/<commit>/${dir}/<file>?raw=true, where <commit> is the commit ` +
    `that last changed the screenshots.`
  );
}

export function visualScope(task: string, request: string): VisualScope {
  const text = `${task}\n${request}`;
  const ref = parseCardRef(task) ?? parseCardRef(request);
  const card = ref === null ? "no-card" : cardLabel(ref);
  const screenshots_dir = `docs/screenshots/${card}`;
  const visual = UI_LAYER.test(text) || REVIEW_ASKED.test(text);
  const reference = visual ? (REFERENCE.exec(text)?.[1] ?? "") : "";
  const ready = !visual || reference !== "";
  return {
    visual,
    ready,
    reason: ready
      ? ""
      : "the task is a UI task (Layer: ui, or Visual review: required) but names no visual reference; add a " +
        "`Visual reference: <URL or style>` line to its Definition of Done",
    reference,
    card,
    screenshots_dir,
    brief: visual && ready ? visualBrief(reference, screenshots_dir) : "",
  };
}

function prParts(delivery: Record<string, unknown>): { url: string; owner: string; repo: string; number: number } | null {
  const url = typeof delivery.pr_url === "string" ? delivery.pr_url : "";
  const m = OWNER_REPO.exec(url);
  return m ? { url, owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

export interface ShotsFacts {
  delivery: Record<string, unknown>;
  files: string[];
  body: string | null;
  dir: string;
  head: string;
}

export interface Shots {
  ready: boolean;
  pr_url: string;
  pr_number: number;
  head: string;
  files: string[];
  links: string;
  summary: string;
}

// Missing screenshots or a delivery that is not ready refuse an approve; a variant no file
// name shows and a description without the folder are only listed: the operator judges them.
export function shotsVerdict(f: ShotsFacts): Shots {
  const pr = prParts(f.delivery);
  const files = f.files.filter((path) => IMAGE.test(path));
  const blocking: string[] = [];
  if (f.delivery.ready !== true) {
    blocking.push(`the revision ended not ready (${String(f.delivery.reason ?? "no reason given")}): ${String(f.delivery.summary ?? "")}`.trimEnd());
  }
  if (pr === null) blocking.push("the delivery names no GitHub pull request URL");
  if (files.length === 0) blocking.push(`no screenshots under ${f.dir}/ at ${f.head}`);

  const names = files.map((path) => path.slice(path.lastIndexOf("/") + 1).toLowerCase());
  const missing = VARIANTS.filter((word) => !names.some((name) => name.includes(word)));
  const soft: string[] = [];
  if (files.length > 0 && missing.length > 0) soft.push(`no file name contains: ${missing.join(", ")}`);
  if (!(f.body ?? "").includes(`${f.dir}/`)) soft.push(`the PR body does not mention ${f.dir}/`);

  const ready = blocking.length === 0;
  const summary = ready
    ? soft.length === 0
      ? `${files.length} screenshots, every variant covered, embedded in the PR body`
      : `${files.length} screenshots; to judge: ${soft.join("; ")}`
    : [...blocking, ...soft].join("; ");
  return {
    ready,
    pr_url: pr?.url ?? "",
    pr_number: pr?.number ?? 0,
    head: f.head,
    files,
    links: pr === null ? "" : files.map((path) => `- https://github.com/${pr.owner}/${pr.repo}/blob/${f.head}/${path}?raw=true`).join("\n"),
    summary,
  };
}

export function readSaved(dir: string, name: string): string | null {
  const path = join(dir, name);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : null;
}

export interface Turn {
  round: number;
  revise: boolean;
  feedback: string;
  pr_number: number;
}

// The previous answer travels in files until_bash wrote: $LOOP_PREV in a `when:` does not
// parse on the first round, and a resumed loop's output is the wrong node's (PILOT-217).
export function visualTurn(artifactsDir: string, deliveryRaw: string): Turn {
  const answered = (readSaved(artifactsDir, FILES.decisions) ?? "").split("\n").filter((line) => line !== "").length;
  const revise = readSaved(artifactsDir, FILES.decision) === "needs-revision";
  return {
    round: answered + 1,
    revise,
    feedback: revise ? (readSaved(artifactsDir, FILES.text) ?? "") : "",
    pr_number: prParts(parseJsonObject(deliveryRaw) ?? {})?.number ?? 0,
  };
}

export interface VisualRoundInput {
  visual: string;
  // The visual-cycle loop's output; empty when the loop was skipped.
  gate: string;
  // The answer until_bash saved; null when it never ran.
  saved: { decision: string; text: string } | null;
  // visual-shots.json as written; null when it is missing.
  shots: string | null;
  delivery: string;
}

export interface VisualVerdict {
  proceed: boolean;
  decision: string;
  stop_reason: string;
  pr_url: string;
}

export function visualRound(i: VisualRoundInput): VisualVerdict {
  const delivery = parseJsonObject(i.delivery) ?? {};
  const pr_url = typeof delivery.pr_url === "string" ? delivery.pr_url : "";
  if (i.visual !== "true") return { proceed: true, decision: "none", stop_reason: "", pr_url };
  const answer = i.saved ?? parseGate(i.gate);
  const stop = (stop_reason: string): VisualVerdict => ({ proceed: false, decision: answer.decision, stop_reason, pr_url });
  if (answer.decision === "needs-revision") {
    return stop(`operator chose needs-revision after the last visual round (${ROUND_CAP}): ${answer.text}`.trimEnd());
  }
  const verdict = roundVerdict(JSON.stringify(answer));
  if (!verdict.proceed) return stop(verdict.stop_reason);
  const shots = i.shots === null ? null : parseJsonObject(i.shots);
  if (shots === null) return stop("approved, but the visual round was not ready: no visual-shots.json was written");
  if (shots.ready !== true) return stop(`approved, but the visual round was not ready: ${String(shots.summary ?? "")}`);
  return { ...verdict, pr_url };
}
