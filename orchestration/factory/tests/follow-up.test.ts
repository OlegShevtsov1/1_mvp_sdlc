import { describe, expect, test } from "bun:test";
import {
  decideFollowUp,
  leftOpenItems,
  parseJudge,
  parseState,
  roundOf,
  type Finding,
  type Judge,
  type ReviewState,
} from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/follow-up.ts";

const PR_URL = "https://github.com/example/repo/pull/3";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const LEFT_OPEN = "Left open, so the pull request does not close its issue:";

// The deliver report as outcome.ts renders it, with its threads caveat after the open items.
function delivery(reason: string, round: number, items: string[] = [], fields: Record<string, unknown> = {}): Record<string, unknown> {
  const left = items.length ? `\n\n${LEFT_OPEN}\n${items.map((i) => `- ${i}`).join("\n")}` : "";
  return {
    ready: false,
    reason,
    pr_url: PR_URL,
    ci_rerun: "none",
    threads_checked: false,
    summary: `Not ready: Round ${round}: ${reason}. R6 re-raised.\n${PR_URL}${left}\n\nReview threads on the pull request were not checked.`,
    ...fields,
  };
}

function finding(id: string, round: number, fields: Partial<Finding> = {}): Finding {
  return { id, severity: "blocking", sources: ["code"], claim: `${id} claim`, status: "open", round, ...fields };
}

// A delivery at round 3 or later has run at least three reviews.
function state(findings: Finding[], fields: Partial<ReviewState> = {}): ReviewState {
  return {
    pr_url: PR_URL, round: 0, review_round: Math.max(3, ...findings.map((f) => f.round)), read: true, head: HEAD, is_draft: true,
    checks: [{ name: "Tests", bucket: "pass" }], checks_read: true,
    review_url: `${PR_URL}#issuecomment-1`, review_commit: HEAD,
    findings_read: true, findings, ...fields,
  };
}

// T7 (be #82): round 3 replan, R6 carried from round 2, every open item on R6's evidence.
const t7 = {
  delivery: delivery("replan", 3, ["Required outcome: unmet — R6", "AC-10: unmet — same R6 evidence"]),
  state: state([finding("R1", 1, { status: "fixed" }), finding("R6", 2)]),
  judge: {
    findings: [{ id: "R6", verdict: "narrower", earlier_id: "R6", why: "a narrower trigger of the same invariant" }],
    left_open: [
      { item: "Required outcome: unmet — R6", finding_ids: ["R6"], only_followups: true },
      { item: "AC-10: unmet — same R6 evidence", finding_ids: ["R6"], only_followups: true },
    ],
  } as Judge,
};

// T22 (fe #49): round 4 at the cap, R6 new this round, narrowing R5 of round 3.
const t22 = {
  delivery: delivery("round_cap", 4, ["Required outcome: unmet on R6"]),
  state: state([finding("R5", 3, { status: "fixed" }), finding("R6", 4)]),
  judge: {
    findings: [{ id: "R6", verdict: "narrower", earlier_id: "R5", why: "the once flag added to fix R5" }],
    left_open: [{ item: "Required outcome: unmet on R6", finding_ids: ["R6"], only_followups: true }],
  } as Judge,
};

function declined(input: Parameters<typeof decideFollowUp>[0]): string {
  const d = decideFollowUp(input);
  if (d.kind !== "declined") throw new Error(`expected declined, got ${JSON.stringify(d)}`);
  return d.reason;
}

