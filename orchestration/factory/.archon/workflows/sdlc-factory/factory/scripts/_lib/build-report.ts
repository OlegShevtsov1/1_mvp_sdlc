export interface ReportInput {
  pr_url: string; merged: string; merge_sha: string;
  deployed: string; deploy_exit: string;
  healthy: string; last_status: string; health_url: string;
  monitor_status: string; monitor_findings: string;
  rollback: string; rolled_back: string; rollback_reason: string;
  merge_refused: string;
  merge_action: string; merge_base: string; notified: string; notify_reason: string;
}

export type ReportStatus = "delivered" | "delivered-pending-operator" | "not-delivered";

export interface ReportDoc {
  status: ReportStatus; delivered: boolean; summary: string;
  pr_url: string; merge_sha: string; deploy_status: string;
  health: string; monitoring: string; rollback: string;
}

// Decision 27: merge-gate handed a green pull request into a manual base to
// the operator, so nothing was merged or deployed. `delivered` keeps meaning
// "live"; `status` tells this outcome apart from a failure.
function pendingOperator(i: ReportInput): ReportDoc {
  const notice = i.notified === "true"
    ? "The operator was notified on the pull request."
    : `The notification could not be posted (${i.notify_reason || "notify-operator did not run"}); tell the operator.`;
  return {
    status: "delivered-pending-operator",
    delivered: false,
    summary:
      `Delivered, pending the operator: ${i.pr_url} is ready for the operator: base ${i.merge_base} is manual ` +
      `(decision 27), so the factory did not merge it; deploy, health and rollback were skipped. ${notice}`,
    pr_url: i.pr_url,
    merge_sha: "",
    deploy_status: `skipped (base ${i.merge_base} is merged by the operator)`,
    health: "skipped",
    monitoring: "skipped",
    rollback: "not needed",
  };
}

export function buildReport(i: ReportInput): ReportDoc {
  if (i.merge_action === "notify") return pendingOperator(i);
  const merged = i.merged === "true";
  const deployed = i.deployed === "true";
  const healthy = i.healthy === "true";
  const rolledBack = i.rollback === "true";

  const deploy_status = !merged ? "not attempted" : deployed ? "ok" : i.deployed === "skipped" ? "skipped" : `failed (exit ${i.deploy_exit || "unknown"})`;
  const health =
    !deployed ? "skipped"
    : healthy ? `200 at ${i.health_url}`
    : i.healthy === "skipped" ? "not checked"
    : `red (last status ${i.last_status}) at ${i.health_url}`;
  const monitoring =
    i.monitor_status === "healthy" ? "healthy"
    : i.monitor_status === "errors" ? `errors: ${i.monitor_findings}`
    : i.monitor_status === "unavailable" ? `unavailable: ${i.monitor_findings}`
    : "skipped";
  const rollback = !rolledBack ? "not needed" : i.rolled_back === "true" ? "done" : `FAILED (${i.rollback_reason})`;

  const delivered = merged && deployed && healthy && i.monitor_status !== "errors" && !rolledBack;

  const summary = delivered
    ? `Delivered: ${i.pr_url} merged as ${i.merge_sha}, deployed, health ${health}, monitoring ${monitoring}.`
    : !merged && i.merge_refused ? `Not delivered: merge refused (${i.merge_refused}). PR ${i.pr_url} is open and was not merged.`
    : !merged ? `Not delivered: PR ${i.pr_url || "(none)"} was not merged.`
    : !i.merge_sha ? `Not delivered: PR ${i.pr_url} is merged, but its merge commit could not be read, so nothing was deployed. Re-check with: gh pr view ${i.pr_url} --json mergeCommit`
    : !deployed ? `Not delivered: deploy ${deploy_status}. PR ${i.pr_url} merged as ${i.merge_sha}. See deploy.log.`
    : i.healthy === "skipped" && !rolledBack ? `Not delivered: health check did not run after the deploy. PR ${i.pr_url} merged as ${i.merge_sha}; monitoring ${monitoring}.`
    : `Not delivered: ${i.rollback_reason || "post-deploy checks failed"} (health ${health}; monitoring ${monitoring}). Rollback ${rollback}.`;

  const status: ReportStatus = delivered ? "delivered" : "not-delivered";
  return { status, delivered, summary, pr_url: i.pr_url, merge_sha: i.merge_sha, deploy_status, health, monitoring, rollback };
}
