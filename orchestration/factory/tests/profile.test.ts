import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  test("manual_merge_bases defaults to main when absent", () => {
    const r = validateProfile(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile.repo.manual_merge_bases).toEqual(["main"]);
  });
  test("manual_merge_bases keeps a given list, including an empty one", () => {
    for (const bases of [["main", "release"], []]) {
      const r = validateProfile({ ...good, repo: { ...good.repo, manual_merge_bases: bases } });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.profile.repo.manual_merge_bases).toEqual(bases);
    }
  });
  test("rejects a manual_merge_bases that is not a list", () => {
    const r = validateProfile({ ...good, repo: { ...good.repo, manual_merge_bases: "main" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("repo.manual_merge_bases must be a list of branch names");
  });
  test("rejects a manual_merge_bases element that is not a branch name", () => {
    for (const bad of ["", "a b", 7]) {
      const r = validateProfile({ ...good, repo: { ...good.repo, manual_merge_bases: ["main", bad] } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join(" ")).toContain("repo.manual_merge_bases[1] must be a branch name");
    }
  });
  test("test_timeout_seconds defaults to 1000 when absent or null", () => {
    for (const stack of [good.stack, { ...good.stack, test_timeout_seconds: null }]) {
      const r = validateProfile({ ...good, stack });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.profile.stack.test_timeout_seconds).toBe(1000);
    }
  });
  test("accepts a whole test_timeout_seconds from 1 to 3600", () => {
    for (const seconds of [1, 2400, 3600]) {
      const r = validateProfile({ ...good, stack: { ...good.stack, test_timeout_seconds: seconds } });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.profile.stack.test_timeout_seconds).toBe(seconds);
    }
  });
  test("rejects a test_timeout_seconds that is not a whole number of seconds between 1 and 3600", () => {
    for (const bad of [0, -5, 1.5, "600", 3601]) {
      const r = validateProfile({ ...good, stack: { ...good.stack, test_timeout_seconds: bad } });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors.join(" ")).toContain("stack.test_timeout_seconds must be a whole number of seconds between 1 and 3600");
      }
    }
  });
});

describe("flattenProfile", () => {
  test("produces top-level keys for every consumer", () => {
    const r = validateProfile(good);
    if (!r.ok) throw new Error(r.errors.join(","));
    expect(flattenProfile(r.profile)).toEqual({
      language: "python", framework: "fastapi",
      test_command: "pytest -q", lint_command: "ruff check .", build_command: "",
      test_timeout_seconds: 1000,
      remote: "origin", base_branch: "main", merge_strategy: "squash",
      deploy_command: good.deploy.command, health_url: good.deploy.health_url,
      wait_seconds: 120, rollback_command: good.deploy.rollback_command,
      monitoring_provider: "sentry", window_minutes: 10,
      secret_names: ["DEPLOY_SSH_KEY_PATH", "SENTRY_AUTH_TOKEN"],
      manual_merge_bases: ["main"],
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

  test("manual_merge_bases round-trips, empty or not", () => {
    for (const bases of [[], ["main"]]) {
      const r = validateProfile({ ...good, repo: { ...good.repo, manual_merge_bases: bases } });
      if (!r.ok) throw new Error(r.errors.join(","));
      const back = validateProfile(Bun.YAML.parse(profileToYaml(r.profile)));
      expect(back.ok).toBe(true);
      if (back.ok) expect(back.profile).toEqual(r.profile);
    }
  });

  test("test_timeout_seconds round-trips", () => {
    const r = validateProfile({ ...good, stack: { ...good.stack, test_timeout_seconds: 2400 } });
    if (!r.ok) throw new Error(r.errors.join(","));
    const back = validateProfile(Bun.YAML.parse(profileToYaml(r.profile)));
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

describe("this repository's own profile", () => {
  // The toolkit's PRs go into develop and are merged by the factory; PRs into
  // main are releases the operator merges (decisions 27 and 54).
  test("targets develop and leaves main to the operator (decision 54)", () => {
    const path = join(import.meta.dir, "../../../.archon/factory-profile.yaml");
    const r = validateProfile(Bun.YAML.parse(readFileSync(path, "utf8")));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.profile.repo.base_branch).toEqual("develop");
      expect(r.profile.repo.manual_merge_bases).toEqual(["main"]);
    }
  });
  // check.sh outgrew the 1000 s default under parallel factory load (PILOT-375).
  test("gives the test command more than the default limit", () => {
    const path = join(import.meta.dir, "../../../.archon/factory-profile.yaml");
    const r = validateProfile(Bun.YAML.parse(readFileSync(path, "utf8")));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile.stack.test_timeout_seconds).toBeGreaterThanOrEqual(1600);
  });
});
