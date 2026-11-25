import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nowIso } from "../src/core/db.ts";
import { startServer } from "../src/web/server.ts";
import { newDocify, tempDir, writeDocs } from "./helpers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

async function setup(opts: { project?: string } = {}) {
  const home = tempDir();
  const d = newDocify(home);
  const project = opts.project ?? tempDir("docify-project-");
  const server = await startServer(0, { docify: d, quiet: true, project, token: "a".repeat(32) });
  cleanup.push(() => {
    server.stop(true);
    d.close();
  });
  const base = `http://127.0.0.1:${server.port}`;
  const call = async (path: string, method = "GET", body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { "x-docify-token": server.token!, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  return { home, d, project, base, call };
}

test("web schedule edits share CLI state and invalid schedules leave the source unchanged", async () => {
  const { d, call } = await setup();
  d.addSource({ id: "docs", library: "docs", locator: "https://example.com", kind: "url" });
  const path = "/api/sources/docs";
  d.setRefreshCron("docs", "0 3 * * *");
  expect((await call(path)).data.refreshCron).toBe("0 3 * * *");
  expect((await call(path, "PATCH", { refreshCron: "invalid", title: "changed" })).status).toBe(400);
  expect((await call(path)).data).toMatchObject({ refreshCron: "0 3 * * *", title: null });
  expect((await call(path, "PATCH", { refreshCron: "15 4 * * *" })).status).toBe(200);
  expect(JSON.parse(d.requireSource("docs").options).refreshCron).toBe("15 4 * * *");
  expect((await call(path, "PATCH", { refreshCron: null })).status).toBe(200);
  expect((await call(path)).data.refreshCron).toBeNull();
});

test("the page and every asset it references are served, with a restrictive policy on the page", async () => {
  const { base } = await setup();
  const page = await fetch(`${base}/`);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
  const html = await page.text();
  const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]!);
  expect(refs.some((r) => r.endsWith(".js"))).toBe(true);
  expect(refs.some((r) => r.endsWith(".css"))).toBe(true);
  for (const ref of refs) {
    const res = await fetch(base + ref);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(ref.endsWith(".js") ? /javascript/ : /css/);
  }
  expect((await fetch(`${base}/nope.js`)).status).toBe(404);
});

// Bun reads bunfig.toml and Tailwind scans from the current directory; `docify serve` runs anywhere.
test("the UI bundle compiles Svelte and includes component classes when built from another directory", async () => {
  const script = `
    const { uiAssets } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "web", "bundle.ts"))});
    const assets = await uiAssets();
    const pick = (ext) => [...assets].find(([p]) => p.endsWith(ext))[1].body.text();
    const [css, js] = await Promise.all([pick(".css"), pick(".js")]);
    console.log(JSON.stringify({ tokens: css.includes(".bg-window") && css.includes("--hig-window"), component: css.includes(".bg-seg-on"), source: js.includes("Update Without Graph"), logs: js.includes("Filter lines") && js.includes("No warnings or errors") }));
  `;
  const proc = Bun.spawn(["bun", "-e", script], { cwd: tempDir("docify-cwd-"), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text(), await proc.exited];
  expect(err).not.toMatch(/error/i);
  expect(code).toBe(0);
  expect(JSON.parse(out.trim().split("\n").pop()!)).toEqual({ tokens: true, component: true, source: true, logs: true });
});

test("saving settings writes config.json and applies the values without a restart", async () => {
  const { home, d, call } = await setup();
  const before = await call("/api/config");
  expect(before.status).toBe(200);
  expect(before.data.values.lexicalWeight).toBe(1);

  const saved = await call("/api/config", "PUT", { lexicalWeight: 0.5, graph: { model: "other/model" } });
  expect(saved.status).toBe(200);
  expect(saved.data.values.lexicalWeight).toBe(0.5);
  expect(saved.data.values.graph.backend).toBe("openai");
  expect(saved.data.inFile.sort()).toEqual(["graph", "lexicalWeight"]);
  expect(d.config.lexicalWeight).toBe(0.5);
  expect(d.config.graph?.model).toBe("other/model");
  expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).lexicalWeight).toBe(0.5);
  expect((await call("/api/config")).data.values.lexicalWeight).toBe(0.5);
});

