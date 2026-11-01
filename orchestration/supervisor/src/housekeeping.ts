import { lstatSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SweepRoot = { dir: string; prefix: string };

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Test scratch: `1_mvp_prompt/orchestration/test-preload.ts` makes each run's TMPDIR a `run-*` dir, bun leaves `bun-*`.
export const HOUSEKEEPING_ROOTS: SweepRoot[] = [
  { dir: join(homedir(), ".cache", "orchestration-tests"), prefix: "run-" },
  { dir: "/tmp", prefix: "bun-" },
];

// Returns how many entries it removed; an entry it cannot remove is left for the next sweep.
export function housekeep(now = Date.now(), roots = HOUSEKEEPING_ROOTS): number {
  let removed = 0;
  for (const root of roots) {
    let names: string[];
    try {
      names = readdirSync(root.dir);
    } catch {
      continue;
    }
    for (const name of names.filter((n) => n.startsWith(root.prefix))) {
      const path = join(root.dir, name);
      try {
        if (now - lstatSync(path).mtimeMs <= MAX_AGE_MS) continue;
        rmSync(path, { recursive: true, force: true });
        removed++;
      } catch {
        // Owned by another user or gone meanwhile.
      }
    }
  }
  return removed;
}
