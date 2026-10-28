import { emit, parseJsonObject } from "./_lib/io.ts";
import { type CiCheck, PR_URL } from "./_lib/merge-decision.ts";
import { settledChecks } from "./_lib/pr-checks.ts";

// Binding (see factory.yaml `pr-state` node): delivery (the whole deliver
// report). Reports facts only, merge-gate decides; always exits 0 with one line.
const delivery = parseJsonObject(process.env.INPUTS_DELIVERY ?? "") ?? {};
// A body edit just before this node restarts the head's CI; tests shorten both.
const POLL_MS = Number(process.env.PR_STATE_POLL_MS || 30_000);
const WAIT_MS = Number(process.env.PR_STATE_WAIT_MS || 20 * 60_000);

interface PrState {
  pr_url: string;
  read: boolean;
  head: string;
  base: string;
  state: string;
  mergeable: string;
  is_draft: boolean;
  checkout_is_head: boolean;
  checkout_clean: boolean;
  checks: CiCheck[];
  checks_read: boolean;
}

function capture(argv: string[]): { ok: boolean; out: string } {
  const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim() };
}

async function read(): Promise<PrState> {
  // archon-deliver-block's report carries the URL as pr_url.
  const url = typeof delivery.pr_url === "string" ? delivery.pr_url : "";
  const unread: PrState = {
    pr_url: PR_URL.test(url) ? url : "",
    read: false,
    head: "",
    base: "",
    state: "",
    mergeable: "",
    is_draft: false,
    checkout_is_head: false,
    checkout_clean: false,
    checks: [],
    checks_read: false,
  };
  if (!PR_URL.test(url)) return unread;

  // The URL is the selector, so gh infers no repository from the checkout.
  const view = capture(["gh", "pr", "view", url, "--json", "headRefOid,headRefName,isDraft,state,baseRefName,mergeable"]);
  const pr = view.ok ? parseJsonObject(view.out) : null;
  if (!pr || typeof pr.headRefOid !== "string" || typeof pr.headRefName !== "string" || typeof pr.baseRefName !== "string") {
    return unread;
  }

  const checkout = capture(["git", "rev-parse", "HEAD"]);
  // Untracked files are ignored: Archon scaffolds an untracked .archon/ in every run.
  const status = capture(["git", "status", "--porcelain", "--untracked-files=no"]);
  return {
    pr_url: url,
    read: true,
    head: pr.headRefName,
    base: pr.baseRefName,
    state: String(pr.state),
    mergeable: typeof pr.mergeable === "string" ? pr.mergeable : "",
    is_draft: pr.isDraft !== false,
    checkout_is_head: checkout.ok && checkout.out === pr.headRefOid,
    checkout_clean: status.ok && status.out === "",
    ...(await settledChecks(url, pr.headRefOid, { pollMs: POLL_MS, waitMs: WAIT_MS })),
  };
}

emit(await read());