test("rejected settings report the field and leave config.json untouched", async () => {
  const { home, d, call } = await setup();
  writeFileSync(join(home, "config.json"), JSON.stringify({ lexicalWeight: 0.7 }));
  const original = readFileSync(join(home, "config.json"), "utf8");
  for (const [body, field] of [
    [{ graphifyBin: "/tmp/evil" }, "graphifyBin"],
    [{ weakVectorSim: 0.9 }, "weakVectorSim"],
    [{ lexicalWeight: "0.5" }, "lexicalWeight"],
  ] as const) {
    const res = await call("/api/config", "PUT", body);
    expect(res.status).toBe(400);
    expect(res.data.code).toBe("invalid_input");
    expect(res.data.field).toBe(field);
  }
  expect(readFileSync(join(home, "config.json"), "utf8")).toBe(original);
  expect(d.config.graphifyBin).not.toBe("/tmp/evil");
});

test("active web job uses its initial model and the next job uses the saved model", async () => {
  const { d, call } = await setup();
  const release = Promise.withResolvers<void>();
  const models: string[] = [];
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/api/embed") {
      const { model, input } = await req.json();
      models.push(model);
      return Response.json({ embeddings: input.map(() => Array(384).fill(0.1)) });
    }
    await release.promise;
    return new Response("# Local fixture\n\nOne document for the worker.", { headers: { "content-type": "text/markdown" } });
  } });
  try {
    expect((await call("/api/config", "PUT", { embeddingProvider: "ollama", embeddingUrl: origin.url.origin, embeddingModel: "first" })).status).toBe(200);
    for (const id of ["first", "next"]) d.addSource({ id, library: id, kind: "url", locator: new URL("page.md", origin.url).href });
    for (const id of ["first", "next"]) {
      expect((await call(`/api/sources/${id}/prepare`, "POST", { graph: false })).status).toBe(202);
      if (id === "first") {
        expect((await call("/api/config", "PUT", { embeddingModel: "second" })).status).toBe(200);
        release.resolve();
      }
      for (let i = 0; i < 300 && d.requireSource(id).lock_pid; i++) await Bun.sleep(10);
      expect(d.requireSource(id).active_generation).toBeGreaterThan(0);
    }
    expect(models).toEqual(["first", "second"]);
  } finally {
    release.resolve();
    await origin.stop(true);
  }
}, 15000);

test("a web prepare holds its own lease while settings stay writable", async () => {
  const { d, call } = await setup();
  const gate = Promise.withResolvers<void>();
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() { await gate.promise; return new Response("# Page"); } });
  d.addSource({ id: "held", library: "held", kind: "url", locator: origin.url.href });
  try {
    expect((await call("/api/sources/held/prepare", "POST", { graph: false })).status).toBe(202);
    expect((await call("/api/config", "PUT", { lexicalWeight: 0.6 })).status).toBe(200);
    const pid = d.requireSource("held").lock_pid;
    expect(pid).toBeGreaterThan(0);
    expect(pid).not.toBe(process.pid);
    expect(d.config.lexicalWeight).toBe(0.6);
  } finally {
    await call("/api/sources/held/cancel", "POST", {});
    gate.resolve();
    await origin.stop(true);
    for (let i = 0; i < 200 && d.requireSource("held").lock_pid; i++) await Bun.sleep(10);
  }
  expect(d.requireSource("held").lock_pid).toBeNull();
});

test("settings cannot change while this process prepares a source", async () => {
  const { home, d, call } = await setup();
  const docs = writeDocs(join(tempDir("docify-src-"), "docs"), { "a.md": "# A\n\ntext\n" });
  d.addSource({ library: "lib", version: "1", kind: "local", locator: docs });
  d.db.run("UPDATE sources SET lock_pid = ?, lock_at = ? WHERE id = ?", [process.pid, nowIso(), "lib@1"]);
  const res = await call("/api/config", "PUT", { lexicalWeight: 0.5 });
  expect(res.status).toBe(409);
  expect(res.data.code).toBe("busy");
  expect(res.data.error).toContain("lib@1");
  expect(existsSync(join(home, "config.json"))).toBe(false);
  expect(d.config.lexicalWeight).toBe(1);
  // Control: the same request passes once the lease is released.
  d.db.run("UPDATE sources SET lock_pid = NULL, lock_at = NULL");
  expect((await call("/api/config", "PUT", { lexicalWeight: 0.5 })).status).toBe(200);
});

test("a malformed config.json is reported as an error, not as default settings", async () => {
  const { home, call } = await setup();
  const ok = await call("/api/config");
  expect(ok.status).toBe(200);
  expect(ok.data.inFile).toEqual([]);
  writeFileSync(join(home, "config.json"), "{ broken");
  const res = await call("/api/config");
  expect(res.status).toBe(400);
  expect(res.data.error).toMatch(/config\.json is not valid JSON/);
  expect(res.data.values).toBeUndefined();
});

