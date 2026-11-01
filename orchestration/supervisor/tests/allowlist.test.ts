import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchReleaseStep, RELEASE_SUBCOMMANDS, readStep } from "../src/allowlist.ts";

const CWD = "/home/operator/.archon/workspaces/OlegShevtsov1/1_mvp_sdlc/post-merge/20261101T072956Z-2602916/repo";
const OPTS = { cwd: CWD, subcommands: RELEASE_SUBCOMMANDS };
type Steps = { steps: { n: string; title: string; text: string }[] };
const fixture = (f: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", f), "utf8")) as Steps;
const RELEASE_SH = fixture("steps-8275c6ec-release-sh.json");
const FREE_FORM = fixture("steps-8275c6ec.json");
const text = (steps: Steps, n: string) => steps.steps.find((s) => s.n === n)?.text ?? "";
const A = ["1", "2", "3", "4"];
const SUBCOMMAND: Record<string, string> = { 1: "merge-release-pr", 2: "tag", 3: "mirror", 4: "install" };

// A step of the runbook template whose command block is `lines`.
const step = (...lines: string[]) =>
  `**A2 — 🔒 Tag**\n\n\`\`\`bash\n${lines.join("\n")}\n\`\`\`\n\nExpected:\n- manual: it exits 0\n  and prints ok`;
const TAG = "bash scripts/release.sh tag v0.9.3";
const withLine = (t: string, line: string) => t.replace("\n```\n\nExpected:", `\n${line}\n\`\`\`\n\nExpected:`);
const reason = (t: string) => {
  const m = matchReleaseStep(t, OPTS);
  return m.ok ? "" : m.reason;
};

describe("matchReleaseStep", () => {
  test("the release.sh A1–A4 match, naming the entry of each command", () => {
    for (const n of A) {
      const m = matchReleaseStep(text(RELEASE_SH, n), OPTS);
      if (!m.ok) throw new Error(`A${n}: ${m.reason}`);
      expect(m.matched).toContainEqual({ command: `cd ${CWD}`, entry: "cd run worktree" });
      expect(m.matched).toContainEqual({ command: "git fetch origin --tags", entry: "read-only git fetch" });
      expect(m.matched).toContainEqual({
        command: `bash scripts/release.sh ${SUBCOMMAND[n]} v0.9.3`, entry: `release.sh ${SUBCOMMAND[n]}`,
      });
    }
  });

  test("the free-form v0.9.3 steps do not match", () => {
    for (const s of FREE_FORM.steps) expect(matchReleaseStep(s.text, OPTS).ok).toBe(false);
  });

  test("a destructive line next to the release line fails, naming the token", () => {
    for (const n of A) {
      expect(reason(withLine(text(RELEASE_SH, n), "git push --force origin v0.9.3"))).toContain("«--force»");
      expect(reason(withLine(text(RELEASE_SH, n), "rm -rf /tmp/x"))).toContain("«rm»");
    }
    expect(reason(step(TAG, "git fetch origin --tags && git reset --hard origin/main"))).toContain("«reset»");
    expect(reason(step(TAG, "git fetch origin --force-with-lease"))).toContain("--force");
  });

  test("read-only commands, assignments and the run's cd may surround the release line", () => {
    const m = matchReleaseStep(step(
      `cd ${CWD} && git fetch origin --tags --prune`,
      "M=v0.9.3; rc=$?",
      TAG,
      "echo \"rc=$?\"",
      "git log -1 --format=%s \"$M\" | grep -c Merge",
      "gh pr view 111 -R o/r --json state --jq .state",
      "gh pr checks 111 -R o/r 2>&1",
      "gh api repos/o/r/releases --jq length >/dev/null",
      "gh api -X GET repos/o/r/git/ref/tags/v0.9.3",
      "git show origin/develop:CHANGELOG.md | grep -cE '^## \\[0\\.9\\.3\\]'",
      "test \"$M\" = v0.9.3 && echo same",
      "cat CHANGELOG.md | jq -r . || echo no-json",
      "# a comment line",
    ), OPTS);
    if (!m.ok) throw new Error(m.reason);
    expect(m.matched.map((c) => c.entry)).toEqual([
      "cd run worktree", "read-only git fetch", "assignment", "assignment", "release.sh tag", "read-only echo",
      "read-only git log", "read-only grep", "read-only gh pr view", "read-only gh pr checks", "read-only gh api GET",
      "read-only gh api GET", "read-only git show", "read-only grep", "read-only test", "read-only echo",
      "read-only cat", "read-only jq", "read-only echo",
    ]);
  });

  test("an unknown or write command fails", () => {
    for (const line of [
      "gh pr merge 120 --merge", "git push origin v0.9.3", "git tag -a v0.9.3 -m x HEAD", "curl -X POST https://x",
      "ssh host true", "terraform apply", "kamal deploy", "bash install.sh", "./scripts/release.sh tag v0.9.3",
      "timeout 60 bash scripts/release.sh tag v0.9.3", "git ls-remote origin", "gh release create v0.9.3",
    ]) {
      expect(reason(step(TAG, line))).toContain("не в allowlist");
    }
  });

  test("the cd must name the run's own worktree", () => {
    expect(reason(step("cd /tmp/elsewhere", TAG))).toContain("не в allowlist: cd /tmp/elsewhere");
    expect(reason(step("cd", TAG))).toContain("не в allowlist");
  });

  test("exactly one release line, with a known subcommand and a v-semver version", () => {
    expect(reason(step(TAG, "bash scripts/release.sh install v0.9.3"))).toContain("рядків bash scripts/release.sh: 2");
    expect(reason(step("git fetch origin --tags"))).toContain("рядків bash scripts/release.sh: 0");
    for (const line of [
      "bash scripts/release.sh publish v0.9.3", "bash scripts/release.sh tag 0.9.3",
      "bash scripts/release.sh tag v0.9.3-rc1", "bash scripts/release.sh tag v0.09.3",
      "bash scripts/release.sh tag v0.9.3 --dry-run", "bash scripts/release.sh tag \"$V\"",
    ]) {
      expect(reason(step(line))).toContain("не в allowlist");
    }
    expect(matchReleaseStep(step(TAG), { cwd: CWD, subcommands: ["install"] }).ok).toBe(false);
  });

  test("substitutions, subshells, globs, file redirections and odd quoting are unparsable", () => {
    for (const line of [
      "P=$(gh pr view 1 --json mergeCommit)", "echo `id`", "echo \"$(id)\"", "echo \"`id`\"", "echo hi > out.txt",
      "cat < /etc/passwd", "(cd /tmp && echo hi)", "{ echo hi; }", "echo hi &", "echo 'unterminated",
      "echo \"unterminated", "cat <<EOF", "git log *", "echo $HOME", "echo \"${X:--XPOST}\"", "echo $'\\x2d'",
      "echo hi |& cat", "echo hi # trailing", "echo hi;; echo", "git log ${M}",
    ]) {
      expect(reason(step(TAG, line))).toContain("не розібрано");
    }
  });

  test("assignments cannot change what later commands run", () => {
    for (const line of [
      "PATH=/tmp/evil:/usr/bin", "BASH_ENV=/tmp/x", "GIT_SSH_COMMAND=evil", "IFS=x", "X=--upload-pack=evil",
      "NAME=v bash scripts/release.sh tag v0.9.3",
    ]) {
      expect(reason(step(line, TAG))).not.toBe("");
    }
    expect(reason(step("NAME=v bash scripts/release.sh tag v0.9.3"))).toContain("не в allowlist");
  });

  test("a variable can reach git or gh only as a whole word the step assigned", () => {
    const words = "слово зі змінною";
    for (const line of [
      "git log -1 \"$A--output=scripts/release.sh\"", "gh api \"$A-XDELETE\" repos/o/r/git/refs/tags/v0.9.3",
      "git fetch \"$A-f\" origin", "git log \"-$A\"", "git log \"$A\"x", "git log \"$B\"", "gh pr view \"$HOME\"",
    ]) {
      expect(reason(step("A=", TAG, line))).toContain(words);
    }
    for (const line of ["B=\"$A-f\"", "B=\"$A\"", "B=x\"$A\""]) {
      expect(reason(step("A=", line, TAG))).toContain("присвоєння не дозволене");
    }
    const m = matchReleaseStep(step("M=v0.9.3; rc=$?", TAG, "git log \"$M\" \"$rc\"", "echo \"-$Z$M\""), OPTS);
    if (!m.ok) throw new Error(m.reason);
  });

  test("gh api is read-only only as a GET without fields", () => {
    for (const line of [
      "gh api -X POST repos/o/r/git/refs", "gh api -XPOST repos/o/r/git/refs", "gh api --method=PATCH repos/o/r",
      "gh api --method POST repos/o/r", "gh api repos/o/r/issues -F title=x", "gh api repos/o/r --raw-field a=b",
      "gh api repos/o/r --input body.json", "gh api -iXPOST repos/o/r", "gh api repos/o/r -f a=b",
    ]) {
      expect(reason(step(TAG, line))).not.toBe("");
    }
    expect(reason(step(TAG, "gh api repos/x/y/releases --jq length"))).toBe("");
  });

  test("git is read-only only through its read subcommands and without write options", () => {
    for (const line of [
      "git -C /x log", "git -c core.pager=evil log", "git diff --output=/tmp/x", "git log --outp=/tmp/x",
      "git fetch --upload-pack=evil origin", "git show --exec=evil",
    ]) {
      expect(reason(step(TAG, line))).not.toBe("");
    }
  });

  test("prose outside the block, two blocks, or no block fails", () => {
    const shape = "крок не має форми";
    expect(reason(`**A2**\n\nRun this as root first.\n\n\`\`\`bash\n${TAG}\n\`\`\`\n\nExpected:\n- manual: ok`))
      .toContain(shape);
    expect(reason(`${step(TAG)}\n\nThen also run it twice.`)).toContain(shape);
    expect(reason(`**A2**\n\n\`\`\`bash\n${TAG}\n\`\`\`\n\n\`\`\`bash\necho hi\n\`\`\``)).toContain(shape);
    expect(reason(`**A2**\n\n${TAG}`)).toContain(shape);
    expect(reason(`**A2**\n\n\`\`\`bash\n${TAG}`)).toContain(shape);
    expect(reason(`**A2**\n\nExpected:\n- manual: ok\n\n\`\`\`bash\n${TAG}\n\`\`\``)).toContain(shape);
  });
});

test("RELEASE_SUBCOMMANDS are the subcommands scripts/release.sh accepts", () => {
  const script = readFileSync(join(import.meta.dir, "..", "..", "..", "scripts", "release.sh"), "utf8");
  const accepted = script.match(/^case "\$\{cmd\}" in (.+?)\) ;; \*\) usage ;; esac$/m)?.[1];
  expect(accepted?.split(" | ").sort()).toEqual([...RELEASE_SUBCOMMANDS].sort());
});

