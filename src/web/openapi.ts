// OpenAPI description of the web UI's /api, served with Swagger UI at /api/docs.
// Keep it in step with the routes in server.ts; tests/api-docs.test.ts checks that every /api route is listed.

const error = { $ref: "#/components/schemas/Error" };
const errors = (...codes: number[]) =>
  Object.fromEntries(codes.map((code) => [String(code), { description: ERROR_TEXT[code], content: { "application/json": { schema: error } } }]));
const ERROR_TEXT: Record<number, string> = {
  400: "Invalid input",
  401: "Missing or wrong access token, or not signed in",
  403: "Forbidden host, origin or path; with accounts, an account that is not approved or not an administrator",
  404: "Unknown source, passage, user, key or access-list entry",
  409: "Busy, already exists, nothing running, or a change the account rules refuse",
  415: "JSON body required (raw bytes for /api/import)",
  502: "The summary provider failed or returned an unusable summary",
  503: "A store import is running",
  500: "Internal error",
};
const ok = (description: string, schema: object = { type: "object" }) => ({ description, content: { "application/json": { schema } } });
const jsonBody = (schema: object, required = true) => ({ required, content: { "application/json": { schema } } });
const patternList = { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 500 } };
const idParam = (description: string) => ({ name: "id", in: "path", required: true, description, schema: { type: "string" } });

