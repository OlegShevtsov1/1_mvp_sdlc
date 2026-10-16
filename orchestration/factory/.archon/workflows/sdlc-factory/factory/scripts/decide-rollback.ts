import { emit } from "./_lib/io.ts";
import { decideRollback } from "./_lib/rollback-decision.ts";

emit(decideRollback({
  deployed: process.env.INPUTS_DEPLOYED ?? "skipped",
  healthy: process.env.INPUTS_HEALTHY ?? "skipped",
  monitor_status: process.env.INPUTS_MONITOR_STATUS ?? "skipped",
}));
