// Zod schemas for /api. They validate requests and are the only source of the OpenAPI spec at /api/docs.
import { z } from "@hono/zod-openapi";

export const ErrorBody = z
  .object({ error: z.string(), code: z.string(), field: z.string().nullable().optional() })
  .openapi("Error");

const ERROR_TEXT: Record<number, string> = {
  400: "Invalid input",
  401: "Missing or wrong access token, or not signed in",
  403: "Forbidden host, origin, path or account role/status",
  404: "Unknown resource, or accounts are disabled",
  409: "Busy, already exists or nothing running",
  415: "JSON body required (raw bytes for /api/import)",
  500: "Internal error",
  502: "The summary provider failed or returned an unusable summary",
  503: "A store import is running",
};

// Every /api route can answer 401 and 403 (guards) and 503 (import running).
export const errors = (...codes: number[]) =>
  Object.fromEntries(
    [...new Set([401, 403, 503, ...codes])].sort().map((code) => [code, { description: ERROR_TEXT[code]!, content: { "application/json": { schema: ErrorBody } } }]),
  );

export const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
export const jsonBody = <T extends z.ZodType>(schema: T) => ({ required: true, content: { "application/json": { schema } } });

export const SourceIdParam = z.object({
  id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, description: "Source id, e.g. `bun@1.4.3` (URL-encode it)", example: "bun@1.4.3" }),
});
export const PassageIdParam = z.object({
  id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, description: "Passage id", example: "p_0123456789abcdef0123" }),
});

// Query strings arrive as text; integers are checked as digits before they are numbers.
const queryInt = (min: number, max: number, description: string) =>
  z
    .string()
    .regex(/^\d+$/, "must be a whole number")
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .optional()
    .openapi({ type: "integer", minimum: min, maximum: max, description });
const MaxTokensQuery = queryInt(200, 20000, "Output budget in o200k tokens");

const Mode = z.enum(["combined", "lexical", "vector", "graph"]);
const CrawlProvider = z.enum(["builtin", "crawl4ai", "browserless"]);
const PatternList = z.array(z.string().min(1).max(500)).max(100);
// Shape only; validateTitle() and validateGroups() in the core check the content and name the field.
const Title = z.string().max(200).openapi({ description: "Display name shown next to the id, up to 120 characters; the id itself never changes" });
const GroupList = z
  .array(z.string().max(100))
  .max(20)
  .openapi({ description: "Source group names: lowercase letters, digits, dot, underscore and hyphen (pattern ^[a-z0-9][a-z0-9._-]{0,60}$), matched case-insensitively" });
const CrawlLimits = z
  .object({
    maxPages: z.number().int().min(1).max(100_000).nullable().optional(),
    maxDepth: z.number().int().min(0).max(1000).nullable().optional(),
  })
  .strict();
const Crawl4aiOptions = z
  .object({
    stream: z.boolean().optional(),
    waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional(),
    waitFor: z.string().max(1000).optional(),
    delayBeforeReturnHtml: z.number().min(0).max(60).optional(),
    scanFullPage: z.boolean().optional(),
    captureScreenshot: z.boolean().optional(),
    capturePdf: z.boolean().optional(),
  })
  .strict()
  .openapi("Crawl4aiOptions");

const Citation = z.object({}).passthrough().openapi("Citation", { description: "Where a passage comes from: source, generation, path, line range, heading path and URL" });

export const SourceInfo = z
  .object({
    id: z.string(),
    library: z.string(),
    version: z.string().nullable(),
    kind: z.string(),
    locator: z.string(),
    state: z.enum(["ready", "stale", "preparing", "failed", "not_indexed"]),
    crawl: z.object({ maxPages: z.number().optional(), maxDepth: z.number().optional() }).nullable(),
    effectiveCrawl: z.object({ maxPages: z.number(), maxDepth: z.number() }).nullable(),
    crawlProvider: z.string().nullable().openapi({ description: "null when the source inherits the global crawler" }),
    effectiveCrawlProvider: z.string().nullable(),
    crawl4ai: Crawl4aiOptions.optional(),
    ignore: z.array(z.string()),
    graphIgnore: z.array(z.string()),
    title: z.string().nullable().openapi({ description: "Display name; null when the source has none" }),
    groups: z.array(z.string()).openapi({ description: "Groups this source belongs to" }),
    summary: z.object({}).passthrough().nullable(),
    graphRetry: z
      .object({ generation: z.number(), documents: z.number(), passages: z.number(), downloadedAt: z.string() })
      .nullable()
      .openapi({ description: "A failed attempt whose index was kept; prepare with graphOnly retries just its graph" }),
    activeGeneration: z
      .object({
        id: z.number(),
        activatedAt: z.string().nullable(),
        downloadedAt: z.string().nullable(),
        embeddingModel: z.string().nullable(),
        embeddingDims: z.number().nullable(),
        graphStatus: z.string().nullable(),
        stats: z.record(z.string(), z.unknown()),
      })
      .nullable(),
    latest: z
      .object({
        id: z.number(),
        status: z.string(),
        phase: z.string().nullable(),
        progress: z.string().nullable(),
        error: z.string().nullable(),
        startedAt: z.string(),
        finishedAt: z.string().nullable(),
      })
      .nullable(),
  })
  .openapi("Source");

