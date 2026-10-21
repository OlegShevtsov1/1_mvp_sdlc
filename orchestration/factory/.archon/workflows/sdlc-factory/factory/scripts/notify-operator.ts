import { emit } from "./_lib/io.ts";
import { PR_URL } from "./_lib/merge-decision.ts";

// Bindings (see factory.yaml `notify-operator` node): pr_url, base (both from
// merge-gate). Always exits 0 with one {notified, reason} line: a comment that
// could not be posted is a reported state, the report tells the operator.
const url = process.env.INPUTS_PR_URL ?? "";
const base = process.env.INPUTS_BASE ?? "";

function notify(): { notified: boolean; reason: string } {
  if (!PR_URL.test(url)) return { notified: false, reason: "no GitHub pull request URL to comment on" };
  const body =
    `ready for the operator: base ${base} is manual — the factory does not merge pull requests into ${base} ` +
    "(decision 27); review and merge it by hand.";
  // The URL is the selector, so gh infers no repository from the checkout.
  const p = Bun.spawnSync(["gh", "pr", "comment", url, "--body", body], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode === 0) return { notified: true, reason: "" };
  const firstLine = p.stderr.toString().trim().split("\n")[0] ?? "";
  return { notified: false, reason: `gh pr comment failed: ${firstLine || `exit ${p.exitCode}`}` };
}

emit(notify());
