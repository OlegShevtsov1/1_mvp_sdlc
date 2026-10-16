import { describe, expect, test } from "bun:test";
import { buildReport } from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/build-report.ts";

const base = {
  pr_url: "https://github.com/o/r/pull/7", merged: "true", merge_sha: "abc123",
  deployed: "true", deploy_exit: "0", healthy: "true", last_status: "200",
  health_url: "https://app.example.com/health", monitor_status: "healthy", monitor_findings: "",
  rollback: "false", rolled_back: "skipped", rollback_reason: "", merge_refused: "",
};

describe("buildReport", () => {
  test("green path is delivered", () => {
    const r = buildReport(base);
    expect(r.delivered).toBe(true);
    expect(r.summary).toContain("https://github.com/o/r/pull/7");
    expect(r.rollback).toBe("not needed");
  });
  test("a refused merge is not delivered and names the refusal", () => {
    const r = buildReport({ ...base, merged: "skipped", merge_sha: "", deployed: "skipped", healthy: "skipped", monitor_status: "skipped", merge_refused: "test command exited 1 on the pull request head; see merge-gate.log" });
    expect(r.delivered).toBe(false);
    expect(r.summary).toContain("merge refused");
    expect(r.summary).toContain("test command exited 1");
    expect(r.summary).toContain("https://github.com/o/r/pull/7");
  });
  test("a merged PR whose merge commit could not be read is reported merged, not deployed", () => {
    const r = buildReport({ ...base, merge_sha: "", deployed: "skipped", deploy_exit: "", healthy: "skipped", monitor_status: "skipped" });
    expect(r.delivered).toBe(false);
    expect(r.deploy_status).toBe("skipped");
    expect(r.summary).toContain("https://github.com/o/r/pull/7 is merged");
    expect(r.summary).toContain("merge commit could not be read");
    expect(r.summary).toContain("gh pr view https://github.com/o/r/pull/7 --json mergeCommit");
  });
  test("red health with rollback is not delivered and names the cause", () => {
    const r = buildReport({ ...base, healthy: "false", last_status: "503", monitor_status: "skipped", rollback: "true", rolled_back: "true", rollback_reason: "health check returned 503" });
    expect(r.delivered).toBe(false);
    expect(r.summary).toContain("503");
    expect(r.rollback).toBe("done");
  });
  test("failed deploy command is not delivered", () => {
    const r = buildReport({ ...base, deployed: "false", deploy_exit: "2", healthy: "skipped", monitor_status: "skipped" });
    expect(r.delivered).toBe(false);
    expect(r.deploy_status).toBe("failed (exit 2)");
  });
  test("a deploy whose health check did not run is not delivered", () => {
    const r = buildReport({ ...base, healthy: "skipped", last_status: "", health_url: "", monitor_status: "skipped" });
    expect(r.delivered).toBe(false);
    expect(r.health).toBe("not checked");
    expect(r.summary).toContain("did not run");
  });
  test("a failed deploy with no exit code reports an unknown exit", () => {
    const r = buildReport({ ...base, deployed: "false", deploy_exit: "", healthy: "skipped", monitor_status: "skipped" });
    expect(r.deploy_status).toBe("failed (exit unknown)");
  });
  test("monitoring unavailable stays delivered but is reported", () => {
    const r = buildReport({ ...base, monitor_status: "unavailable", monitor_findings: "MCP server not reachable" });
    expect(r.delivered).toBe(true);
    expect(r.monitoring).toContain("unavailable");
  });
});
