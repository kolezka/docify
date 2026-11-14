// Per-source ignore patterns: `ignore` keeps paths out of the snapshot, `graphIgnore` keeps
// documents searchable but out of the graph.
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { collectLocal, crawl, DEFAULT_LIMITS } from "../src/core/collect.ts";
import { DocifyError, validateIgnorePatterns } from "../src/core/docify.ts";
import { renderSources, search, sources } from "../src/core/search.ts";
import { fakeGraph, newDocify, tempDir, writeDocs } from "./helpers.ts";

const dirs: string[] = [];
const temp = (prefix?: string) => {
  const dir = tempDir(prefix);
  dirs.push(dir);
  return dir;
};

const page = (title: string, body: string) => `<html><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const hits: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/embed") {
      const { input } = (await req.json()) as { input: string[] };
      return Response.json({ embeddings: input.map(() => [1, 2, 3, 4]) });
    }
    hits.push(url.pathname);
    const html = (s: string) => new Response(s, { headers: { "content-type": "text/html" } });
    switch (url.pathname) {
      case "/docs/":
        return html(page("Index", `<p>Start.</p><a href="guide.html">guide</a><a href="changelog/v1.html">v1</a><a href="api/internal.html">internal</a><a href="moved.html">moved</a>`));
      case "/docs/guide.html":
        return html(page("Guide", `<h2>Kestrel option</h2><p>The kestrelSpeed option sets hover speed.</p><a href="changelog/v2.html">v2</a>`));
      case "/docs/changelog/v1.html":
      case "/docs/changelog/v2.html":
        return html(page("Changelog", "<p>Release notes that must not be collected.</p>"));
      case "/docs/api/internal.html":
        return html(page("Internal", "<h2>Heron switch</h2><p>The heronSwitch flag is internal.</p>"));
      case "/docs/moved.html":
        return new Response(null, { status: 301, headers: { location: "/docs/changelog/v3.html" } });
      case "/docs/changelog/v3.html":
        return html(page("Changelog 3", "<p>Reached through a redirect.</p>"));
    }
    return new Response("nope", { status: 404 });
  },
});
const origin = `http://127.0.0.1:${server.port}`;
const base = `${origin}/docs/`;
// A fake Ollama endpoint, so these tests need no local model.
const config = { embeddingProvider: "ollama" as const, embeddingUrl: origin, embeddingModel: "test", embeddingDims: 4, embeddingQueryPrefix: "" };

