// OpenAPI description of the web UI's /api, served with Swagger UI at /api/docs.
// Keep it in step with the routes in server.ts; tests/api-docs.test.ts checks that every /api route is listed.

const error = { $ref: "#/components/schemas/Error" };
const errors = (...codes: number[]) =>
  Object.fromEntries(codes.map((code) => [String(code), { description: ERROR_TEXT[code], content: { "application/json": { schema: error } } }]));
const ERROR_TEXT: Record<number, string> = {
  400: "Invalid input",
  401: "Missing or wrong access token",
  403: "Forbidden host, origin or path",
  404: "Unknown source or passage",
  409: "Busy, already exists or nothing running",
  415: "JSON body required (raw bytes for /api/import)",
  503: "A store import is running",
  500: "Internal error",
};
const ok = (description: string, schema: object = { type: "object" }) => ({ description, content: { "application/json": { schema } } });
const jsonBody = (schema: object, required = true) => ({ required, content: { "application/json": { schema } } });
const idParam = (description: string) => ({ name: "id", in: "path", required: true, description, schema: { type: "string" } });

export function openApiSpec() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Docify web API",
      version: "1",
      description:
        "The HTTP API behind the Docify web UI. Every call needs the access token that `docify serve` prints in the URL fragment (`#token=...`), or `DOCIFY_WEB_TOKEN` on a hosted deployment, sent as `X-Docify-Token`. Requests other than GET must send JSON, except `/api/import`, which takes the backup as raw bytes.",
    },
    servers: [{ url: "/" }],
    security: [{ docifyToken: [] }],
    components: {
      securitySchemes: { docifyToken: { type: "apiKey", in: "header", name: "X-Docify-Token" } },
      schemas: {
        Error: {
          type: "object",
          required: ["error", "code"],
          properties: { error: { type: "string" }, code: { type: "string" }, field: { type: ["string", "null"] } },
        },
        Pins: {
          type: "object",
          properties: {
            project: { type: "string" },
            file: { type: ["string", "null"] },
            pins: { type: "object", additionalProperties: { type: ["string", "null"] } },
          },
        },
      },
    },
    paths: {
      "/api/logs": {
        get: {
          summary: "Read application logs",
          parameters: [
            { name: "after", in: "query", description: "Return entries after this id", schema: { type: "integer", minimum: 0, default: 0 } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 1000, default: 1000 } },
          ],
          responses: { "200": ok("Log entries"), ...errors(400, 401, 500) },
        },
      },
      "/api/sources": {
        get: { summary: "List sources", responses: { "200": ok("Sources with their generations and status"), ...errors(401) } },
        post: {
          summary: "Add a source",
          description: "Local paths must be inside `DOCIFY_SOURCE_ROOTS` (default: the home directory).",
          requestBody: jsonBody({
            type: "object",
            required: ["library", "locator"],
            properties: {
              kind: { type: "string", enum: ["local", "url"], default: "local" },
              library: { type: "string" },
              locator: { type: "string", description: "Directory path or start URL" },
              version: { type: ["string", "null"] },
            },
          }),
          responses: { "201": ok("The new source"), ...errors(400, 401, 403, 409, 415) },
        },
      },
      "/api/sources/{id}": {
        delete: {
          summary: "Remove a source",
          parameters: [idParam("Source id")],
          responses: { "200": ok("Removed", { type: "object", properties: { ok: { type: "boolean" } } }), ...errors(401, 404, 409) },
        },
      },
      "/api/sources/{id}/graph": {
        get: {
          summary: "Graph of the active generation",
          description:
            "Nodes with their page and best grounding passage, one edge per connected node pair (indexes into `nodes`), and hyperedge groups. `nodes` is empty when the source is not prepared or was prepared without a graph; `graphStatus` says which.",
          parameters: [idParam("Source id")],
          responses: { "200": ok("Graph view"), ...errors(401, 404) },
        },
      },
      "/api/sources/{id}/prepare": {
        post: {
          summary: "Start preparing a source",
          description: "Runs in the background. Follow progress through `GET /api/sources` and `GET /api/logs`.",
          parameters: [idParam("Source id")],
          requestBody: jsonBody({
            type: "object",
            properties: {
              graph: { type: "boolean", default: true, description: "Build the Graphify graph" },
              force: { type: "boolean", default: false, description: "Rebuild even when unchanged" },
            },
          }),
          responses: { "202": ok("Started", { type: "object", properties: { started: { type: "string" } } }), ...errors(400, 401, 404, 409, 415) },
        },
      },
      "/api/sources/{id}/cancel": {
        post: {
          summary: "Cancel a running preparation",
          parameters: [idParam("Source id")],
          requestBody: jsonBody({ type: "object" }, false),
          responses: { "200": ok("Cancelled", { type: "object", properties: { cancelled: { type: "boolean" } } }), ...errors(401, 409, 415) },
        },
      },
      "/api/search": {
        post: {
          summary: "Search prepared documentation",
          requestBody: jsonBody({
            type: "object",
            required: ["query"],
            properties: {
              query: { type: "string" },
              library: { type: "string" },
              version: { type: "string" },
              sources: { type: "array", items: { type: "string" } },
              mode: { type: "string", enum: ["combined", "lexical", "vector", "graph"], default: "combined" },
              maxTokens: { type: "integer" },
              graphWeight: { type: "number" },
            },
          }),
          responses: { "200": ok("Search result with status, hits and the rendered agent text"), ...errors(400, 401, 415) },
        },
      },
      "/api/read/{id}": {
        get: {
          summary: "Read a passage",
          parameters: [idParam("Passage id (`p_...`)")],
          responses: { "200": ok("The passage, possibly marked superseded or unavailable"), ...errors(401) },
        },
      },
      "/api/raw/{id}": {
        get: {
          summary: "Raw source file of a passage",
          parameters: [idParam("Passage id (`p_...`)")],
          responses: { "200": { description: "File contents", content: { "text/plain": { schema: { type: "string" } } } }, ...errors(401, 403, 404) },
        },
      },
      "/api/config": {
        get: { summary: "Read settings", responses: { "200": ok("Values, defaults, paths and credential variables (set or not, never values)"), ...errors(401, 500) } },
        put: {
          summary: "Change settings",
          description: "Only known keys are accepted and only changed keys are written. Refused while a source is being prepared.",
          requestBody: jsonBody({ type: "object", additionalProperties: true }),
          responses: { "200": ok("Settings after the change"), ...errors(400, 401, 409, 415) },
        },
      },
      "/api/export": {
        get: {
          summary: "Export the whole store",
          description: "The database, settings and snapshot files of every active and superseded generation, as one .tar.gz with a manifest of SHA-256 sums. Models and the Graphify runtime are left out. Refused while a source is being prepared.",
          responses: { "200": { description: "The backup", content: { "application/gzip": { schema: { type: "string", format: "binary" } } } }, ...errors(401, 409, 500) },
        },
      },
      "/api/import": {
        post: {
          summary: "Replace the store with a backup",
          description:
            "Every file is checked against the manifest before anything changes. A store that already has sources is replaced only with `force=1`, and its files are moved aside, not deleted. The backup's paths to code (`graphifyBin`, `modelsDir`) are ignored, and local sources must be inside DOCIFY_SOURCE_ROOTS.",
          parameters: [
            { name: "force", in: "query", required: false, description: "1 to replace a store that has sources", schema: { type: "string", enum: ["0", "1"] } },
            { name: "keepConfig", in: "query", required: false, description: "1 to keep this server's config.json", schema: { type: "string", enum: ["0", "1"] } },
          ],
          requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
          responses: { "200": ok("Imported sources, the backup's date and version, and where the previous store went"), ...errors(400, 401, 409, 415, 503) },
        },
      },
      "/api/pins": {
        get: { summary: "Read project pins", responses: { "200": ok("Pins", { $ref: "#/components/schemas/Pins" }), ...errors(401, 400) } },
        put: {
          summary: "Pin or unpin a library version",
          requestBody: jsonBody({
            type: "object",
            required: ["library"],
            properties: { library: { type: "string" }, version: { type: ["string", "null"], description: "null removes the pin" } },
          }),
          responses: { "200": ok("Pins", { $ref: "#/components/schemas/Pins" }), ...errors(400, 401, 415) },
        },
      },
    },
  };
}

// No inline script: the page runs under the same `script-src 'self'` policy as the UI.
export const DOCS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Docify API</title>
<link rel="stylesheet" href="/api/docs/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="/api/docs/swagger-ui-bundle.js"></script>
<script src="/api/docs/init.js"></script>
</body>
</html>
`;

// The token stays in the fragment, as on the main page, and is handed to Swagger UI in the browser.
export const DOCS_INIT = `const ui = SwaggerUIBundle({
  url: "/api/docs/openapi.json",
  dom_id: "#swagger-ui",
  persistAuthorization: false,
  onComplete() {
    const token = new URLSearchParams(location.hash.slice(1)).get("token");
    if (token) ui.preauthorizeApiKey("docifyToken", token);
  },
});
`;
