export interface RollbackInput {
  deployed: string;      // "true" | "false" | "skipped"
  healthy: string;       // "true" | "false" | "skipped"
  monitor_status: string; // "healthy" | "errors" | "unavailable" | "skipped"
}

export function decideRollback(i: RollbackInput): { rollback: boolean; reason: string } {
  if (i.deployed !== "true") return { rollback: false, reason: "" };
  if (i.healthy === "false") return { rollback: true, reason: "health check did not return 200 within the profile's wait_seconds" };
  if (i.monitor_status === "errors") return { rollback: true, reason: "monitoring reported new errors after the deploy" };
  return { rollback: false, reason: "" };
}
