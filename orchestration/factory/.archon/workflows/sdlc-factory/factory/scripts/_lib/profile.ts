export const PROFILE_PATH = ".archon/factory-profile.yaml";
export const MONITORING_MCP_PATH = ".archon/mcp/monitoring.json";
export const PROFILE_COMMIT_MESSAGE = "chore: add factory profile";

export const MERGE_STRATEGIES = ["squash", "merge", "rebase"] as const;
export const MONITORING_PROVIDERS = ["sentry", "datadog", "grafana", "none"] as const;
// Decision 27: pull requests into these bases are merged by the operator, never the factory.
export const DEFAULT_MANUAL_MERGE_BASES: readonly string[] = ["main"];
// The merge gate's limit for one run of the test command. The merge-gate node
// timeout in factory.yaml is sized for twice the maximum (one retry after a timeout).
export const DEFAULT_TEST_TIMEOUT_SECONDS = 1000;
export const MAX_TEST_TIMEOUT_SECONDS = 3600;

// stack.preflight (PILOT-499): what the test command needs from the Archon host,
// checked before any work and again right before the merge gate's commands.
export const DEFAULT_MIN_DISK_FREE_PCT = 20;
// Bounds the preflight's worst case (one start per service, see _lib/host-check.ts).
export const MAX_PREFLIGHT_SERVICES = 8;

export interface PreflightService {
  name: string;
  tcp: string;
  // A shell command run once when the service does not answer; "" means check only.
  start: string;
}

export interface PreflightConfig {
  tools: string[];
  services: PreflightService[];
  // 0 turns the disk check off.
  min_disk_free_pct: number;
}

const COMMAND_NAME = /^[A-Za-z0-9._+-]+$/;
const SERVICE_NAME = /^[A-Za-z0-9._-]+$/;
const TCP_ADDRESS = /^(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+):([0-9]{1,5})$/;

function isValidTcp(tcp: string): boolean {
  const m = TCP_ADDRESS.exec(tcp);
  const port = m ? Number(m[2]) : 0;
  return port >= 1 && port <= 65535;
}

function isValidTestTimeout(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_TEST_TIMEOUT_SECONDS;
}

export interface Profile {
  version: 1;
  stack: {
    language: string; framework: string; test_command: string; lint_command: string; build_command: string;
    test_timeout_seconds: number;
    // Substrings of a CI job name or of its failed-step log; a red check that
    // matches gets one `gh run rerun --failed` before the merge gate refuses.
    flaky_patterns: string[];
    preflight?: PreflightConfig;
  };
  repo: {
    remote: string; base_branch: string; merge_strategy: (typeof MERGE_STRATEGIES)[number];
    manual_merge_bases: string[];
  };
  deploy: { command: string; health_url: string; wait_seconds: number; rollback_command: string };
  monitoring: { provider: (typeof MONITORING_PROVIDERS)[number]; mcp_config: string; window_minutes: number };
  secrets: string[];
}

export interface FlatProfile {
  language: string; framework: string;
  test_command: string; lint_command: string; build_command: string;
  test_timeout_seconds: number;
  flaky_patterns: string[];
  preflight?: PreflightConfig;
  remote: string; base_branch: string; merge_strategy: string;
  deploy_command: string; health_url: string; wait_seconds: number; rollback_command: string;
  monitoring_provider: string; window_minutes: number;
  secret_names: string[];
  manual_merge_bases: string[];
}

const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;
const BRANCH_NAME = /^[A-Za-z0-9._\/-]+$/;

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

