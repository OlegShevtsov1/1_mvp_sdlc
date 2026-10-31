import { describe, expect, test } from "bun:test";
import { ciRefusal } from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/merge-decision.ts";
import { actionsJob, isKnownFlaky, latestCheckRuns } from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/pr-checks.ts";

interface Run {
  __typename: "CheckRun";
  name: string;
  workflowName: string;
  status: string;
  conclusion: string;
  startedAt: string | null;
  completedAt: string | null;
}

function run(workflowName: string, name: string, conclusion: string, startedAt: string, completedAt: string): Run {
  return { __typename: "CheckRun", name, workflowName, status: "COMPLETED", conclusion, startedAt, completedAt };
}

function inFlight(workflowName: string, name: string, status: "QUEUED" | "IN_PROGRESS", startedAt: string | null): Run {
  return { __typename: "CheckRun", name, workflowName, status, conclusion: "", startedAt, completedAt: null };
}

// 1_mvp_pilot_be#108 at head 193dd40 (run dacea56f), in the rollup's own order: the PR body
// edit at 14:47 cancelled the TDD, CHANGELOG and PR-conventions runs and started newer ones.
const BE108: Run[] = [
  run("TDD check", "TDD order", "CANCELLED", "2026-10-28T14:47:15Z", "2026-10-28T14:47:34Z"),
  run("changelog-check", "CHANGELOG entry", "CANCELLED", "2026-10-28T14:47:16Z", "2026-10-28T14:47:39Z"),
  run("pr-conventions-check", "PR conventions", "CANCELLED", "2026-10-28T14:47:15Z", "2026-10-28T14:47:34Z"),
  run("AI review", "AI review", "SKIPPED", "2026-10-28T13:45:03Z", "2026-10-28T13:45:03Z"),
  run("AI review", "AI review", "SUCCESS", "2026-10-28T14:13:53Z", "2026-10-28T14:14:14Z"),
  run("TDD check", "TDD order", "SUCCESS", "2026-10-28T14:00:47Z", "2026-10-28T14:01:09Z"),
  run("TDD check", "TDD order", "SUCCESS", "2026-10-28T14:48:07Z", "2026-10-28T14:48:32Z"),
  run("changelog-check", "CHANGELOG entry", "SUCCESS", "2026-10-28T13:53:14Z", "2026-10-28T13:53:46Z"),
  run("changelog-check", "CHANGELOG entry", "SUCCESS", "2026-10-28T14:48:35Z", "2026-10-28T14:48:56Z"),
  run("pr-conventions-check", "PR conventions", "SUCCESS", "2026-10-28T14:04:18Z", "2026-10-28T14:04:53Z"),
  run("pr-conventions-check", "PR conventions", "SUCCESS", "2026-10-28T14:47:40Z", "2026-10-28T14:48:05Z"),
  run("TDD check", "TDD RED on the test commit", "CANCELLED", "2026-10-28T14:47:34Z", "2026-10-28T14:47:34Z"),
  run("Rails CI", "Lint", "SUCCESS", "2026-10-28T14:43:58Z", "2026-10-28T14:45:11Z"),
  run("TDD check", "TDD RED on the test commit", "SUCCESS", "2026-10-28T14:02:03Z", "2026-10-28T14:13:50Z"),
  run("TDD check", "TDD RED on the test commit", "SUCCESS", "2026-10-28T14:48:57Z", "2026-10-28T14:58:32Z"),
];

const OLD = "2026-10-28T14:00:00Z";
const NEW = "2026-10-28T14:30:00Z";