export function openApiSpec() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Docify web API",
      version: "1",
      description:
        "The HTTP API behind the Docify web UI. When `DOCIFY_WEB_TOKEN` is set, every call needs it, sent as `X-Docify-Token`; without it the API needs no token. When GitHub sign-in is on (`DOCIFY_GITHUB_CLIENT_ID`), the token is not used: calls carry the `docify_session` cookie set by `/auth/github` (named `__Host-docify_session` when the public address is https), members may search, read, list and manage their own MCP keys and search history under `/api/me`, and everything else needs an administrator. Administrators keep an access list under `/api/access`: GitHub organizations, logins and email addresses whose owners get in at sign-in without waiting. A request a browser marks as cross-site is refused. Requests other than GET must send JSON, except `/api/import`, which takes the backup as raw bytes.",
    },
    servers: [{ url: "/" }],
    security: [{ docifyToken: [] }, { docifySession: [] }],
    components: {
      securitySchemes: {
        docifyToken: { type: "apiKey", in: "header", name: "X-Docify-Token" },
        docifySession: { type: "apiKey", in: "cookie", name: "docify_session" },
      },
      schemas: {
        User: {
          type: "object",
          properties: {
            id: { type: "integer" },
            login: { type: "string", description: "GitHub login" },
            name: { type: ["string", "null"] },
            role: { type: "string", enum: ["admin", "member"] },
            status: { type: "string", enum: ["pending", "active", "disabled"] },
            createdAt: { type: "string" },
            approvedAt: { type: ["string", "null"] },
            lastLoginAt: { type: ["string", "null"] },
            named: { type: "boolean", description: "Named in DOCIFY_ADMINS; cannot be demoted, disabled or removed here" },
            self: { type: "boolean", description: "The account making the call" },
            rule: {
              type: ["object", "null"],
              description: "The access-list entry that let this person in; null when an administrator approved them",
              properties: { kind: { type: "string", enum: ["org", "login", "email"] }, value: { type: "string" } },
            },
          },
        },
        AccessRule: {
          type: "object",
          properties: {
            id: { type: "integer" },
            kind: { type: "string", enum: ["org", "login", "email"], description: "A GitHub organization, a GitHub login, or an email address verified at GitHub" },
            value: { type: "string", description: "Stored in lower case" },
            createdAt: { type: "string" },
            createdBy: { type: ["string", "null"], description: "Login of the administrator who added it" },
            people: { type: "integer", description: "Accounts this entry let in" },
            bound: { type: "boolean", description: "For a login entry: a GitHub account has signed in with it, and the entry now belongs to that account" },
          },
        },
        Key: {
          type: "object",
          properties: {
            id: { type: "integer" },
            name: { type: "string" },
            prefix: { type: "string", description: "The first 8 characters of the key, to tell keys apart" },
            createdAt: { type: "string" },
            lastUsedAt: { type: ["string", "null"], description: "Updated at most once a minute" },
          },
        },
        Query: {
          type: "object",
          properties: {
            id: { type: "integer" },
            at: { type: "string" },
            via: { type: "string", enum: ["web", "mcp"] },
            keyName: { type: ["string", "null"], description: "The personal key used, for `mcp`" },
            query: { type: "string" },
            scope: { type: ["string", "null"], description: "Sources or library the search was limited to" },
            status: { type: "string" },
            hits: { type: "integer" },
          },
        },
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
      "/api/session": {
        get: {
          summary: "Who is signed in",
          description: "Needs no token or session. `accounts` says whether GitHub sign-in is on; `user` is null when nobody is signed in. With accounts on, `asks` says what sign-in will ask GitHub for beyond the public profile, which depends on the access list.",
          security: [],
          responses: {
            "200": ok("Session", {
              type: "object",
              properties: {
                accounts: { type: "boolean" },
                user: { type: ["object", "null"], properties: { id: { type: "integer" }, login: { type: "string" }, name: { type: ["string", "null"] }, role: { type: "string", enum: ["admin", "member"] }, status: { type: "string", enum: ["pending", "active", "disabled"] } } },
                asks: { type: "object", properties: { orgs: { type: "boolean" }, emails: { type: "boolean" } } },
              },
            }),
            ...errors(403),
          },
        },
        delete: {
          summary: "Sign out",
          security: [],
          requestBody: jsonBody({ type: "object" }, false),
          responses: { "200": ok("Signed out", { type: "object", properties: { ok: { type: "boolean" } } }), ...errors(403, 415) },
        },
      },
      "/api/me/keys": {
        get: {
          summary: "List your MCP keys",
          description: "Any approved account. Only the caller's own keys; the key itself is never returned here. 404 when GitHub sign-in is off.",
          responses: { "200": ok("Keys", { type: "object", properties: { keys: { type: "array", items: { $ref: "#/components/schemas/Key" } }, max: { type: "integer" } } }), ...errors(401, 403, 404) },
        },
        post: {
          summary: "Make an MCP key",
          description: "Any approved account. `token` is the key for `/mcp` (`Authorization: Bearer <token>`); this is the only response that carries it, the server keeps its SHA-256 hash. Names are unique per person, at most ten keys.",
          requestBody: jsonBody({ type: "object", required: ["name"], properties: { name: { type: "string", maxLength: 60 } } }),
          responses: { "201": ok("The new key", { type: "object", properties: { key: { $ref: "#/components/schemas/Key" }, token: { type: "string" } } }), ...errors(400, 401, 403, 404, 409, 415) },
        },
      },
      "/api/me/keys/{id}": {
        delete: {
          summary: "Revoke one of your MCP keys",
          description: "The key stops working at once. Another person's key answers 404.",
          parameters: [idParam("Key id")],
          responses: { "200": ok("Revoked", { type: "object", properties: { ok: { type: "boolean" } } }), ...errors(401, 403, 404) },
        },
      },
      "/api/me/queries": {
        get: {
          summary: "Your recent searches",
          description: "Any approved account. The caller's own searches from the page and through their keys, newest first: the query and its outcome, not the passages. The newest `kept` are stored.",
          parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } }],
          responses: { "200": ok("Searches", { type: "object", properties: { queries: { type: "array", items: { $ref: "#/components/schemas/Query" } }, kept: { type: "integer" } } }), ...errors(400, 401, 403, 404) },
        },
        delete: {
          summary: "Clear your search history",
          responses: { "200": ok("Cleared", { type: "object", properties: { ok: { type: "boolean" }, removed: { type: "integer" } } }), ...errors(401, 403, 404) },
        },
      },
      "/api/users": {
        get: {
          summary: "List accounts",
          description: "Administrators only. Accounts waiting for approval come first. 404 when GitHub sign-in is off.",
          responses: { "200": ok("Accounts", { type: "object", properties: { users: { type: "array", items: { $ref: "#/components/schemas/User" } } } }), ...errors(401, 403, 404) },
        },
      },
      "/api/users/{id}": {
        patch: {
          summary: "Approve, disable or change the role of an account",
          description: "Administrators only. `status: active` approves a pending account or re-enables a disabled one; `disabled` also ends the person's sessions and MCP keys. Your own account and accounts named in DOCIFY_ADMINS are refused with 409.",
          parameters: [idParam("Account id")],
          requestBody: jsonBody({ type: "object", properties: { role: { type: "string", enum: ["admin", "member"] }, status: { type: "string", enum: ["active", "disabled"] } } }),
          responses: { "200": ok("The account", { $ref: "#/components/schemas/User" }), ...errors(400, 401, 403, 404, 409, 415) },
        },
        delete: {
          summary: "Remove an account",
          description: "Administrators only. If the person signs in again, the access list decides whether they get in, wait or are refused.",
          parameters: [idParam("Account id")],
          responses: { "200": ok("Removed", { type: "object", properties: { ok: { type: "boolean" } } }), ...errors(401, 403, 404, 409) },
        },
      },
      "/api/access": {
        get: {
          summary: "The access list",
          description: "Administrators only. `rules` are the entries; `outsiders` says what happens to a person who matches none: `pending` (waits for approval) or `refuse` (gets no account). 404 when GitHub sign-in is off.",
          responses: {
            "200": ok("Access list", {
              type: "object",
              properties: {
                outsiders: { type: "string", enum: ["pending", "refuse"] },
                rules: { type: "array", items: { $ref: "#/components/schemas/AccessRule" } },
                maxOrgs: { type: "integer" },
                maxRules: { type: "integer" },
              },
            }),
            ...errors(401, 403, 404),
          },
        },
        put: {
          summary: "Set what happens to people outside the access list",
          description: "Administrators only. Accounts that already exist are not changed.",
          requestBody: jsonBody({ type: "object", required: ["outsiders"], properties: { outsiders: { type: "string", enum: ["pending", "refuse"] } } }),
          responses: { "200": ok("The setting", { type: "object", properties: { outsiders: { type: "string", enum: ["pending", "refuse"] } } }), ...errors(400, 401, 403, 404, 415) },
        },
      },
      "/api/access/rules": {
        post: {
          summary: "Add an entry to the access list",
          description: "Administrators only. A person who matches gets in as a member at their next sign-in. An organization or email entry makes sign-in ask GitHub for the `read:org` or `user:email` scope. A refused value is reported with `field: value`.",
          requestBody: jsonBody({ type: "object", required: ["kind", "value"], properties: { kind: { type: "string", enum: ["org", "login", "email"] }, value: { type: "string", maxLength: 254 } } }),
          responses: { "201": ok("The new entry", { $ref: "#/components/schemas/AccessRule" }), ...errors(400, 401, 403, 404, 409, 415) },
        },
      },
      "/api/access/rules/{id}": {
        delete: {
          summary: "Remove an entry from the access list",
          description: "Administrators only. The people it let in are signed out, lose their MCP keys and wait for approval; `suspended` lists their logins. Accounts approved by hand stay. An entry that lets the caller in is refused with 409.",
          parameters: [idParam("Entry id")],
          responses: { "200": ok("Removed", { type: "object", properties: { ok: { type: "boolean" }, suspended: { type: "array", items: { type: "string" } } } }), ...errors(401, 403, 404, 409) },
        },
      },
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
        get: { summary: "List sources", description: "Each source includes crawlProvider (null when inherited), effectiveCrawlProvider and its ignore and graphIgnore pattern lists.", responses: { "200": ok("Sources with their generations and status"), ...errors(401) } },
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
              crawlProvider: { type: "string", enum: ["builtin", "crawl4ai", "browserless"], description: "URL sources only; omit to inherit the global crawler" },
              ignore: { ...patternList, description: "Regular expressions over the document path inside the source. Matching files or pages are not collected." },
              graphIgnore: { ...patternList, description: "Regular expressions over the document path. Matching documents stay searchable but are left out of the graph." },
            },
          }),
          responses: { "201": ok("The new source"), ...errors(400, 401, 403, 409, 415) },
        },
      },
      "/api/sources/{id}": {
        patch: {
          summary: "Change a source's crawler or ignore patterns",
          description: "Crawler settings apply to URL sources only; ignore patterns apply to every source. Changes take effect at the next prepare.",
          parameters: [idParam("Source id")],
          requestBody: jsonBody({ type: "object", properties: {
            crawlProvider: { type: ["string", "null"], enum: ["builtin", "crawl4ai", "browserless", null], description: "null inherits the global crawler" },
            crawl4ai: { type: "object", description: "Replaces the Crawl4AI options for this URL source", additionalProperties: false, properties: {
              stream: { type: "boolean" }, waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle", "commit"] },
              waitFor: { type: "string", maxLength: 1000 }, delayBeforeReturnHtml: { type: "number", minimum: 0, maximum: 60 }, scanFullPage: { type: "boolean" }, captureScreenshot: { type: "boolean" }, capturePdf: { type: "boolean" },
            } },
            ignore: { ...patternList, type: ["array", "null"], description: "Replaces the list of paths that are not collected; null or an empty list removes it" },
            graphIgnore: { ...patternList, type: ["array", "null"], description: "Replaces the list of paths left out of the graph; null or an empty list removes it" },
          } }),
          responses: { "200": ok("Source updated"), ...errors(400, 401, 404, 409, 415) },
        },
        delete: {
          summary: "Remove a source",
          parameters: [idParam("Source id")],
          responses: { "200": ok("Removed", { type: "object", properties: { ok: { type: "boolean" } } }), ...errors(401, 404, 409) },
        },
      },
      "/api/sources/{id}/artifacts/{kind}": {
        get: {
          summary: "Download an artifact from the active generation",
          parameters: [idParam("Source id"), { name: "kind", in: "path", required: true, schema: { type: "string", enum: ["screenshot", "pdf"] } }],
          responses: { "200": { description: "PNG or PDF attachment" }, ...errors(401, 404) },
        },
      },
      "/api/sources/{id}/documents": {
        get: {
          summary: "List document paths in the active generation",
          description: "Returns an empty path list and null generation when the source is not prepared.",
          parameters: [idParam("Source id")],
          responses: { "200": ok("Document paths", { type: "object", properties: { source: { type: "string" }, generation: { type: ["integer", "null"] }, paths: { type: "array", items: { type: "string" } } } }), ...errors(401, 404) },
        },
      },
      "/api/sources/{id}/graph": {
        get: {
          summary: "Graph of the active generation",
          description:
            "Nodes with their page and best grounding passage, one edge per connected node pair (indexes into `nodes`), and hyperedge groups. `nodes` is empty when the source is not prepared or was prepared without a graph; `graphStatus` says which. `stats.ignoredDocuments` counts the documents the source's graphIgnore patterns kept out; they are not in `stats.missingDocuments`.",
          parameters: [idParam("Source id")],
          responses: { "200": ok("Graph view"), ...errors(401, 404) },
        },
      },
      "/api/sources/{id}/summary": {
        post: {
          summary: "Generate a collection summary",
          description: "Explicit provider call using the configured OpenAI-compatible graph provider. Returns the saved generation-bound summary, reusing it unless force is true. Reads never generate summaries. Cancel via the source cancel endpoint.",
          parameters: [idParam("Source id")],
          requestBody: jsonBody({ type: "object", additionalProperties: false, properties: { force: { type: "boolean", default: false } } }),
          responses: { "200": ok("Saved summary"), ...errors(400, 401, 404, 409, 415, 502) },
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
          summary: "Cancel a running preparation or summary",
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
