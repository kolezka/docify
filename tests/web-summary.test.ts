import { afterEach, expect, test } from "bun:test";
import { startServer } from "../src/web/server.ts";
import { newDocify, tempDir } from "./helpers.ts";

// An id with "@" is sent percent-encoded, as the web UI sends every real source id.
const SOURCE_ID = "reference@1.0.0";
const base = `/api/sources/${encodeURIComponent(SOURCE_ID)}`;
const path = `${base}/summary`;

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

async function setup() {
  let requests = 0;
  let providerStatus = 200;
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  let blocked = false;
  const provider = Bun.serve({ port: 0, async fetch() {
    requests++;
    entered?.();
    if (blocked) await new Promise<void>(resolve => { release = resolve; });
    return Response.json({ choices: [{ message: { content: "Reference for interface design and accessibility." }, finish_reason: "stop" }] }, { status: providerStatus });
  } });
  process.env.DOCIFY_WEB_SUMMARY_URL = provider.url.origin;
  process.env.DOCIFY_WEB_SUMMARY_KEY = "test-only-key";
  cleanup.push(() => { provider.stop(true); delete process.env.DOCIFY_WEB_SUMMARY_URL; delete process.env.DOCIFY_WEB_SUMMARY_KEY; });
  const d = newDocify(tempDir(), { graph: { backend: "openai", model: "summary-test", baseUrlEnv: "DOCIFY_WEB_SUMMARY_URL", baseUrlSuffix: "/v1", apiKeyEnv: "DOCIFY_WEB_SUMMARY_KEY" } });
  const source = d.addSource({ id: SOURCE_ID, library: "reference", version: "1.0.0", kind: "url", locator: "https://example.test/reference" });
  d.db.run("INSERT INTO generations(id, source_id, status, started_at, schema_version) VALUES (1, ?, 'active', 'now', 1)", [source.id]);
  d.db.run("UPDATE sources SET active_generation = 1 WHERE id = ?", [source.id]);
  d.db.run("INSERT INTO documents(generation_id,path,title,kind,raw_file,raw_sha256,normalized_file,normalized_sha256,lines_match_raw) VALUES (1, 'guide.md', 'Guide', 'markdown', '', '', '', '', 1)");
  const server = await startServer(0, { docify: d, quiet: true, token: "a".repeat(32) });
  cleanup.push(() => { server.stop(true); d.close(); });
  const call = async (path: string, method = "GET", body?: unknown, authenticated = true) => {
    const response = await fetch(new URL(path, server.url), { method, headers: { ...(authenticated ? { "x-docify-token": server.token! } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const upload = async (path: string) => {
    const response = await fetch(new URL(path, server.url), { method: "POST", headers: { "x-docify-token": server.token!, "content-type": "application/octet-stream" }, body: new Uint8Array([1, 2, 3]) });
    return { status: response.status, data: await response.json() };
  };
  // Starts a summary request the caller can drop, like a closed browser tab.
  const abandonable = () => {
    const controller = new AbortController();
    const done = fetch(new URL(path, server.url), { method: "POST", signal: controller.signal, headers: { "x-docify-token": server.token!, "content-type": "application/json" }, body: "{}" }).catch(() => null);
    return { abandon: () => controller.abort(), done };
  };
  return { d, source, call, upload, abandonable, requests: () => requests, failProvider: () => { providerStatus = 500; }, block: () => {
    blocked = true;
    return new Promise<void>(resolve => { entered = resolve; });
  }, release: () => release?.() };
}


test("summary generation is explicit, cached and forceable; failures preserve the saved summary", async () => {
  const f = await setup();
  expect((await f.call("/api/sources")).data[0].summary).toBeNull();
  expect(f.requests()).toBe(0);
  const saved = await f.call(path, "POST", {});
  expect(saved.status).toBe(200);
  expect(saved.data.text).toContain("accessibility");
  expect((await f.call("/api/sources")).data[0].summary).toEqual(saved.data);
  expect((await f.call(path, "POST", {})).data).toEqual(saved.data);
  expect(f.requests()).toBe(1);
  expect((await f.call(path, "POST", { force: true })).status).toBe(200);
  expect(f.requests()).toBe(2);
  f.failProvider();
  const failed = await f.call(path, "POST", { force: true });
  expect(failed.status).toBe(502);
  expect(failed.data.code).toBe("summary_failed");
  expect(failed.data.error).not.toContain("test-only-key");
  expect((await f.call("/api/sources")).data[0].summary.text).toBe(saved.data.text);
  f.d.db.run("UPDATE sources SET active_generation = NULL");
  expect((await f.call("/api/sources")).data[0].summary).toBeNull();
  expect((await f.call(path, "POST", {})).data.code).toBe("not_indexed");
});

test("summary API checks authentication, input, source and provider before spending", async () => {
  const f = await setup();
  expect((await f.call(path, "POST", {}, false)).status).toBe(401);
  for (const body of [null, [], { force: "true" }, { surprise: true }]) {
    const result = await f.call(path, "POST", body);
    expect(result.status).toBe(400);
    expect(result.data.code).toBe("invalid_input");
  }
  expect((await f.call("/api/sources/missing/summary", "POST", {})).status).toBe(404);
  delete process.env.DOCIFY_WEB_SUMMARY_KEY;
  expect((await f.call(path, "POST", {})).data.code).toBe("invalid_config");
  expect(f.requests()).toBe(0);
});

test("in-flight summaries block duplicate work, prepare, removal, settings and import; cancellation releases the guard", async () => {
  const f = await setup();
  const entered = f.block();
  const pending = f.call(path, "POST", {});
  await entered;
  try {
    for (const [url, method, body] of [
      [path, "POST", {}],
      [`${base}/prepare`, "POST", {}],
      [base, "DELETE", {}],
      ["/api/config", "PUT", { lexicalWeight: 0.5 }],
    ] as const) {
      const refused = await f.call(url, method, body);
      expect([url, refused.status, refused.data.code]).toEqual([url, 409, "busy"]);
    }
    const refusedImport = await f.upload("/api/import");
    expect([refusedImport.status, refusedImport.data.code]).toEqual([409, "busy"]);
    expect((await f.call("/api/sources")).data.map((s: { id: string }) => s.id)).toEqual([SOURCE_ID]);
    expect((await f.call(`${base}/cancel`, "POST", {})).status).toBe(200);
    expect((await pending).data.code).toBe("cancelled");
    expect((await f.call("/api/config", "PUT", { lexicalWeight: 0.5 })).status).toBe(200);
    expect((await f.call("/api/sources")).data[0].summary).toBeNull();
  } finally { f.release(); }
});

test("a client that disconnects mid-summary stops the provider call and frees the source", async () => {
  const f = await setup();
  const entered = f.block();
  const request = f.abandonable();
  await entered;
  try {
    expect((await f.call("/api/config", "PUT", { lexicalWeight: 0.5 })).status).toBe(409);
    request.abandon();
    await request.done;
    let status = 409;
    for (let i = 0; i < 100 && status === 409; i++) {
      status = (await f.call("/api/config", "PUT", { lexicalWeight: 0.5 })).status;
      if (status === 409) await Bun.sleep(10);
    }
    expect(status).toBe(200);
    expect((await f.call("/api/sources")).data[0].summary).toBeNull();
  } finally { f.release(); }
});
