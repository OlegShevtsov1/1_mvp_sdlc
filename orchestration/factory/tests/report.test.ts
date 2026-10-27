import { describe, expect, test } from "bun:test";
import { buildReport } from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/build-report.ts";

const SOURCE = {
  repo: "1_mvp_infra", path: "docs/uk/26-rag-server.md", commit_sha: "a".repeat(40),
  url: "https://github.com/o/1_mvp_infra/blob/aaaaaaa/docs/uk/26-rag-server.md", title: "RAG server",
};

const base = {
  pr_url: "https://github.com/o/r/pull/7", merged: "true", merge_sha: "abc123",
  deployed: "true", deploy_exit: "0", healthy: "true", last_status: "200",
  health_url: "https://app.example.com/health", monitor_status: "healthy", monitor_findings: "",
  rollback: "false", rolled_back: "skipped", rollback_reason: "", merge_refused: "",
  merge_action: "merge", merge_base: "develop", notified: "skipped", notify_reason: "",
  delivery_ready: "true", delivery_reason: "delivered", delivery_summary: "",
  rag_status: "ok", rag_sources: JSON.stringify([SOURCE]),
  visual_proceed: "skipped", visual_stop: "", visual_pr_url: "",
  claude_auth: "ok", claude_auth_node: "",
};

const notReady = {
  ...base, merged: "skipped", merge_sha: "", deployed: "skipped", healthy: "skipped",
  monitor_status: "skipped", pr_url: "", merge_action: "", delivery_ready: "false",
};

const pendingOperator = {
  ...base, merge_action: "notify", merge_base: "main", notified: "true",
  merged: "skipped", merge_sha: "", deployed: "skipped", deploy_exit: "", healthy: "skipped", last_status: "",
  monitor_status: "skipped", rollback: "false",
};