describe("decideFollowUp", () => {
  for (const reason of ["delivered", "review_open", "needs_human", "implement_blocked", "ci_other", "threads_open"]) {
    test(`a ${reason} ending is not considered`, () => {
      expect(decideFollowUp({ ...t7, delivery: delivery(reason, 4) })).toEqual({ kind: "pass" });
    });
  }

  test("T7: a carried blocker re-raised on a narrower case is followed up", () => {
    const d = decideFollowUp(t7);
    expect(d.kind).toBe("follow");
    if (d.kind !== "follow") return;
    expect(d.round).toBe(3);
    expect(d.followups.map((f) => [f.finding.id, f.judgement.earlier_id])).toEqual([["R6", "R6"]]);
  });

  test("T22: a new id narrowing an earlier round's finding is followed up", () => {
    const d = decideFollowUp(t22);
    expect(d.kind).toBe("follow");
    if (d.kind !== "follow") return;
    expect(d.round).toBe(4);
    expect(d.followups.map((f) => [f.finding.id, f.judgement.earlier_id])).toEqual([["R6", "R5"]]);
  });

  test("a replan before round 3 keeps today's behaviour", () => {
    expect(declined({ ...t7, delivery: delivery("replan", 2, ["Required outcome: unmet — R6", "AC-10: unmet — same R6 evidence"]) }))
      .toBe("the delivery ended at round 2, before round 3");
  });

  test("a summary that names no round keeps today's behaviour", () => {
    expect(declined({ ...t7, delivery: { ...t7.delivery, summary: "Not ready: something else" } }))
      .toBe("the delivery summary names no round");
  });

  test("a missing judge keeps today's behaviour", () => {
    expect(declined({ ...t7, judge: null })).toBe("the follow-up judge did not run");
  });

  test("unread review state keeps today's behaviour", () => {
    expect(declined({ ...t7, state: null })).toBe("the pull request and its review could not be read");
    expect(declined({ ...t7, state: state([], { read: false }) })).toBe("the pull request and its review could not be read");
    expect(declined({ ...t7, state: state([], { findings_read: false }) })).toBe("the review's findings.json could not be read");
  });

  test("no open blocker keeps today's behaviour", () => {
    expect(declined({ ...t7, state: state([finding("R6", 2, { status: "fixed" }), finding("R7", 3, { severity: "note" })]) }))
      .toBe("no blocking finding is open");
  });

  for (const verdict of ["new", "unfixed"]) {
    test(`a blocker the judge calls ${verdict} keeps today's behaviour`, () => {
      const judge = { ...t7.judge, findings: [{ ...t7.judge.findings[0], verdict }] } as Judge;
      expect(declined({ ...t7, judge })).toBe(`the judge found R6 ${verdict}, not a narrower case of an earlier finding`);
    });
  }

  test("a blocker the judge did not judge keeps today's behaviour", () => {
    const s = state([finding("R6", 2), finding("R7", 3)]);
    expect(declined({ ...t7, state: s })).toBe("the judge did not judge R7");
  });

  test("an earlier finding that is not in findings.json keeps today's behaviour", () => {
    const judge = { ...t22.judge, findings: [{ ...t22.judge.findings[0], earlier_id: "R9" }] } as Judge;
    expect(declined({ ...t22, judge })).toBe("R6's earlier finding R9 is not in findings.json");
  });

  test("an earlier finding raised no earlier than the blocker keeps today's behaviour", () => {
    const s = state([finding("R5", 4, { status: "fixed" }), finding("R6", 4)]);
    expect(declined({ ...t22, state: s })).toBe("R6's earlier finding R5 was not raised before R6");
  });

  test("a blocker named as its own earlier finding must have been carried from an earlier round", () => {
    const judge = { ...t22.judge, findings: [{ ...t22.judge.findings[0], earlier_id: "R6" }] } as Judge;
    expect(declined({ ...t22, judge })).toBe("R6's earlier finding R6 was not raised before R6");
  });

  test("a contract blocker raised this round keeps today's behaviour", () => {
    const s = state([finding("R5", 3, { status: "fixed" }), finding("R6", 4, { sources: ["contract"] })]);
    expect(declined({ ...t22, state: s })).toBe("R6 is a contract finding raised in review round 4");
  });

  test("a contract blocker raised in the latest review round keeps today's behaviour when review rounds outrun deliver rounds", () => {
    const s = state([finding("R1", 1, { status: "fixed" }), finding("R6", 2), finding("R7", 5, { sources: ["contract"] })], { review_round: 5 });
    const judge = { ...t7.judge, findings: [...t7.judge.findings, { id: "R7", verdict: "narrower", earlier_id: "R6", why: "x" }] } as Judge;
    expect(declined({ ...t7, state: s, judge })).toBe("R7 is a contract finding raised in review round 5");
  });

  test("a blocker carried from a review round at or after the deliver round can be followed up", () => {
    const s = state([finding("R1", 1, { status: "fixed" }), finding("R6", 4, { sources: ["contract"] })], { review_round: 5 });
    expect(decideFollowUp({ ...t7, state: s }).kind).toBe("follow");
  });

  test("a blocker the judge carries from itself, raised in the latest review round, keeps today's behaviour", () => {
    const s = state([finding("R1", 1, { status: "fixed" }), finding("R6", 5)], { review_round: 5 });
    expect(declined({ ...t7, state: s })).toBe("R6's earlier finding R6 was not raised before R6");
  });

  test("an unread review round keeps today's behaviour", () => {
    expect(declined({ ...t7, state: { ...t7.state, review_round: 0 } })).toBe("the review's round could not be read");
  });

  test("a contract blocker carried from an earlier round can be followed up", () => {
    const s = state([finding("R1", 1, { status: "fixed" }), finding("R6", 2, { sources: ["contract"] })]);
    expect(decideFollowUp({ ...t7, state: s }).kind).toBe("follow");
  });

  test("an open item the judge did not match keeps today's behaviour", () => {
    const d = delivery("replan", 3, ["Required outcome: unmet — R6", "AC-10: unmet — same R6 evidence", "DoD 2: unmet"]);
    expect(declined({ ...t7, delivery: d })).toBe("the open item \"DoD 2: unmet\" is not left open only by followed-up findings");
  });

  test("an open item left open by more than the followed-up findings keeps today's behaviour", () => {
    const judge = { ...t7.judge, left_open: [t7.judge.left_open[0], { ...t7.judge.left_open[1], only_followups: false }] };
    expect(declined({ ...t7, judge })).toBe("the open item \"AC-10: unmet — same R6 evidence\" is not left open only by followed-up findings");
  });

  test("an open item citing a finding that is not an open blocker keeps today's behaviour", () => {
    const judge = { ...t7.judge, left_open: [t7.judge.left_open[0], { ...t7.judge.left_open[1], finding_ids: ["R6", "R1"] }] };
    expect(declined({ ...t7, judge })).toBe("the open item \"AC-10: unmet — same R6 evidence\" is not left open only by followed-up findings");
  });

  test("an open item citing no finding keeps today's behaviour", () => {
    const judge = { ...t7.judge, left_open: [t7.judge.left_open[0], { ...t7.judge.left_open[1], finding_ids: [] }] };
    expect(declined({ ...t7, judge })).toBe("the open item \"AC-10: unmet — same R6 evidence\" is not left open only by followed-up findings");
  });

  test("an open item matches the judge's entry after trimming", () => {
    const judge = { ...t7.judge, left_open: t7.judge.left_open.map((l) => ({ ...l, item: `  ${l.item} ` })) };
    expect(decideFollowUp({ ...t7, judge }).kind).toBe("follow");
  });

  test("red CI keeps today's behaviour", () => {
    const s = { ...t7.state, checks: [{ name: "Tests", bucket: "pass" }, { name: "Lint", bucket: "fail" }] };
    expect(declined({ ...t7, state: s })).toBe("CI check Lint is fail on the pull request head");
  });

  test("cancelled CI keeps today's behaviour", () => {
    const s = { ...t7.state, checks: [{ name: "Tests", bucket: "cancel" }] };
    expect(declined({ ...t7, state: s })).toBe("CI check Tests is cancel on the pull request head");
  });

  test("pending CI keeps today's behaviour", () => {
    const s = { ...t7.state, checks: [{ name: "Tests", bucket: "pass" }, { name: "Build", bucket: "pending" }] };
    expect(declined({ ...t7, state: s })).toBe("CI check Build is still pending on the pull request head");
  });

  test("no CI check keeps today's behaviour", () => {
    expect(declined({ ...t7, state: { ...t7.state, checks: [] } })).toBe("no CI check passed on the pull request head");
    expect(declined({ ...t7, state: { ...t7.state, checks: [{ name: "Docs", bucket: "skipping" }] } }))
      .toBe("no CI check passed on the pull request head");
  });

  test("unread checks keep today's behaviour", () => {
    expect(declined({ ...t7, state: { ...t7.state, checks_read: false } })).toBe("the pull request's CI checks could not be read");
  });

  test("a review of an earlier commit keeps today's behaviour", () => {
    expect(declined({ ...t7, state: { ...t7.state, review_commit: "fedcba9" } }))
      .toBe(`the review comment judged fedcba9, not the pull request head ${HEAD}`);
    expect(declined({ ...t7, state: { ...t7.state, review_commit: "" } }))
      .toBe(`the review comment judged no commit, not the pull request head ${HEAD}`);
  });
});

