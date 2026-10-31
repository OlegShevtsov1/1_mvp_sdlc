import { describe, expect, test } from "bun:test";
import {
  deliveredByEarlierMerge, isManualBase, isMergeConflict, leftoverPaths, originRepo, parseFlakyPatterns, parseManualMergeBases,
  refusalReason,
} from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/merge-decision.ts";

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

describe("refusalReason", () => {
  test("prefixes the class and keeps the reason on one line", () => {
    expect(refusalReason("conflict", "the pull request is not mergeable")).toBe("conflict: the pull request is not mergeable");
    expect(refusalReason("failure", "gh pr edit exited 1:\nHTTP 502\r\n  Bad Gateway\n")).toBe("failure: gh pr edit exited 1: HTTP 502 Bad Gateway");
  });
});

describe("leftoverPaths", () => {
  test("keeps only ignored entries whose last component is __pycache__ or .terraform", () => {
    const listing = ["app/__pycache__/", "app/", "node_modules/", "x__pycache__/", "infra/mod/.terraform/", ".terraform/", ".env", ".tools/", ""].join("\0");
    expect(leftoverPaths(listing)).toEqual(["app/__pycache__/", "infra/mod/.terraform/", ".terraform/"]);
  });
  test("an empty listing has no leftovers", () => {
    expect(leftoverPaths("")).toEqual([]);
  });
});

describe("parseFlakyPatterns", () => {
  test("reads a JSON list of strings", () => {
    expect(parseFlakyPatterns('["tokenStore"]')).toEqual(["tokenStore"]);
    expect(parseFlakyPatterns("[]")).toEqual([]);
    expect(parseFlakyPatterns('["a", 7, null, ""]')).toEqual(["a"]);
  });
  test("an unreadable binding reruns nothing", () => {
    for (const raw of ["", "not json", "{}", '"tokenStore"']) expect(parseFlakyPatterns(raw)).toEqual([]);
  });
});

describe("isMergeConflict", () => {
  test("gh's conflict wordings or a CONFLICTING re-read are a conflict", () => {
    expect(isMergeConflict("GraphQL: Pull Request has merge conflicts (mergePullRequest)", "UNKNOWN")).toBe(true);
    expect(isMergeConflict("X Pull request example/repo#3 is not mergeable: the merge commit cannot be cleanly created.", "MERGEABLE")).toBe(true);
    expect(isMergeConflict("HTTP 502", "CONFLICTING")).toBe(true);
  });
  test("any other refusal is not", () => {
    expect(isMergeConflict("X Pull request example/repo#3 is not mergeable: the base branch policy prohibits the merge.", "MERGEABLE")).toBe(false);
    expect(isMergeConflict("", "")).toBe(false);
  });
});

describe("originRepo", () => {
  test("normalises ssh, https and token-bearing remote URLs to owner/repo", () => {
    expect(originRepo("git@github.com:o/r.git")).toBe("o/r");
    expect(originRepo("https://github.com/o/r")).toBe("o/r");
    expect(originRepo("https://x:tok@github.com/o/r.git")).toBe("o/r");
    expect(originRepo("/tmp/remote/example/repo.git")).toBe("example/repo");
  });
  test("keeps the last two components of a longer path, as the bash it replaced did", () => {
    expect(originRepo("https://github.com/o/r/extra")).toBe("r/extra");
  });
  test("a URL that does not end in owner/repo resolves to nothing", () => {
    for (const url of ["", "o/r with space", "repo", "https://github.com/o/", "o$/r"]) expect(originRepo(url)).toBeNull();
  });
});

describe("deliveredByEarlierMerge", () => {
  test("only a MERGED pull request at the checkout, or whose merge commit introduced it", () => {
    expect(deliveredByEarlierMerge({ state: "MERGED", checkout_is_head: true })).toBe(true);
    expect(deliveredByEarlierMerge({ state: "MERGED", checkout_is_head: false, merge_contains_checkout: true })).toBe(true);
    expect(deliveredByEarlierMerge({ state: "MERGED", checkout_is_head: false, merge_contains_checkout: false })).toBe(false);
    expect(deliveredByEarlierMerge({ state: "MERGED" })).toBe(false);
    expect(deliveredByEarlierMerge({ state: "OPEN", checkout_is_head: true, merge_contains_checkout: true })).toBe(false);
    expect(deliveredByEarlierMerge({ state: "CLOSED", checkout_is_head: true })).toBe(false);
  });
});