test("pins edit the .docify.json that search reads", async () => {
  const parent = tempDir("docify-project-");
  writeFileSync(join(parent, ".docify.json"), JSON.stringify({ other: true, pins: { react: "18" } }));
  const project = join(parent, "app");
  mkdirSync(project);
  const { call } = await setup({ project });

  const initial = await call("/api/pins");
  expect(initial.data).toEqual({ project, file: join(parent, ".docify.json"), pins: { react: "18" } });

  const pinned = await call("/api/pins", "PUT", { library: "Bun", version: "1.2" });
  expect(pinned.status).toBe(200);
  expect(pinned.data.pins).toEqual({ react: "18", bun: "1.2" });
  expect(existsSync(join(project, ".docify.json"))).toBe(false);
  expect(JSON.parse(readFileSync(join(parent, ".docify.json"), "utf8"))).toEqual({ other: true, pins: { react: "18", bun: "1.2" } });

  expect((await call("/api/pins", "PUT", { library: "react", version: null })).data.pins).toEqual({ bun: "1.2" });
  const bad = await call("/api/pins", "PUT", { library: "../x", version: "1" });
  expect(bad.status).toBe(400);
  expect(bad.data.error).toContain("invalid library name");
});

test("pins report a malformed .docify.json instead of an empty list", async () => {
  const project = tempDir("docify-project-");
  const { call } = await setup({ project });
  expect((await call("/api/pins")).data.pins).toEqual({});
  writeFileSync(join(project, ".docify.json"), "{ nope");
  const res = await call("/api/pins");
  expect(res.status).toBe(400);
  expect(res.data.error).toMatch(/\.docify\.json is not valid JSON/);
  expect((await call("/api/pins", "PUT", { library: "bun", version: "1" })).status).toBe(400);
  expect(readFileSync(join(project, ".docify.json"), "utf8")).toBe("{ nope");
});


test("URL source crawler can be set, changed and inherited through the API", async () => {
  const { call, d } = await setup();
  const created = await call("/api/sources", "POST", { library: "web", kind: "url", locator: "https://example.com/docs", crawlProvider: "crawl4ai" });
  expect(created.status).toBe(201);
  let source = (await call("/api/sources")).data.find((s: { id: string }) => s.id === "web@unknown");
  expect(source.crawlProvider).toBe("crawl4ai");
  expect(source.effectiveCrawlProvider).toBe("crawl4ai");
  expect((await call("/api/sources/web%40unknown", "PATCH", { crawlProvider: "browserless" })).status).toBe(200);
  source = (await call("/api/sources")).data.find((s: { id: string }) => s.id === "web@unknown");
  expect(source.crawlProvider).toBe("browserless");
  expect((await call("/api/sources/web%40unknown", "PATCH", { crawlProvider: null })).status).toBe(200);
  source = (await call("/api/sources")).data.find((s: { id: string }) => s.id === "web@unknown");
  expect(source.crawlProvider).toBeNull();
  expect(source.effectiveCrawlProvider).toBe(d.config.crawlProvider);
  for (const value of ["unknown", 3, {}, undefined]) {
    expect((await call("/api/sources/web%40unknown", "PATCH", { crawlProvider: value })).status).toBe(400);
  }
  expect((await call("/api/sources", "POST", { library: "bad", kind: "url", locator: "https://example.com", crawlProvider: "unknown" })).status).toBe(400);
  expect((await call("/api/sources/missing", "PATCH", { crawlProvider: null })).status).toBe(404);
});

