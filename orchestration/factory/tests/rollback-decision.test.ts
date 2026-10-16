import { describe, expect, test } from "bun:test";
import { decideRollback } from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/rollback-decision.ts";

describe("decideRollback", () => {
  test("no rollback when everything is green", () => {
    expect(decideRollback({ deployed: "true", healthy: "true", monitor_status: "healthy" })).toEqual({ rollback: false, reason: "" });
  });
  test("rolls back on red health", () => {
    expect(decideRollback({ deployed: "true", healthy: "false", monitor_status: "skipped" }).rollback).toBe(true);
  });
  test("rolls back on monitoring errors", () => {
    const r = decideRollback({ deployed: "true", healthy: "true", monitor_status: "errors" });
    expect(r.rollback).toBe(true);
    expect(r.reason).toContain("monitoring");
  });
  test("does not roll back when monitoring is unavailable or skipped", () => {
    expect(decideRollback({ deployed: "true", healthy: "true", monitor_status: "unavailable" }).rollback).toBe(false);
    expect(decideRollback({ deployed: "true", healthy: "true", monitor_status: "skipped" }).rollback).toBe(false);
  });
  test("does not roll back when the deploy command itself failed", () => {
    expect(decideRollback({ deployed: "false", healthy: "skipped", monitor_status: "skipped" }).rollback).toBe(false);
  });
});
