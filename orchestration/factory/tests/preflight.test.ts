import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPreflight, CONNECT_TIMEOUT_MS, parsePreflight, POLL_WINDOW_MS, PREFLIGHT_STATUSES, PREFLIGHT_TIMEOUT_MS, type PreflightDeps,
  preflightMessage, runPreflight, START_TIMEOUT_MS, tcpOpen,
} from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/host-check.ts";
import { MAX_PREFLIGHT_SERVICES, type PreflightConfig } from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/profile.ts";

const PACK = join(import.meta.dir, "..", ".archon", "workflows", "sdlc-factory", "factory");
const SCRIPT = join(PACK, "scripts", "preflight.ts");
const FAST = { pollWindowMs: 300, pollIntervalMs: 50 };

function config(extra: Partial<PreflightConfig> = {}): PreflightConfig {
  return { tools: [], services: [], min_disk_free_pct: 0, ...extra };
}

// Fake host: `up` holds the ports that answer; every call is counted.
function fakeHost(over: Partial<PreflightDeps> & { up?: Set<number>; onPath?: string[]; disk?: number[] } = {}) {
  const calls = { start: [] as string[], cleanup: 0, freePct: 0, sleep: 0 };
  const up = over.up ?? new Set<number>();
  const disk = over.disk ?? [50];
  const deps: PreflightDeps = {
    which: (t) => (over.onPath ?? []).includes(t),
    tcpOpen: async (_host, port) => up.has(port),
    freePct: () => disk[Math.min(calls.freePct++, disk.length - 1)],
    cleanup: () => { calls.cleanup++; },
    start: async (command) => { calls.start.push(command); return { exit_code: 0, timed_out: false }; },
    sleep: async (ms) => { calls.sleep++; await Bun.sleep(ms); },
    now: () => Date.now(),
    log: () => {},
    logName: "preflight.log",
    cwd: "/work",
    ...over,
  };
  return { deps, calls, up };
}

