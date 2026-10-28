import { describe, expect, test } from "bun:test";
import { lastDelivery } from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/redeliver.ts";

const PR = "https://github.com/example/repo/pull/3";
const failed = {
  ready: false, reason: "failed", pr_url: PR, ci_rerun: "none", threads_checked: false,
  summary: "Not done: a node failed before this run reported its result.",
};
const delivered = { ...failed, ready: true, reason: "delivered", summary: "Ready: Round 1: delivered." };

describe("lastDelivery", () => {
  test("without a retry it hands the first report on unchanged", () => {
    const first = { ...delivered, reason: "review_open", ready: false };
    expect(lastDelivery(JSON.stringify(first), "")).toEqual({ ...first, retry_note: "" });
  });
  test("a failed delivery the retry delivered hands on the retry's report and says why it retried", () => {
    const r = lastDelivery(JSON.stringify(failed), JSON.stringify(delivered));
    expect(r.ready).toBe(true);
    expect(r.reason).toBe("delivered");
    expect(r.pr_url).toBe(PR);
    expect(r.retry_note).toContain("the first delivery ended failed");
    expect(r.retry_note).toContain(PR);
    expect(r.retry_note).toEndWith("which ended ready");
  });
  test("a retry that failed again stays not ready and says so", () => {
    const r = lastDelivery(JSON.stringify(failed), JSON.stringify(failed));
    expect(r.ready).toBe(false);
    expect(r.reason).toBe("failed");
    expect(r.retry_note).toEndWith("which ended not ready (failed)");
  });
  test.each(["replan", "round_cap"])("a retry that ended %s hands that reason on, not the first's failure", (reason) => {
    const r = lastDelivery(JSON.stringify(failed), JSON.stringify({ ...failed, reason }));
    expect(r.ready).toBe(false);
    expect(r.reason).toBe(reason);
    expect(r.retry_note).toEndWith(`which ended not ready (${reason})`);
  });
  test("the note names the retry's pull request, else the first's, else none", () => {
    const noPr = { ...failed, pr_url: "" };
    expect(lastDelivery(JSON.stringify(noPr), JSON.stringify(delivered)).retry_note).toContain(PR);
    expect(lastDelivery(JSON.stringify(failed), JSON.stringify(noPr)).retry_note).toContain(PR);
    expect(lastDelivery(JSON.stringify(noPr), JSON.stringify(noPr)).retry_note).not.toContain("pull request");
  });
});
