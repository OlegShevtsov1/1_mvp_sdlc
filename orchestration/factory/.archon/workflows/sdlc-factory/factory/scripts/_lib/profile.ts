export const PROFILE_PATH = ".archon/factory-profile.yaml";
export const MONITORING_MCP_PATH = ".archon/mcp/monitoring.json";

export const MERGE_STRATEGIES = ["squash", "merge", "rebase"] as const;
export const MONITORING_PROVIDERS = ["sentry", "datadog", "grafana", "none"] as const;
// Decision 27: pull requests into these bases are merged by the operator, never the factory.
export const DEFAULT_MANUAL_MERGE_BASES: readonly string[] = ["main"];

export interface Profile {
  version: 1;
  stack: { language: string; framework: string; test_command: string; lint_command: string; build_command: string };
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
