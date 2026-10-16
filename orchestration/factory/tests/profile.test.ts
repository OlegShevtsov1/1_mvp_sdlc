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
  test("accepts an empty test_command", () => {
    const r = validateProfile({ ...good, stack: { ...good.stack, test_command: "" } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(flattenProfile(r.profile).test_command).toBe("");
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

  test("secret names that are YAML keywords round-trip as strings", () => {
    const r = validateProfile({ ...good, secrets: ["TRUE", "NULL_TOKEN"] });
    if (!r.ok) throw new Error(r.errors.join(","));
    const yaml = profileToYaml(r.profile);
    const parsed = Bun.YAML.parse(yaml) as { secrets: unknown };
    // Unquoted, `- TRUE` parses as the boolean true and the profile no longer validates.
    expect(parsed.secrets).toEqual(["TRUE", "NULL_TOKEN"]);
    const back = validateProfile(parsed);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.profile).toEqual(r.profile);
  });
});