test("crawl limits round trip through settings and source APIs", async () => {
  const { call } = await setup();
  expect((await call("/api/config", "PUT", { maxPages: 8, maxDepth: 3, maxTotalMb: 100 })).status).toBe(200);
  expect((await call("/api/config")).data.values.maxTotalMb).toBe(100);
  expect((await call("/api/config", "PUT", { maxTotalMb: 0 })).status).toBe(400);
  expect((await call("/api/config", "PUT", { maxTotalBytes: 100_000_000 })).status).toBe(400);
  expect((await call("/api/config", "PUT", { maxDepth: -1 })).status).toBe(400);
  const added = await call("/api/sources", "POST", { library: "crawl-limits", kind: "url", locator: "https://example.com/docs/", crawl: { maxDepth: 0 } });
  expect(added.status).toBe(201);
  const id = added.data.id;
  expect((await call("/api/sources")).data.find((s: { id: string }) => s.id === id)).toMatchObject({ crawl: { maxDepth: 0 }, effectiveCrawl: { maxPages: 8, maxDepth: 0 } });
  expect((await call(`/api/sources/${id}`, "PATCH", { crawl: { maxDepth: null, maxPages: 2 } })).status).toBe(200);
  expect((await call("/api/sources")).data.find((s: { id: string }) => s.id === id)).toMatchObject({ crawl: { maxPages: 2 }, effectiveCrawl: { maxPages: 2, maxDepth: 3 } });
  for (const crawl of [null, [], { maxPages: 0 }, { maxDepth: 1.5 }, { timeoutMs: 1 }]) {
    expect((await call(`/api/sources/${id}`, "PATCH", { crawl })).status).toBe(400);
    expect((await call("/api/sources", "POST", { library: "bad", kind: "url", locator: "https://example.com", crawl })).status).toBe(400);
  }
});

test("ignore patterns round trip through the source APIs for URL and local sources", async () => {
  // Source roots are read when the server starts.
  const savedRoots = process.env.DOCIFY_SOURCE_ROOTS;
  const roots = tempDir("docify-src-");
  process.env.DOCIFY_SOURCE_ROOTS = roots;
  cleanup.push(() => {
    if (savedRoots === undefined) delete process.env.DOCIFY_SOURCE_ROOTS;
    else process.env.DOCIFY_SOURCE_ROOTS = savedRoots;
  });
  const { call } = await setup();
  const added = await call("/api/sources", "POST", { library: "web", kind: "url", locator: "https://example.com/docs/", ignore: ["^changelog/"], graphIgnore: ["^api/"] });
  expect(added.status).toBe(201);
  const id = added.data.id;
  const read = async (sourceId = id) => (await call("/api/sources")).data.find((s: { id: string }) => s.id === sourceId);
  expect(await read()).toMatchObject({ ignore: ["^changelog/"], graphIgnore: ["^api/"] });
  expect((await call(`/api/sources/${id}`, "PATCH", { graphIgnore: ["^api/", "^blog/"] })).status).toBe(200);
  expect(await read()).toMatchObject({ ignore: ["^changelog/"], graphIgnore: ["^api/", "^blog/"] });
  // One request may change the crawler and the lists together.
  expect((await call(`/api/sources/${id}`, "PATCH", { crawl: { maxPages: 3 }, ignore: null })).status).toBe(200);
  expect(await read()).toMatchObject({ crawl: { maxPages: 3 }, ignore: [], graphIgnore: ["^api/", "^blog/"] });

  for (const ignore of ["^a", {}, [3], [""], ["("]]) {
    const patched = await call(`/api/sources/${id}`, "PATCH", { ignore });
    expect(patched.status).toBe(400);
    expect(patched.data.code).toBe("invalid_input");
    // The form puts the message at the field the response names.
    expect(patched.data.field).toBe("ignore");
    const posted = await call("/api/sources", "POST", { library: "bad", kind: "url", locator: "https://example.com", graphIgnore: ignore });
    expect(posted.status).toBe(400);
    expect(posted.data.field).toBe("graphIgnore");
  }
  // Errors that are not about one input carry no field.
  expect((await call(`/api/sources/${id}`, "PATCH", {})).data.field).toBeUndefined();
  // A bad list must not leave the crawler half of the same request applied.
  expect((await call(`/api/sources/${id}`, "PATCH", { crawl: { maxPages: 9 }, graphIgnore: ["("] })).status).toBe(400);
  expect((await read()).crawl).toEqual({ maxPages: 3 });
  expect((await call(`/api/sources/${id}`, "PATCH", {})).status).toBe(400);
  expect((await call("/api/sources/missing", "PATCH", { ignore: [] })).status).toBe(404);

  const dir = writeDocs(join(roots, "docs"), { "a.md": "# A\n\nText.\n" });
  const local = await call("/api/sources", "POST", { library: "local", kind: "local", locator: dir, ignore: ["^drafts/"] });
  expect(local.status).toBe(201);
  expect(await read(local.data.id)).toMatchObject({ ignore: ["^drafts/"], graphIgnore: [] });
  expect((await call(`/api/sources/${local.data.id}`, "PATCH", { graphIgnore: ["^notes/"] })).status).toBe(200);
  expect(await read(local.data.id)).toMatchObject({ ignore: ["^drafts/"], graphIgnore: ["^notes/"] });
});