describe("roundOf", () => {
  test("reads the round the bundled delivery stopped at", () => {
    expect(roundOf("Not ready: Round 4: review_open at the 4-round cap. x")).toBe(4);
    expect(roundOf("Not ready: Round 12: replan. x")).toBe(12);
  });
  test("no round outside the pinned prefix", () => {
    expect(roundOf("Ready: Round 3: delivered.")).toBeNull();
    expect(roundOf("x Not ready: Round 3: replan.")).toBeNull();
    expect(roundOf("")).toBeNull();
  });
});

describe("leftOpenItems", () => {
  test("reads the bullets under the pinned header up to the first blank line", () => {
    const s = String(delivery("replan", 3, ["Required outcome: unmet — R6", "AC-10: unmet"]).summary);
    expect(leftOpenItems(s)).toEqual(["Required outcome: unmet — R6", "AC-10: unmet"]);
  });
  test("an item that wraps onto a further line stays one item", () => {
    expect(leftOpenItems(`x\n\n${LEFT_OPEN}\n- first\ncontinued\n- second\n\ntail`)).toEqual(["first\ncontinued", "second"]);
  });
  test("no header, no items", () => {
    expect(leftOpenItems("Not ready: Round 3: replan. x\nhttps://github.com/o/r/pull/1")).toEqual([]);
  });
});

describe("parseState and parseJudge", () => {
  test("a stubbed state and judge parse", () => {
    expect(parseState(JSON.stringify(t7.state))).toEqual(t7.state);
    expect(parseJudge(JSON.stringify(t7.judge))).toEqual(t7.judge);
  });
  test("a skipped producer's empty binding is null", () => {
    expect(parseState("")).toBeNull();
    expect(parseJudge("")).toBeNull();
  });
  test("a judge with an unknown verdict is null", () => {
    expect(parseJudge(JSON.stringify({ ...t7.judge, findings: [{ id: "R6", verdict: "maybe", earlier_id: "R6", why: "" }] }))).toBeNull();
  });
  test("a state whose findings are malformed is null", () => {
    expect(parseState(JSON.stringify({ ...t7.state, findings: [{ id: "R6" }] }))).toBeNull();
  });
});
