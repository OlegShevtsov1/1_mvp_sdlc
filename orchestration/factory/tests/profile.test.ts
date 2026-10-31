import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_MIN_DISK_FREE_PCT,
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
  test("flaky_patterns defaults to an empty list when absent or null", () => {
    for (const stack of [good.stack, { ...good.stack, flaky_patterns: null }]) {
      const r = validateProfile({ ...good, stack });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.profile.stack.flaky_patterns).toEqual([]);
    }
  });
  test("flaky_patterns keeps a given list", () => {
    const r = validateProfile({ ...good, stack: { ...good.stack, flaky_patterns: ["tokenStore", "e2e / login"] } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile.stack.flaky_patterns).toEqual(["tokenStore", "e2e / login"]);
  });
  test("rejects a flaky_patterns that is not a list", () => {
    const r = validateProfile({ ...good, stack: { ...good.stack, flaky_patterns: "tokenStore" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("stack.flaky_patterns must be a list of strings");
  });
  test("rejects a flaky_patterns element that is not a non-empty single-line string", () => {
    for (const bad of ["", "a\nb", 7]) {
      const r = validateProfile({ ...good, stack: { ...good.stack, flaky_patterns: ["tokenStore", bad] } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join(" ")).toContain("stack.flaky_patterns[1] must be a non-empty single-line string");
    }
  });
});

describe("stack.preflight", () => {
  const withPreflight = (preflight: unknown) => validateProfile({ ...good, stack: { ...good.stack, preflight } });
  const errors = (preflight: unknown): string[] => {
    const r = withPreflight(preflight);
    return r.ok ? [] : r.errors;
  };

  test("an absent or null block leaves no preflight in the profile or its flat form", () => {
    for (const r of [validateProfile(good), withPreflight(null)]) {
      if (!r.ok) throw new Error(r.errors.join(","));
      expect(r.profile.stack.preflight).toBeUndefined();
      expect("preflight" in flattenProfile(r.profile)).toBe(false);
    }
  });

  test("a block gets the defaults: 20 % free disk and no start command", () => {
    const r = withPreflight({ tools: ["pytest"], services: [{ name: "db", tcp: "localhost:5432" }] });
    if (!r.ok) throw new Error(r.errors.join(","));
    expect(r.profile.stack.preflight).toEqual({
      tools: ["pytest"], services: [{ name: "db", tcp: "localhost:5432", start: "" }], min_disk_free_pct: DEFAULT_MIN_DISK_FREE_PCT,
    });
    expect(DEFAULT_MIN_DISK_FREE_PCT).toBe(20);
    expect(flattenProfile(r.profile).preflight).toEqual(r.profile.stack.preflight);
    const empty = withPreflight({});
    if (!empty.ok) throw new Error(empty.errors.join(","));
    expect(empty.profile.stack.preflight).toEqual({ tools: [], services: [], min_disk_free_pct: 20 });
  });

  test("accepts an IPv6 address, a start command and a 0 that turns the disk check off", () => {
    const r = withPreflight({ services: [{ name: "redis", tcp: "[::1]:6379", start: "docker compose up -d redis" }], min_disk_free_pct: 0 });
    expect(r.ok).toBe(true);
  });

  test("rejects each malformed key, naming it", () => {
    expect(errors("yes")).toEqual(["stack.preflight must be a mapping"]);
    expect(errors(["tools"])).toEqual(["stack.preflight must be a mapping"]);
    expect(errors({ tools: ["rspec", "bad tool"] })).toEqual(["stack.preflight.tools[1] must be a command name"]);
    expect(errors({ tools: "jq" })).toEqual(["stack.preflight.tools must be a list of command names"]);
    for (const tcp of ["localhost", "h:0", "h:70000", "h:", ":5432"]) {
      expect(errors({ services: [{ name: "db", tcp }] })).toEqual(["stack.preflight.services[0].tcp must be host:port with a port from 1 to 65535"]);
    }
    expect(errors({ services: [{ tcp: "h:1" }] })).toEqual(["stack.preflight.services[0].name is required"]);
    expect(errors({ services: [{ name: "my db", tcp: "h:1" }] })).toEqual(["stack.preflight.services[0].name must be a name like postgres"]);
    expect(errors({ services: [{ name: "db", tcp: "h:1", start: "a\nb" }] })).toEqual(["stack.preflight.services[0].start must be a single line"]);
    expect(errors({ services: ["db"] })).toEqual(["stack.preflight.services[0] must be a mapping"]);
    const nine = Array.from({ length: 9 }, (_, i) => ({ name: `s${i}`, tcp: `h:${i + 1}` }));
    expect(errors({ services: nine })).toEqual(["stack.preflight.services must list at most 8 services"]);
    for (const pct of [100, 1.5, -1, "20"]) {
      expect(errors({ min_disk_free_pct: pct })).toEqual(["stack.preflight.min_disk_free_pct must be a whole number from 0 to 99"]);
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
      flaky_patterns: [],
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

  test("flaky_patterns round-trips, empty or not", () => {
    for (const patterns of [[], ["tokenStore", 'say "hi"']]) {
      const r = validateProfile({ ...good, stack: { ...good.stack, flaky_patterns: patterns } });
      if (!r.ok) throw new Error(r.errors.join(","));
      const back = validateProfile(Bun.YAML.parse(profileToYaml(r.profile)));
      expect(back.ok).toBe(true);
      if (back.ok) expect(back.profile).toEqual(r.profile);
    }
  });

  test("a preflight block round-trips", () => {
    const r = validateProfile({
      ...good,
      stack: {
        ...good.stack,
        preflight: { tools: ["pytest"], services: [{ name: "db", tcp: "localhost:5432", start: 'docker compose up -d "db"' }], min_disk_free_pct: 15 },
      },
    });
    if (!r.ok) throw new Error(r.errors.join(","));
    const back = validateProfile(Bun.YAML.parse(profileToYaml(r.profile)));
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.profile).toEqual(r.profile);
  });

  test("without a preflight block the stack section is what it was before preflight existed", () => {
    const r = validateProfile(good);
    if (!r.ok) throw new Error(r.errors.join(","));
    const yaml = profileToYaml(r.profile);
    expect(yaml).not.toContain("preflight");
    const lines = yaml.split("\n");
    const stack = lines.slice(lines.indexOf("stack:"), lines.indexOf("repo:"));
    expect(stack).toEqual([
      "stack:",
      '  language: "python"',
      '  framework: "fastapi"',
      '  test_command: "pytest -q"',
      '  lint_command: "ruff check ."',
      '  build_command: ""',
      "  test_timeout_seconds: 1000",
      "  flaky_patterns: []",
    ]);
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

// PILOT-499: the profiles the project templates render declare what their test command needs.
describe("the project templates' profiles", () => {
  const rendered = (template: string) => {
    const path = join(import.meta.dir, `../../../templates/${template}/.archon/factory-profile.yaml.tmpl`);
    const r = validateProfile(Bun.YAML.parse(readFileSync(path, "utf8").replace(/\{\{[A-Z_]+\}\}/g, "example")));
    if (!r.ok) throw new Error(r.errors.join(","));
    return r.profile;
  };

  test("project-be checks its tools and its test Postgres and Redis, check-only", () => {
    const preflight = rendered("project-be").stack.preflight;
    expect(preflight?.tools).toEqual(["bundle", "ruby", "docker", "gh", "jq"]);
    expect(preflight?.min_disk_free_pct).toBe(20);
    expect(preflight?.services.map((s) => s.name)).toEqual(["postgres", "redis"]);
    // The ports config/database.yml and config/environments/test.rb use, on loopback.
    expect(preflight?.services[0].tcp).toMatch(/^127\.0\.0\.1:5432$/);
    expect(preflight?.services[1].tcp).toMatch(/^127\.0\.0\.1:6379$/);
    expect(preflight?.services.map((s) => s.start)).toEqual(["", ""]);
  });

  test("project-fe checks its tools and no service", () => {
    expect(rendered("project-fe").stack.preflight).toEqual({ tools: ["node", "npm", "gh", "jq"], services: [], min_disk_free_pct: 20 });
  });
});