describe("latestCheckRuns", () => {
  test("a cancelled run superseded by a newer green run is not red (be#108)", () => {
    const checks = latestCheckRuns(BE108);
    expect(checks).toMatchObject([
      { name: "TDD order", bucket: "pass" },
      { name: "CHANGELOG entry", bucket: "pass" },
      { name: "PR conventions", bucket: "pass" },
      { name: "AI review", bucket: "pass" },
      { name: "TDD RED on the test commit", bucket: "pass" },
      { name: "Lint", bucket: "pass" },
    ]);
    expect(ciRefusal(checks)).toBeNull();
  });

  test("a cancelled run next to a newer green one is not red (fe#65)", () => {
    const name = "Branch name, PR title, Type line";
    const checks = latestCheckRuns([
      run("PR conventions", name, "CANCELLED", OLD, OLD),
      run("PR conventions", name, "SUCCESS", NEW, NEW),
    ]);
    expect(checks).toMatchObject([{ name, bucket: "pass" }]);
  });

  test("a latest run cancelled with nothing newer is refused", () => {
    const checks = latestCheckRuns([run("TDD check", "TDD order", "SUCCESS", OLD, OLD), run("TDD check", "TDD order", "CANCELLED", NEW, NEW)]);
    expect(checks).toMatchObject([{ name: "TDD order", bucket: "cancel" }]);
    expect(ciRefusal(checks)).toBe("CI check TDD order is cancel on the pull request head");
  });

  test("a queued or in-progress run newer than a green one is pending", () => {
    for (const pending of [inFlight("TDD check", "TDD order", "IN_PROGRESS", NEW), inFlight("TDD check", "TDD order", "QUEUED", null)]) {
      expect(latestCheckRuns([run("TDD check", "TDD order", "SUCCESS", OLD, OLD), pending])).toMatchObject([{ name: "TDD order", bucket: "pending" }]);
    }
  });

  test("a latest run that failed or timed out is refused", () => {
    for (const conclusion of ["FAILURE", "TIMED_OUT"]) {
      const checks = latestCheckRuns([run("CI", "Tests", "SUCCESS", OLD, OLD), run("CI", "Tests", conclusion, NEW, NEW)]);
      expect(checks).toMatchObject([{ name: "Tests", bucket: "fail" }]);
      expect(ciRefusal(checks)).toBe("CI check Tests is fail on the pull request head");
    }
  });

  test("an older failure superseded by a newer green run is not red", () => {
    expect(latestCheckRuns([run("CI", "Tests", "FAILURE", OLD, OLD), run("CI", "Tests", "SUCCESS", NEW, NEW)])).toMatchObject([{ name: "Tests", bucket: "pass" }]);
  });

  test("the same name in two workflows is two checks", () => {
    const checks = latestCheckRuns([run("A", "build", "SUCCESS", NEW, NEW), run("B", "build", "FAILURE", OLD, OLD)]);
    expect(checks).toMatchObject([{ name: "build", bucket: "pass" }, { name: "build", bucket: "fail" }]);
    expect(ciRefusal(checks)).toBe("CI check build is fail on the pull request head");
  });

  test("a commit status is judged by its context and state", () => {
    expect(latestCheckRuns([
      { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS", startedAt: OLD },
      { __typename: "StatusContext", context: "ci/deploy", state: "ERROR", startedAt: OLD },
      { __typename: "StatusContext", context: "ci/slow", state: "PENDING", startedAt: OLD },
    ])).toMatchObject([{ name: "ci/legacy", bucket: "pass" }, { name: "ci/deploy", bucket: "fail" }, { name: "ci/slow", bucket: "pending" }]);
  });

  test("a skipped or neutral latest run is skipping; an entry without a name is dropped", () => {
    expect(latestCheckRuns([run("CI", "Deploy", "SKIPPED", OLD, OLD), run("CI", "Docs", "NEUTRAL", OLD, OLD), null, 7, {}])).toMatchObject([
      { name: "Deploy", bucket: "skipping" },
      { name: "Docs", bucket: "skipping" },
    ]);
  });

  test("keeps the latest run's details URL", () => {
    const url = "https://github.com/OlegShevtsov1/1_mvp_sdlc/actions/runs/40801047052/job/1232151809";
    const entries = [
      { ...run("CI", "Tests", "FAILURE", OLD, OLD), detailsUrl: "https://github.com/o/r/actions/runs/1/job/2" },
      { ...run("CI", "Tests", "FAILURE", NEW, NEW), detailsUrl: url },
      { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS", startedAt: OLD },
    ];
    expect(latestCheckRuns(entries)).toEqual([
      { name: "Tests", bucket: "fail", detailsUrl: url },
      { name: "ci/legacy", bucket: "pass", detailsUrl: "" },
    ]);
  });
});

describe("actionsJob", () => {
  test("reads the run and job ids of a GitHub Actions job URL", () => {
    expect(actionsJob("https://github.com/OlegShevtsov1/1_mvp_sdlc/actions/runs/40801047052/job/1232151809"))
      .toEqual({ runId: "40801047052", jobId: "1232151809" });
  });
  test("any other URL is not an Actions job", () => {
    for (const url of ["", "https://ci.example.com/build/7", "https://github.com/o/r/actions/runs/1", "https://github.com/o/r/actions/runs/1/job/2; rm -rf /"]) {
      expect(actionsJob(url)).toBeNull();
    }
  });
});

describe("isKnownFlaky", () => {
  test("a pattern in the job name or in its failed-step log makes it known flaky", () => {
    expect(isKnownFlaky("fe / tokenStore", "", ["tokenStore"])).toBe(true);
    expect(isKnownFlaky("Test", "FAIL src/auth/tokenStore.test.ts > refresh", ["tokenStore"])).toBe(true);
  });
  test("no pattern hit, or no patterns at all, is not flaky", () => {
    expect(isKnownFlaky("Test", "FAIL src/api.test.ts", ["tokenStore"])).toBe(false);
    expect(isKnownFlaky("tokenStore", "tokenStore", [])).toBe(false);
  });
  test("patterns are case-sensitive substrings, not regexes", () => {
    expect(isKnownFlaky("Test", "tokenstore", ["tokenStore"])).toBe(false);
    expect(isKnownFlaky("Test", "a.b", ["a*b"])).toBe(false);
  });
});
