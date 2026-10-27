import { describe, expect, test } from "bun:test";
import { parseGate, roundVerdict } from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/gate.ts";

describe("parseGate", () => {
  test("reads a real gate document", () => {
    expect(parseGate('{"decision":"needs-revision","text":"use flyctl"}')).toEqual({
      decision: "needs-revision",
      text: "use flyctl",
    });
  });
  test("treats the dry-run string 'approved' as approve", () => {
    expect(parseGate("approved")).toEqual({ decision: "approve", text: "" });
  });
  test("returns an empty decision for empty input", () => {
    expect(parseGate("")).toEqual({ decision: "", text: "" });
  });
});

describe("roundVerdict", () => {
  test("approve proceeds", () => {
    expect(roundVerdict('{"decision":"approve","text":""}')).toEqual({
      proceed: true,
      decision: "approve",
      stop_reason: "",
    });
  });
  test("abort stops with the operator's words", () => {
    expect(roundVerdict('{"decision":"abort","text":"not today"}')).toEqual({
      proceed: false,
      decision: "abort",
      stop_reason: "operator chose abort: not today",
    });
  });
});

describe("roundVerdict with a saved decision (PILOT-217)", () => {
  test("the saved decision wins over a loop output without one", () => {
    expect(roundVerdict('{"ready":true,"summary":"plan"}', "approve").proceed).toBe(true);
  });
  test("a saved abort stops even if the output looks approved", () => {
    expect(roundVerdict("approved", "abort")).toEqual({ proceed: false, decision: "abort", stop_reason: "operator chose abort:" });
  });
  test("no saved decision keeps the old behaviour", () => {
    expect(roundVerdict("approved", "").proceed).toBe(true);
  });
});