describe("runPreflight", () => {
  test("every tool on PATH passes; missing ones are one problem naming them all and the PATH fix", async () => {
    const { deps } = fakeHost({ onPath: ["gh", "jq"] });
    expect(await runPreflight(config({ tools: ["gh", "jq"] }), deps, FAST)).toEqual({ ok: true, problems: [] });
    const r = await runPreflight(config({ tools: ["gh", "bundle", "jq", "ruby"] }), deps, FAST);
    expect(r).toEqual({
      ok: false,
      problems: ["tools not on PATH: bundle, ruby — install them on the Archon host or put them on the PATH of the shell that starts Archon"],
    });
  });

  test("a service that answers passes and is never started", async () => {
    const { deps, calls } = fakeHost({ up: new Set([5432]) });
    const r = await runPreflight(config({ services: [{ name: "postgres", tcp: "localhost:5432", start: "start-pg" }] }), deps, FAST);
    expect(r.ok).toBe(true);
    expect(calls.start).toEqual([]);
  });

  test("a down service without a start command is a problem", async () => {
    const { deps } = fakeHost();
    const r = await runPreflight(config({ services: [{ name: "postgres", tcp: "localhost:5432", start: "" }] }), deps, FAST);
    expect(r.problems).toEqual([
      "service postgres (localhost:5432) does not answer — the profile gives no start command; start it on the Archon host",
    ]);
  });

  test("a down service its start command brings up passes, started exactly once", async () => {
    const listeners: ReturnType<typeof Bun.listen>[] = [];
    const port = await freePort();
    const { deps, calls } = fakeHost({
      tcpOpen: (host, p) => tcpOpen(host, p, CONNECT_TIMEOUT_MS),
      start: async (command) => {
        calls.start.push(command);
        listeners.push(Bun.listen({ hostname: "localhost", port, socket: { data() {} } }));
        return { exit_code: 0, timed_out: false };
      },
    });
    try {
      const r = await runPreflight(config({ services: [{ name: "redis", tcp: `localhost:${port}`, start: "start-redis" }] }), deps, FAST);
      expect(r).toEqual({ ok: true, problems: [] });
      expect(calls.start).toEqual(["start-redis"]);
    } finally {
      for (const l of listeners) l.stop(true);
    }
  });

  test("a started service that comes up during the poll window passes", async () => {
    const { deps, calls, up } = fakeHost();
    deps.sleep = async () => { calls.sleep++; if (calls.sleep === 2) up.add(6379); };
    const r = await runPreflight(config({ services: [{ name: "redis", tcp: "localhost:6379", start: "start-redis" }] }), deps, FAST);
    expect(r.ok).toBe(true);
    expect(calls.start.length).toBe(1);
  });

  test("a service still down after its start command and the poll window is a problem, started exactly once", async () => {
    const { deps, calls } = fakeHost();
    const r = await runPreflight(config({ services: [{ name: "redis", tcp: "localhost:6379", start: "start-redis" }] }), deps, FAST);
    expect(r.problems).toEqual([
      "service redis (localhost:6379) still does not answer 0.3 s after its start command `start-redis` — start it by hand on the Archon host",
    ]);
    expect(calls.start).toEqual(["start-redis"]);
    expect(calls.sleep).toBeGreaterThan(0);
  });

  test("a start command that fails or does not return is a problem at once, without polling", async () => {
    for (const [result, problem] of [
      [{ exit_code: 3, timed_out: false }, "its start command exited 3 (see preflight.log) — fix the start command or start the service by hand"],
      [
        { exit_code: 124, timed_out: true },
        `its start command did not return within ${START_TIMEOUT_MS / 1000} s (see preflight.log) — use a start command that returns once the service is launched, such as \`docker compose up -d\`, or start the service by hand`,
      ],
    ] as const) {
      const { deps, calls } = fakeHost({ start: async () => result });
      const r = await runPreflight(config({ services: [{ name: "db", tcp: "h:5432", start: "start-db" }] }), deps, FAST);
      expect(r.problems).toEqual([`service db (h:5432) does not answer and ${problem}`]);
      expect(calls.sleep).toBe(0);
    }
  });

  test("low disk runs the leftovers cleanup once and passes when it recovers", async () => {
    const { deps, calls } = fakeHost({ disk: [12, 25] });
    expect(await runPreflight(config({ min_disk_free_pct: 20 }), deps, FAST)).toEqual({ ok: true, problems: [] });
    expect(calls.cleanup).toBe(1);
    expect(calls.freePct).toBe(2);
  });

  test("disk still low after the cleanup is a problem naming the share, the threshold and df -h", async () => {
    const { deps, calls } = fakeHost({ disk: [12.7, 13.9] });
    const r = await runPreflight(config({ min_disk_free_pct: 20 }), deps, FAST);
    expect(r.problems).toEqual([
      "only 13% of the disk holding /work is free, below stack.preflight.min_disk_free_pct 20, after removing build leftovers — free space there (df -h /work)",
    ]);
    expect(calls.cleanup).toBe(1);
  });

  test("enough disk never cleans up; min_disk_free_pct 0 never measures", async () => {
    const enough = fakeHost({ disk: [20] });
    expect((await runPreflight(config({ min_disk_free_pct: 20 }), enough.deps, FAST)).ok).toBe(true);
    expect(enough.calls.cleanup).toBe(0);
    const off = fakeHost({ disk: [1] });
    expect((await runPreflight(config({ min_disk_free_pct: 0 }), off.deps, FAST)).ok).toBe(true);
    expect(off.calls.freePct).toBe(0);
  });

  test("every failing check is reported in one message", async () => {
    const { deps } = fakeHost({ disk: [5] });
    const r = await runPreflight(
      config({ tools: ["bundle"], services: [{ name: "postgres", tcp: "localhost:5432", start: "" }], min_disk_free_pct: 20 }),
      deps,
      FAST,
    );
    expect(r.problems.length).toBe(3);
    const message = preflightMessage(r.problems);
    expect(message).toStartWith("preflight: tools not on PATH: bundle");
    expect(message).toContain("; only 5% of the disk");
    expect(message).toContain("; service postgres (localhost:5432) does not answer");
    expect(message).toEndWith(".");
    expect(message).not.toContain("\n");
  });
});

