import { resolve } from "node:path";
import { redact, secretNamesFor } from "./exec.ts";
import { parseJsonObject } from "./io.ts";

// A child run of a sibling script (pr-state.ts, merge-gate.ts, …) with the node's own bindings plus
// env; its last stdout line, or null when it reported nothing readable. Every step goes to log.
export function runChild(
  script: string,
  env: Record<string, string>,
  timeoutMs: number,
  log: (line: string) => void,
): Record<string, unknown> | null {
  const p = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "..", script)], {
    env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", timeout: timeoutMs,
  });
  const stderr = redact(p.stderr.toString().trim(), secretNamesFor());
  if (stderr !== "") log(`${script} stderr: ${stderr}`);
  const doc = parseJsonObject(p.stdout.toString().trim().split("\n").at(-1) ?? "");
  log(`${script}: ${doc === null ? `no report (exit ${p.exitCode})` : JSON.stringify(doc)}`);
  return doc;
}
