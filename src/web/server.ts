import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import index from "./index.html";
import { Docify, DocifyError } from "../core/docify.ts";
import { read, search, sources, type Mode } from "../core/search.ts";

const STATUS_BY_CODE: Record<string, number> = { invalid_input: 400, exists: 409, busy: 409, source_unknown: 404 };

export async function startServer(port: number, opts: { docify?: Docify; quiet?: boolean; token?: string } = {}) {
  const docify = opts.docify ?? new Docify();
  const running = new Map<string, AbortController>();
  let boundPort = port;
  // Loopback is shared by every local user, so each server start gets a secret that is shown
  // only in the URL fragment (never sent to the server or logged) and required on /api.
  const token = opts.token ?? Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
  const tokenOk = (given: string | null) => !!given && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));

  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const fail = (err: unknown) => {
    if (err instanceof DocifyError) return json({ error: err.message, code: err.code }, STATUS_BY_CODE[err.code] ?? 400);
    console.error(err);
    return json({ error: String(err instanceof Error ? err.message : err), code: "internal" }, 500);
  };

  // DNS rebinding and cross-site requests: only our own loopback origin, JSON bodies only.
  const guard = (req: Request): Response | null => {
    const host = req.headers.get("host");
    if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) return json({ error: "forbidden host", code: "forbidden" }, 403);
    if (!tokenOk(req.headers.get("x-docify-token"))) return json({ error: "missing or wrong access token; open the URL printed by docify serve", code: "unauthorized" }, 401);
    if (req.method !== "GET") {
      if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return json({ error: "JSON body required", code: "unsupported" }, 415);
      const origin = req.headers.get("origin");
      if (origin && origin !== `http://${host}`) return json({ error: "forbidden origin", code: "forbidden" }, 403);
    }
    return null;
  };

  const api =
    (handler: (req: Request & { params: Record<string, string> }) => Promise<Response> | Response) =>
    async (req: Request & { params: Record<string, string> }) => {
      const blocked = guard(req);
      if (blocked) return blocked;
      try {
        return await handler(req);
      } catch (err) {
        return fail(err);
      }
    };

  const body = async (req: Request) => {
    try {
      return (await req.json()) as Record<string, unknown>;
    } catch {
      throw new DocifyError("invalid_input", "invalid JSON body");
    }
  };
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    development: false,
    routes: {
      "/": index,
      "/api/sources": {
        GET: api(() => json(sources(docify))),
        POST: api(async (req) => {
          const b = await body(req);
          const kind = b.kind === "url" ? "url" : "local";
          const locator = str(b.locator);
          const library = str(b.library);
          if (!locator || !library) throw new DocifyError("invalid_input", "library and locator are required");
          if (kind === "local") {
            // The UI may only register paths inside the user's home directory.
            let real: string;
            try {
              real = realpathSync(resolve(locator.replace(/^~(?=$|\/)/, homedir())));
            } catch {
              throw new DocifyError("invalid_input", `path does not exist: ${locator}`);
            }
            const home = realpathSync(homedir());
            if (real !== home && !real.startsWith(home + sep)) throw new DocifyError("invalid_input", "local sources must be inside your home directory");
            return json(docify.addSource({ library, version: str(b.version) ?? null, kind, locator: real }), 201);
          }
          return json(docify.addSource({ library, version: str(b.version) ?? null, kind, locator }), 201);
        }),
      },
      "/api/sources/:id": {
        DELETE: api((req) => {
          if (running.has(req.params.id!)) throw new DocifyError("busy", "cancel the running preparation first");
          docify.removeSource(decodeURIComponent(req.params.id!));
          return json({ ok: true });
        }),
      },
      "/api/sources/:id/prepare": {
        POST: api(async (req) => {
          const id = decodeURIComponent(req.params.id!);
          docify.requireSource(id);
          if (running.has(id)) throw new DocifyError("busy", `${id} is already being prepared`);
          const b = await body(req);
          const controller = new AbortController();
          running.set(id, controller);
          docify
            .prepare(id, { graph: b.graph !== false, force: b.force === true, signal: controller.signal })
            .catch((err) => console.error(`prepare ${id} failed: ${err instanceof Error ? err.message : err}`))
            .finally(() => running.delete(id));
          return json({ started: id }, 202);
        }),
      },
      "/api/sources/:id/cancel": {
        POST: api((req) => {
          const c = running.get(decodeURIComponent(req.params.id!));
          if (!c) return json({ error: "nothing running", code: "not_running" }, 409);
          c.abort();
          return json({ cancelled: true });
        }),
      },
      "/api/search": {
        POST: api(async (req) => {
          const b = await body(req);
          const query = str(b.query);
          if (!query) throw new DocifyError("invalid_input", "query is required");
          const modes = ["combined", "lexical", "vector", "graph"];
          return json(
            await search(docify, {
              query,
              library: str(b.library),
              version: str(b.version),
              sources: Array.isArray(b.sources) ? b.sources.filter((s): s is string => typeof s === "string") : undefined,
              mode: modes.includes(String(b.mode)) ? (b.mode as Mode) : "combined",
              maxTokens: typeof b.maxTokens === "number" ? b.maxTokens : undefined,
              graphWeight: typeof b.graphWeight === "number" ? b.graphWeight : undefined,
              project: process.cwd(),
            }),
          );
        }),
      },
      "/api/read/:id": { GET: api((req) => json(read(docify, req.params.id!))) },
      // Raw source is served only for stored passages, and only from the snapshot directory.
      "/api/raw/:id": {
        GET: api((req) => {
          const row = docify.db
            .query<{ raw_file: string }, [string]>("SELECT d.raw_file FROM passages p JOIN documents d ON d.id = p.document_id WHERE p.id = ?")
            .get(req.params.id!);
          if (!row) return json({ error: "unknown passage", code: "unavailable" }, 404);
          const root = realpathSync(join(docify.config.home, "snapshots"));
          const file = realpathSync(row.raw_file);
          if (!file.startsWith(root + sep)) return json({ error: "forbidden", code: "forbidden" }, 403);
          return new Response(Bun.file(file), { headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
        }),
      },
    },
    fetch: () => new Response("not found", { status: 404 }),
  });
  boundPort = server.port!;
  if (!opts.quiet) console.log(`Docify UI on http://127.0.0.1:${boundPort}/#token=${token}`);
  return Object.assign(server, { token });
}