async function freePort(): Promise<number> {
  const l = Bun.listen({ hostname: "localhost", port: 0, socket: { data() {} } });
  const port = l.port;
  l.stop(true);
  return port;
}

describe("tcpOpen", () => {
  test("answers true for a listening port and false once it is closed", async () => {
    const l = Bun.listen({ hostname: "localhost", port: 0, socket: { data() {} } });
    const port = l.port;
    expect(await tcpOpen("localhost", port, 1000)).toBe(true);
    l.stop(true);
    expect(await tcpOpen("localhost", port, 1000)).toBe(false);
  });
});

describe("parsePreflight", () => {
  test("only an empty binding means no block", () => {
    expect(parsePreflight("")).toBeNull();
  });

  test("any other binding that is not a valid block is an error, not a skip", () => {
    expect(parsePreflight("not json")).toEqual({ error: "it is not JSON" });
    for (const raw of ["null", "[]", '"x"']) expect(parsePreflight(raw)).toHaveProperty("error");
    expect(parsePreflight(JSON.stringify({ services: [{ name: "db" }], min_disk_free_pct: "20" }))).toEqual({
      error: "stack.preflight.services[0].tcp is required; stack.preflight.min_disk_free_pct must be a whole number from 0 to 99",
    });
  });

  test("absent fields take the profile's defaults", () => {
    expect(parsePreflight("{}")).toEqual({ tools: [], services: [], min_disk_free_pct: 20 });
  });

  test("reads load-profile's preflight object", () => {
    const cfg = { tools: ["jq"], services: [{ name: "db", tcp: "localhost:5432", start: "" }], min_disk_free_pct: 20 };
    expect(parsePreflight(JSON.stringify(cfg))).toEqual(cfg);
  });
});

describe("checkPreflight", () => {
  test("no block skips the host; an unreadable binding fails without touching it", async () => {
    let built = 0;
    const deps = () => { built++; return fakeHost().deps; };
    expect(await checkPreflight("", deps)).toBeNull();
    const r = await checkPreflight("{not json", deps);
    expect(r).toEqual({
      ok: false,
      problems: ["the stack.preflight binding from load-profile is unreadable (it is not JSON) — check stack.preflight in .archon/factory-profile.yaml and the load-profile output in the run log"],
    });
    expect(built).toBe(0);
  });
});