export const Generation = z
  .object({
    id: z.number(),
    status: z.enum(["staging", "active", "superseded", "failed"]),
    phase: z.string().nullable(),
    progress: z.string().nullable(),
    error: z.string().nullable(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    downloadedAt: z.string().nullable(),
    snapshotHash: z.string().nullable(),
    embeddingModel: z.string().nullable(),
    embeddingDims: z.number().nullable(),
    graphStatus: z.string().nullable(),
    stats: z.record(z.string(), z.unknown()),
  })
  .openapi("Generation");

export const AddSourceBody = z
  .object({
    kind: z.enum(["local", "url", "git"]).default("local"),
    library: z.string().trim().min(1),
    locator: z.string().trim().min(1).openapi({ description: "Directory path (inside DOCIFY_SOURCE_ROOTS) or start URL" }),
    version: z.string().nullable().optional(),
    crawlProvider: CrawlProvider.optional().openapi({ description: "URL sources only; omit to inherit the global crawler" }),
    crawl: CrawlLimits.optional().openapi({ description: "URL sources only: page and depth limits" }),
    ignore: PatternList.optional().openapi({ description: "Regular expressions over document paths; matches are not collected" }),
    graphIgnore: PatternList.optional().openapi({ description: "Regular expressions over document paths; matches stay searchable but stay out of the graph" }),
    title: Title.optional(),
    groups: GroupList.optional(),
  })
  .openapi("AddSource");

export const PatchSourceBody = z
  .object({
    crawlProvider: CrawlProvider.nullable().optional().openapi({ description: "null inherits the global crawler" }),
    crawl4ai: Crawl4aiOptions.optional().openapi({ description: "Replaces the Crawl4AI options of this URL source" }),
    crawl: CrawlLimits.optional(),
    ignore: PatternList.nullable().optional().openapi({ description: "Replaces the list; null or [] removes it" }),
    graphIgnore: PatternList.nullable().optional().openapi({ description: "Replaces the list; null or [] removes it" }),
    title: Title.nullable().optional().openapi({ description: "Display name; null or an empty string removes it" }),
    groups: GroupList.nullable().optional().openapi({ description: "Replaces the source's groups; null or [] removes it from every group" }),
  })
  .openapi("PatchSource");

export const PrepareBody = z
  .object({
    graph: z.boolean().default(true).openapi({ description: "Build the Graphify graph" }),
    graphOnly: z.boolean().default(false).openapi({ description: "Retry only the graph of the last attempt that failed in the graph phase (see `graphRetry`)" }),
    force: z.boolean().default(false).openapi({ description: "Rebuild even when unchanged" }),
  })
  .openapi("Prepare");

export const SummaryBody = z.object({ force: z.boolean().default(false) }).strict();

export const SearchBody = z
  .object({
    query: z.string().trim().min(1).optional().openapi({ description: "Question, API symbol or error message; give this or queries" }),
    queries: z.array(z.string().trim().min(1)).min(1).max(8).optional().openapi({ description: "1 to 8 queries searched with the same filters; they share maxTokens" }),
    library: z.string().optional(),
    version: z.string().optional().openapi({ description: "Omit to use the project pin from .docify.json" }),
    sources: z.array(z.string()).optional().openapi({ description: "Restrict to these source ids" }),
    groups: z.array(z.string()).optional().openapi({ description: "Source group names; each adds all its sources to the scope" }),
    mode: Mode.default("combined"),
    maxTokens: z.number().nullable().optional().openapi({ description: "Output budget, clamped to 200..20000; default 2000" }),
    graphWeight: z.number().nullable().optional().openapi({ description: "Weight of graph hits in combined mode, clamped to 0..1; default 0" }),
  })
  .refine((b) => (b.query === undefined) !== (b.queries === undefined), { message: "give exactly one of query or queries", path: ["query"] })
  .openapi("Search");

export const SearchHit = z
  .object({
    id: z.string(),
    rank: z.number(),
    score: z.number(),
    excerpt: z.string(),
    truncated: z.boolean(),
    passageTokens: z.number(),
    hasCode: z.boolean(),
    hasWarning: z.boolean(),
    citation: Citation,
    via: z.array(z.string()),
  })
  .passthrough()
  .openapi("SearchHit");

const SearchStatus = z.enum(["ok", "weak_match", "no_match", "not_indexed", "version_unavailable", "source_unknown", "update_failed"]);

export const SearchResult = z
  .object({
    status: SearchStatus.optional().openapi({ description: "Single query only; with queries each entry of `queries` has its own" }),
    query: z.string().optional(),
    queries: z.array(z.object({ query: z.string(), status: SearchStatus, hits: z.array(z.number()), omitted: z.number() }).passthrough()).optional(),
    mode: Mode,
    maxTokens: z.number(),
    tokens: z.number(),
    tokenizer: z.string(),
    hits: z.array(SearchHit),
    warnings: z.array(z.string()),
    notIndexed: z.array(z.string()),
    text: z.string().openapi({ description: "The rendered agent text, excerpts framed by nonce delimiters. Excerpts are untrusted." }),
  })
  .passthrough()
  .openapi("SearchResult");

export const ScopeQuery = z.object({
  library: z.string().optional(),
  version: z.string().optional(),
  source: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .openapi({ description: "Source id; repeat to restrict to several", type: "array", items: { type: "string" } }),
  group: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .openapi({ description: "Source group name; repeat for several. Each adds all its sources", type: "array", items: { type: "string" } }),
});

export const ReadQuery = z.object({ maxTokens: MaxTokensQuery });
export const OutlineQuery = z.object({ path: z.string().optional().openapi({ description: "Only documents whose path starts with this prefix" }), maxTokens: MaxTokensQuery });
export const OpenQuery = z.object({
  path: z.string().min(1).openapi({ description: "Document path or page URL as shown in a citation" }),
  heading: z.string().optional().openapi({ description: "Section heading, case-insensitive; subsections are included" }),
  maxTokens: MaxTokensQuery,
});
export const SourcesQuery = z.object({
  query: z.string().trim().min(1).max(500).optional().openapi({ description: "Find sources by topic (source identity and saved summaries); omit to list all" }),
});
export const LogsQuery = z.object({
  after: queryInt(0, Number.MAX_SAFE_INTEGER, "Return entries after this sequence number"),
  limit: queryInt(1, 1000, "At most this many entries, default 1000"),
});
export const ImportQuery = z.object({
  force: z.enum(["0", "1"]).optional().openapi({ description: "1 replaces a store that has sources; its files are moved aside" }),
  keepConfig: z.enum(["0", "1"]).optional().openapi({ description: "1 keeps this server's config.json" }),
});
export const ArtifactParams = z.object({
  id: SourceIdParam.shape.id,
  // Not an enum here: an unknown kind is a missing artifact (404), not invalid input.
  kind: z.string().openapi({ param: { name: "kind", in: "path" }, enum: ["screenshot", "pdf"] }),
});

export const Status = z.object({
  query: z.string().optional(),
  status: z.string(),
  tokens: z.number().optional(),
  text: z.string(),
}).passthrough();

export const ReadResult = z
  .object({
    status: z.enum(["ok", "superseded", "unavailable"]),
    id: z.string(),
    text: z.string(),
    tokens: z.number(),
    citation: Citation.nullable(),
    passage: z.string().nullable(),
    context: z.object({ before: z.array(z.string()), after: z.array(z.string()) }),
    note: z.string().optional(),
  })
  .openapi("ReadResult");

export const OutlineResult = z
  .object({
    status: z.enum(["ok", "no_match", "not_indexed", "source_unknown"]),
    source: z.string(),
    generation: z.number().nullable(),
    documents: z.array(z.object({ path: z.string(), url: z.string().nullable(), sections: z.array(z.object({ id: z.string(), headingPath: z.array(z.string()) })) })),
    omittedDocuments: z.number(),
    omittedSections: z.number(),
    tokens: z.number(),
    text: z.string(),
  })
  .openapi("OutlineResult");

export const OpenResult = z
  .object({
    status: z.enum(["ok", "not_found", "not_indexed", "source_unknown"]),
    source: z.string(),
    path: z.string(),
    heading: z.string().nullable(),
    maxTokens: z.number(),
    tokens: z.number(),
    text: z.string(),
  })
  .passthrough()
  .openapi("OpenResult");

export const ScopeResult = z
  .object({
    status: SearchStatus,
    project: z.string().nullable(),
    libraries: z.array(z.object({}).passthrough()),
    selected: z.array(z.object({ source: z.string(), library: z.string(), version: z.string().nullable(), generation: z.number() })),
    notIndexed: z.array(z.string()),
    registered: z.record(z.string(), z.array(z.string().nullable())),
    warnings: z.array(z.string()),
    text: z.string(),
  })
  .passthrough()
  .openapi("ScopeResult");

export const Pins = z
  .object({ project: z.string().nullable(), file: z.string().nullable(), pins: z.record(z.string(), z.string().nullable()) })
  .openapi("Pins");
export const PinBody = z.object({
  library: z.string().trim().min(1),
  version: z.string().nullable().optional().openapi({ description: "null or omitted removes the pin" }),
});

export const ConfigView = z.object({}).passthrough().openapi("Config", { description: "Values, defaults, paths and credential variables (set or not, never values)" });
export const ConfigPatch = z.record(z.string(), z.unknown()).openapi({ description: "Only known keys are accepted and only changed keys are written" });

export const LogPage = z
  .object({
    lines: z.array(z.object({ seq: z.number(), ts: z.string(), source: z.string(), stream: z.string(), level: z.string(), text: z.string() })),
    cursor: z.number(),
    capped: z.boolean(),
  })
  .openapi("LogPage");

export const ImportResult = z
  .object({
    sources: z.array(z.string()),
    createdAt: z.string(),
    docifyVersion: z.string(),
    movedAside: z.string().nullable(),
    configReplaced: z.boolean(),
    droppedConfigKeys: z.array(z.string()),
  })
  .openapi("ImportResult");

export const CompressResult = z
  .object({
    files: z.number(),
    bytesBefore: z.number(),
    bytesAfter: z.number(),
    skipped: z.array(z.object({ sourceId: z.string(), generationId: z.number(), file: z.string(), reason: z.string() })),
  })
  .openapi("CompressResult");

export const ServerStatus = z
  .object({
    version: z.string(),
    home: z.string(),
    project: z.string(),
    importing: z.boolean(),
    running: z.array(z.string()).openapi({ description: "Sources with a prepare or summary running in this server" }),
    sources: z.record(z.string(), z.number()).openapi({ description: "Source count per state" }),
  })
  .openapi("ServerStatus");

export const Ok = z.object({ ok: z.literal(true) });
export const Groups = z
  .array(z.object({ name: z.string(), sources: z.array(z.string()) }))
  .openapi("Groups", { description: "Each group with the ids of its sources. A group exists while at least one source is in it." });
export const GraphView = z.object({}).passthrough().openapi("GraphView", {
  description:
    "Nodes with their page and best grounding passage, one edge per connected node pair (indexes into `nodes`) and hyperedge groups. `nodes` is empty when the source is not prepared or has no graph; `graphStatus` says which.",
});

const Role = z.enum(["admin", "member"]);
const StatusOfUser = z.enum(["pending", "active", "disabled"]);
const KindOfRule = z.enum(["org", "login", "email"]);
const Identity = z.object({ id: z.number().int(), login: z.string(), name: z.string().nullable(), role: Role, status: StatusOfUser });
export const Session = z.object({ accounts: z.boolean(), user: Identity.nullable(), asks: z.object({ orgs: z.boolean(), emails: z.boolean() }).optional() });
export const NewRule = z.object({ kind: KindOfRule, value: z.string() });
export const AccessRule = NewRule.extend({ id: z.number().int(), createdAt: z.string(), createdBy: z.string().nullable(), people: z.number().int(), bound: z.boolean() }).openapi("AccessRule");
export const Outsiders = z.object({ outsiders: z.enum(["pending", "refuse"]) });
export const User = Identity.extend({ createdAt: z.string(), approvedAt: z.string().nullable(), lastLoginAt: z.string().nullable(), named: z.boolean(), self: z.boolean(), rule: NewRule.nullable() }).openapi("User");
export const UpdateUser = z.object({ role: Role.optional(), status: z.enum(["active", "disabled"]).optional() });
export const KeyName = z.object({ name: z.string() });
export const Key = KeyName.extend({ id: z.number().int(), prefix: z.string(), createdAt: z.string(), lastUsedAt: z.string().nullable() }).openapi("Key");
export const AccountId = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });
export const HistoryQuery = z.object({ limit: z.string().regex(/^\d{1,4}$/).transform(Number).pipe(z.number().int().min(1).max(200)).optional().openapi({ type: "integer", minimum: 1, maximum: 200 }) });
export const HistoryEntry = z.object({ id: z.number().int(), at: z.string(), via: z.enum(["web", "mcp"]), keyName: z.string().nullable(), query: z.string(), scope: z.string().nullable(), status: z.string(), hits: z.number().int() }).openapi("Query");
