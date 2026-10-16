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
