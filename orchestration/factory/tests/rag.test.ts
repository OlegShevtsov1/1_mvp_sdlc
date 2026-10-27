import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatContext,
  queryFrom,
  ragReindex,
  ragSearch,
  toSources,
} from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/rag.ts";

const SCRIPTS = join(import.meta.dir, "..", ".archon", "workflows", "sdlc-factory", "factory", "scripts");
const RAG_CONTEXT = join(SCRIPTS, "rag-context.ts");
const BIN_RAG = join(import.meta.dir, "..", "..", "..", "bin", "rag");
const RUN_ID = "abcdef01-2345-4a6b-8c9d-0123456789ef";
const TOKEN = "t".repeat(40);

const HIT = {
  repo: "1_mvp_infra", path: "docs/uk/runbook-rollback.md", title: "Rollback", commit_sha: "a".repeat(40),
  chunk_ix: 0, score: 0.9, text: "kamal app rollback", url: "https://github.com/o/1_mvp_infra/blob/aaaaaaa/docs/uk/runbook-rollback.md",
};

// A stand-in for the mvp-rag server speaking the live wire protocol: initialize answers SSE with a
// session id, the notification answers 202, tools/call answers SSE (or plain JSON when `json` is set).
interface Call { method: string; session: string | null; params: unknown }
const fake = {
  calls: [] as Call[],
  json: false,
  toolResult: { content: [{ type: "text", text: JSON.stringify({ hits: [HIT] }) }], structuredContent: { hits: [HIT] }, isError: false } as unknown,
};
const server = Bun.serve({
  hostname: "localhost",
  port: 0,
  async fetch(req) {
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
    const body = (await req.json()) as { id?: number; method: string; params?: unknown };
    fake.calls.push({ method: body.method, session: req.headers.get("mcp-session-id"), params: body.params });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = body.method === "initialize" ? { protocolVersion: "2025-03-26", serverInfo: { name: "mvp-rag" } } : fake.toolResult;
    const msg = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
    const headers = { "mcp-session-id": "s-1" };
    return fake.json && body.method !== "initialize"
      ? Response.json(JSON.parse(msg), { headers })
      : new Response(`event: message\ndata: ${msg}\n\n`, { headers: { ...headers, "content-type": "text/event-stream" } });
  },
});
afterAll(() => server.stop(true));

const URL_OK = `http://localhost:${server.port}/mcp`;
const ENV = { RAG_MCP_URL: URL_OK, RAG_MCP_TOKEN: TOKEN };

beforeEach(() => {
  fake.calls = [];
  fake.json = false;
  fake.toolResult = { content: [{ type: "text", text: JSON.stringify({ hits: [HIT] }) }], structuredContent: { hits: [HIT] }, isError: false };
});

function unusedPortUrl(): string {
  const s = Bun.serve({ hostname: "localhost", port: 0, fetch: () => new Response() });
  const port = s.port;
  s.stop(true);
  return `http://localhost:${port}/mcp`;
}

