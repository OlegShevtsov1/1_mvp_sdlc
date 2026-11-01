import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { housekeep } from "../src/housekeeping.ts";

const HOUR = 60 * 60 * 1000;

describe("housekeep", () => {
  test("removes only matching entries older than 24h", () => {
    const now = Date.now();
    const base = mkdtempSync(join(tmpdir(), "supervisor-housekeeping-"));
    const cache = join(base, "orchestration-tests");
    const tmp = join(base, "tmp");
    const make = (path: string, ageHours: number, dir: boolean) => {
      if (dir) {
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, "leftover.txt"), "x");
      } else {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "x");
      }
      const t = new Date(now - ageHours * HOUR);
      utimesSync(path, t, t);
    };
    make(join(cache, "run-old"), 25, true);
    make(join(cache, "run-fresh"), 23, true);
    make(join(cache, "keep-old"), 25, true);
    make(join(tmp, "bun-old.sock"), 30, false);
    make(join(tmp, "other-old"), 30, false);

    const removed = housekeep(now, [
      { dir: cache, prefix: "run-" },
      { dir: tmp, prefix: "bun-" },
      { dir: join(base, "missing"), prefix: "run-" },
    ]);

    expect(removed).toBe(2);
    expect(existsSync(join(cache, "run-old"))).toBe(false);
    expect(existsSync(join(tmp, "bun-old.sock"))).toBe(false);
    expect(existsSync(join(cache, "run-fresh"))).toBe(true);
    expect(existsSync(join(cache, "keep-old"))).toBe(true);
    expect(existsSync(join(tmp, "other-old"))).toBe(true);
  });
});
