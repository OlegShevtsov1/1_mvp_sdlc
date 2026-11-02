import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { ledgerPath } from "./ledger.ts";
import type { RunView } from "./runs.ts";

// The policy answers only approve and retry; the operator's Telegram buttons also skip, abort, reject a PR or QA card,
// or accept the work on dev (`ok`, the QA dev wait's own option).
export const RESPOND_ACTIONS = ["approve", "retry", "skip", "abort", "reject", "ok"] as const;

export type RespondAction = (typeof RESPOND_ACTIONS)[number];

export const isRespondAction = (action: string | undefined): action is RespondAction =>
  RESPOND_ACTIONS.some((a) => a === action);

export type Decision = {
  action: RespondAction | "resume" | "launch-post-merge" | "launch-task" | "escalate" | "none";
  text: string;
  rule: string;
};

// `archon workflow respond|resume|run` runs the resumed workflow in the foreground for hours: the child gets its own
// session and no stdin, and is never wrapped in `timeout`. It gets the supervisor's environment, whose PATH is the
// unit's Environment=PATH= (the operator's toolchains); passed explicitly because Bun's default is the environment
// captured at process start.
export function runDetached(argv: string[], cwd: string, logFile: string): void {
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  try {
    Bun.spawn(["setsid", ...argv], { cwd, env: process.env, stdin: "ignore", stdout: fd, stderr: fd }).unref();
  } finally {
    closeSync(fd);
  }
}

// `--occurrence` pins the answer to the pause the policy judged: if the operator answered it first, Archon refuses.
// Without it the answer could land on a later pause, so a pause with no occurrence is not answered. The text goes after
// `--`: an operator's reason may start with `-`, which Archon would otherwise refuse as an unknown option.
export function respondArgv(run: RunView, d: Decision): string[] {
  if (!isRespondAction(d.action)) {
    throw new Error(`respond carries only ${RESPOND_ACTIONS.join(", ")}, not ${d.action}`);
  }
  const occurrence = run.pause?.occurrence;
  if (!occurrence) throw new Error(`run ${run.id} has no pause occurrence to pin the answer to`);
  return ["archon", "workflow", "respond", run.id, d.action, "--occurrence", occurrence, "--", d.text];
}

// Archon resolves the run from the repository it is started in, so respond runs in the run's own worktree.
export function respond(run: RunView, d: Decision): void {
  runDetached(respondArgv(run, d), run.cwd, join(dirname(ledgerPath()), "logs", `${run.id}.log`));
}