describe("readStep", () => {
  const home = mkdtempSync(join(tmpdir(), "supervisor-allowlist-"));
  const before = process.env.ARCHON_HOME;
  process.env.ARCHON_HOME = home;
  afterAll(() => {
    if (before === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = before;
    rmSync(home, { recursive: true, force: true });
  });
  const runId = "8275c6ec-780e-44c4-98cc-b8e5bac0e0dc";
  const cwd = "/x/.archon/workspaces/OlegShevtsov1/1_mvp_sdlc/post-merge/20261101T072956Z-2602916/repo";

  test("readStep reads step n from the run's steps.json, undefined when it cannot", () => {
    expect(readStep(runId, cwd, "2")).toBeUndefined();
    const dir = join(home, "workspaces", "OlegShevtsov1", "1_mvp_sdlc", "artifacts", "runs", runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "steps.json"), JSON.stringify(RELEASE_SH));
    expect(readStep(runId, cwd, "2")).toEqual({ n: "2", title: RELEASE_SH.steps[2].title, text: text(RELEASE_SH, "2") });
    expect(readStep(runId, cwd, "42")).toBeUndefined();
    expect(readStep(runId, "/tmp/not-a-workspace", "2")).toBeUndefined();
    writeFileSync(join(dir, "steps.json"), "{not json");
    expect(readStep(runId, cwd, "2")).toBeUndefined();
  });
});