export function validatePreflight(raw: unknown, errors: string[]): PreflightConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("stack.preflight must be a mapping");
    return undefined;
  }
  const section = raw as Record<string, unknown>;
  const cfg: PreflightConfig = { tools: [], services: [], min_disk_free_pct: DEFAULT_MIN_DISK_FREE_PCT };
  const tools = section.tools;
  if (tools !== undefined && tools !== null) {
    if (!Array.isArray(tools)) {
      errors.push("stack.preflight.tools must be a list of command names");
    } else {
      tools.forEach((t, i) => {
        if (typeof t !== "string" || !COMMAND_NAME.test(t)) errors.push(`stack.preflight.tools[${i}] must be a command name`);
        else cfg.tools.push(t);
      });
    }
  }
  const services = section.services;
  if (services !== undefined && services !== null) {
    if (!Array.isArray(services)) {
      errors.push("stack.preflight.services must be a list of {name, tcp, start} mappings");
    } else if (services.length > MAX_PREFLIGHT_SERVICES) {
      errors.push(`stack.preflight.services must list at most ${MAX_PREFLIGHT_SERVICES} services`);
    } else {
      services.forEach((raw, i) => {
        const path = `stack.preflight.services[${i}]`;
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
          errors.push(`${path} must be a mapping`);
          return;
        }
        const svc = raw as Record<string, unknown>;
        const name = str(svc, "name", path, errors, true);
        if (name !== "" && !SERVICE_NAME.test(name)) errors.push(`${path}.name must be a name like postgres`);
        const tcp = str(svc, "tcp", path, errors, true);
        if (tcp !== "" && !isValidTcp(tcp)) errors.push(`${path}.tcp must be host:port with a port from 1 to 65535`);
        cfg.services.push({ name, tcp, start: str(svc, "start", path, errors, false) });
      });
    }
  }
  const pct = section.min_disk_free_pct;
  if (pct !== undefined && pct !== null) {
    if (typeof pct === "number" && Number.isInteger(pct) && pct >= 0 && pct <= 99) cfg.min_disk_free_pct = pct;
    else errors.push("stack.preflight.min_disk_free_pct must be a whole number from 0 to 99");
  }
  return cfg;
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
      // Optional: a project with no test suite is legitimate, and the intake
      // prompt tells the interviewer to write "" when the project has none.
      test_command: str(stack, "test_command", "stack", errors, false),
      lint_command: str(stack, "lint_command", "stack", errors, false),
      build_command: str(stack, "build_command", "stack", errors, false),
      test_timeout_seconds: DEFAULT_TEST_TIMEOUT_SECONDS,
      flaky_patterns: [],
    },
    repo: {
      remote: str(repo, "remote", "repo", errors, true),
      base_branch: str(repo, "base_branch", "repo", errors, true),
      merge_strategy: str(repo, "merge_strategy", "repo", errors, true) as Profile["repo"]["merge_strategy"],
      manual_merge_bases: [],
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

  const testTimeout = stack.test_timeout_seconds;
  if (testTimeout !== undefined && testTimeout !== null) {
    if (isValidTestTimeout(testTimeout)) {
      profile.stack.test_timeout_seconds = testTimeout;
    } else {
      errors.push(`stack.test_timeout_seconds must be a whole number of seconds between 1 and ${MAX_TEST_TIMEOUT_SECONDS}`);
    }
  }
  const flaky = stack.flaky_patterns;
  if (flaky !== undefined && flaky !== null) {
    if (!Array.isArray(flaky)) {
      errors.push("stack.flaky_patterns must be a list of strings");
    } else {
      flaky.forEach((f, i) => {
        if (typeof f !== "string" || f.trim() === "" || f.includes("\n")) {
          errors.push(`stack.flaky_patterns[${i}] must be a non-empty single-line string`);
        } else {
          profile.stack.flaky_patterns.push(f);
        }
      });
    }
  }
  const preflight = validatePreflight(stack.preflight, errors);
  if (preflight !== undefined) profile.stack.preflight = preflight;
  if (!MERGE_STRATEGIES.includes(profile.repo.merge_strategy)) {
    errors.push(`repo.merge_strategy must be one of ${MERGE_STRATEGIES.join(", ")}`);
  }
  const bases = repo.manual_merge_bases;
  if (bases === undefined || bases === null) {
    profile.repo.manual_merge_bases = [...DEFAULT_MANUAL_MERGE_BASES];
  } else if (!Array.isArray(bases)) {
    errors.push("repo.manual_merge_bases must be a list of branch names");
  } else {
    bases.forEach((b, i) => {
      if (typeof b !== "string" || !BRANCH_NAME.test(b)) errors.push(`repo.manual_merge_bases[${i}] must be a branch name`);
      else profile.repo.manual_merge_bases.push(b);
    });
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
    test_timeout_seconds: p.stack.test_timeout_seconds,
    flaky_patterns: [...p.stack.flaky_patterns],
    ...(p.stack.preflight ? { preflight: structuredClone(p.stack.preflight) } : {}),
    remote: p.repo.remote, base_branch: p.repo.base_branch, merge_strategy: p.repo.merge_strategy,
    deploy_command: p.deploy.command, health_url: p.deploy.health_url,
    wait_seconds: p.deploy.wait_seconds, rollback_command: p.deploy.rollback_command,
    monitoring_provider: p.monitoring.provider, window_minutes: p.monitoring.window_minutes,
    secret_names: [...p.secrets],
    manual_merge_bases: [...p.repo.manual_merge_bases],
  };
}

// Every string is emitted as a JSON string literal, which is a valid YAML
// double-quoted scalar, so no value can break the document.
const q = (s: string): string => JSON.stringify(s);

function preflightYaml(cfg: PreflightConfig): string[] {
  return [
    "  preflight:",
    `    tools: ${JSON.stringify(cfg.tools)}`,
    `    services: ${JSON.stringify(cfg.services.map((s) => ({ name: s.name, tcp: s.tcp, start: s.start })))}`,
    `    min_disk_free_pct: ${cfg.min_disk_free_pct}`,
  ];
}

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
    `  test_timeout_seconds: ${p.stack.test_timeout_seconds}`,
    `  flaky_patterns: ${JSON.stringify(p.stack.flaky_patterns)}`,
    ...(p.stack.preflight ? preflightYaml(p.stack.preflight) : []),
    "repo:",
    `  remote: ${q(p.repo.remote)}`,
    `  base_branch: ${q(p.repo.base_branch)}`,
    `  merge_strategy: ${q(p.repo.merge_strategy)}`,
    // A JSON array is a valid YAML flow sequence, quoted for the same reason as q.
    `  manual_merge_bases: ${JSON.stringify(p.repo.manual_merge_bases)}`,
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
    // Quoted like every other scalar: a name such as TRUE, NULL or ON is a
    // YAML 1.1 boolean/null keyword unquoted and would not round-trip as a string.
    ...p.secrets.map((s) => `  - ${q(s)}`),
    "",
  ];
  return lines.join("\n");
}

// `add -f` so a repo that gitignores `.archon/` still tracks the file, and the
// commit is skipped when nothing is staged: re-writing identical bytes must
// count as done, not die on git's "nothing to commit" exit code.
export function commitIfChanged(path: string, message: string): { ok: boolean; err: string } {
  const run = (...args: string[]) => Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const add = run("add", "-f", "--", path);
  if (add.exitCode !== 0) return { ok: false, err: add.stderr.toString().trim() };
  if (run("diff", "--cached", "--quiet").exitCode === 0) return { ok: true, err: "" };
  const commit = run("commit", "-q", "-m", message);
  return { ok: commit.exitCode === 0, err: commit.stderr.toString().trim() };
}
