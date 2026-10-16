import { emit, parseJsonObject } from "./_lib/io.ts";
import { type CiCheck, PR_URL } from "./_lib/merge-decision.ts";

// Binding (see factory.yaml `pr-state` node): delivery (the whole deliver
// output). Reports facts only, merge-gate decides; always exits 0 with one line.
const delivery = parseJsonObject(process.env.INPUTS_DELIVERY ?? "") ?? {};

interface PrState {
  pr_url: string;
  read: boolean;
  head: string;
  state: string;
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

// gh encodes the checks' state in its exit code, so stdout is parsed whatever
// the exit; a head with no checks at all prints a message instead of JSON.
function readChecks(url: string): { checks: CiCheck[]; checks_read: boolean } {
  const p = Bun.spawnSync(["gh", "pr", "checks", url, "--json", "name,bucket"], { stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString().trim();
  if (/no checks reported/i.test(out + p.stderr.toString())) return { checks: [], checks_read: true };
  try {
    const doc: unknown = JSON.parse(out);
    if (!Array.isArray(doc)) return { checks: [], checks_read: false };
    const checks = doc.map((c: { name?: unknown; bucket?: unknown }) => ({
      name: typeof c?.name === "string" ? c.name : "",
      bucket: typeof c?.bucket === "string" ? c.bucket : "",
    }));
    return { checks, checks_read: true };
  } catch {
    return { checks: [], checks_read: false };
  }
}

function read(): PrState {
  // Archon v0.10.1's archon-deliver returns the PR record ({url, head, ...});
  // v0.11.1's returns {pr_url}.
  const url = typeof delivery.url === "string" ? delivery.url : typeof delivery.pr_url === "string" ? delivery.pr_url : "";
  const unread: PrState = {
    pr_url: PR_URL.test(url) ? url : "",
    read: false,
    head: "",
    state: "",
    is_draft: false,
    checkout_is_head: false,
    checkout_clean: false,
    checks: [],
    checks_read: false,
  };
  if (!PR_URL.test(url)) return unread;

  // The URL is the selector, so gh infers no repository from the checkout.
  const view = capture(["gh", "pr", "view", url, "--json", "headRefOid,headRefName,isDraft,state"]);
  const pr = view.ok ? parseJsonObject(view.out) : null;
  if (!pr || typeof pr.headRefOid !== "string" || typeof pr.headRefName !== "string") return unread;

  const checkout = capture(["git", "rev-parse", "HEAD"]);
  // Untracked files are ignored: Archon scaffolds an untracked .archon/ in every run.
  const status = capture(["git", "status", "--porcelain", "--untracked-files=no"]);
  return {
    pr_url: url,
    read: true,
    head: pr.headRefName,
    state: String(pr.state),
    is_draft: pr.isDraft !== false,
    checkout_is_head: checkout.ok && checkout.out === pr.headRefOid,
    checkout_clean: status.ok && status.out === "",
    ...readChecks(url),
  };
}

emit(read());
