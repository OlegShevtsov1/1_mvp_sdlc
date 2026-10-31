import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSecretNames, redact, runLogged, runUntilExit } from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/exec.ts";

describe("redact", () => {
  test("replaces every occurrence of each named secret's value", () => {
    const env = { TOKEN: "s3cr3t", EMPTY: "", OTHER: "keep" };
    expect(redact("token=s3cr3t and again s3cr3t keep", ["TOKEN", "EMPTY", "MISSING"], env)).toBe(
      "token=*** and again *** keep",
    );
  });
  test("ignores values shorter than 4 characters", () => {
    expect(redact("a1 a1", ["X"], { X: "a1" })).toBe("a1 a1");
  });
});

describe("parseSecretNames", () => {
  test("parses a JSON array", () => {
    expect(parseSecretNames('["A_B","C"]')).toEqual(["A_B", "C"]);
  });
  test("returns [] for anything else", () => {
    expect(parseSecretNames("")).toEqual([]);
    expect(parseSecretNames("nope")).toEqual([]);
  });
});

describe("runLogged", () => {
  test("captures both streams into the log, redacted, and returns the exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-exec-"));
    const logPath = join(dir, "deploy.log");
    process.env.FACTORY_TEST_SECRET = "hunter22";
    const r = await runLogged('echo "out hunter22"; echo "err hunter22" >&2; exit 3', {
      logPath,
      secretNames: ["FACTORY_TEST_SECRET"],
    });
    expect(r).toEqual({ exit_code: 3, timed_out: false });
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("out ***");
    expect(log).toContain("err ***");
    expect(log).not.toContain("hunter22");
  });
  test("redacts a secret split across two chunks of output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-exec-"));
    const logPath = join(dir, "split.log");
    process.env.FACTORY_TEST_SPLIT_SECRET = "hunter2222";
    const r = await runLogged("printf 'tok=hun'; sleep 0.25; printf 'ter2222 done\\n'", {
      logPath,
      secretNames: ["FACTORY_TEST_SPLIT_SECRET"],
      timeoutMs: 10_000,
    });
    expect(r.exit_code).toBe(0);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("tok=*** done");
    expect(log).not.toContain("hunter2222");
  });
  test("times out with exit code 124", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-exec-"));
    const r = await runLogged("sleep 5", { logPath: join(dir, "x.log"), secretNames: [], timeoutMs: 300 });
    expect(r).toEqual({ exit_code: 124, timed_out: true });
  });
  test("a command that exits 124 by itself is not a timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-exec-"));
    const r = await runLogged("exit 124", { logPath: join(dir, "x.log"), secretNames: [], timeoutMs: 10_000 });
    expect(r).toEqual({ exit_code: 124, timed_out: false });
  });
});

describe("runLogged deadline", () => {
  test(
    "kills a command that leaves a background child holding the stdout pipe",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "factory-exec-"));
      const started = Date.now();
      const r = await runLogged("sleep 30 & echo started; wait", {
        logPath: join(dir, "orphan.log"),
        secretNames: [],
        timeoutMs: 300,
      });
      expect(r.exit_code).toBe(124);
      expect(Date.now() - started).toBeLessThan(5_000);
    },
    10_000,
  );
  test(
    "kills a command that ignores SIGTERM",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "factory-exec-"));
      const started = Date.now();
      const r = await runLogged('trap "" TERM; sleep 30', {
        logPath: join(dir, "stubborn.log"),
        secretNames: [],
        timeoutMs: 300,
      });
      expect(r.exit_code).toBe(124);
      expect(Date.now() - started).toBeLessThan(5_000);
    },
    10_000,
  );
});

describe("runUntilExit", () => {
  test("returns when the command exits, while what it backgrounded keeps running and logging", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-exec-"));
    const logPath = join(dir, "start.log");
    const started = Date.now();
    const r = await runUntilExit("echo launched; (sleep 0.3; echo daemon-still-logging; sleep 0.2) &", {
      logPath, secretNames: [], timeoutMs: 10_000,
    });
    expect(r).toEqual({ exit_code: 0, timed_out: false });
    expect(Date.now() - started).toBeLessThan(2_000);
    await Bun.sleep(1_000);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("launched");
    expect(log).toContain("daemon-still-logging");
  });
  test("returns the command's exit code and logs the command line redacted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-exec-"));
    const logPath = join(dir, "start.log");
    process.env.FACTORY_TEST_START_SECRET = "hunter33";
    const r = await runUntilExit("exit 3 # hunter33", { logPath, secretNames: ["FACTORY_TEST_START_SECRET"], timeoutMs: 10_000 });
    expect(r).toEqual({ exit_code: 3, timed_out: false });
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("$ exit 3 # ***");
    expect(log).toContain("[exit 3]");
  });
  test("kills a command that does not return by its deadline, with exit code 124", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-exec-"));
    const started = Date.now();
    const r = await runUntilExit("sleep 30", { logPath: join(dir, "x.log"), secretNames: [], timeoutMs: 300 });
    expect(r).toEqual({ exit_code: 124, timed_out: true });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