describe("preflight.ts", () => {
  function run(binding: string | undefined) {
    const artifacts = mkdtempSync(join(tmpdir(), "factory-preflight-art-"));
    const env: Record<string, string> = { ...process.env, ARTIFACTS_DIR: artifacts, INPUTS_SECRET_NAMES: "[]" } as Record<string, string>;
    if (binding === undefined) delete env.INPUTS_PREFLIGHT;
    else env.INPUTS_PREFLIGHT = binding;
    const p = Bun.spawnSync(["bun", SCRIPT], { cwd: artifacts, env, stdout: "pipe", stderr: "pipe" });
    const lines = p.stdout.toString().trim().split("\n").filter((l) => l !== "");
    return { code: p.exitCode, lines, doc: lines.length === 1 ? JSON.parse(lines[0]) : {}, artifacts };
  }

  test("a profile without a block is skipped", () => {
    for (const binding of ["", undefined]) {
      const r = run(binding);
      expect(r.code).toBe(0);
      expect(r.lines.length).toBe(1);
      expect(r.doc).toEqual({ status: "skipped", problems: [], message: "" });
    }
  });

  test("a missing tool fails with one line naming it, and the steps are logged", () => {
    const r = run(JSON.stringify({ tools: ["factory-preflight-missing-tool"], services: [], min_disk_free_pct: 0 }));
    expect(r.code).toBe(0);
    expect(r.lines.length).toBe(1);
    expect(r.doc.status).toBe("failed");
    expect(r.doc.message).toStartWith("preflight: tools not on PATH: factory-preflight-missing-tool — ");
    expect(r.doc.problems.length).toBe(1);
    expect(existsSync(join(r.artifacts, "preflight.log"))).toBe(true);
    expect(readFileSync(join(r.artifacts, "preflight.log"), "utf8")).toContain("factory-preflight-missing-tool");
  });

  test("an unreadable binding fails instead of skipping", () => {
    const r = run("{not json");
    expect(r.doc.status).toBe("failed");
    expect(r.doc.message).toStartWith("preflight: the stack.preflight binding from load-profile is unreadable (it is not JSON) — ");
  });

  test("a start command that backgrounds the service returns at once and the service is polled until it answers", async () => {
    const port = await freePort();
    const dir = mkdtempSync(join(tmpdir(), "factory-preflight-svc-"));
    const pidFile = join(dir, "pid");
    const server = `Bun.listen({ hostname: "localhost", port: ${port}, socket: { data() {} } }); console.log("listening"); await Bun.sleep(20000)`;
    const start = `(sleep 1; exec bun -e '${server}') & echo $! > ${pidFile}`;
    try {
      const started = Date.now();
      const r = run(JSON.stringify({ tools: [], services: [{ name: "svc", tcp: `localhost:${port}`, start }], min_disk_free_pct: 0 }));
      expect(r.doc).toEqual({ status: "ok", problems: [], message: "" });
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(readFileSync(join(r.artifacts, "preflight.log"), "utf8")).toContain("answers after its start command");
    } finally {
      if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, "utf8").trim()));
    }
  });

  test("a host that has everything is ok", () => {
    const r = run(JSON.stringify({ tools: ["bash"], services: [], min_disk_free_pct: 1 }));
    expect(r.doc).toEqual({ status: "ok", problems: [], message: "" });
  });
});

describe("factory.yaml", () => {
  type Node = {
    id: string; script?: string; cancel?: string; when?: string; trigger_rule?: string; timeout?: number;
    depends_on?: string[]; with?: Record<string, unknown>;
    output_format?: { properties: Record<string, { enum?: string[] }>; required: string[] };
  };
  const yaml = Bun.YAML.parse(readFileSync(join(PACK, "factory.yaml"), "utf8")) as { nodes: Node[] };
  const node = (id: string) => yaml.nodes.find((n) => n.id === id);

  test("preflight runs after load-profile on its binding, within a timeout that covers its worst case", () => {
    const pf = node("preflight");
    expect(pf?.script).toBe("preflight");
    expect(pf?.depends_on).toEqual(["load-profile"]);
    expect(pf?.with?.preflight).toBe("$load-profile.output.preflight");
    expect(pf?.with?.secret_names).toBe("$load-profile.output.secret_names");
    expect(pf?.timeout).toBe(PREFLIGHT_TIMEOUT_MS);
    const worst = MAX_PREFLIGHT_SERVICES * (2 * CONNECT_TIMEOUT_MS + START_TIMEOUT_MS) + POLL_WINDOW_MS;
    expect(PREFLIGHT_TIMEOUT_MS).toBeGreaterThanOrEqual(worst + 60_000);
    expect(pf?.output_format?.properties.status.enum).toEqual([...PREFLIGHT_STATUSES]);
  });

  test("preflight-stop cancels on failed and sync-base waits for both", () => {
    expect(node("preflight-stop")?.cancel).toStartWith("Stopped before any work: $preflight.output.message");
    expect(node("preflight-stop")?.when).toBe("$preflight.output.status == 'failed'");
    const sync = node("sync-base");
    expect(sync?.depends_on).toEqual(expect.arrayContaining(["load-profile", "preflight", "preflight-stop"]));
    expect(sync?.trigger_rule).toBe("none_failed_min_one_success");
    expect(sync?.when).toBe("$preflight.output.status != 'failed'");
  });

  test("load-profile declares preflight without requiring it, so a profile without a block binds \"\"", () => {
    const lp = node("load-profile");
    expect(lp?.output_format?.properties.preflight).toBeDefined();
    expect(lp?.output_format?.required).not.toContain("preflight");
    expect(node("merge-gate")?.with?.preflight).toBe("$load-profile.output.preflight");
  });
});