afterAll(() => {
  server.stop(true);
  dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

const localDocs = () =>
  writeDocs(join(temp("docify-src-"), "lib"), {
    "guide.md": "# Guide\n\n## Otter knob\n\nThe otterKnob setting enables floating.\n",
    "changelog.md": "# Changelog\n\n## Beaver dam\n\nThe beaverDam option stacks logs.\n",
    "CHANGELOG-old.md": "# Old\n\n## Marten trail\n\nThe martenTrail option is gone.\n",
  });

test("patterns must be a bounded list of valid regular expressions", () => {
  expect(validateIgnorePatterns(["^changelog/", "\\.html$", "^changelog/"], "ignore")).toEqual(["^changelog/", "\\.html$"]);
  expect(validateIgnorePatterns([], "graphIgnore")).toEqual([]);
  for (const bad of ["^a", null, {}, [1], [""], ["("], ["x".repeat(501)], Array.from({ length: 101 }, (_, i) => `p${i}`)]) {
    expect(() => validateIgnorePatterns(bad, "ignore")).toThrow(/^ignore/);
  }
  expect(() => validateIgnorePatterns(["("], "graphIgnore")).toThrow(/^graphIgnore: /);
});

test("a rejected list names the option and the pattern, so a form can point at the field", () => {
  const caught = (value: unknown, name: "ignore" | "graphIgnore") => {
    try {
      validateIgnorePatterns(value, name);
    } catch (err) {
      return err as DocifyError;
    }
    throw new Error("expected a rejection");
  };
  const bad = caught(["^docs/", "^api/(v1"], "graphIgnore");
  expect(bad).toBeInstanceOf(DocifyError);
  expect(bad.code).toBe("invalid_input");
  expect(bad.field).toBe("graphIgnore");
  // The second of two lines is wrong; the message has to say which.
  expect(bad.message).toStartWith('graphIgnore: "^api/(v1" is not a valid regular expression');
  expect(bad.message).not.toContain("^docs/");
  expect(caught("^a", "ignore").field).toBe("ignore");
  expect(caught(Array.from({ length: 101 }, (_, i) => `p${i}`), "ignore").message).toBe("ignore: at most 100 patterns are accepted");
});

test("local collection leaves out files whose path matches, and says so when nothing is left", () => {
  const dir = localDocs();
  const log: string[] = [];
  const docs = collectLocal(dir, DEFAULT_LIMITS, (_level, text) => log.push(text), [/^changelog/i]);
  expect(docs.map((d) => d.path)).toEqual(["guide.md"]);
  expect(log).toContain("Ignored 2 files matching the source's ignore patterns");
  expect(() => collectLocal(dir, DEFAULT_LIMITS, () => {}, [/\.md$/])).toThrow("(3 ignored)");
});

test("the crawler neither fetches nor stores ignored paths, including redirect targets", async () => {
  hits.length = 0;
  const log: string[] = [];
  const docs = await crawl(base, { ...DEFAULT_LIMITS, maxDepth: 2 }, fetch, { ignore: [/^changelog\//], markdownExports: false, log: (_level, text) => log.push(text) });
  expect(docs.map((d) => d.path).sort()).toEqual(["api/internal.html", "guide.html", "index.html"]);
  // v1 and v2 are dropped as links; v3 is only known from a redirect and is not requested either.
  expect(hits.filter((path) => path.startsWith("/docs/changelog/"))).toEqual([]);
  expect(log).toContain("Ignored 2 links matching the source's ignore patterns");
  expect(log).toContain(`Skipped ${base}moved.html: redirects to ${base}changelog/v3.html, which matches an ignore pattern`);
  expect(crawl(base, DEFAULT_LIMITS, fetch, { ignore: [/^index\.html$/] })).rejects.toThrow("the start URL matches an ignore pattern: index.html");
});

test("sources store, replace and remove both lists without touching other options", () => {
  const d = newDocify(temp(), config);
  try {
    const id = d.addSource({ library: "web", kind: "url", locator: base, crawl: { maxDepth: 1 }, ignore: ["^changelog/"], graphIgnore: ["^api/"] }).id;
    expect(JSON.parse(d.getSource(id)!.options)).toEqual({ crawl: { maxDepth: 1 }, ignore: ["^changelog/"], graphIgnore: ["^api/"] });
    d.db.run("UPDATE sources SET options = ? WHERE id = ?", [JSON.stringify({ crawl: { maxDepth: 1 }, ignore: ["^changelog/"], graphIgnore: ["^api/"], future: { value: 42 } }), id]);
    d.updateSourceIgnore(id, { graphIgnore: ["^api/", "^guide"] });
    expect(JSON.parse(d.getSource(id)!.options)).toEqual({ crawl: { maxDepth: 1 }, ignore: ["^changelog/"], graphIgnore: ["^api/", "^guide"], future: { value: 42 } });
    expect(sources(d).find((s) => s.id === id)).toMatchObject({ ignore: ["^changelog/"], graphIgnore: ["^api/", "^guide"] });
    expect(renderSources(sources(d))).toContain("ignored paths: ^changelog/");
    d.updateSourceIgnore(id, { ignore: null, graphIgnore: [] });
    expect(JSON.parse(d.getSource(id)!.options)).toEqual({ crawl: { maxDepth: 1 }, future: { value: 42 } });
    expect(sources(d).find((s) => s.id === id)).toMatchObject({ ignore: [], graphIgnore: [] });

    expect(() => d.updateSourceIgnore(id, {})).toThrow("ignore or graphIgnore is required");
    expect(() => d.updateSourceIgnore(id, { ignore: ["("] })).toThrow(/^ignore: /);
    expect(() => d.updateSourceIgnore("missing@1", { ignore: [] })).toThrow();
    expect(() => d.addSource({ library: "bad", kind: "url", locator: base, graphIgnore: ["["] })).toThrow(/^graphIgnore: /);
    // A local source has no crawler, but it does have paths.
    const local = d.addSource({ library: "local", kind: "local", locator: localDocs(), ignore: ["^changelog"] });
    expect(JSON.parse(local.options).ignore).toEqual(["^changelog"]);
  } finally {
    d.close();
  }
});

test("ignored paths never reach the snapshot of a crawled or a local source", async () => {
  const d = newDocify(temp(), config);
  try {
    const paths = (id: string) =>
      d.db.query<{ path: string }, [number]>("SELECT path FROM documents WHERE generation_id = ? ORDER BY path").all(d.getSource(id)!.active_generation!).map((row) => row.path);
    d.addSource({ library: "web", kind: "url", locator: base, crawl: { maxDepth: 2 }, ignore: ["^changelog/", "^api/"] });
    await d.prepare("web@unknown", { graph: false });
    expect(paths("web@unknown")).toEqual(["guide.html", "index.html"]);
    expect((await search(d, { query: "heronSwitch", library: "web", mode: "lexical" })).hits).toEqual([]);

    d.addSource({ library: "local", kind: "local", locator: localDocs(), ignore: ["^changelog"] });
    await d.prepare("local@unknown", { graph: false });
    expect(paths("local@unknown")).toEqual(["CHANGELOG-old.md", "guide.md"]);
    // A changed list is a changed snapshot: the next prepare rebuilds instead of reporting unchanged.
    d.updateSourceIgnore("local@unknown", { ignore: ["^changelog", "^CHANGELOG"] });
    expect((await d.prepare("local@unknown", { graph: false })).status).toBe("activated");
    expect(paths("local@unknown")).toEqual(["guide.md"]);
  } finally {
    d.close();
  }
});

test("graph-ignored documents stay searchable, get no graph nodes and do not make the graph partial", async () => {
  const d = newDocify(temp(), config);
  const sent: string[][] = [];
  const graphRunner: typeof fakeGraph = (cfg, sourceId, docs) => {
    sent.push(docs.map((doc) => doc.path).sort());
    return fakeGraph(cfg, sourceId, docs);
  };
  try {
    const id = d.addSource({ library: "lib", version: "1", kind: "local", locator: localDocs(), graphIgnore: ["^changelog", "^CHANGELOG"] }).id;
    const active = () => d.getGeneration(d.getSource(id)!.active_generation!)!;
    const nodeLabels = () => d.db.query<{ label: string }, [number]>("SELECT label FROM graph_nodes WHERE generation_id = ? ORDER BY label").all(active().id).map((row) => row.label);

    const first = await d.prepare(id, { graphRunner });
    expect(first.status).toBe("activated");
    expect(sent).toEqual([["guide.md"]]);
    expect(active().graph_status).toBe("ok");
    expect(first.stats).toMatchObject({ documents: 3, graphMissing: [], graphIgnore: ["^changelog", "^CHANGELOG"], graphIgnored: 2 });
    expect(nodeLabels()).toEqual(["Otter knob"]);
    expect((await search(d, { query: "beaverDam", library: "lib", mode: "lexical" })).hits[0]!.citation.document).toBe("changelog.md");

    expect((await d.prepare(id, { graphRunner })).status).toBe("unchanged");
    expect(sent.length).toBe(1);

    // Same documents, another list: only the graph differs, and it must be rebuilt.
    // The second pattern matches nothing here; it checks that stats keep the text as written.
    d.updateSourceIgnore(id, { graphIgnore: ["^CHANGELOG", "^api/v\\d+/"] });
    const second = await d.prepare(id, { graphRunner });
    expect(second.status).toBe("activated");
    expect(sent[1]).toEqual(["changelog.md", "guide.md"]);
    expect(nodeLabels()).toEqual(["Beaver dam", "Otter knob"]);
    expect(second.stats).toMatchObject({ graphIgnore: ["^CHANGELOG", "^api/v\\d+/"], graphIgnored: 1 });

    d.updateSourceIgnore(id, { graphIgnore: null });
    const third = await d.prepare(id, { graphRunner });
    expect(third.status).toBe("activated");
    expect(sent[2]).toEqual(["CHANGELOG-old.md", "changelog.md", "guide.md"]);
    expect(third.stats.graphIgnore).toBeUndefined();
    expect((await d.prepare(id, { graphRunner })).status).toBe("unchanged");
  } finally {
    d.close();
  }
});

test("a list that matches every document skips the graph instead of failing the prepare", async () => {
  const d = newDocify(temp(), config);
  let runs = 0;
  const graphRunner: typeof fakeGraph = (cfg, sourceId, docs) => {
    runs++;
    return fakeGraph(cfg, sourceId, docs);
  };
  try {
    const id = d.addSource({ library: "lib", version: "1", kind: "local", locator: localDocs(), graphIgnore: ["\\.md$"] }).id;
    const result = await d.prepare(id, { graphRunner });
    expect(result.status).toBe("activated");
    expect(runs).toBe(0);
    expect(d.getGeneration(result.generationId)!.graph_status).toBe("skipped");
    expect(result.stats).toMatchObject({ documents: 3, graphIgnored: 3 });
    expect(d.logs.read(0, 1000).lines.some((line) => line.text === "Every document matches graphIgnore; no graph is built" && line.level === "warn")).toBe(true);
    expect((await search(d, { query: "otterKnob", library: "lib", mode: "lexical" })).hits.length).toBe(1);
    expect((await d.prepare(id, { graphRunner })).status).toBe("unchanged");
  } finally {
    d.close();
  }
});

test("docify add and docify ignore set, show and clear the lists", () => {
  const home = temp();
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const run = (...args: string[]) => {
    const p = Bun.spawnSync(["bun", cli, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, DOCIFY_HOME: home } });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  expect(run("add", "web", "https://example.com/docs/", "--ignore", "^changelog/", "--ignore", "^blog/", "--graph-ignore", "^api/").code).toBe(0);
  expect(run("ignore", "web@unknown").out).toBe("web@unknown\n  ignored paths:\n    ^changelog/\n    ^blog/\n  left out of the graph:\n    ^api/\n");
  const changed = run("ignore", "web@unknown", "--ignore", "^legal/", "--no-graph-ignore");
  expect(changed.out).toBe("web@unknown\n  ignored paths:\n    ^legal/\n  left out of the graph: none\nRun: docify prepare web@unknown\n");
  expect(run("sources").out).toContain("ignored paths: ^legal/");
  const bad = run("ignore", "web@unknown", "--ignore", "(");
  expect(bad.code).toBe(1);
  expect(bad.err).toContain("error (invalid_input): ignore: ");
  expect(run("ignore", "web@unknown", "--ignore", "x", "--no-ignore").err).toContain("use either --ignore or --no-ignore");
  expect(run("ignore", "web@unknown").out).toContain("ignored paths:\n    ^legal/");
});
