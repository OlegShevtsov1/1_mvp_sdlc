# Archon SDLC Factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `factory` Archon workflow package: interview once → profile gate → plan → plan gate → deliver (reviewed PR) → merge → deploy → health → monitoring → rollback on red → honest report.

**Architecture:** One packaged Archon workflow (`.archon/workflows/sdlc-factory/factory/factory.yaml`) that composes the bundled `archon-plan` and `archon-deliver` blocks via `include:` and adds its own nodes for intake, profile, gates, merge, deploy, health, monitoring, rollback and report. Deterministic logic lives in TypeScript scripts run by Bun, with all testable logic in `scripts/_lib/` modules and thin script entry files. Dry-run fixtures prove the DAG wiring without AI spend.

**Tech Stack:** Archon CLI v0.10.1 (binary), Bun 1.4.x (`bun test`, `Bun.YAML`, `Bun.spawn`), bash, `gh` CLI, `curl`. No npm dependencies.

Spec: `docs/superpowers/specs/2026-09-20-archon-sdlc-factory-design.md` (read it first; §4.2 and §7 record verified engine behaviour).

## Global Constraints

- Target Archon **v0.10.1**. Do not use `outcome_field:` (rejected on exec nodes in this version); the terminal red path is the `not-delivered` `cancel:` node.
- Workflow name is exactly `factory`; package path `.archon/workflows/sdlc-factory/factory/factory.yaml`; installed to `~/.archon/workflows/sdlc-factory/factory/`.
- Profile path in the target repo is exactly `.archon/factory-profile.yaml`; monitoring MCP config path is exactly `.archon/mcp/monitoring.json`.
- Every approval gate must be the **last node** of its `loop_group` body.
- Scripts that consume a gate bind the **whole** gate output (`"$<loop>.output"`), never `.decision`.
- Named scripts read bindings only as literal `process.env.INPUTS_<UPPER_SNAKE>` in the script's own file (Archon's load-time scan does not follow imports). Never call `process.exit()`; set `process.exitCode`.
- Scripts import only the standard library, Bun globals and relative modules under `scripts/_lib/` with the `.ts` extension written.
- Secret **values** never appear in YAML, prompts, node stdout, artifacts or logs. `secrets:` in the profile holds env-var names matching `^[A-Z_][A-Z0-9_]*$`.
- Loop body node ids are unprefixed in fixtures (`intake`, `plan__plan`); include-expanded nodes are prefixed (`deliver__impl__implement`).
- All commands below run with `export PATH="$HOME/.bun/bin:$PATH"` and from the repo root `~/projects/mvp/1_hrss/archon-sdlc-factory` unless stated.
- Validation after every YAML change: `archon validate workflows factory --cwd "$PWD"` must print `ok`.
- **Commits:** the user's global rule requires explicit approval for every `git commit`. At each commit step, show the file list and message and wait for the user's OK.

---

### Task 1: Repo scaffold, `_lib/io.ts`, `_lib/gate.ts`, `gate-round` script

**Files:**
- Create: `package.json`, `.gitignore`, `tests/gate.test.ts`, `.archon/workflows/sdlc-factory/factory/scripts/_lib/io.ts`, `.archon/workflows/sdlc-factory/factory/scripts/_lib/gate.ts`, `.archon/workflows/sdlc-factory/factory/scripts/gate-round.ts`

**Interfaces:**
- Produces: `emit(doc: unknown): void` (prints one JSON line), `fail(message: string): void` (stderr + `process.exitCode = 1`), `parseGate(raw: string): { decision: string; text: string }`, `roundVerdict(raw: string): { proceed: boolean; decision: string; stop_reason: string }`.

- [ ] **Step 1: Create `package.json` and `.gitignore`**

```json
{
  "name": "archon-sdlc-factory",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test",
    "validate": "archon validate workflows factory --cwd .",
    "fixtures": "archon workflow test factory --cwd ."
  }
}
```

`.gitignore`:

```
node_modules/
*.log
```

- [ ] **Step 2: Write the failing test `tests/gate.test.ts`**

```ts
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test tests/gate.test.ts`
Expected: FAIL — `Cannot find module '../factory/scripts/_lib/gate.ts'`

- [ ] **Step 4: Write `.archon/workflows/sdlc-factory/factory/scripts/_lib/io.ts`**

```ts
// Shared output discipline for every named script in this package.
// Never call process.exit(): Bun may leave without draining stdout.
export function emit(doc: unknown): void {
  process.stdout.write(JSON.stringify(doc) + "\n");
}

export function fail(message: string): void {
  process.stderr.write(message + "\n");
  process.exitCode = 1;
}

export function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const doc: unknown = JSON.parse(raw);
    return doc !== null && typeof doc === "object" && !Array.isArray(doc)
      ? (doc as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Write `.archon/workflows/sdlc-factory/factory/scripts/_lib/gate.ts`**

```ts
import { parseJsonObject } from "./io.ts";

export interface GateOutput {
  decision: string;
  text: string;
}

// A real gate with authored `decisions:` outputs {decision, text}.
// The dry-run simulator auto-approves with the plain string "approved".
export function parseGate(raw: string): GateOutput {
  const doc = parseJsonObject(raw);
  if (doc !== null) {
    return { decision: String(doc.decision ?? ""), text: String(doc.text ?? "") };
  }
  const trimmed = raw.trim();
  if (trimmed === "approved") return { decision: "approve", text: "" };
  return { decision: trimmed, text: "" };
}

export interface RoundVerdict {
  proceed: boolean;
  decision: string;
  stop_reason: string;
}

export function roundVerdict(raw: string): RoundVerdict {
  const gate = parseGate(raw);
  const proceed = gate.decision === "approve";
  return {
    proceed,
    decision: gate.decision,
    stop_reason: proceed ? "" : `operator chose ${gate.decision || "nothing"}: ${gate.text}`.trimEnd(),
  };
}
```

- [ ] **Step 6: Write `.archon/workflows/sdlc-factory/factory/scripts/gate-round.ts`**

```ts
import { emit } from "./_lib/io.ts";
import { roundVerdict } from "./_lib/gate.ts";

// Bound by the workflow as `with: { gate: "$<loop>.output" }` (whole output).
const raw = process.env.INPUTS_GATE ?? "";
emit(roundVerdict(raw));
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test tests/gate.test.ts`
Expected: `5 pass, 0 fail`

- [ ] **Step 8: Commit (ask the user first)**

```bash
git add package.json .gitignore tests/gate.test.ts .archon/workflows
git commit -m "feat: scaffold package and gate-round script"
```

---

### Task 2: Profile module (`_lib/profile.ts`) with validation, flattening and YAML output

**Files:**
- Create: `.archon/workflows/sdlc-factory/factory/scripts/_lib/profile.ts`, `tests/profile.test.ts`, `examples/factory-profile.example.yaml`

**Interfaces:**
- Produces: `PROFILE_PATH = ".archon/factory-profile.yaml"`, `interface Profile`, `interface FlatProfile`, `validateProfile(doc: unknown): { ok: true; profile: Profile } | { ok: false; errors: string[] }`, `flattenProfile(p: Profile): FlatProfile`, `profileToYaml(p: Profile): string`.

- [ ] **Step 1: Write the failing test `tests/profile.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import {
  flattenProfile,
  profileToYaml,
  validateProfile,
} from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/profile.ts";

const good = {
  version: 1,
  stack: { language: "python", framework: "fastapi", test_command: "pytest -q", lint_command: "ruff check .", build_command: "" },
  repo: { remote: "origin", base_branch: "main", merge_strategy: "squash" },
  deploy: { command: "ssh deploy@vps 'cd /srv/app && git pull && docker compose up -d --build'", health_url: "https://app.example.com/health", wait_seconds: 120, rollback_command: "ssh deploy@vps 'cd /srv/app && git checkout HEAD~1 && docker compose up -d --build'" },
  monitoring: { provider: "sentry", mcp_config: ".archon/mcp/monitoring.json", window_minutes: 10 },
  secrets: ["DEPLOY_SSH_KEY_PATH", "SENTRY_AUTH_TOKEN"],
};