describe("buildReport", () => {
  test("green path is delivered", () => {
    const r = buildReport(base);
    expect(r.delivered).toBe(true);
    expect(r.status).toBe("delivered");
    expect(r.summary).toContain("https://github.com/o/r/pull/7");
    expect(r.rollback).toBe("not needed");
  });
  test("a refused merge is not delivered and names the refusal", () => {
    const r = buildReport({ ...base, merged: "skipped", merge_sha: "", deployed: "skipped", healthy: "skipped", monitor_status: "skipped", merge_refused: "test command exited 1 on the pull request head; see merge-gate.log" });
    expect(r.delivered).toBe(false);
    expect(r.status).toBe("not-delivered");
    expect(r.summary).toContain("merge refused");
    expect(r.summary).toContain("test command exited 1");
    expect(r.summary).toContain("https://github.com/o/r/pull/7");
  });
  test("an interim review verdict ends not delivered and quotes the delivery's reason and summary", () => {
    const r = buildReport({ ...notReady, delivery_reason: "review_open", delivery_summary: "Not ready: Round 1: review_open. Not yet finalized — still verifying." });
    expect(r.status).toBe("not-delivered");
    expect(r.delivered).toBe(false);
    expect(r.summary).toContain("the delivery ended not ready (review_open)");
    expect(r.summary).toContain("Not yet finalized — still verifying.");
  });
  test("a failed delivery names its reason", () => {
    const r = buildReport({ ...notReady, delivery_reason: "failed", delivery_summary: "" });
    expect(r.summary).toBe("Not delivered: the delivery ended not ready (failed).");
  });
  test("a not-ready delivery with no reason says so", () => {
    const r = buildReport({ ...notReady, delivery_reason: "", delivery_summary: "" });
    expect(r.summary).toContain("(no reason given)");
  });
  test("a skipped delivery changes no summary", () => {
    const r = buildReport({ ...base, merged: "skipped", merge_sha: "", deployed: "skipped", healthy: "skipped", monitor_status: "skipped", pr_url: "", delivery_ready: "skipped", delivery_reason: "" });
    expect(r.summary).toBe("Not delivered: PR (none) was not merged.");
  });
  test("a merge gh refused is not delivered and carries gh's words", () => {
    const r = buildReport({ ...base, merged: "false", merge_sha: "", deployed: "skipped", healthy: "skipped", monitor_status: "skipped", merge_refused: "merge: gh pr merge failed: X Pull request o/r#7 is not mergeable: the merge commit cannot be cleanly created." });
    expect(r.delivered).toBe(false);
    expect(r.status).toBe("not-delivered");
    expect(r.summary).toContain("merge refused (merge: gh pr merge failed:");
    expect(r.summary).toContain("not mergeable");
    expect(r.summary).toContain("https://github.com/o/r/pull/7");
    expect(r.deploy_status).toBe("not attempted");
    expect(r.rollback).toBe("not needed");
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
    expect(r.status).toBe("not-delivered");
    expect(r.summary).toContain("503");
    expect(r.rollback).toBe("done");
  });
  test("failed deploy command is not delivered", () => {
    const r = buildReport({ ...base, deployed: "false", deploy_exit: "2", healthy: "skipped", monitor_status: "skipped" });
    expect(r.delivered).toBe(false);
    expect(r.status).toBe("not-delivered");
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
  test("a green PR into a manual base is delivered pending the operator", () => {
    const r = buildReport(pendingOperator);
    expect(r.status).toBe("delivered-pending-operator");
    expect(r.delivered).toBe(false);
    expect(r.summary).toContain("https://github.com/o/r/pull/7");
    expect(r.summary).toContain("ready for the operator");
    expect(r.summary).toContain("base main is manual");
    expect(r.summary).toContain("deploy, health and rollback were skipped");
    expect(r.summary).toContain("The operator was notified on the pull request.");
    expect(r.merge_sha).toBe("");
    expect(r.deploy_status).toContain("skipped");
    expect(r.health).toBe("skipped");
    expect(r.monitoring).toBe("skipped");
    expect(r.rollback).toBe("not needed");
  });
  test("a pending-operator run whose comment failed says so and stays pending", () => {
    const r = buildReport({ ...pendingOperator, notified: "false", notify_reason: "gh pr comment failed: HTTP 403" });
    expect(r.status).toBe("delivered-pending-operator");
    expect(r.summary).toContain("could not be posted");
    expect(r.summary).toContain("gh pr comment failed: HTTP 403");
  });
  test("the green path records the mvp-rag status and sources the plan was given", () => {
    const r = buildReport(base);
    expect(r.rag_status).toBe("ok");
    expect(r.rag_sources).toEqual([SOURCE]);
  });
  test("a pending-operator run records them too", () => {
    const r = buildReport({ ...pendingOperator, rag_status: "unavailable" });
    expect(r.rag_status).toBe("unavailable");
    expect(r.rag_sources).toEqual([SOURCE]);
  });
  test("a run stopped at the visual gate names the gate and the open pull request", () => {
    const r = buildReport({
      ...notReady, delivery_ready: "true", visual_proceed: "false",
      visual_stop: "operator chose abort: too dark", visual_pr_url: "https://github.com/o/r/pull/7",
    });
    expect(r.status).toBe("not-delivered");
    expect(r.summary).toBe(
      "Not delivered: stopped at the visual gate (operator chose abort: too dark). PR https://github.com/o/r/pull/7 is open and was not merged.",
    );
    expect(r.pr_url).toBe("https://github.com/o/r/pull/7");
  });
  test("a visual task that passed its gate, or a task without one, keeps every other summary", () => {
    const refused = { ...base, merged: "skipped", merge_sha: "", deployed: "skipped", healthy: "skipped", monitor_status: "skipped", merge_refused: "checks red" };
    for (const input of [base, refused, pendingOperator, { ...notReady, delivery_reason: "failed" }]) {
      const skipped = buildReport({ ...input, visual_proceed: "skipped" });
      expect(buildReport({ ...input, visual_proceed: "true" })).toEqual(skipped);
    }
  });
  test("a run stopped by an expired Claude login says so first and names the fix", () => {
    const r = buildReport({ ...notReady, delivery_ready: "skipped", claude_auth: "auth_failed", claude_auth_node: "plan__plan" });
    expect(r.status).toBe("not-delivered");
    expect(r.summary.startsWith("Not delivered: the Claude CLI login on the Archon host has expired")).toBe(true);
    expect(r.summary).toContain("plan__plan");
    expect(r.summary).toContain("claude /login");
  });
  test("a delivered run keeps its summary whatever the login scan found", () => {
    expect(buildReport({ ...base, claude_auth: "auth_failed", claude_auth_node: "monitor" }).summary)
      .toBe(buildReport(base).summary);
  });
  for (const claude_auth of ["skipped", "ok", "unknown"]) {
    test(`a login scan of ${claude_auth} changes no summary`, () => {
      const visualStopped = {
        ...notReady, delivery_ready: "true", visual_proceed: "false",
        visual_stop: "operator chose abort", visual_pr_url: "https://github.com/o/r/pull/7",
      };
      for (const input of [base, notReady, pendingOperator, visualStopped]) {
        expect(buildReport({ ...input, claude_auth }).summary).toBe(buildReport(input).summary);
      }
    });
  }
  for (const raw of ["", "not json", "{}", JSON.stringify([{ repo: "r" }])]) {
    test(`unreadable rag_sources ${JSON.stringify(raw)} records none`, () => {
      expect(buildReport({ ...base, rag_sources: raw }).rag_sources).toEqual([]);
    });
  }
});
