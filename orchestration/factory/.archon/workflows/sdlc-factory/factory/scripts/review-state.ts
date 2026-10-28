import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FIRST_FOLLOW_UP_ROUND, parseFindings, REVIEW_MARKER, REVIEWED_COMMIT, roundOf, type ReviewState } from "./_lib/follow-up.ts";
import { emit, parseJsonObject } from "./_lib/io.ts";
import { PR_URL } from "./_lib/merge-decision.ts";
import { settledChecks } from "./_lib/pr-checks.ts";

// Binding (see factory.yaml `review-state` node): delivery (the whole deliver
// report). ARTIFACTS_DIR is engine-provided. Reads the facts review-followup
// decides on and judges nothing; always exits 0 with one line. Before round 3
// it reads nothing, so neither GitHub nor the follow-up judge is asked.
const delivery = parseJsonObject(process.env.INPUTS_DELIVERY ?? "") ?? {};
const artifactsDir = process.env.ARTIFACTS_DIR ?? ".";
// The bundled CI is still running on a head no CI agent judged; tests shorten both.
const POLL_MS = Number(process.env.REVIEW_STATE_POLL_MS || 30_000);
const WAIT_MS = Number(process.env.REVIEW_STATE_WAIT_MS || 20 * 60_000);

function readFindings(): ReviewState["findings"] | null {
  try {
    return parseFindings(JSON.parse(readFileSync(join(artifactsDir, "review", "findings.json"), "utf8")));
  } catch {
    return null;
  }
}

// The bundled review writes review/report-round-N.md each review round.
const REVIEW_ROUND = /^report-round-(\d+)\.md$/;

function reviewRound(): number {
  try {
    return Math.max(0, ...readdirSync(join(artifactsDir, "review")).map((n) => Number(REVIEW_ROUND.exec(n)?.[1] ?? 0)));
  } catch {
    return 0;
  }
}

// The canonical review comment, last one wins: its URL and the commit it judged.
function reviewComment(comments: unknown): { review_url: string; review_commit: string } {
  const last = (Array.isArray(comments) ? comments : [])
    .filter((c): c is { body: string; url?: unknown } => typeof c?.body === "string" && c.body.startsWith(REVIEW_MARKER))
    .at(-1);
  if (last === undefined) return { review_url: "", review_commit: "" };
  return {
    review_url: typeof last.url === "string" ? last.url : "",
    review_commit: REVIEWED_COMMIT.exec(last.body)?.[1] ?? "",
  };
}

async function read(): Promise<ReviewState> {
  const url = typeof delivery.pr_url === "string" ? delivery.pr_url : "";
  const round = roundOf(typeof delivery.summary === "string" ? delivery.summary : "") ?? 0;
  const unread: ReviewState = {
    pr_url: PR_URL.test(url) ? url : "", round, review_round: 0, read: false, head: "", is_draft: false, checks: [], checks_read: false,
    review_url: "", review_commit: "", findings_read: false, findings: [],
  };
  if (!PR_URL.test(url) || round < FIRST_FOLLOW_UP_ROUND) return unread;

  // The URL is the selector, so gh infers no repository from the checkout.
  const p = Bun.spawnSync(["gh", "pr", "view", url, "--json", "headRefOid,isDraft,comments"], { stdout: "pipe", stderr: "pipe" });
  const pr = p.exitCode === 0 ? parseJsonObject(p.stdout.toString()) : null;
  if (pr === null || typeof pr.headRefOid !== "string") return unread;

  const findings = readFindings();
  return {
    ...unread,
    read: true,
    head: pr.headRefOid,
    is_draft: pr.isDraft !== false,
    ...(await settledChecks(url, pr.headRefOid, { pollMs: POLL_MS, waitMs: WAIT_MS })),
    ...reviewComment(pr.comments),
    review_round: reviewRound(),
    findings_read: findings !== null,
    findings: findings ?? [],
  };
}

emit(await read());