describe("validateProfile", () => {
  test("accepts a complete profile", () => {
    const r = validateProfile(good);
    expect(r.ok).toBe(true);
  });
  test("rejects a secret that looks like a value", () => {
    const r = validateProfile({ ...good, secrets: ["TOKEN=abc123"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("secrets[0]");
  });
  test("rejects an unknown merge strategy", () => {
    const r = validateProfile({ ...good, repo: { ...good.repo, merge_strategy: "fast" } });
    expect(r.ok).toBe(false);
  });
  test("rejects a missing health_url", () => {
    const r = validateProfile({ ...good, deploy: { ...good.deploy, health_url: "" } });
    expect(r.ok).toBe(false);
  });
  test("rejects a non-positive wait_seconds", () => {
    const r = validateProfile({ ...good, deploy: { ...good.deploy, wait_seconds: 0 } });
    expect(r.ok).toBe(false);
  });
  test("accepts provider none with empty mcp_config", () => {
    const r = validateProfile({ ...good, monitoring: { provider: "none", mcp_config: "", window_minutes: 10 } });
    expect(r.ok).toBe(true);
  });
});

describe("flattenProfile", () => {
  test("produces top-level keys for every consumer", () => {
    const r = validateProfile(good);
    if (!r.ok) throw new Error(r.errors.join(","));
    expect(flattenProfile(r.profile)).toEqual({
      language: "python", framework: "fastapi",
      test_command: "pytest -q", lint_command: "ruff check .", build_command: "",
      remote: "origin", base_branch: "main", merge_strategy: "squash",
      deploy_command: good.deploy.command, health_url: good.deploy.health_url,
      wait_seconds: 120, rollback_command: good.deploy.rollback_command,
      monitoring_provider: "sentry", window_minutes: 10,
      secret_names: ["DEPLOY_SSH_KEY_PATH", "SENTRY_AUTH_TOKEN"],
    });
  });
});

describe("profileToYaml", () => {
  test("round-trips through Bun.YAML", () => {
    const r = validateProfile(good);
    if (!r.ok) throw new Error(r.errors.join(","));
    const yaml = profileToYaml(r.profile);
    expect(yaml.startsWith("# .archon/factory-profile.yaml")).toBe(true);
    const back = validateProfile(Bun.YAML.parse(yaml));
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.profile).toEqual(r.profile);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/profile.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `.archon/workflows/sdlc-factory/factory/scripts/_lib/profile.ts`**

```ts
export const PROFILE_PATH = ".archon/factory-profile.yaml";
export const MONITORING_MCP_PATH = ".archon/mcp/monitoring.json";

export const MERGE_STRATEGIES = ["squash", "merge", "rebase"] as const;
export const MONITORING_PROVIDERS = ["sentry", "datadog", "grafana", "none"] as const;

export interface Profile {
  version: 1;
  stack: { language: string; framework: string; test_command: string; lint_command: string; build_command: string };
  repo: { remote: string; base_branch: string; merge_strategy: (typeof MERGE_STRATEGIES)[number] };
  deploy: { command: string; health_url: string; wait_seconds: number; rollback_command: string };
  monitoring: { provider: (typeof MONITORING_PROVIDERS)[number]; mcp_config: string; window_minutes: number };
  secrets: string[];
}

export interface FlatProfile {
  language: string; framework: string;
  test_command: string; lint_command: string; build_command: string;
  remote: string; base_branch: string; merge_strategy: string;
  deploy_command: string; health_url: string; wait_seconds: number; rollback_command: string;
  monitoring_provider: string; window_minutes: number;
  secret_names: string[];
}

const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;

type Validation = { ok: true; profile: Profile } | { ok: false; errors: string[] };

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(section: Record<string, unknown>, key: string, path: string, errors: string[], required: boolean): string {
  const v = section[key];
  if (v === undefined || v === null) {
    if (required) errors.push(`${path}.${key} is required`);
    return "";
  }
  if (typeof v !== "string") { errors.push(`${path}.${key} must be a string`); return ""; }
  if (required && v.trim() === "") errors.push(`${path}.${key} must not be empty`);
  if (v.includes("\n")) errors.push(`${path}.${key} must be a single line`);
  return v;
}

function posInt(section: Record<string, unknown>, key: string, path: string, errors: string[]): number {
  const v = section[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    errors.push(`${path}.${key} must be a positive integer`);
    return 0;
  }
  return v;
}

export function validateProfile(doc: unknown): Validation {
  const errors: string[] = [];
  const root = obj(doc);
  if (root.version !== 1) errors.push("version must be 1");
  const stack = obj(root.stack), repo = obj(root.repo), deploy = obj(root.deploy), monitoring = obj(root.monitoring);

  const profile: Profile = {
    version: 1,
    stack: {
      language: str(stack, "language", "stack", errors, true),
      framework: str(stack, "framework", "stack", errors, false),
      test_command: str(stack, "test_command", "stack", errors, true),
      lint_command: str(stack, "lint_command", "stack", errors, false),
      build_command: str(stack, "build_command", "stack", errors, false),
    },
    repo: {
      remote: str(repo, "remote", "repo", errors, true),
      base_branch: str(repo, "base_branch", "repo", errors, true),
      merge_strategy: str(repo, "merge_strategy", "repo", errors, true) as Profile["repo"]["merge_strategy"],
    },
    deploy: {
      command: str(deploy, "command", "deploy", errors, true),
      health_url: str(deploy, "health_url", "deploy", errors, true),
      wait_seconds: posInt(deploy, "wait_seconds", "deploy", errors),
      rollback_command: str(deploy, "rollback_command", "deploy", errors, true),
    },
    monitoring: {
      provider: str(monitoring, "provider", "monitoring", errors, true) as Profile["monitoring"]["provider"],
      mcp_config: str(monitoring, "mcp_config", "monitoring", errors, false),
      window_minutes: posInt(monitoring, "window_minutes", "monitoring", errors),
    },
    secrets: [],
  };

  if (!MERGE_STRATEGIES.includes(profile.repo.merge_strategy)) {
    errors.push(`repo.merge_strategy must be one of ${MERGE_STRATEGIES.join(", ")}`);
  }
  if (!MONITORING_PROVIDERS.includes(profile.monitoring.provider)) {
    errors.push(`monitoring.provider must be one of ${MONITORING_PROVIDERS.join(", ")}`);
  }
  if (profile.deploy.health_url !== "" && !/^https?:\/\//.test(profile.deploy.health_url)) {
    errors.push("deploy.health_url must start with http:// or https://");
  }

  const secrets = root.secrets;
  if (secrets === undefined || secrets === null) {
    profile.secrets = [];
  } else if (!Array.isArray(secrets)) {
    errors.push("secrets must be a list of environment variable names");
  } else {
    secrets.forEach((s, i) => {
      if (typeof s !== "string" || !SECRET_NAME.test(s)) {
        errors.push(`secrets[${i}] must be an environment variable NAME like MY_TOKEN, never a value`);
      } else {
        profile.secrets.push(s);
      }
    });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, profile };
}

export function flattenProfile(p: Profile): FlatProfile {
  return {
    language: p.stack.language, framework: p.stack.framework,
    test_command: p.stack.test_command, lint_command: p.stack.lint_command, build_command: p.stack.build_command,
    remote: p.repo.remote, base_branch: p.repo.base_branch, merge_strategy: p.repo.merge_strategy,
    deploy_command: p.deploy.command, health_url: p.deploy.health_url,
    wait_seconds: p.deploy.wait_seconds, rollback_command: p.deploy.rollback_command,
    monitoring_provider: p.monitoring.provider, window_minutes: p.monitoring.window_minutes,
    secret_names: [...p.secrets],
  };
}

// Every string is emitted as a JSON string literal, which is a valid YAML
// double-quoted scalar, so no value can break the document.
const q = (s: string): string => JSON.stringify(s);

export function profileToYaml(p: Profile): string {
  const lines = [
    "# .archon/factory-profile.yaml — written by the Archon `factory` workflow.",
    "# Edit freely. While this file exists the workflow never asks these questions again.",
    "# `secrets` lists environment-variable NAMES only; values stay on the machine that runs Archon.",
    "version: 1",
    "stack:",
    `  language: ${q(p.stack.language)}`,
    `  framework: ${q(p.stack.framework)}`,
    `  test_command: ${q(p.stack.test_command)}`,
    `  lint_command: ${q(p.stack.lint_command)}`,
    `  build_command: ${q(p.stack.build_command)}`,
    "repo:",
    `  remote: ${q(p.repo.remote)}`,
    `  base_branch: ${q(p.repo.base_branch)}`,
    `  merge_strategy: ${q(p.repo.merge_strategy)}`,
    "deploy:",
    `  command: ${q(p.deploy.command)}`,
    `  health_url: ${q(p.deploy.health_url)}`,
    `  wait_seconds: ${p.deploy.wait_seconds}`,
    `  rollback_command: ${q(p.deploy.rollback_command)}`,
    "monitoring:",
    `  provider: ${q(p.monitoring.provider)}`,
    `  mcp_config: ${q(p.monitoring.mcp_config)}`,
    `  window_minutes: ${p.monitoring.window_minutes}`,
    p.secrets.length === 0 ? "secrets: []" : "secrets:",
    ...p.secrets.map((s) => `  - ${s}`),
    "",
  ];
  return lines.join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/profile.test.ts`
Expected: `8 pass, 0 fail`

- [ ] **Step 5: Write `examples/factory-profile.example.yaml`**

Copy the YAML block from spec §3.3 verbatim (it is the same shape `profileToYaml` emits, with comments).

- [ ] **Step 6: Commit (ask the user first)**

```bash
git add .archon/workflows/sdlc-factory/factory/scripts/_lib/profile.ts tests/profile.test.ts examples/factory-profile.example.yaml
git commit -m "feat: profile schema, validation, flattening and YAML output"
```

---

### Task 3: Exec module (`_lib/exec.ts`) with secret redaction, plus `deploy` and `rollback` scripts

**Files:**
- Create: `.archon/workflows/sdlc-factory/factory/scripts/_lib/exec.ts`, `tests/exec.test.ts`, `.archon/workflows/sdlc-factory/factory/scripts/deploy.ts`, `.archon/workflows/sdlc-factory/factory/scripts/rollback.ts`

**Interfaces:**
- Produces: `redact(text: string, secretNames: string[], env?: Record<string, string | undefined>): string`, `runLogged(command: string, opts: { logPath: string; secretNames: string[]; cwd?: string; timeoutMs?: number }): Promise<{ exit_code: number }>`, `parseSecretNames(raw: string): string[]`.
- Consumes: `emit`, `fail` from Task 1.

- [ ] **Step 1: Write the failing test `tests/exec.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSecretNames, redact, runLogged } from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/exec.ts";

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
    expect(r.exit_code).toBe(3);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("out ***");
    expect(log).toContain("err ***");
    expect(log).not.toContain("hunter22");
  });
  test("times out with exit code 124", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-exec-"));
    const r = await runLogged("sleep 5", { logPath: join(dir, "x.log"), secretNames: [], timeoutMs: 300 });
    expect(r.exit_code).toBe(124);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/exec.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `.archon/workflows/sdlc-factory/factory/scripts/_lib/exec.ts`**

```ts
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function redact(
  text: string,
  secretNames: string[],
  env: Record<string, string | undefined> = process.env,
): string {
  let out = text;
  for (const name of secretNames) {
    const value = env[name];
    if (!value || value.length < 4) continue;
    out = out.split(value).join("***");
  }
  return out;
}

export function parseSecretNames(raw: string): string[] {
  try {
    const doc: unknown = JSON.parse(raw);
    return Array.isArray(doc) ? doc.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export interface RunOptions {
  logPath: string;
  secretNames: string[];
  cwd?: string;
  timeoutMs?: number;
}

// Runs one shell command, appends its redacted stdout+stderr to `logPath`, and
// returns the exit code. Nothing the command prints reaches this process's
// stdout — a node's stdout is its declared result and nothing else.
export async function runLogged(command: string, opts: RunOptions): Promise<{ exit_code: number }> {
  mkdirSync(dirname(opts.logPath), { recursive: true });
  appendFileSync(opts.logPath, `\n$ ${redact(command, opts.secretNames)}\n`);
  const proc = Bun.spawn(["bash", "-c", command], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  let timedOut = false;
  const timer = opts.timeoutMs
    ? setTimeout(() => { timedOut = true; proc.kill(); }, opts.timeoutMs)
    : undefined;
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (timer) clearTimeout(timer);
  appendFileSync(opts.logPath, redact(out, opts.secretNames));
  if (err) appendFileSync(opts.logPath, "\n[stderr]\n" + redact(err, opts.secretNames));
  const exit_code = timedOut ? 124 : code;
  appendFileSync(opts.logPath, `\n[exit ${exit_code}]\n`);
  return { exit_code };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/exec.test.ts`
Expected: `6 pass, 0 fail`

- [ ] **Step 5: Write `.archon/workflows/sdlc-factory/factory/scripts/deploy.ts`**

```ts
import { emit, fail } from "./_lib/io.ts";
import { parseSecretNames, runLogged } from "./_lib/exec.ts";

// Bindings (see factory.yaml `deploy` node): command, secret_names (JSON array
// string), remote, merge_sha. ARTIFACTS_DIR is engine-provided.
const command = process.env.INPUTS_COMMAND ?? "";
const secretNames = parseSecretNames(process.env.INPUTS_SECRET_NAMES ?? "[]");
const remote = process.env.INPUTS_REMOTE ?? "origin";
const mergeSha = process.env.INPUTS_MERGE_SHA ?? "";
const artifacts = process.env.ARTIFACTS_DIR ?? ".";
const logPath = `${artifacts}/deploy.log`;

if (command.trim() === "") {
  fail("deploy: the profile's deploy.command is empty");
} else {
  // Put the checkout on the merged commit so a directory-based deploy (flyctl,
  // docker build, rsync) ships exactly what was merged.
  const checkout = mergeSha
    ? await runLogged(`git fetch ${remote} && git checkout --detach ${mergeSha}`, { logPath, secretNames, timeoutMs: 120_000 })
    : { exit_code: 0 };
  if (checkout.exit_code !== 0) {
    fail(`deploy: could not check out merge commit ${mergeSha}; see deploy.log`);
  } else {
    const deployed_at = new Date().toISOString();
    const r = await runLogged(command, { logPath, secretNames, timeoutMs: 1_500_000 });
    emit({ deployed: r.exit_code === 0, exit_code: r.exit_code, deployed_at, log: logPath });
  }
}
```

- [ ] **Step 6: Write `.archon/workflows/sdlc-factory/factory/scripts/rollback.ts`**

```ts
import { emit, fail } from "./_lib/io.ts";
import { parseSecretNames, runLogged } from "./_lib/exec.ts";

const command = process.env.INPUTS_COMMAND ?? "";
const secretNames = parseSecretNames(process.env.INPUTS_SECRET_NAMES ?? "[]");
const artifacts = process.env.ARTIFACTS_DIR ?? ".";
const logPath = `${artifacts}/rollback.log`;

if (command.trim() === "") {
  fail("rollback: the profile's deploy.rollback_command is empty");
} else {
  const r = await runLogged(command, { logPath, secretNames, timeoutMs: 1_500_000 });
  emit({ rolled_back: r.exit_code === 0, exit_code: r.exit_code, log: logPath });
}
```

- [ ] **Step 7: Smoke-run both scripts by hand**

Run:
```bash
mkdir -p /tmp/factory-smoke && cd /tmp/factory-smoke && git init -q && git commit -q --allow-empty -m init && \
ARTIFACTS_DIR=/tmp/factory-smoke INPUTS_COMMAND='echo deploying' INPUTS_SECRET_NAMES='[]' INPUTS_REMOTE=origin INPUTS_MERGE_SHA= \
bun ~/projects/mvp/1_hrss/archon-sdlc-factory/.archon/workflows/sdlc-factory/factory/scripts/deploy.ts && cat /tmp/factory-smoke/deploy.log
```
Expected: one JSON line `{"deployed":true,"exit_code":0,...}` and a log containing `deploying` and `[exit 0]`.

- [ ] **Step 8: Commit (ask the user first)**

```bash
git add .archon/workflows/sdlc-factory/factory/scripts/_lib/exec.ts tests/exec.test.ts .archon/workflows/sdlc-factory/factory/scripts/deploy.ts .archon/workflows/sdlc-factory/factory/scripts/rollback.ts
git commit -m "feat: logged command runner with secret redaction; deploy and rollback scripts"
```

---

### Task 4: Rollback decision and report modules + scripts

**Files:**
- Create: `.archon/workflows/sdlc-factory/factory/scripts/_lib/rollback-decision.ts`, `.archon/workflows/sdlc-factory/factory/scripts/_lib/report.ts`, `tests/rollback-decision.test.ts`, `tests/report.test.ts`, `.archon/workflows/sdlc-factory/factory/scripts/decide-rollback.ts`, `.archon/workflows/sdlc-factory/factory/scripts/report.ts`

**Interfaces:**
- Produces: `decideRollback(input: { deployed: string; healthy: string; monitor_status: string }): { rollback: boolean; reason: string }`; `buildReport(input: ReportInput): ReportDoc` where
  `ReportInput = { pr_url: string; merged: string; merge_sha: string; deployed: string; deploy_exit: string; healthy: string; last_status: string; health_url: string; monitor_status: string; monitor_findings: string; rollback: string; rolled_back: string; rollback_reason: string }` (every field is the string the engine delivers; skipped producers arrive as the `if_skipped` literal `"skipped"`), and
  `ReportDoc = { delivered: boolean; summary: string; pr_url: string; merge_sha: string; deploy_status: string; health: string; monitoring: string; rollback: string }`.

- [ ] **Step 1: Write the failing tests**

`tests/rollback-decision.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { decideRollback } from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/rollback-decision.ts";

describe("decideRollback", () => {
  test("no rollback when everything is green", () => {
    expect(decideRollback({ deployed: "true", healthy: "true", monitor_status: "healthy" })).toEqual({ rollback: false, reason: "" });
  });
  test("rolls back on red health", () => {
    expect(decideRollback({ deployed: "true", healthy: "false", monitor_status: "skipped" }).rollback).toBe(true);
  });
  test("rolls back on monitoring errors", () => {
    const r = decideRollback({ deployed: "true", healthy: "true", monitor_status: "errors" });
    expect(r.rollback).toBe(true);
    expect(r.reason).toContain("monitoring");
  });
  test("does not roll back when monitoring is unavailable or skipped", () => {
    expect(decideRollback({ deployed: "true", healthy: "true", monitor_status: "unavailable" }).rollback).toBe(false);
    expect(decideRollback({ deployed: "true", healthy: "true", monitor_status: "skipped" }).rollback).toBe(false);
  });
  test("does not roll back when the deploy command itself failed", () => {
    expect(decideRollback({ deployed: "false", healthy: "skipped", monitor_status: "skipped" }).rollback).toBe(false);
  });
});
```

`tests/report.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildReport } from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/report.ts";

const base = {
  pr_url: "https://github.com/o/r/pull/7", merged: "true", merge_sha: "abc123",
  deployed: "true", deploy_exit: "0", healthy: "true", last_status: "200",
  health_url: "https://app.example.com/health", monitor_status: "healthy", monitor_findings: "",
  rollback: "false", rolled_back: "skipped", rollback_reason: "",
};

describe("buildReport", () => {
  test("green path is delivered", () => {
    const r = buildReport(base);
    expect(r.delivered).toBe(true);
    expect(r.summary).toContain("https://github.com/o/r/pull/7");
    expect(r.rollback).toBe("not needed");
  });
  test("red health with rollback is not delivered and names the cause", () => {
    const r = buildReport({ ...base, healthy: "false", last_status: "503", monitor_status: "skipped", rollback: "true", rolled_back: "true", rollback_reason: "health check returned 503" });
    expect(r.delivered).toBe(false);
    expect(r.summary).toContain("503");
    expect(r.rollback).toBe("done");
  });
  test("failed deploy command is not delivered", () => {
    const r = buildReport({ ...base, deployed: "false", deploy_exit: "2", healthy: "skipped", monitor_status: "skipped" });
    expect(r.delivered).toBe(false);
    expect(r.deploy_status).toBe("failed (exit 2)");
  });
  test("monitoring unavailable stays delivered but is reported", () => {
    const r = buildReport({ ...base, monitor_status: "unavailable", monitor_findings: "MCP server not reachable" });
    expect(r.delivered).toBe(true);
    expect(r.monitoring).toContain("unavailable");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/rollback-decision.test.ts tests/report.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Write `.archon/workflows/sdlc-factory/factory/scripts/_lib/rollback-decision.ts`**

```ts
export interface RollbackInput {
  deployed: string;      // "true" | "false" | "skipped"
  healthy: string;       // "true" | "false" | "skipped"
  monitor_status: string; // "healthy" | "errors" | "unavailable" | "skipped"
}

export function decideRollback(i: RollbackInput): { rollback: boolean; reason: string } {
  if (i.deployed !== "true") return { rollback: false, reason: "" };
  if (i.healthy === "false") return { rollback: true, reason: "health check did not return 200 within the profile's wait_seconds" };
  if (i.monitor_status === "errors") return { rollback: true, reason: "monitoring reported new errors after the deploy" };
  return { rollback: false, reason: "" };
}
```

- [ ] **Step 4: Write `.archon/workflows/sdlc-factory/factory/scripts/_lib/report.ts`**

```ts
export interface ReportInput {
  pr_url: string; merged: string; merge_sha: string;
  deployed: string; deploy_exit: string;
  healthy: string; last_status: string; health_url: string;
  monitor_status: string; monitor_findings: string;
  rollback: string; rolled_back: string; rollback_reason: string;
}

export interface ReportDoc {
  delivered: boolean; summary: string;
  pr_url: string; merge_sha: string; deploy_status: string;
  health: string; monitoring: string; rollback: string;
}

export function buildReport(i: ReportInput): ReportDoc {
  const merged = i.merged === "true";
  const deployed = i.deployed === "true";
  const healthy = i.healthy === "true";
  const rolledBack = i.rollback === "true";

  const deploy_status = !merged ? "not attempted" : deployed ? "ok" : i.deployed === "skipped" ? "skipped" : `failed (exit ${i.deploy_exit})`;
  const health = !deployed ? "skipped" : healthy ? `200 at ${i.health_url}` : `red (last status ${i.last_status}) at ${i.health_url}`;
  const monitoring =
    i.monitor_status === "healthy" ? "healthy"
    : i.monitor_status === "errors" ? `errors: ${i.monitor_findings}`
    : i.monitor_status === "unavailable" ? `unavailable: ${i.monitor_findings}`
    : "skipped";
  const rollback = !rolledBack ? "not needed" : i.rolled_back === "true" ? "done" : `FAILED (${i.rollback_reason})`;

  const delivered = merged && deployed && healthy && i.monitor_status !== "errors" && !rolledBack;

  const summary = delivered
    ? `Delivered: ${i.pr_url} merged as ${i.merge_sha}, deployed, health ${health}, monitoring ${monitoring}.`
    : !merged ? `Not delivered: PR ${i.pr_url || "(none)"} was not merged.`
    : !deployed ? `Not delivered: deploy ${deploy_status}. PR ${i.pr_url} merged as ${i.merge_sha}. See deploy.log.`
    : `Not delivered: ${i.rollback_reason || "post-deploy checks failed"} (health ${health}; monitoring ${monitoring}). Rollback ${rollback}.`;

  return { delivered, summary, pr_url: i.pr_url, merge_sha: i.merge_sha, deploy_status, health, monitoring, rollback };
}
```

- [ ] **Step 5: Write `.archon/workflows/sdlc-factory/factory/scripts/decide-rollback.ts`**

```ts
import { emit } from "./_lib/io.ts";
import { decideRollback } from "./_lib/rollback-decision.ts";

emit(decideRollback({
  deployed: process.env.INPUTS_DEPLOYED ?? "skipped",
  healthy: process.env.INPUTS_HEALTHY ?? "skipped",
  monitor_status: process.env.INPUTS_MONITOR_STATUS ?? "skipped",
}));
```

- [ ] **Step 6: Write `.archon/workflows/sdlc-factory/factory/scripts/report.ts`**

```ts
import { writeFileSync } from "node:fs";
import { emit } from "./_lib/io.ts";
import { buildReport } from "./_lib/report.ts";

const doc = buildReport({
  pr_url: process.env.INPUTS_PR_URL ?? "",
  merged: process.env.INPUTS_MERGED ?? "skipped",
  merge_sha: process.env.INPUTS_MERGE_SHA ?? "",
  deployed: process.env.INPUTS_DEPLOYED ?? "skipped",
  deploy_exit: process.env.INPUTS_DEPLOY_EXIT ?? "",
  healthy: process.env.INPUTS_HEALTHY ?? "skipped",
  last_status: process.env.INPUTS_LAST_STATUS ?? "",
  health_url: process.env.INPUTS_HEALTH_URL ?? "",
  monitor_status: process.env.INPUTS_MONITOR_STATUS ?? "skipped",
  monitor_findings: process.env.INPUTS_MONITOR_FINDINGS ?? "",
  rollback: process.env.INPUTS_ROLLBACK ?? "skipped",
  rolled_back: process.env.INPUTS_ROLLED_BACK ?? "skipped",
  rollback_reason: process.env.INPUTS_ROLLBACK_REASON ?? "",
});
const artifacts = process.env.ARTIFACTS_DIR;
if (artifacts) writeFileSync(`${artifacts}/report.json`, JSON.stringify(doc, null, 2) + "\n");
emit(doc);
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test`
Expected: all tests pass (`0 fail`)

- [ ] **Step 8: Commit (ask the user first)**

```bash
git add .archon/workflows tests
git commit -m "feat: rollback decision and terminal report"
```

---

### Task 5: `write-profile` and `load-profile` scripts

**Files:**
- Create: `.archon/workflows/sdlc-factory/factory/scripts/write-profile.ts`, `.archon/workflows/sdlc-factory/factory/scripts/load-profile.ts`, `tests/write-profile.test.ts`

**Interfaces:**
- Consumes: `validateProfile`, `profileToYaml`, `flattenProfile`, `PROFILE_PATH` (Task 2); `emit`, `fail` (Task 1).
- Produces: `write-profile` stdout `{written: true, path: ".archon/factory-profile.yaml", commit: "<sha>"}`; `load-profile` stdout = `FlatProfile` JSON.

- [ ] **Step 1: Write the failing test `tests/write-profile.test.ts`** (runs the script as a subprocess in a temp git repo)

```ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPTS = join(import.meta.dir, "..", ".archon", "workflows", "sdlc-factory", "factory", "scripts");

function sh(cmd: string, cwd: string, env: Record<string, string> = {}): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(["bash", "-c", cmd], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const draft = {
  version: 1,
  stack: { language: "python", framework: "", test_command: "pytest -q", lint_command: "", build_command: "" },
  repo: { remote: "origin", base_branch: "main", merge_strategy: "squash" },
  deploy: { command: "echo deploy", health_url: "http://localhost:8000/health", wait_seconds: 30, rollback_command: "echo rollback" },
  monitoring: { provider: "none", mcp_config: "", window_minutes: 10 },
  secrets: ["API_TOKEN"],
};

describe("write-profile then load-profile", () => {
  test("writes, commits and reads back the profile", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-repo-"));
    const artifacts = mkdtempSync(join(tmpdir(), "factory-art-"));
    sh("git init -q -b main && git config user.email t@e.com && git config user.name t && git commit -q --allow-empty -m init", repo);
    writeFileSync(join(artifacts, "factory-profile.json"), JSON.stringify(draft));

    const w = sh(`bun ${SCRIPTS}/write-profile.ts`, repo, { ARTIFACTS_DIR: artifacts });
    expect(w.err).toBe("");
    expect(w.code).toBe(0);
    const wdoc = JSON.parse(w.out);
    expect(wdoc.written).toBe(true);
    expect(existsSync(join(repo, ".archon/factory-profile.yaml"))).toBe(true);
    expect(sh("git log --oneline | head -1", repo).out).toContain("factory profile");
    expect(readFileSync(join(repo, ".archon/factory-profile.yaml"), "utf8")).not.toContain("API_TOKEN=");

    const l = sh(`bun ${SCRIPTS}/load-profile.ts`, repo);
    expect(l.code).toBe(0);
    const flat = JSON.parse(l.out);
    expect(flat.health_url).toBe("http://localhost:8000/health");
    expect(flat.secret_names).toEqual(["API_TOKEN"]);
    expect(flat.monitoring_provider).toBe("none");
  });

  test("refuses an invalid draft and writes nothing", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-repo-"));
    const artifacts = mkdtempSync(join(tmpdir(), "factory-art-"));
    sh("git init -q -b main && git commit -q --allow-empty -m init", repo);
    writeFileSync(join(artifacts, "factory-profile.json"), JSON.stringify({ ...draft, secrets: ["BAD=value"] }));
    const w = sh(`bun ${SCRIPTS}/write-profile.ts`, repo, { ARTIFACTS_DIR: artifacts });
    expect(w.code).toBe(1);
    expect(w.err).toContain("secrets[0]");
    expect(existsSync(join(repo, ".archon/factory-profile.yaml"))).toBe(false);
  });

  test("load-profile fails when the file is missing", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-repo-"));
    const l = sh(`bun ${SCRIPTS}/load-profile.ts`, repo);
    expect(l.code).toBe(1);
    expect(l.err).toContain(".archon/factory-profile.yaml");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/write-profile.test.ts`
Expected: FAIL — `write-profile.ts` not found / exit code mismatch

- [ ] **Step 3: Write `.archon/workflows/sdlc-factory/factory/scripts/write-profile.ts`**

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { emit, fail } from "./_lib/io.ts";
import { PROFILE_PATH, profileToYaml, validateProfile } from "./_lib/profile.ts";

// Reads the approved draft the intake node wrote, validates it, writes the YAML
// profile into the checkout, and commits it on the run's branch.
const artifacts = process.env.ARTIFACTS_DIR ?? "";
const draftPath = `${artifacts}/factory-profile.json`;
const draftFile = Bun.file(draftPath);

if (!(await draftFile.exists())) {
  fail(`write-profile: draft not found at ${draftPath}`);
} else {
  let draft: unknown;
  try {
    draft = JSON.parse(await draftFile.text());
  } catch (e) {
    fail(`write-profile: draft is not valid JSON: ${(e as Error).message}`);
  }
  if (draft !== undefined) {
    const v = validateProfile(draft);
    if (!v.ok) {
      fail("write-profile: the draft profile is invalid:\n- " + v.errors.join("\n- "));
    } else {
      mkdirSync(dirname(PROFILE_PATH), { recursive: true });
      writeFileSync(PROFILE_PATH, profileToYaml(v.profile));
      const git = Bun.spawnSync(
        ["bash", "-c", `git add ${PROFILE_PATH} && git commit -q -m "chore: add factory profile" && git rev-parse HEAD`],
        { stdout: "pipe", stderr: "pipe" },
      );
      if (git.exitCode !== 0) {
        fail(`write-profile: profile written but the commit failed: ${git.stderr.toString().trim()}`);
      } else {
        emit({ written: true, path: PROFILE_PATH, commit: git.stdout.toString().trim() });
      }
    }
  }
}
```

- [ ] **Step 4: Write `.archon/workflows/sdlc-factory/factory/scripts/load-profile.ts`**

```ts
import { emit, fail } from "./_lib/io.ts";
import { PROFILE_PATH, flattenProfile, validateProfile } from "./_lib/profile.ts";

const file = Bun.file(PROFILE_PATH);
if (!(await file.exists())) {
  fail(`load-profile: ${PROFILE_PATH} not found in the checkout`);
} else {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(await file.text());
  } catch (e) {
    fail(`load-profile: ${PROFILE_PATH} is not valid YAML: ${(e as Error).message}`);
  }
  if (doc !== undefined) {
    const v = validateProfile(doc);
    if (!v.ok) fail(`load-profile: ${PROFILE_PATH} is invalid:\n- ` + v.errors.join("\n- "));
    else emit(flattenProfile(v.profile));
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/write-profile.test.ts`
Expected: `3 pass, 0 fail`

- [ ] **Step 6: Commit (ask the user first)**

```bash
git add .archon/workflows/sdlc-factory/factory/scripts/write-profile.ts .archon/workflows/sdlc-factory/factory/scripts/load-profile.ts tests/write-profile.test.ts
git commit -m "feat: write-profile and load-profile scripts"
```

---

### Task 6: Workflow part 1 — header, profile-check, intake loop, profile gate, profile-write, load-profile

**Files:**
- Create: `.archon/workflows/sdlc-factory/factory/factory.yaml`, `.archon/workflows/sdlc-factory/factory/commands/intake.md`, `.archon/workflows/sdlc-factory/factory/fixtures/fresh-profile.stubs.yaml`, `.archon/workflows/sdlc-factory/factory/fixtures/existing-profile.stubs.yaml`

**Interfaces:**
- Produces node ids used later: `profile-check`, `intake-cycle` (body `intake`, `profile-gate`), `profile-round`, `abort-profile`, `profile-write`, `load-profile` (output = `FlatProfile`). `returns:` is temporarily `load-profile` and moves to `report` in Task 8.

- [ ] **Step 1: Write `.archon/workflows/sdlc-factory/factory/commands/intake.md`**

```markdown
You are the intake interviewer of the Archon `factory` workflow. Your job is to
draft the project profile that every later step will rely on. Ask nothing of
the user directly: you cannot talk to them here. Instead, read the repository,
pre-fill every answer you can find, mark what you assumed, and write a draft
the operator will confirm or correct at the next gate.

The task the operator wants built (for context only): $INPUTS.task
Original trigger message: $ARGUMENTS

Operator feedback from the previous round (empty or a literal placeholder on
the first round; when present, change ONLY what the feedback touches and keep
everything else as it was in your previous draft at
$ARTIFACTS_DIR/factory-profile.json):
$LOOP_PREV.profile-gate.output.text

## What to determine

Read manifests (package.json, pyproject.toml, go.mod, Cargo.toml, Gemfile,
composer.json, pom.xml, *.csproj), CI configuration (.github/workflows,
.gitlab-ci.yml), Dockerfiles, docker-compose files, Procfile, fly.toml,
render.yaml, vercel.json, Makefile, README and any existing `.archon/` files.
Then fill every field below.

1. `stack.language` — primary language.
2. `stack.framework` — main framework, or "".
3. `stack.test_command`, `stack.lint_command`, `stack.build_command` — the
   exact shell commands the project uses (from scripts, Makefile or CI). "" when
   the project has none.
4. `repo.remote` — normally "origin". `repo.base_branch` — the default branch
   (`git symbolic-ref refs/remotes/origin/HEAD` or CI config). `repo.merge_strategy`
   — "squash" unless the history shows merge commits ("merge") or linear rebases
   ("rebase").
5. `deploy.command` — ONE shell command that deploys the merged base branch from
   this machine. Derive it from what exists (fly.toml → `flyctl deploy`,
   docker-compose on a server → `ssh <host> 'cd <dir> && git pull && docker compose up -d --build'`,
   render/vercel → their CLI). If nothing indicates a target, write the most
   likely command and mark it assumed.
6. `deploy.health_url` — an HTTP URL that returns 200 when the app is healthy.
   Look for /health, /healthz, /ping routes and for a public hostname in configs.
   If unknown, write "https://CHANGE-ME.example.com/health" and mark assumed.
7. `deploy.wait_seconds` — 120 unless the deploy is clearly slower.
8. `deploy.rollback_command` — ONE shell command that restores the previous
   release (the inverse of the deploy command; for git-pull deploys use
   `git checkout HEAD~1` on the server, for flyctl `flyctl releases rollback`).
9. `monitoring.provider` — "sentry", "datadog", "grafana" or "none", from SDK
   dependencies and configs. `monitoring.mcp_config` — always
   ".archon/mcp/monitoring.json" unless provider is "none" (then ""). `monitoring.window_minutes` — 10.
10. `secrets` — the NAMES of environment variables the deploy, rollback or
    monitoring need (e.g. from .env.example, CI secrets, compose files). Names
    only, `^[A-Z_][A-Z0-9_]*$`. NEVER write a value, and never open files that
    hold real secrets (.env, credentials, key files).

## Output

Write the draft as JSON to `$ARTIFACTS_DIR/factory-profile.json` with exactly this shape:

{"version":1,"stack":{"language":"","framework":"","test_command":"","lint_command":"","build_command":""},"repo":{"remote":"origin","base_branch":"","merge_strategy":"squash"},"deploy":{"command":"","health_url":"","wait_seconds":120,"rollback_command":""},"monitoring":{"provider":"none","mcp_config":"","window_minutes":10},"secrets":[]}

Then return the structured result: `summary` is 5-10 short lines the operator
reads at the gate — one line per section, stating the value and whether it was
detected or assumed; `assumed` lists the field names you could not detect;
`report` points at the draft file.
```

- [ ] **Step 2: Write `.archon/workflows/sdlc-factory/factory/factory.yaml` (part 1)**

```yaml
name: factory
description: |
  Interview once, plan, deliver a reviewed PR, merge, deploy, verify health and
  monitoring, roll back on red, report honestly. Two human gates: the project
  profile (first run only) and the plan.

  Use when: "build X and put it live", "factory: <task>", a task that should end
  deployed on the operator's own infrastructure.
  NOT for: reviewing an existing PR, work that must not be merged or deployed,
  or repositories without a GitHub remote.

interactive: true
requires: [github]

inputs:
  task:
    default: ""
    description: What to build. Empty means the run's trigger message is the task.

returns: load-profile

nodes:
  # ── Profile ────────────────────────────────────────────────────────────────
  - id: profile-check
    bash: |
      if test -f .archon/factory-profile.yaml; then printf '{"exists":true}'; else printf '{"exists":false}'; fi
    output_format:
      type: object
      properties:
        exists: { type: boolean }
      required: [exists]

  # First run only. The gate is the body's last node so the loop pauses on it;
  # `needs-revision` repeats the interview with the operator's words as feedback.
  - id: intake-cycle
    depends_on: [profile-check]
    when: "$profile-check.output.exists == false"
    loop_group:
      until_bash: test $profile-gate.output.decision != "needs-revision"
      max_iterations: 5
      fresh_context: true
      nodes:
        - id: intake
          command: intake
          model: medium
          output_type: factory-profile-draft
          output_format:
            type: object
            properties:
              summary: { type: string }
              assumed:
                type: array
                items: { type: string }
              report:
                type: object
                properties:
                  type: { type: string, enum: [archon_artifact] }
                  run_id: { type: string }
                  path: { type: string, enum: [factory-profile.json] }
                required: [type, run_id, path]
            required: [summary, assumed, report]
        - id: profile-gate
          approval:
            message: |
              GATE 1 — project profile. Read the draft at
              $ARTIFACTS_DIR/factory-profile.json and this summary:

              $intake.output.summary

              approve        → save it as .archon/factory-profile.yaml and continue
              needs-revision → say what to change (free text); the interview repeats
              abort          → stop the run
            decisions:
              - { id: approve, label: Approve }
              - { id: needs-revision, label: Needs revision }
              - { id: abort, label: Abort }
          depends_on: [intake]

  # The loop's output is the gate's output. Whole-output binding on purpose:
  # the dry-run simulator emits the string "approved", a real run emits
  # {decision, text}; scripts/_lib/gate.ts reads both.
  - id: profile-round
    script: gate-round
    runtime: bun
    depends_on: [intake-cycle]
    with:
      gate: "$intake-cycle.output"
    output_format:
      type: object
      properties:
        proceed: { type: boolean }
        decision: { type: string }
        stop_reason: { type: string }
      required: [proceed, decision, stop_reason]

  - id: abort-profile
    cancel: "Stopped at the profile gate: $profile-round.output.stop_reason"
    depends_on: [profile-round]
    when: "$profile-round.output.proceed == false"

  - id: profile-write
    script: write-profile
    runtime: bun
    depends_on: [profile-round]
    when: "$profile-round.output.proceed == true"
    output_format:
      type: object
      properties:
        written: { type: boolean }
        path: { type: string }
        commit: { type: string }
      required: [written, path, commit]

  # Joins both paths: profile already existed (write skipped) or was just written.
  - id: load-profile
    script: load-profile
    runtime: bun
    depends_on: [profile-check, profile-write]
    trigger_rule: none_failed_min_one_success
    output_format:
      type: object
      properties:
        language: { type: string }
        framework: { type: string }
        test_command: { type: string }
        lint_command: { type: string }
        build_command: { type: string }
        remote: { type: string }
        base_branch: { type: string }
        merge_strategy: { type: string }
        deploy_command: { type: string }
        health_url: { type: string }
        wait_seconds: { type: number }
        rollback_command: { type: string }
        monitoring_provider: { type: string }
        window_minutes: { type: number }
        secret_names:
          type: array
          items: { type: string }
      required: [language, test_command, remote, base_branch, merge_strategy, deploy_command, health_url, wait_seconds, rollback_command, monitoring_provider, window_minutes, secret_names]
```

- [ ] **Step 3: Validate**

Run: `archon validate workflows factory --cwd "$PWD" 2>&1 | grep -v '^{"level"'`
Expected: `factory  ok` with no warnings. A "sole terminal sink" warning means a node was added after `profile-gate` inside the loop — fix it.

- [ ] **Step 4: Write the two fixtures**

`.archon/workflows/sdlc-factory/factory/fixtures/fresh-profile.stubs.yaml`:

```yaml
# First run: no profile → interview → (auto-approved gate) → write → load.
# gate-round executes for real (exec-code); write-profile and load-profile are
# stubbed because the scratch worktree has no draft and no profile file.
profile-check: '{"exists":false}'
intake:
  summary: "stub: python/fastapi detected; deploy via docker compose over ssh (assumed)"
  assumed: [deploy.command, deploy.health_url]
  report: { type: archon_artifact, run_id: "fixture-run", path: "factory-profile.json" }
profile-write: { written: true, path: ".archon/factory-profile.yaml", commit: "0000000" }
load-profile: &profile
  language: python
  framework: fastapi
  test_command: "pytest -q"
  lint_command: ""
  build_command: ""
  remote: origin
  base_branch: main
  merge_strategy: squash
  deploy_command: "echo deploy"
  health_url: "https://app.example.com/health"
  wait_seconds: 120
  rollback_command: "echo rollback"
  monitoring_provider: sentry
  window_minutes: 10
  secret_names: [SENTRY_AUTH_TOKEN]
exec-code: true
fixture:
  expect: completed
  inputs:
    task: "add a /health endpoint"
```

`.archon/workflows/sdlc-factory/factory/fixtures/existing-profile.stubs.yaml`:

```yaml
# Profile already committed: the interview and the write are skipped.
profile-check: '{"exists":true}'
load-profile:
  language: python
  framework: fastapi
  test_command: "pytest -q"
  lint_command: ""
  build_command: ""
  remote: origin
  base_branch: main
  merge_strategy: squash
  deploy_command: "echo deploy"
  health_url: "https://app.example.com/health"
  wait_seconds: 120
  rollback_command: "echo rollback"
  monitoring_provider: none
  window_minutes: 10
  secret_names: []
exec-code: true
fixture:
  expect: completed
  inputs:
    task: "add a /health endpoint"
```

- [ ] **Step 5: Run the fixtures** (the repo needs at least one commit — Task 1 made one)

Run: `archon workflow test factory --cwd "$PWD" 2>&1 | grep -v '^{"level"'`
Expected: `2 passed, 0 failed`. If a stub is reported unused or missing, compare with `archon workflow run factory --cwd "$PWD" --dry-run --stubs-init /tmp/scaffold.yaml "x"` and fix ids.

- [ ] **Step 6: Commit (ask the user first)**

```bash
git add .archon/workflows/sdlc-factory/factory/factory.yaml .archon/workflows/sdlc-factory/factory/commands/intake.md .archon/workflows/sdlc-factory/factory/fixtures
git commit -m "feat(factory): profile intake, gate and load"
```

---

### Task 7: Workflow part 2 — plan loop, plan gate, deliver, merge

**Files:**
- Modify: `.archon/workflows/sdlc-factory/factory/factory.yaml` (append nodes; `returns:` → `merge` for now)
- Modify: both fixtures (add plan/deliver/merge stubs)

**Interfaces:**
- Produces node ids: `plan-cycle` (body `plan` = include `archon-plan`, `plan-gate`), `plan-round`, `abort-plan`, `deliver` (include `archon-deliver`, output `{pr_url}`), `merge` (output `{merged, merge_sha, head}`).

- [ ] **Step 1: Append to `.archon/workflows/sdlc-factory/factory/factory.yaml` and change `returns: load-profile` to `returns: merge`**

```yaml
  # ── Plan ───────────────────────────────────────────────────────────────────
  # archon-plan writes $ARTIFACTS_DIR/plan.md and returns {ready, summary, report}.
  # `ready` is not reachable outside the loop (only the last node's output is),
  # so the gate message states it in words.
  - id: plan-cycle
    depends_on: [load-profile]
    loop_group:
      until_bash: test $plan-gate.output.decision != "needs-revision"
      max_iterations: 3
      fresh_context: true
      nodes:
        - id: plan
          include: archon-plan
          with:
            work: >-
              Plan this task for the project described by the profile below.
              Task: $INPUTS.task
              Original request: $ARGUMENTS
              Operator feedback on the previous plan (empty or a literal
              placeholder on the first round; when present, revise the previous
              plan at $ARTIFACTS_DIR/plan.md accordingly instead of starting
              over): $LOOP_PREV.plan-gate.output.text
              Project profile: language $load-profile.output.language,
              framework $load-profile.output.framework, tests run with
              `$load-profile.output.test_command`, lint with
              `$load-profile.output.lint_command`, build with
              `$load-profile.output.build_command`, base branch
              $load-profile.output.base_branch. The result will be merged and
              deployed automatically, so the plan must include the checks that
              prove the change is safe to ship.
        - id: plan-gate
          approval:
            message: |
              GATE 2 — the plan. Ready to build: $plan.output.ready
              Summary: $plan.output.summary
              Full plan: $ARTIFACTS_DIR/plan.md

              approve        → build, review, merge, deploy and verify WITHOUT further questions
              needs-revision → say what to change; the plan is redone
              abort          → stop the run
              (If "Ready to build" is false, the plan names what is missing —
              answer it with needs-revision or abort; approving a blocked plan
              makes the build fail honestly.)
            decisions:
              - { id: approve, label: Approve }
              - { id: needs-revision, label: Needs revision }
              - { id: abort, label: Abort }
          depends_on: [plan]

  - id: plan-round
    script: gate-round
    runtime: bun
    depends_on: [plan-cycle]
    with:
      gate: "$plan-cycle.output"
    output_format:
      type: object
      properties:
        proceed: { type: boolean }
        decision: { type: string }
        stop_reason: { type: string }
      required: [proceed, decision, stop_reason]

  - id: abort-plan
    cancel: "Stopped at the plan gate: $plan-round.output.stop_reason"
    depends_on: [plan-round]
    when: "$plan-round.output.proceed == false"

  # ── Deliver (bundled block): implement → green gate → draft PR → review →
  # corrections → validate → CI → ready flip. Returns {pr_url}. ───────────────
  - id: deliver
    include: archon-deliver
    depends_on: [plan-round]
    when: "$plan-round.output.proceed == true"
    with:
      work: >-
        Deliver the plan at $ARTIFACTS_DIR/plan.md — read it in full first. The
        project's own checks: tests `$load-profile.output.test_command`, lint
        `$load-profile.output.lint_command`, build `$load-profile.output.build_command`
        (an empty command means the project has none). The pull request will be
        merged and deployed automatically once it is ready, so never leave a
        known failure behind. Original request: $INPUTS.task $ARGUMENTS

  # ── Merge ──────────────────────────────────────────────────────────────────
  - id: merge
    bash: |
      set -euo pipefail
      PR_URL=$deliver.output.pr_url
      STRATEGY=$load-profile.output.merge_strategy
      case "$STRATEGY" in squash|merge|rebase) ;; *) printf '%s\n' "merge: unknown merge_strategy '$STRATEGY'" >&2; exit 1;; esac
      # Owner/repo is normalised inside the substitution so a token-bearing remote
      # URL never reaches a command line or a message.
      if ! ORIGIN_REPO=$(git remote get-url origin 2>/dev/null | sed -E 's#^.*[:/]([^/]+/[^/]+)$#\1#; s#\.git$##'); then
        printf '%s\n' "merge: could not read the origin remote." >&2; exit 1
      fi
      if ! HEAD_BRANCH=$(gh pr view "$PR_URL" --json headRefName --jq .headRefName 2>/dev/null); then
        printf '%s\n' "merge: could not read the pull request." >&2; exit 1
      fi
      if ! OUT=$(gh pr merge "$PR_URL" "--$STRATEGY" 2>&1); then
        printf '%s\n' "merge: gh pr merge failed: $OUT" >&2; exit 1
      fi
      STATE=$(gh pr view "$PR_URL" --json state --jq .state 2>/dev/null || true)
      if [ "$STATE" != "MERGED" ]; then
        printf '%s\n' "merge: pull request is not MERGED after the merge (state: $STATE)." >&2; exit 1
      fi
      # Best effort; a protected or already-deleted branch must not fail the run.
      git push origin --delete "$HEAD_BRANCH" >/dev/null 2>&1 || true
      gh pr view "$PR_URL" --json mergeCommit,headRefName --jq '{merged: true, merge_sha: .mergeCommit.oid, head: .headRefName}' 2>/dev/null
    timeout: 300000
    depends_on: [deliver]
    output_format:
      type: object
      properties:
        merged: { type: boolean }
        merge_sha: { type: string, minLength: 1 }
        head: { type: string }
      required: [merged, merge_sha, head]
```

- [ ] **Step 2: Validate**

Run: `archon validate workflows factory --cwd "$PWD" 2>&1 | grep -v '^{"level"'`
Expected: `ok`. An error naming an unknown node id means a typo in a reference. If validation rejects `$LOOP_PREV.plan-gate.output.text` inside the include `with:` value (the probe only verified it inside a command file), delete that sentence from `work:` — the previous plan is still overwritten at `$ARTIFACTS_DIR/plan.md` and the operator's feedback is visible in the run transcript — and note the change in the spec.

- [ ] **Step 3: Generate the stub scaffold to learn the include-expanded ids**

Run: `archon workflow run factory --cwd "$PWD" --dry-run --stubs-init /tmp/factory-scaffold.yaml "x" 2>&1 | grep -v '^{"level"' | tail -3 && cat /tmp/factory-scaffold.yaml`
Expected: a mapping listing `plan__plan`, `plan__assert-intact`, `deliver__impl__record-start`, `deliver__impl__implement`, `deliver__impl__assert-changed`, `deliver__gate-green`, `deliver__pr__pr`, `deliver__classify`, `deliver__resolve-scope`, `deliver__review__*`, `deliver__gate-ready`, `deliver__validate__validate`, `deliver__gate-validated`, `deliver__ci-verdict`, `deliver__flip-ready`, `deliver__outcome`, `merge`, plus loop-body ids (`ci-probe`, …). Use exactly the ids the scaffold prints.

- [ ] **Step 4: Add these stubs to BOTH fixtures** (values adapted from Archon's `ship/fixtures/planned-delivered.stubs.yaml`; reconcile ids with the scaffold from Step 3)

```yaml
plan__plan:
  ready: true
  summary: "stub: approach chosen and plan ready"
  report: { type: archon_artifact, run_id: "fixture-run", path: "plan.md" }
plan__assert-intact: "ok"
deliver__impl__record-start: '{"start":"recorded"}'
deliver__impl__implement:
  done: true
  green: true
  red_cause: ""
  summary: "stub: implemented and green"
deliver__impl__assert-changed: "2 files changed"
deliver__gate-green: '{"gate":"green","red_cause":"","stage":"The implementation","summary":""}'
deliver__pr__pr: { repo: { host: "github.com", path: "example/repo" }, number: 3, url: "https://github.com/example/repo/pull/3", head: "fixture-branch", base: "main", is_draft: true }
deliver__classify:
  errors: false
  docs: false
  reasons: { errors: "stub", docs: "stub" }
deliver__resolve-scope: '{"errors":"false"}'
deliver__review__mode: '{"continuation":false}'
deliver__review__scope: { docs: false }
deliver__review__code: "0 findings"
deliver__review__seams: "0 findings"
deliver__review__simplify: "0 findings"
deliver__review__tests: "0 findings"
deliver__review__review-complete: "settled"
deliver__review__synthesize:
  ready: true
  action: none
  findings_summary: "stub: no open findings"
  report: { type: archon_artifact, run_id: "fixture-run", path: "review/report.md" }
deliver__gate-ready: '{"gate":"ready"}'
deliver__validate__validate:
  green: true
  red_cause: ""
  summary: "stub: project gate green"
deliver__gate-validated: '{"gate":"green","red_cause":"","stage":"The project gate","summary":""}'
ci-probe: '{"state":"concluded","detail":"all checks green"}'
deliver__ci-verdict: '{"state":"concluded","detail":"all checks green"}'
deliver__flip-ready: { pr_url: "https://github.com/example/repo/pull/3" }
deliver__outcome: { pr_url: "https://github.com/example/repo/pull/3", summary: "https://github.com/example/repo/pull/3" }
merge: { merged: true, merge_sha: "abc1234", head: "fixture-branch" }
```

- [ ] **Step 5: Run the fixtures**

Run: `archon workflow test factory --cwd "$PWD" 2>&1 | grep -v '^{"level"'`
Expected: `2 passed, 0 failed`. Missing-stub errors name the id to add; unused-stub warnings name ids to remove.

- [ ] **Step 6: Commit (ask the user first)**

```bash
git add .archon/workflows/sdlc-factory/factory/factory.yaml .archon/workflows/sdlc-factory/factory/fixtures
git commit -m "feat(factory): plan gate, deliver and merge"
```

---

### Task 8: Workflow part 3 — deploy, health, monitoring, rollback, report, cancel-on-red

**Files:**
- Create: `.archon/workflows/sdlc-factory/factory/commands/monitor.md`, `.archon/workflows/sdlc-factory/factory/fixtures/red-health-rollback.stubs.yaml`, `.archon/workflows/sdlc-factory/factory/fixtures/monitor-errors-rollback.stubs.yaml`, `.archon/workflows/sdlc-factory/factory/fixtures/deploy-failed.stubs.yaml`, `examples/mcp/monitoring.sentry.example.json`, `examples/mcp/monitoring.datadog.example.json`
- Modify: `.archon/workflows/sdlc-factory/factory/factory.yaml` (append; `returns:` → `report`), both existing fixtures (add tail stubs)

**Interfaces:**
- Produces node ids: `deploy`, `health`, `monitor-check`, `monitor`, `decide-rollback`, `rollback`, `report`, `not-delivered`.

- [ ] **Step 1: Write `.archon/workflows/sdlc-factory/factory/commands/monitor.md`**

```markdown
You are the post-deploy monitoring check of the Archon `factory` workflow. You
have ONLY the tools of the monitoring MCP server declared for this node; you
cannot read files or run commands.

Provider: $INPUTS.provider
Deploy finished at (UTC): $INPUTS.deployed_at
Merged commit: $INPUTS.merge_sha
Window to inspect: the $INPUTS.window_minutes minutes after the deploy timestamp.

Using the provider's tools, list issues/errors/alerts that were FIRST SEEN
after the deploy timestamp (new issues, or regressions of resolved issues).
Ignore issues that already existed before it. If the provider tools are absent,
fail, or cannot answer, report `unavailable` — never guess.

Return the structured result:
- `status`: `errors` when at least one new issue exists in the window;
  `healthy` when the query succeeded and found none; `unavailable` when the
  tools were missing or failed.
- `findings`: one short line per new issue (title, count, first seen), or the
  reason the check was unavailable, or "" when healthy. Never include raw
  payloads, stack traces or credentials.
```

- [ ] **Step 2: Append to `.archon/workflows/sdlc-factory/factory/factory.yaml` and change `returns: merge` to `returns: report`**

```yaml
  # ── Deploy / health / monitoring ───────────────────────────────────────────
  - id: deploy
    script: deploy
    runtime: bun
    depends_on: [merge]
    timeout: 1800000
    with:
      command: "$load-profile.output.deploy_command"
      secret_names: "$load-profile.output.secret_names"
      remote: "$load-profile.output.remote"
      merge_sha: "$merge.output.merge_sha"
    output_format:
      type: object
      properties:
        deployed: { type: boolean }
        exit_code: { type: number }
        deployed_at: { type: string }
        log: { type: string }
      required: [deployed, exit_code, deployed_at, log]

  # Always exits 0: red health is a reported state, decide-rollback owns what it means.
  - id: health
    bash: |
      URL=$load-profile.output.health_url
      WAIT=$load-profile.output.wait_seconds
      START=$(date +%s); STATUS=000; ELAPSED=0
      while :; do
        STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$URL" 2>/dev/null || printf '000')
        ELAPSED=$(( $(date +%s) - START ))
        [ "$STATUS" = "200" ] && break
        [ "$ELAPSED" -ge "$WAIT" ] && break
        sleep 5
      done
      if [ "$STATUS" = "200" ]; then H=true; else H=false; fi
      printf '{"healthy":%s,"last_status":"%s","elapsed_seconds":%s}' "$H" "$STATUS" "$ELAPSED"
    timeout: 1800000
    depends_on: [deploy]
    when: "$deploy.output.deployed == true"
    output_format:
      type: object
      properties:
        healthy: { type: boolean }
        last_status: { type: string }
        elapsed_seconds: { type: number }
      required: [healthy, last_status, elapsed_seconds]

  - id: monitor-check
    bash: |
      PROVIDER=$load-profile.output.monitoring_provider
      if [ "$PROVIDER" != "none" ] && [ -f .archon/mcp/monitoring.json ]; then printf '{"enabled":true}'; else printf '{"enabled":false}'; fi
    depends_on: [health]
    when: "$health.output.healthy == true"
    output_format:
      type: object
      properties:
        enabled: { type: boolean }
      required: [enabled]

  - id: monitor
    command: monitor
    model: medium
    mcp: .archon/mcp/monitoring.json
    allowed_tools: []
    depends_on: [monitor-check]
    when: "$monitor-check.output.enabled == true"
    with:
      provider: "$load-profile.output.monitoring_provider"
      window_minutes: "$load-profile.output.window_minutes"
      deployed_at: "$deploy.output.deployed_at"
      merge_sha: "$merge.output.merge_sha"
    output_type: monitoring-verdict
    output_format:
      type: object
      properties:
        status: { type: string, enum: [healthy, errors, unavailable] }
        findings: { type: string }
      required: [status, findings]

  # ── Rollback decision ──────────────────────────────────────────────────────
  - id: decide-rollback
    script: decide-rollback
    runtime: bun
    depends_on: [deploy, health, monitor]
    trigger_rule: all_done
    with:
      deployed: { from: "$deploy.output.deployed", if_skipped: "skipped" }
      healthy: { from: "$health.output.healthy", if_skipped: "skipped" }
      monitor_status: { from: "$monitor.output.status", if_skipped: "skipped" }
    output_format:
      type: object
      properties:
        rollback: { type: boolean }
        reason: { type: string }
      required: [rollback, reason]

  - id: rollback
    script: rollback
    runtime: bun
    depends_on: [decide-rollback]
    when: "$decide-rollback.output.rollback == true"
    timeout: 1800000
    with:
      command: "$load-profile.output.rollback_command"
      secret_names: "$load-profile.output.secret_names"
    output_format:
      type: object
      properties:
        rolled_back: { type: boolean }
        exit_code: { type: number }
        log: { type: string }
      required: [rolled_back, exit_code, log]

  # ── Report ─────────────────────────────────────────────────────────────────
  - id: report
    script: report
    runtime: bun
    depends_on: [merge, deploy, health, monitor, decide-rollback, rollback]
    trigger_rule: none_failed_min_one_success
    with:
      pr_url: "$deliver.output.pr_url"
      merged: "$merge.output.merged"
      merge_sha: "$merge.output.merge_sha"
      deployed: { from: "$deploy.output.deployed", if_skipped: "skipped" }
      deploy_exit: { from: "$deploy.output.exit_code", if_skipped: "" }
      healthy: { from: "$health.output.healthy", if_skipped: "skipped" }
      last_status: { from: "$health.output.last_status", if_skipped: "" }
      health_url: "$load-profile.output.health_url"
      monitor_status: { from: "$monitor.output.status", if_skipped: "skipped" }
      monitor_findings: { from: "$monitor.output.findings", if_skipped: "" }
      rollback: "$decide-rollback.output.rollback"
      rolled_back: { from: "$rollback.output.rolled_back", if_skipped: "skipped" }
      rollback_reason: "$decide-rollback.output.reason"
    output_format:
      type: object
      properties:
        delivered: { type: boolean }
        summary: { type: string }
        pr_url: { type: string }
        merge_sha: { type: string }
        deploy_status: { type: string }
        health: { type: string }
        monitoring: { type: string }
        rollback: { type: string }
      required: [delivered, summary, pr_url, merge_sha, deploy_status, health, monitoring, rollback]

  # Archon v0.10.1 rejects `outcome_field` on exec nodes, so a red result ends
  # the run here with the report's summary as the reason.
  - id: not-delivered
    cancel: "Not delivered — $report.output.summary"
    depends_on: [report]
    when: "$report.output.delivered == false"
```

- [ ] **Step 3: Validate**

Run: `archon validate workflows factory --cwd "$PWD" 2>&1 | grep -v '^{"level"'`
Expected: `ok`. An error like "INPUTS_X read has no binding" means a `with:` key and a `process.env.INPUTS_X` read disagree — align the names.

- [ ] **Step 4: Add the tail stubs to `fresh-profile` and `existing-profile`**

Append to both (`fresh-profile` keeps `monitoring_provider: sentry`; in `existing-profile` the provider is `none`, so leave out `monitor-check`/`monitor` there — `monitor-check` executes for real and prints `enabled:false`):

```yaml
deploy: { deployed: true, exit_code: 0, deployed_at: "2026-09-20T10:00:00Z", log: "deploy.log" }
health: { healthy: true, last_status: "200", elapsed_seconds: 4 }
monitor-check: '{"enabled":true}'
monitor: { status: healthy, findings: "" }
```

`decide-rollback` and `report` are executed for real (`exec-code: true`); `rollback` is skipped by `when:`.

- [ ] **Step 5: Write the three red fixtures** (copy `fresh-profile.stubs.yaml`, then change only these keys)

`red-health-rollback.stubs.yaml`:

```yaml
health: { healthy: false, last_status: "503", elapsed_seconds: 120 }
rollback: { rolled_back: true, exit_code: 0, log: "rollback.log" }
fixture:
  expect: cancelled
  inputs:
    task: "add a /health endpoint"
```
(remove the `monitor-check` and `monitor` stubs: both are skipped)

`monitor-errors-rollback.stubs.yaml`:

```yaml
monitor: { status: errors, findings: "TypeError in /health handler (12 events, first seen 10:01Z)" }
rollback: { rolled_back: true, exit_code: 0, log: "rollback.log" }
fixture:
  expect: cancelled
  inputs:
    task: "add a /health endpoint"
```

`deploy-failed.stubs.yaml`:

```yaml
deploy: { deployed: false, exit_code: 2, deployed_at: "2026-09-20T10:00:00Z", log: "deploy.log" }
fixture:
  expect: cancelled
  inputs:
    task: "add a /health endpoint"
```
(remove `health`, `monitor-check`, `monitor` stubs: all skipped)

- [ ] **Step 6: Run all fixtures**

Run: `archon workflow test factory --cwd "$PWD" 2>&1 | grep -v '^{"level"'`
Expected: `5 passed, 0 failed`. To inspect a failing path: `archon workflow run factory --cwd "$PWD" --dry-run --stubs <plain-stub-map> --exec-code --json "x"` (strip the `fixture:`/`exec-code:` keys into a temporary file first) and read `trace[].reason`.

- [ ] **Step 7: Write the MCP examples**

`examples/mcp/monitoring.sentry.example.json`:

```json
{
  "sentry": {
    "type": "http",
    "url": "https://mcp.sentry.dev/mcp",
    "headers": { "Authorization": "Bearer $SENTRY_AUTH_TOKEN" }
  }
}
```

`examples/mcp/monitoring.datadog.example.json`:

```json
{
  "datadog": {
    "command": "npx",
    "args": ["-y", "@winor30/mcp-server-datadog"],
    "env": { "DATADOG_API_KEY": "$DATADOG_API_KEY", "DATADOG_APP_KEY": "$DATADOG_APP_KEY", "DATADOG_SITE": "datadoghq.com" }
  }
}
```

Both files carry a top comment in the README (JSON has none): copy to `.archon/mcp/monitoring.json` in the target repo, add `.archon/mcp/` to its `.gitignore`, export the variables before running.

- [ ] **Step 8: Commit (ask the user first)**

```bash
git add .archon/workflows examples
git commit -m "feat(factory): deploy, health, monitoring, rollback and report"
```

---

### Task 9: Installer, README, global install check

**Files:**
- Create: `install.sh`, `README.md`

- [ ] **Step 1: Write `install.sh`**

```bash
#!/usr/bin/env bash
# Installs the `factory` workflow package globally for Archon and validates it.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCHON_HOME="${ARCHON_HOME:-$HOME/.archon}"
DEST="$ARCHON_HOME/workflows/sdlc-factory/factory"

command -v archon >/dev/null || { echo "archon not found. Install: curl -fsSL https://archon.diy/install | bash" >&2; exit 1; }
command -v bun >/dev/null || { echo "bun not found. Install: curl -fsSL https://bun.sh/install | bash" >&2; exit 1; }
command -v gh >/dev/null || { echo "gh not found. Install GitHub CLI and run: gh auth login" >&2; exit 1; }

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -R "$HERE/.archon/workflows/sdlc-factory/factory" "$DEST"
echo "Installed to $DEST"

# Validation needs a git checkout; use this repo when the caller is not in one.
CWD="$PWD"
git -C "$CWD" rev-parse --is-inside-work-tree >/dev/null 2>&1 || CWD="$HERE"
archon validate workflows factory --cwd "$CWD" 2>&1 | grep -v '^{"level"' | tail -3
```

Run: `chmod +x install.sh && ./install.sh`
Expected: `Installed to ~/.archon/workflows/sdlc-factory/factory` and `factory  ok`.

- [ ] **Step 2: Verify the global package from an unrelated repository**

Run: `cd /tmp && rm -rf gtest && mkdir gtest && cd gtest && git init -q && git commit -q --allow-empty -m init && archon workflow test factory --cwd "$PWD" 2>&1 | grep -v '^{"level"' | tail -3`
Expected: `5 passed, 0 failed`.

- [ ] **Step 3: Write `README.md`**

Sections, in this order, each a few lines:
1. **What it is** — the one-paragraph goal from spec §1.
2. **Install** — the three prerequisites with commands (`curl -fsSL https://bun.sh/install | bash`, `curl -fsSL https://archon.diy/install | bash`, `gh auth login`), then `./install.sh`.
3. **First run** — `archon workflow run factory --cwd /path/to/repo "describe the task"`; what gate 1 shows; the three responses (`archon workflow respond <run-id> approve | needs-revision "text" | abort`); gate 2; then hands-off.
4. **The profile** — where it lives, the field list (link to `examples/factory-profile.example.yaml`), that secrets are names only.
5. **Monitoring** — copy an example from `examples/mcp/` to `.archon/mcp/monitoring.json`, gitignore it, export the variables; `provider: none` skips it.
6. **What happens on red** — health or monitoring red → rollback command → run ends `cancelled` with the report summary; `report.json`, `deploy.log`, `rollback.log` under the run's artifacts (`archon workflow get <run-id>` prints the path).
7. **Testing** — `bun test`, `archon validate workflows factory --cwd .`, `archon workflow test factory --cwd .`.
8. **Known limits (v1)** — spec §6 and §8, plus: `outcome_field` disabled until Archon > 0.10.1.

- [ ] **Step 4: Full verification**

Run: `bun test && archon validate workflows factory --cwd "$PWD" 2>&1 | grep -v '^{"level"' | tail -2 && archon workflow test factory --cwd "$PWD" 2>&1 | grep -v '^{"level"' | tail -2`
Expected: all unit tests pass, `factory ok`, `5 passed, 0 failed`.

- [ ] **Step 5: Commit (ask the user first)**

```bash
git add install.sh README.md
git commit -m "feat: installer and README"
```

---

### Task 10: Live smoke run on a throwaway repository (user-driven)

This task needs the user's GitHub account and a real Claude session; it is executed together with the user, not by a subagent.

- [ ] **Step 1: Create a throwaway repo** — `gh repo create factory-smoke --private --clone`, add a trivial Python or Node app with one test and a `/health` route runnable locally (`python -m http.server 8000` serving a `health` file is enough), commit and push.
- [ ] **Step 2: Green run** — `archon workflow run factory --cwd ~/factory-smoke "add a README section describing the health endpoint"`. Answer gate 1 with `needs-revision "deploy.command: echo deploy; deploy.health_url: http://localhost:8000/health; rollback_command: echo rollback; monitoring.provider: none"` once, then `approve`; approve gate 2. Before launching, `export FACTORY_SMOKE_SECRET=hunter22` and use `deploy.command: echo deploy $FACTORY_SMOKE_SECRET` with `secrets: [FACTORY_SMOKE_SECRET]`. Expected: PR merged, `deploy.log` contains `deploy ***` and never `hunter22` (proves the array binding reached the script and redaction works), health 200, run `completed`, `report.json` has `delivered: true`.
- [ ] **Step 3: Red run** — edit `.archon/factory-profile.yaml` in the smoke repo so `health_url` points to a port nothing listens on and `wait_seconds: 20`; commit; run another task. Expected: rollback executed (`rollback.log` contains `rollback`), run `cancelled` with reason starting `Not delivered — `.
- [ ] **Step 4: Record findings** — append a "Live run 2026-xx-xx" section to the spec with anything the live run changed, and open follow-up tasks for it.
