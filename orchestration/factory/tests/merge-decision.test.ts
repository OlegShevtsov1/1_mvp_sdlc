import { describe, expect, test } from "bun:test";
import { isManualBase, parseManualMergeBases } from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/merge-decision.ts";

describe("parseManualMergeBases", () => {
  test("reads a JSON list of branch names", () => {
    expect(parseManualMergeBases('["main"]')).toEqual(["main"]);
    expect(parseManualMergeBases("[]")).toEqual([]);
    expect(parseManualMergeBases('["main","release"]')).toEqual(["main", "release"]);
  });
  test("an unreadable binding falls back to main", () => {
    for (const raw of ["", "not json", "{}"]) expect(parseManualMergeBases(raw)).toEqual(["main"]);
  });
  test("drops elements that are not strings", () => {
    expect(parseManualMergeBases('["main", 7, null]')).toEqual(["main"]);
  });
});

describe("isManualBase", () => {
  test("matches the base exactly against the list", () => {
    expect(isManualBase("main", ["main"])).toBe(true);
    expect(isManualBase("develop", ["main"])).toBe(false);
    expect(isManualBase("main", [])).toBe(false);
    expect(isManualBase("", ["main"])).toBe(false);
  });
});
