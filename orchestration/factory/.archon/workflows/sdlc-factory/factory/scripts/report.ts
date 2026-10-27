import { writeFileSync } from "node:fs";
import { emit } from "./_lib/io.ts";
import { buildReport } from "./_lib/build-report.ts";

const doc = buildReport({
  pr_url: process.env.INPUTS_PR_URL ?? "",
  merged: process.env.INPUTS_MERGED ?? "skipped",
  merge_sha: process.env.INPUTS_MERGE_SHA ?? "",
  deployed: process.env.INPUTS_DEPLOYED ?? "skipped",
  deploy_exit: process.env.INPUTS_DEPLOY_EXIT ?? "",
  healthy: process.env.INPUTS_HEALTHY ?? "skipped",
  last_status: process.env.INPUTS_LAST_STATUS ?? "",
  health_url: process.env.INPUTS_HEALTH_URL ?? "",
  monitor_status: process.env.INPUTS_MONITOR_STATUS ?? "skipped",
  monitor_findings: process.env.INPUTS_MONITOR_FINDINGS ?? "",
  rollback: process.env.INPUTS_ROLLBACK ?? "skipped",
  rolled_back: process.env.INPUTS_ROLLED_BACK ?? "skipped",
  rollback_reason: process.env.INPUTS_ROLLBACK_REASON ?? "",
  merge_refused: process.env.INPUTS_MERGE_REFUSED || process.env.INPUTS_MERGE_ERROR || "",
  merge_action: process.env.INPUTS_MERGE_ACTION ?? "",
  merge_base: process.env.INPUTS_MERGE_BASE ?? "",
  notified: process.env.INPUTS_NOTIFIED ?? "skipped",
  notify_reason: process.env.INPUTS_NOTIFY_REASON ?? "",
  delivery_ready: process.env.INPUTS_DELIVERY_READY ?? "skipped",
  delivery_reason: process.env.INPUTS_DELIVERY_REASON ?? "",
  delivery_summary: process.env.INPUTS_DELIVERY_SUMMARY ?? "",
  rag_status: process.env.INPUTS_RAG_STATUS ?? "skipped",
  rag_sources: process.env.INPUTS_RAG_SOURCES ?? "[]",
  visual_proceed: process.env.INPUTS_VISUAL_PROCEED ?? "skipped",
  visual_stop: process.env.INPUTS_VISUAL_STOP ?? "",
  visual_pr_url: process.env.INPUTS_VISUAL_PR_URL ?? "",
  claude_auth: process.env.INPUTS_CLAUDE_AUTH ?? "skipped",
  claude_auth_node: process.env.INPUTS_CLAUDE_AUTH_NODE ?? "",
});
const artifacts = process.env.ARTIFACTS_DIR;
if (artifacts) writeFileSync(`${artifacts}/report.json`, JSON.stringify(doc, null, 2) + "\n");
emit(doc);