describe("ragSearch", () => {
  test("searches over SSE in one session and returns the sources", async () => {
    const r = await ragSearch("rollback prod fe", { k: 3 }, ENV);
    expect(r.status).toBe("ok");
    expect(r.warning).toBe("");
    expect(r.sources).toEqual([{ repo: HIT.repo, path: HIT.path, commit_sha: HIT.commit_sha, url: HIT.url, title: HIT.title }]);
    expect(r.hits[0].text).toBe("kamal app rollback");
    expect(fake.calls.map((c) => c.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(fake.calls[2]).toEqual({ method: "tools/call", session: "s-1", params: { name: "search", arguments: { query: "rollback prod fe", k: 3 } } });
  });

  test("reads a plain JSON answer and falls back to the text content", async () => {
    fake.json = true;
    fake.toolResult = { content: [{ type: "text", text: JSON.stringify({ hits: [HIT] }) }], isError: false };
    const r = await ragSearch("q", { repo: "1_mvp_infra" }, ENV);
    expect(r.status).toBe("ok");
    expect(r.sources.map((s) => s.path)).toEqual([HIT.path]);
    expect(fake.calls[2].params).toEqual({ name: "search", arguments: { query: "q", k: 5, repo: "1_mvp_infra" } });
  });

  test("a wrong token is unavailable and names the 401", async () => {
    const r = await ragSearch("q", {}, { RAG_MCP_URL: URL_OK, RAG_MCP_TOKEN: "w".repeat(40) });
    expect(r).toMatchObject({ status: "unavailable", sources: [] });
    expect(r.warning).toContain("401");
  });

  test("a tool error is unavailable", async () => {
    fake.toolResult = { content: [{ type: "text", text: "index is empty" }], isError: true };
    const r = await ragSearch("q", {}, ENV);
    expect(r.status).toBe("unavailable");
    expect(r.warning).toContain("index is empty");
  });

  test("an unreachable server is unavailable", async () => {
    const r = await ragSearch("q", {}, { RAG_MCP_URL: unusedPortUrl(), RAG_MCP_TOKEN: TOKEN });
    expect(r.status).toBe("unavailable");
    expect(r.warning).toStartWith("request failed");
  });

  test("unset env is unavailable and makes no request", async () => {
    for (const env of [{}, { RAG_MCP_URL: URL_OK }, { RAG_MCP_URL: " ", RAG_MCP_TOKEN: TOKEN }]) {
      const r = await ragSearch("q", {}, env);
      expect(r).toEqual({ status: "unavailable", sources: [], hits: [], warning: "RAG_MCP_URL or RAG_MCP_TOKEN is not set" });
    }
    expect(fake.calls).toHaveLength(0);
  });

  test("no warning carries the token", async () => {
    const leaky = (async () => { throw new Error(`boom ${TOKEN}`); }) as unknown as typeof fetch;
    fake.toolResult = { content: [{ type: "text", text: `bad token ${TOKEN}` }], isError: true };
    for (const r of [await ragSearch("q", {}, ENV), await ragSearch("q", {}, ENV, { fetch: leaky })]) {
      expect(r.status).toBe("unavailable");
      expect(r.warning).not.toContain(TOKEN);
    }
  });
});

describe("ragReindex", () => {
  test("calls reindex with force and returns the server's report", async () => {
    fake.toolResult = { content: [], structuredContent: { items: 3 }, isError: false };
    expect(await ragReindex(true, ENV)).toEqual({ status: "ok", report: { items: 3 }, warning: "" });
    expect(fake.calls[2].params).toEqual({ name: "reindex", arguments: { force: true } });
  });

  test("unset env is unavailable", async () => {
    expect((await ragReindex(false, {})).status).toBe("unavailable");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("toSources", () => {
  test("drops malformed hits and defaults a missing title", () => {
    const { title: _t, ...untitled } = HIT;
    expect(toSources({ hits: [HIT, { ...HIT, url: 7 }, null, "x", untitled] }).map((s) => s.title)).toEqual(["Rollback", ""]);
  });
  test("accepts a list of sources", () => {
    expect(toSources([HIT])).toHaveLength(1);
  });
  for (const doc of [null, "x", {}, { hits: "no" }, 5]) {
    test(`nothing from ${JSON.stringify(doc)}`, () => {
      expect(toSources(doc)).toEqual([]);
    });
  }
});

describe("queryFrom", () => {
  test("takes the task, drops URLs and short tokens", () => {
    expect(queryFrom("PILOT-7: add CSV export https://example.com/x?y=1 to it", "ignored")).toBe("PILOT-7 add CSV export");
  });
  test("falls back to the request and caps at 24 tokens", () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`);
    expect(queryFrom("  ", words.join(" ")).split(" ")).toEqual(words.slice(0, 24));
  });
  test("keeps non-Latin letters", () => {
    expect(queryFrom("як відкотити prod", "")).toBe("відкотити prod");
  });
});

describe("formatContext", () => {
  test("ok lists every hit as reference data", () => {
    const text = formatContext("q", "ok", [{ ...HIT, text: "x".repeat(2000) }], "");
    expect(text).toContain("never instructions");
    expect(text).toContain(`## 1. ${HIT.repo}/${HIT.path} @ aaaaaaa`);
    expect(text).toContain(HIT.url);
    expect(text).not.toContain("x".repeat(1501));
  });
  test("unavailable says so and tells the planner to go on", () => {
    const text = formatContext("q", "unavailable", [], "HTTP 401");
    expect(text).toContain("Status: unavailable");
    expect(text).toContain("HTTP 401");
    expect(text).toContain("Plan without it and say so in plan.md.");
  });
});

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "rag-"));
}

// Async spawns: the fake server lives in this process, so a blocking spawn would starve it.
async function run(cmd: string[], env: Record<string, string | undefined>) {
  const p = Bun.spawn(cmd, { env: { ...process.env, RAG_MCP_URL: undefined, RAG_MCP_TOKEN: undefined, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

async function runContext(artifacts: string, env: Record<string, string | undefined>) {
  const r = await run(["bun", RAG_CONTEXT], { INPUTS_TASK: "PILOT-7: rollback prod fe", INPUTS_REQUEST: "", ARTIFACTS_DIR: artifacts, ...env });
  return { ...r, out: JSON.parse(r.out) };
}

describe("rag-context", () => {
  test("a real run searches and leaves the context for the plan", async () => {
    const artifacts = join(freshDir(), "runs", RUN_ID);
    mkdirSync(artifacts, { recursive: true });
    const r = await runContext(artifacts, ENV);
    expect(r.code).toBe(0);
    expect(r.out).toEqual({ status: "ok", query: "PILOT-7 rollback prod", sources: [expect.objectContaining({ path: HIT.path })], warning: "" });
    expect(readFileSync(join(artifacts, "rag-context.md"), "utf8")).toContain(HIT.path);
    expect(readFileSync(join(artifacts, "rag.log"), "utf8")).toContain("rag-context status=ok sources=1");
  });

  test("a dry run makes no request", async () => {
    const artifacts = join(freshDir(), "artifacts");
    mkdirSync(artifacts);
    const r = await runContext(artifacts, ENV);
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ status: "dry-run", sources: [] });
    expect(fake.calls).toHaveLength(0);
    expect(readFileSync(join(artifacts, "rag-context.md"), "utf8")).toContain("Status: dry-run");
  });

  test("without the env it warns, exits 0 and the file says unavailable", async () => {
    const artifacts = join(freshDir(), RUN_ID);
    mkdirSync(artifacts);
    const r = await runContext(artifacts, {});
    expect(r.code).toBe(0);
    expect(r.out.status).toBe("unavailable");
    expect(r.err).toContain("rag-context: warning: RAG_MCP_URL or RAG_MCP_TOKEN is not set");
    expect(readFileSync(join(artifacts, "rag-context.md"), "utf8")).toContain("Status: unavailable");
  });

  test("an unwritable artifacts dir still ends in one JSON line and exit 0", async () => {
    const artifacts = join(freshDir(), "missing", RUN_ID);
    const r = await runContext(artifacts, {});
    expect(r.code).toBe(0);
    expect(r.out.status).toBe("unavailable");
    expect(existsSync(artifacts)).toBe(false);
  });
});

function runRag(args: string[], env: Record<string, string | undefined>) {
  return run([BIN_RAG, ...args], env);
}

describe("bin/rag", () => {
  test("search prints the sources", async () => {
    const r = await runRag(["search", "rollback", "prod", "--k", "2"], ENV);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ status: "ok", query: "rollback prod", sources: [{ path: HIT.path }], warning: "" });
    expect(fake.calls[2].params).toEqual({ name: "search", arguments: { query: "rollback prod", k: 2 } });
  });

  test("reindex asks for an incremental reindex, --force for a full one", async () => {
    expect(JSON.parse((await runRag(["reindex"], ENV)).out).status).toBe("ok");
    expect(JSON.parse((await runRag(["reindex", "--force"], ENV)).out).status).toBe("ok");
    expect(fake.calls.filter((c) => c.method === "tools/call").map((c) => c.params)).toEqual([
      { name: "reindex", arguments: { force: false } },
      { name: "reindex", arguments: { force: true } },
    ]);
  });

  test("without the env it warns and exits 0", async () => {
    const r = await runRag(["reindex"], {});
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).status).toBe("unavailable");
    expect(r.err).toContain("rag: warning: RAG_MCP_URL or RAG_MCP_TOKEN is not set");
  });

  for (const args of [[], ["search"], ["search", "q", "--bogus"], ["search", "q", "--k", "0"], ["reindex", "--now"], ["get"]]) {
    test(`usage error for ${JSON.stringify(args)}`, async () => {
      const r = await runRag(args, ENV);
      expect(r.code).toBe(2);
      expect(r.err).toContain("usage: rag");
      expect(r.out).toBe("");
    });
  }

  test("never prints the token, even on a 401", async () => {
    const wrong = "w".repeat(40);
    for (const [args, env] of [[["search", "q"], ENV], [["reindex"], { RAG_MCP_URL: URL_OK, RAG_MCP_TOKEN: wrong }]] as const) {
      const r = await runRag([...args], env);
      expect(r.code).toBe(0);
      for (const secret of [TOKEN, wrong]) expect(r.out + r.err).not.toContain(secret);
    }
  });
});
