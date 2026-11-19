// The /api routes as a Hono app. Each route is declared with zod schemas, which validate the
// request and generate the OpenAPI document served at /api/docs/openapi.json.
import { homedir } from "node:os";
import { delimiter, join, resolve, sep } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { OpenAPIHono, createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { Docify, DocifyError, effectiveGeneration, validateGroups, validateIgnorePatterns, validateTitle } from "../core/docify.ts";
import { ConfigError, describeConfig } from "../core/config.ts";
import { discoverSources, open, outline, read, scope, search, searchMany, sources } from "../core/search.ts";
import { graphView } from "../core/graph-view.ts";
import { summarizeSource } from "../core/summary.ts";
import { exportStore, importStore } from "../core/backup.ts";
import { compressSnapshots } from "../core/compress-snapshots.ts";
import { readSnapshotFile } from "../core/snapshot-file.ts";
import { LogReadError } from "../core/logs.ts";
import { VERSION } from "../version.ts";
import * as s from "./api-schemas.ts";

const STATUS_BY_CODE: Record<string, number> = { invalid_input: 400, exists: 409, busy: 409, source_unknown: 404, generation_changed: 409, summary_failed: 502, invalid_summary: 502 };
// A store backup is uploaded whole; a real store is around 100 MB before compression.
export const IMPORT_MAX_BYTES = 1024 * 1024 * 1024;

export interface ApiDeps {
  docify: Docify;
  project: string;
  sourceRoots: string[];
  // Host, token, content type and Origin; null lets the request through.
  guard: (req: Request, bodyType: string) => Response | null;
  // Lifts the idle timeout for a request that waits on a slow provider.
  noTimeout: (req: Request) => void;
}

export function withinSourceRoots(realPath: string, roots: string[]): boolean {
  return roots.some((root) => {
    try {
      const realRoot = realpathSync(root);
      return realPath === realRoot || realPath.startsWith(realRoot + sep);
    } catch {
      return false;
    }
  });
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

// zod failures answer like the core's own validation: invalid_input, and the body field when there is one.
function invalidInput(result: { success: boolean; error?: z.ZodError; target: string; data?: unknown }): Response | undefined {
  if (result.success) return;
  const issue = result.error!.issues[0]!;
  const top = issue.path[0];
  const field = result.target === "json" && typeof top === "string" ? top : undefined;
  if (field === "ignore" || field === "graphIgnore") {
    // The core's message names the bad pattern; the forms show it next to the field.
    try {
      validateIgnorePatterns((result.data as Record<string, unknown>)[field], field);
    } catch (err) {
      if (err instanceof DocifyError) return json({ error: err.message, code: "invalid_input", field }, 400);
    }
  }
  if (field === "title" || field === "groups") {
    try {
      const value = (result.data as Record<string, unknown>)[field];
      if (field === "title") validateTitle(value);
      else validateGroups(value);
    } catch (err) {
      if (err instanceof DocifyError) return json({ error: err.message, code: "invalid_input", field }, 400);
    }
  }
  const where = issue.path.length ? `${issue.path.join(".")}: ` : result.target === "json" ? "body: " : "";
  return json({ error: `${where}${issue.message}`, code: "invalid_input", ...(field ? { field } : {}) }, 400);
}

export function createApi(deps: ApiDeps) {
  const { docify, project, sourceRoots } = deps;
  const running = new Map<string, AbortController>();
  // Set while an import swaps the store files; the database is closed for that moment.
  let importing = false;

  const fail = (err: unknown): Response => {
    if (err instanceof HTTPException) {
      // Hono's own body checks: malformed JSON (400) and a wrong media type (415).
      if (err.status === 415) return json({ error: "application/json body required", code: "unsupported" }, 415);
      return json({ error: err.status === 400 ? "invalid JSON body" : err.message, code: err.status === 400 ? "invalid_input" : "internal" }, err.status);
    }
    if (err instanceof LogReadError) return json({ error: err.message, code: "logs_unavailable" }, 500);
    if (err instanceof ConfigError) return json({ error: err.message, code: "invalid_input", field: err.field ?? null }, 400);
    if (err instanceof DocifyError) return json({ error: err.message, code: err.code, ...(err.field ? { field: err.field } : {}) }, STATUS_BY_CODE[err.code] ?? 400);
    docify.logs.append("docify", err instanceof Error ? err.message : String(err), "system", "error");
    console.error(err);
    return json({ error: String(err instanceof Error ? err.message : err), code: "internal" }, 500);
  };

  const app = new OpenAPIHono({ defaultHook: invalidInput });
  app.onError((err) => fail(err));
  app.notFound(() => new Response("not found", { status: 404 }));

  // Guards run before routing and validation, so a refused request learns nothing about the input.
  const guards: MiddlewareHandler = async (c, next) => {
    const blocked = deps.guard(c.req.raw, c.req.path === "/api/import" ? "application/octet-stream" : "application/json");
    if (blocked) return blocked;
    if (importing) return json({ error: "a store import is running; try again in a moment", code: "busy" }, 503);
    await next();
  };
  app.use("/api/*", guards);

  app.openAPIRegistry.registerComponent("securitySchemes", "docifyToken", { type: "apiKey", in: "header", name: "X-Docify-Token" });

  // Handlers return plain Responses; the declared responses document them.
  const add = <R extends RouteConfig>(route: R, handler: (c: Context) => Response | Promise<Response>) => app.openapi(createRoute(route), handler as never);
  const valid = <T extends z.ZodType>(c: Context, target: "json" | "query" | "param", _schema: T) => (c.req.valid as (t: string) => unknown)(target) as z.output<T>;
  const sourceId = (c: Context) => valid(c, "param", s.SourceIdParam).id;
  const busyGuard = (id: string, what = "a running operation") => {
    if (running.has(id)) throw new DocifyError("busy", `${id} already has ${what}`);
  };
  const pinsView = () => ({ project, file: Docify.pinFile(project), pins: Docify.readPins(project) });

  // ---- Server ----
  add(
    { method: "get", path: "/api/status", tags: ["Server"], summary: "Server and store status", responses: { 200: s.json(s.ServerStatus, "Version, store, running operations and source counts by state"), ...s.errors() } },
    () => {
      const counts: Record<string, number> = {};
      for (const source of sources(docify)) counts[source.state] = (counts[source.state] ?? 0) + 1;
      return json({ version: VERSION, home: docify.config.home, project, importing, running: [...running.keys()], sources: counts });
    },
  );
  add(
    { method: "get", path: "/api/logs", tags: ["Server"], summary: "Read log lines", description: "Lines in sequence order; pass the returned cursor as `after` to poll for new ones.", request: { query: s.LogsQuery }, responses: { 200: s.json(s.LogPage, "Log lines after the cursor"), ...s.errors(400, 500) } },
    (c) => {
      const q = valid(c, "query", s.LogsQuery);
      return json(docify.logs.read(q.after ?? 0, q.limit ?? 1000));
    },
  );
  add(
    { method: "get", path: "/api/config", tags: ["Settings"], summary: "Read the settings", responses: { 200: s.json(s.ConfigView, "Values, defaults and which keys config.json sets"), ...s.errors() } },
    () => json(describeConfig(docify.config)),
  );
  add(
    {
      method: "put",
      path: "/api/config",
      tags: ["Settings"],
      summary: "Change settings",
      description: "Writes only the given known keys to config.json and applies them without a restart. `graphifyBin`, `modelsDir` and `home` are read-only. Refused while a source operation runs.",
      request: { body: s.jsonBody(s.ConfigPatch) },
      responses: { 200: s.json(s.ConfigView, "The settings after the change"), ...s.errors(400, 409, 415) },
    },
    (c) => {
      const patch = valid(c, "json", s.ConfigPatch);
      if (running.size) throw new DocifyError("busy", `cannot change settings while ${[...running.keys()].join(", ")} has a running operation; wait or cancel first`);
      docify.saveConfig(patch);
      return json(describeConfig(docify.config));
    },
  );
  add(
    { method: "get", path: "/api/pins", tags: ["Settings"], summary: "Read project pins", description: "The nearest `.docify.json` above the directory `docify serve` started in.", responses: { 200: s.json(s.Pins, "Pins"), ...s.errors(400) } },
    () => json(pinsView()),
  );
  add(
    { method: "put", path: "/api/pins", tags: ["Settings"], summary: "Set or remove a version pin", request: { body: s.jsonBody(s.PinBody) }, responses: { 200: s.json(s.Pins, "Pins after the change"), ...s.errors(400, 415) } },
    (c) => {
      const b = valid(c, "json", s.PinBody);
      Docify.setPin(project, b.library, str(b.version) ?? null);
      return json(pinsView());
    },
  );

  // ---- Sources ----
  add(
    { method: "get", path: "/api/groups", tags: ["Sources"], summary: "List source groups", description: "Pass a group name in `groups` to search or scope all its sources.", responses: { 200: s.json(s.Groups, "Groups"), ...s.errors() } },
    () => json(docify.listGroups()),
  );
  add(
    {
      method: "get",
      path: "/api/sources",
      tags: ["Sources"],
      summary: "List or find sources",
      description: "Every registered source with its state, settings, summary and generations. With `query`, only sources whose identity or saved summary matches, best first.",
      request: { query: s.SourcesQuery },
      responses: { 200: s.json(z.array(s.SourceInfo), "Sources"), ...s.errors(400) },
    },
    (c) => {
      const { query } = valid(c, "query", s.SourcesQuery);
      return json(query === undefined ? sources(docify) : discoverSources(docify, query));
    },
  );
  add(
    {
      method: "post",
      path: "/api/sources",
      tags: ["Sources"],
      summary: "Register a source",
      description: "Registers a local directory (inside `DOCIFY_SOURCE_ROOTS`, default the home directory) or a URL. Nothing is fetched until it is prepared.",
      request: { body: s.jsonBody(s.AddSourceBody) },
      responses: { 201: s.json(z.object({ id: z.string() }).passthrough(), "The new source row"), ...s.errors(400, 409, 415) },
    },
    (c) => {
      const b = valid(c, "json", s.AddSourceBody);
      const version = str(b.version) ?? null;
      const labels = { title: b.title === undefined ? undefined : validateTitle(b.title), groups: b.groups === undefined ? undefined : validateGroups(b.groups) };
      if (b.kind === "local") {
        if (b.crawlProvider !== undefined || b.crawl !== undefined) throw new DocifyError("invalid_input", "crawler settings are only valid for URL sources");
        // The API may only register paths inside DOCIFY_SOURCE_ROOTS.
        let real: string;
        try {
          real = realpathSync(resolve(b.locator.replace(/^~(?=$|\/)/, homedir())));
        } catch {
          throw new DocifyError("invalid_input", `path does not exist: ${b.locator}`);
        }
        if (!withinSourceRoots(real, sourceRoots)) throw new DocifyError("invalid_input", `local sources must be inside DOCIFY_SOURCE_ROOTS (${sourceRoots.join(delimiter)})`);
        return json(docify.addSource({ library: b.library, version, kind: "local", locator: real, ignore: b.ignore, graphIgnore: b.graphIgnore, ...labels }), 201);
      }
      return json(docify.addSource({ library: b.library, version, kind: "url", locator: b.locator, crawlProvider: b.crawlProvider, crawl: b.crawl as never, ignore: b.ignore, graphIgnore: b.graphIgnore, ...labels }), 201);
    },
  );
  add(
    { method: "get", path: "/api/sources/{id}", tags: ["Sources"], summary: "Read one source", request: { params: s.SourceIdParam }, responses: { 200: s.json(s.SourceInfo, "The source"), ...s.errors(404) } },
    (c) => {
      const id = sourceId(c);
      docify.requireSource(id);
      return json(sources(docify).find((source) => source.id === id));
    },
  );
  add(
    {
      method: "patch",
      path: "/api/sources/{id}",
      tags: ["Sources"],
      summary: "Change title, groups, crawler settings or ignore patterns",
      description: "Every value is checked before anything is written, so a bad one leaves the whole request unapplied. Crawler settings and ignore patterns take effect on the next prepare; title and groups at once, also while the source prepares. The id never changes.",
      request: { params: s.SourceIdParam, body: s.jsonBody(s.PatchSourceBody) },
      responses: { 200: s.json(s.Ok, "Saved"), ...s.errors(400, 404, 415) },
    },
    (c) => {
      const id = sourceId(c);
      const b = valid(c, "json", s.PatchSourceBody);
      const crawler = b.crawlProvider !== undefined || b.crawl4ai !== undefined || b.crawl !== undefined;
      const ignoring = b.ignore !== undefined || b.graphIgnore !== undefined;
      const labelling = b.title !== undefined || b.groups !== undefined;
      if (!crawler && !ignoring && !labelling) throw new DocifyError("invalid_input", "crawler settings, ignore patterns, title or groups are required");
      // Checked before anything is written, so a bad value cannot leave half of the request applied.
      for (const name of ["ignore", "graphIgnore"] as const) {
        if (b[name] !== undefined && b[name] !== null) validateIgnorePatterns(b[name], name);
      }
      if (b.title !== undefined) validateTitle(b.title);
      if (b.groups !== undefined) validateGroups(b.groups);
      if (labelling) docify.updateSourceLabels(id, { title: b.title, groups: b.groups });
      if (crawler) docify.updateSourceCrawler(id, b.crawlProvider, b.crawl4ai, b.crawl);
      if (ignoring) docify.updateSourceIgnore(id, { ignore: b.ignore, graphIgnore: b.graphIgnore });
      return json({ ok: true });
    },
  );
  add(
    { method: "delete", path: "/api/sources/{id}", tags: ["Sources"], summary: "Remove a source", description: "Deletes the source, its generations and snapshots. Refused while it prepares or summarizes.", request: { params: s.SourceIdParam }, responses: { 200: s.json(s.Ok, "Removed"), ...s.errors(404, 409, 415) } },
    (c) => {
      const id = sourceId(c);
      busyGuard(id);
      docify.removeSource(id);
      return json({ ok: true });
    },
  );
  add(
    {
      method: "get",
      path: "/api/sources/{id}/generations",
      tags: ["Sources"],
      summary: "List generations",
      description: "Every kept generation, newest first. A staging generation whose writer died reads as failed, as after recovery.",
      request: { params: s.SourceIdParam },
      responses: { 200: s.json(z.object({ source: z.string(), activeGeneration: z.number().nullable(), generations: z.array(s.Generation) }), "Generations"), ...s.errors(404) },
    },
    (c) => {
      const id = sourceId(c);
      return json(
        docify.db.transaction(() => {
          const source = docify.requireSource(id);
          const generations = docify.generations(id).map((row) => {
            const gen = effectiveGeneration(row, source);
            let stats: Record<string, unknown> = {};
            try {
              stats = JSON.parse(gen.stats || "{}");
            } catch {}
            return {
              id: gen.id,
              status: gen.status,
              phase: gen.phase,
              progress: gen.progress,
              error: gen.error,
              startedAt: gen.started_at,
              finishedAt: gen.finished_at,
              downloadedAt: gen.downloaded_at,
              snapshotHash: gen.snapshot_hash,
              embeddingModel: gen.embedding_model,
              embeddingDims: gen.embedding_dims,
              graphStatus: gen.graph_status,
              stats,
            };
          });
          return { source: id, activeGeneration: source.active_generation ?? null, generations };
        })(),
      );
    },
  );
  add(
    {
      method: "get",
      path: "/api/sources/{id}/documents",
      tags: ["Sources"],
      summary: "List document paths",
      description: "Paths of the active generation's documents, sorted. Empty when the source is not prepared.",
      request: { params: s.SourceIdParam },
      responses: { 200: s.json(z.object({ source: z.string(), generation: z.number().nullable(), paths: z.array(z.string()) }), "Document paths"), ...s.errors(404) },
    },
    (c) => {
      const id = sourceId(c);
      return json(
        docify.db.transaction(() => {
          const source = docify.requireSource(id);
          const generation = source.active_generation ? docify.getGeneration(source.active_generation) : null;
          if (!generation || generation.status !== "active") return { source: source.id, generation: null, paths: [] };
          const rows = docify.db.query<{ path: string }, [number]>("SELECT path FROM documents WHERE generation_id = ? ORDER BY path").all(generation.id);
          return { source: source.id, generation: generation.id, paths: rows.map((row) => row.path) };
        })(),
      );
    },
  );
  add(
    { method: "get", path: "/api/sources/{id}/graph", tags: ["Sources"], summary: "Read the knowledge graph", request: { params: s.SourceIdParam }, responses: { 200: s.json(s.GraphView, "Graph of the active generation"), ...s.errors(404) } },
    (c) => json(graphView(docify, sourceId(c))),
  );
  add(
    {
      method: "get",
      path: "/api/sources/{id}/artifacts/{kind}",
      tags: ["Sources"],
      summary: "Download a page artifact",
      description: "The screenshot or PDF that Crawl4AI captured for a single-page source, from the active generation.",
      request: { params: s.ArtifactParams },
      responses: {
        200: { description: "The file", content: { "image/png": { schema: z.string().openapi({ format: "binary" }) }, "application/pdf": { schema: z.string().openapi({ format: "binary" }) } } },
        ...s.errors(404),
      },
    },
    (c) => {
      const missing = () => json({ error: "artifact not found", code: "unavailable" }, 404);
      const { id, kind } = valid(c, "param", s.ArtifactParams);
      if (!/^[a-z0-9][a-z0-9._@-]{0,80}$/.test(id) || (kind !== "screenshot" && kind !== "pdf")) return missing();
      const generation = docify.getSource(id)?.active_generation;
      if (!generation || !Number.isSafeInteger(generation) || generation < 1) return missing();
      const filename = kind === "screenshot" ? "screenshot.png" : "page.pdf";
      let file: string;
      try {
        const root = realpathSync(join(docify.config.home, "snapshots"));
        file = join(root, id, String(generation), "artifacts", filename);
        if (realpathSync(file) !== file) return missing();
      } catch {
        return missing();
      }
      return new Response(Bun.file(file), {
        headers: {
          "content-type": kind === "screenshot" ? "image/png" : "application/pdf",
          "content-disposition": `attachment; filename="${filename}"`,
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        },
      });
    },
  );

  // ---- Operations ----
  add(
    {
      method: "post",
      path: "/api/sources/{id}/prepare",
      tags: ["Operations"],
      summary: "Start preparing a source",
      description: "Runs in the background: download, normalize, index, embed and (optionally) build the graph, then activate. Follow it through the source's `latest` and `/api/logs`.",
      request: { params: s.SourceIdParam, body: s.jsonBody(s.PrepareBody) },
      responses: { 202: s.json(z.object({ started: z.string() }), "Started"), ...s.errors(400, 404, 409, 415) },
    },
    (c) => {
      const id = sourceId(c);
      const b = valid(c, "json", s.PrepareBody);
      docify.requireSource(id);
      if (running.has(id)) throw new DocifyError("busy", `${id} is already being prepared`);
      const controller = new AbortController();
      running.set(id, controller);
      docify
        .prepare(id, { graph: b.graph, graphOnly: b.graphOnly, force: b.force, signal: controller.signal })
        .catch((err) => console.error(`prepare ${id} failed: ${err instanceof Error ? err.message : err}`))
        .finally(() => running.delete(id));
      return json({ started: id }, 202);
    },
  );
  add(
    { method: "post", path: "/api/sources/{id}/cancel", tags: ["Operations"], summary: "Cancel a running prepare or summary", description: "The previous generation keeps serving.", request: { params: s.SourceIdParam }, responses: { 200: s.json(z.object({ cancelled: z.literal(true) }), "Cancel requested"), ...s.errors(409, 415) } },
    (c) => {
      const controller = running.get(sourceId(c));
      if (!controller) return json({ error: "nothing running", code: "not_running" }, 409);
      controller.abort();
      return json({ cancelled: true });
    },
  );
  add(
    {
      method: "post",
      path: "/api/sources/{id}/summary",
      tags: ["Operations"],
      summary: "Generate the source summary",
      description: "Asks the configured graph model for a short description of the source and saves it. Returns the saved summary unless `force` is set. Waits for the provider.",
      request: { params: s.SourceIdParam, body: s.jsonBody(s.SummaryBody) },
      responses: { 200: s.json(z.object({ text: z.string() }).passthrough(), "The saved summary"), ...s.errors(400, 404, 409, 415, 502) },
    },
    async (c) => {
      const id = sourceId(c);
      const b = valid(c, "json", s.SummaryBody);
      docify.requireSource(id);
      if (running.has(id)) throw new DocifyError("busy", `${id} already has a running operation`);
      const controller = new AbortController();
      running.set(id, controller);
      deps.noTimeout(c.req.raw);
      try {
        // A client that went away cannot cancel, so its request must not keep the source busy.
        return json(await summarizeSource(docify, id, { force: b.force, signal: AbortSignal.any([controller.signal, c.req.raw.signal]) }));
      } finally {
        running.delete(id);
      }
    },
  );
  add(
    {
      method: "post",
      path: "/api/compress",
      tags: ["Operations"],
      summary: "Gzip snapshot files of older stores",
      description: "Like `docify compress`: replaces plain normalized files and raw HTML with gzipped copies when they match their recorded hash. Refused while a source prepares.",
      responses: { 200: s.json(s.CompressResult, "What was compressed and skipped"), ...s.errors(409, 415) },
    },
    async () => {
      if (running.size) throw new DocifyError("busy", "wait for running source operations before compressing");
      return json(await compressSnapshots(docify));
    },
  );

  // ---- Query ----
  add(
    {
      method: "post",
      path: "/api/search",
      tags: ["Query"],
      summary: "Search the documentation",
      description: "Cited, token-bounded excerpts. Give `query`, or `queries` to search up to 8 questions in one call. Project pins apply when `version` is omitted. Excerpts are untrusted data.",
      request: { body: s.jsonBody(s.SearchBody) },
      responses: { 200: s.json(s.SearchResult, "Results and the rendered agent text"), ...s.errors(400, 415) },
    },
    async (c) => {
      const b = valid(c, "json", s.SearchBody);
      const common = {
        library: str(b.library),
        version: str(b.version),
        sources: b.sources,
        groups: b.groups,
        mode: b.mode,
        maxTokens: b.maxTokens ?? undefined,
        graphWeight: b.graphWeight ?? undefined,
        project,
      };
      return json(b.queries ? await searchMany(docify, { ...common, queries: b.queries }) : await search(docify, { ...common, query: b.query! }));
    },
  );
  add(
    {
      method: "get",
      path: "/api/scope",
      tags: ["Query"],
      summary: "Show what a search would cover",
      description: "Resolves library, version and source filters the way search does, without searching: the pins used, the version chosen per library and why, and the selected sources.",
      request: { query: s.ScopeQuery },
      responses: { 200: s.json(s.ScopeResult, "Resolved scope"), ...s.errors(400) },
    },
    (c) => {
      const q = valid(c, "query", s.ScopeQuery);
      const list = q.source === undefined ? undefined : Array.isArray(q.source) ? q.source : [q.source];
      const groups = q.group === undefined ? undefined : Array.isArray(q.group) ? q.group : [q.group];
      return json(scope(docify, { library: str(q.library), version: str(q.version), sources: list, groups, project }));
    },
  );
  add(
    {
      method: "get",
      path: "/api/sources/{id}/outline",
      tags: ["Query"],
      summary: "Outline a source",
      description: "Documents with their section headings and the passage id of each section.",
      request: { params: s.SourceIdParam, query: s.OutlineQuery },
      responses: { 200: s.json(s.OutlineResult, "Outline"), ...s.errors(400) },
    },
    (c) => {
      const q = valid(c, "query", s.OutlineQuery);
      return json(outline(docify, { source: sourceId(c), path: q.path, maxTokens: q.maxTokens }));
    },
  );
  add(
    {
      method: "get",
      path: "/api/sources/{id}/open",
      tags: ["Query"],
      summary: "Open a document or one section",
      description: "A whole document, or one section with its subsections, from the active generation.",
      request: { params: s.SourceIdParam, query: s.OpenQuery },
      responses: { 200: s.json(s.OpenResult, "Document text"), ...s.errors(400) },
    },
    (c) => {
      const q = valid(c, "query", s.OpenQuery);
      return json(open(docify, { source: sourceId(c), path: q.path, heading: q.heading, maxTokens: q.maxTokens }));
    },
  );
  add(
    {
      method: "get",
      path: "/api/read/{id}",
      tags: ["Query"],
      summary: "Read a passage with context",
      description: "An id from an older generation returns that snapshot marked `superseded`, then `unavailable` after cleanup.",
      request: { params: s.PassageIdParam, query: s.ReadQuery },
      responses: { 200: s.json(s.ReadResult, "Passage"), ...s.errors(400) },
    },
    (c) => json(read(docify, valid(c, "param", s.PassageIdParam).id, valid(c, "query", s.ReadQuery).maxTokens)),
  );
  add(
    {
      method: "get",
      path: "/api/raw/{id}",
      tags: ["Query"],
      summary: "Raw source of a passage's document",
      description: "The preserved source file, only when it still matches its recorded hash.",
      request: { params: s.PassageIdParam },
      responses: { 200: { description: "File content", content: { "text/plain": { schema: z.string() } } }, ...s.errors(404) },
    },
    (c) => {
      const row = docify.db
        .query<{ raw_file: string; raw_sha256: string }, [string]>("SELECT d.raw_file, d.raw_sha256 FROM passages p JOIN documents d ON d.id = p.document_id WHERE p.id = ?")
        .get(valid(c, "param", s.PassageIdParam).id);
      if (!row) return json({ error: "unknown passage", code: "unavailable" }, 404);
      const root = realpathSync(join(docify.config.home, "snapshots"));
      const file = realpathSync(row.raw_file);
      if (!file.startsWith(root + sep)) return json({ error: "forbidden", code: "forbidden" }, 403);
      // Stored gzipped or plain; either way only the content the database recorded is served.
      const content = readSnapshotFile(file, row.raw_sha256);
      if (!content) return json({ error: "the preserved source no longer matches its recorded hash", code: "unavailable" }, 404);
      return new Response(content, { headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
    },
  );

  // ---- Backup ----
  add(
    {
      method: "get",
      path: "/api/export",
      tags: ["Backup"],
      summary: "Download a store backup",
      description: "A gzipped tar of the database, config.json and snapshots, with a manifest of SHA-256 sums. Refused while a source prepares.",
      responses: { 200: { description: "Backup archive", content: { "application/gzip": { schema: z.string().openapi({ format: "binary" }) } } }, ...s.errors(409) },
    },
    async () => {
      const { bytes, manifest } = await exportStore(docify);
      const name = `docify-backup-${manifest.createdAt.slice(0, 19).replace(/[:T]/g, "-")}.tar.gz`;
      return new Response(bytes, { headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" } });
    },
  );
  add(
    {
      method: "post",
      path: "/api/import",
      tags: ["Backup"],
      summary: "Restore a store backup",
      description: "Send the archive as raw bytes (`application/octet-stream`). A store with sources is replaced only with `force=1`; it is moved aside first. Local sources must be inside `DOCIFY_SOURCE_ROOTS`.",
      request: { query: s.ImportQuery, body: { required: true, content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } } } },
      responses: { 200: s.json(s.ImportResult, "Imported"), ...s.errors(400, 409, 415) },
    },
    async (c) => {
      const req = c.req.raw;
      const size = Number(req.headers.get("content-length") ?? "0");
      if (size > IMPORT_MAX_BYTES) throw new DocifyError("invalid_input", "the backup is larger than the upload limit; use docify import on the server");
      const data = new Uint8Array(await req.arrayBuffer());
      if (!data.length) throw new DocifyError("invalid_input", "empty upload");
      const q = valid(c, "query", s.ImportQuery);
      // Like adding one, an imported local source must be inside DOCIFY_SOURCE_ROOTS.
      const checkLocalSource = (path: string) => {
        const real = existsSync(path) ? realpathSync(path) : resolve(path);
        if (!withinSourceRoots(real, sourceRoots)) throw new DocifyError("invalid_input", `the backup has a local source outside DOCIFY_SOURCE_ROOTS: ${path}`);
      };
      if (running.size) throw new DocifyError("busy", "wait for running source operations before importing");
      importing = true;
      try {
        return json(await importStore(docify, data, { force: q.force === "1", keepConfig: q.keepConfig === "1", checkLocalSource }));
      } finally {
        importing = false;
      }
    },
  );

  return app;
}

export type ApiApp = ReturnType<typeof createApi>;

// The spec does not depend on the store, so it is built once from a route table with no store behind it.
let cachedSpec: unknown;
export function openApiSpec(): { openapi: string; paths: Record<string, Record<string, unknown>> } & Record<string, unknown> {
  cachedSpec ??= createApi({ docify: null as never, project: "", sourceRoots: [], guard: () => null, noTimeout: () => {} }).getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "Docify web API",
      version: VERSION,
      description:
        "Controls Docify and reads everything it stores: sources, preparation, generations, search, settings, logs and backups. When `DOCIFY_WEB_TOKEN` is set, every call needs it, sent as `X-Docify-Token`; without it the API needs no token. Requests other than GET must send JSON, except `/api/import`, which takes the backup as raw bytes. Errors are `{ error, code, field? }`.",
    },
    servers: [{ url: "/" }],
    security: [{ docifyToken: [] }],
    tags: [
      { name: "Sources", description: "Register, configure, inspect and remove sources" },
      { name: "Operations", description: "Prepare, cancel, summarize and compress" },
      { name: "Query", description: "Search and read prepared documentation; never writes" },
      { name: "Settings", description: "config.json and project pins" },
      { name: "Backup", description: "Export and import the whole store" },
      { name: "Server", description: "Status and logs" },
    ],
  });
  return cachedSpec as never;
}
