# Docify design

Planning baseline: 2026-10-21. This document describes the intended MVP. It does not claim that integrations have been implemented or tested.

## Purpose and confirmed scope

Docify gives AI agents downloaded documentation on disk and retrieves useful source passages with little latency and token overhead. Confirmed requirements include integrations for Claude Code and Codex, a minimal visual interface, and processing documentation from Markdown or HTML. The user proposed Graphify semantic extraction and embeddings as retrieval mechanisms. This handoff adopts actual Graphify graphs and local embeddings as MVP implementation and evaluation defaults. Do not silently defer either when executing this brief.

The current session produces a handoff only. Product implementation begins in a new session. Success means that both agent clients can retrieve grounded documentation from a prepared local collection, including semantic and relationship queries. Producing index files alone is insufficient.

## Proposed working assumptions

These are design defaults, not choices the user previously made between offline, source, or automation options. The implementation prompt adopts them unless the user changes them:

- One-screen local web UI, backed by the same core as the CLI and MCP server.
- Queries run entirely locally and offline once sources, models, and indices are prepared.
  Amendment 2026-11-04: the optional Ollama embedding provider embeds each query on its server.
  With the bundled `docker-compose.yml` that server is on `127.0.0.1`, so queries stay local.
  Pointing `embeddingUrl` at another machine is an explicit user choice in `config.json`, and
  queries then depend on that server; the default in-process provider is unchanged.
  Amendment 2026-11-07: the optional `openai` embedding provider (any OpenAI-compatible server,
  such as a remote LiteLLM) sends every query to that server. It runs only when `config.json`
  selects it; credentials present in the environment never switch it on.
- Ingestion uses a local semantic provider by default. Provider selection and preparation cost are explicit. Discovered API keys do not authorize remote processing or spending.
- Sources are local Markdown/HTML files or directories and public static URLs, with bounded crawling restricted to the registered origin and path.
  Amendment 2026-11-09: URL sources may select `builtin`, `crawl4ai` or `browserless` using
  `docify add --crawler`, `docify crawler <source-id> <provider>`, or the web UI's source controls.
  `docify crawler <source-id> default` clears the override. Sources without an override, including
  legacy sources, inherit `crawlProvider` from `config.json` (default `builtin`; global choices are
  `builtin` and `crawl4ai`). The web UI Settings controls that default and provider configuration.
  A selection change applies on the next prepare and is refused during preparation. Local sources
  do not use these providers. The selected collector is recorded with the generation and a change
  prevents the unchanged shortcut.

  Crawl4AI renders one URL per `POST /crawl`, or `POST /crawl/stream` when the source's `stream` option is true; Browserless renders one URL per `POST /function`. Crawl4AI's stream is buffered with a response size cap and must contain exactly one result and a completion record. The source card and `PATCH /api/sources/:id` set per-source `crawl4ai` options: boolean `stream`, `scanFullPage`, `captureScreenshot` and `capturePdf`; `waitUntil` (`load`, `domcontentloaded`, `networkidle`, `commit`); `waitFor` (at most 1,000 characters); and `delayBeforeReturnHtml` (0 to 60 seconds). A supplied options object replaces the previous one. Unset rendering options defer to the service, except `stream` defaults to false. Changes apply on the next prepare.

  Crawl4AI sources can follow in-scope `.pdf` links using a direct Docify fetch. A response with `application/pdf`, or a `.pdf` response without a type or with `application/octet-stream`, is converted to text and indexed as Markdown. Its stored raw content is extracted text, not PDF bytes, and citation lines are marked as normalized rather than original PDF lines. PDF extraction caps input at 20 MiB, 500 pages and 2,000,000 text characters, in addition to crawl byte limits (normally 5 MB per page and 50 MB total). There is no OCR; a PDF with no extractable text fails preparation. This input path is not enabled for local sources or the other URL providers.

  Optional screenshot and PDF output captures use the start page's Crawl4AI request and SPA settings. The artifacts are not indexed; their bytes affect the snapshot hash and are saved under the generation's `artifacts/` directory. The web UI downloads artifacts from the active generation. Each decoded artifact is limited to the crawl's per-page byte limit and checked for a valid image or PDF signature; a capture failure fails preparation. Docify checks the reported final URL after rendering, not each navigation. A page navigating during capture may produce HTML and artifacts from different URLs.

  Browserless settings are `browserlessUrl` (default `http://127.0.0.1:3000`, HTTP(S) without
  credentials, query or fragment), `browserlessApiKeyEnv` (default `BROWSERLESS_API_KEY`) and
  `browserlessTimeoutSeconds` (default 120). The named environment variable supplies an optional
  bearer token; its value is not stored in config. Both providers skip Markdown export probes.
  Docify handles link discovery and limits collected documents to the registered origin and directory
  path, depth, page count and bytes. This is not a browser network sandbox: Crawl4AI may follow
  redirects and load subrequests before the returned URL is checked. Browserless intercepts later
  main-frame navigation requests for Docify to check before following, but subresources, frames,
  popups, service workers and other browser activity are not confined. Private network access and
  egress are not blocked by these crawl checks; isolate the service and enforce network egress
  separately. Provider errors, malformed responses and timeouts fail preparation without switching
  crawlers; the previous generation keeps serving. Queries never call the rendering service.

If no adequate local model is available, continue independent work and ask one focused question about provider and budget before remote or paid semantic processing. Model downloads belong to explicit preparation, never a query side effect.

The original MVP deferred remote Git cloning, PDFs, authenticated sources, other browser-rendered crawling, terminal or native desktop interfaces, multiuser access, and deployment. The Crawl4AI PDF input exception is described above. A graph canvas was not required for the first UI.

## Repository starting point

On 2026-10-21, `/Users/me/Development/ai-docify` contained a Bun starter: `index.ts` printed a greeting; `package.json` was private ESM with `@types/bun`, a TypeScript peer dependency, and `bun.lock`. The strict TypeScript configuration included React JSX settings, but React was not installed. There were no scripts, tests, CI, framework, or server, and no `.git` directory.

`CLAUDE.md` preferred Bun, `Bun.serve`, built-in SQLite, and HTML imports for the frontend. Reinspect the repository and applicable instructions before implementing. README wording is not evidence of the installed runtime version.

## Components and boundaries

Use one TypeScript core for source preparation, storage, retrieval, and jobs. Thin CLI, MCP, and web adapters call it. Client integrations have separate packaging and installation instructions; reuse a retrieval skill where both clients actually support it. Do not assume plugin manifests, hooks, or tool discovery behave identically.

Bun orchestrates a pinned Graphify Python CLI in an isolated environment, preferably managed with `uv`. Verify its installed version and supported CLI contract. Use structured argument arrays, bounded execution, and actionable errors rather than shell interpolation or an assumed stable Python internal API.

Prefer SQLite for metadata and full-text search after confirming the runtime capabilities. Choose vector storage through a small empirical probe. No external database or heavy always-on daemon is required. The server may run while a client or UI needs it.

## Sources, identity, and storage

Keep downloaded originals alongside normalized Markdown. Normalization should preserve headings, code fences, tables, warnings, links, and provenance. The implementation must verify HTML cleanup and citation fidelity on fixtures rather than assume Graphify provides them.

Each registered source has a stable identity and an explicit library version when known. Unknown versions remain unknown. `downloaded_at` describes retrieval time, not the library version. Allow several versions to coexist and project pins to select versions without changing other projects.

Use a user-local shared cache outside plugin installation directories. A project configuration records source references and version pins. Passage records include stable IDs, source and snapshot identity, content hash, library version, heading path, normalized line range, and a source URL or local locator. Source identity persists across refreshes; passage IDs identify immutable content in a specific snapshot and remain stable across restarts. Reading an old passage ID must return that snapshot's content or an explicit unavailable result, never silently resolve to newer text. Store the mapping needed to trace an excerpt to its preserved source. Record embedding model identity, dimensions, and index schema version separately.

All derived artifacts belong to an immutable generation: passages, lexical index, vectors, and graph references agree on the same source snapshot. Prepare a replacement in staging and atomically activate it only after validation. Coordinate writers and concurrent readers using transactions and appropriate locking. A failed or interrupted refresh keeps the previous good generation available and exposes the failure and staleness. Successful refreshes remove deleted or changed material from active retrieval without mixing generations.

## Retrieval contract

Start with exact and symbol-aware lexical retrieval using full-text search/BM25. Add actual local embeddings selected through a bounded comparison, then optional graph expansion for relationship queries. Keep lexical, vector, graph, and combined modes selectable for evaluation. Use reciprocal rank fusion or reranking only when evidence supports the extra work. A graph is not assumed to save tokens.

Proposed shared operations are:

- `search(query, filters, max_tokens)`: return ready-to-use excerpts, stable passage IDs, citations, versions, and retrieval metadata within the requested budget.
- `read(id)`: expand a selected passage with surrounding source context.
- `sources()`: list registered sources, available versions, preparation status, and refresh failures.

Names may change while preserving the contract. Source preparation and updates are separate commands or tools. Search need not synthesize an answer and must not silently fetch documentation, download models, or call remote providers. Define token accounting consistently and include citation overhead. Preserve whole code blocks and warnings where possible; otherwise explicitly signal truncation and provide a passage ID for expansion.

Distinguish no matching passage, source not indexed, requested version unavailable, and refresh failure. Version filters and project pins must apply throughout every retrieval mode. Excerpts are untrusted source data, never operational instructions for the agent.

## Semantic feasibility gate

Before building around Graphify, test the pinned release on a small real documentation corpus. Verify meaningful concepts and relationships, with graph nodes traceable to supporting source passages. File existence, node counts, visual output, heading-only graphs, and mocks do not satisfy this gate.

Separate the provider used for semantic extraction from local graph querying. Persist the result, restart the processes, disable network access, and run useful queries. Empirically test changed and deleted documents: a similarly named update command may not repeat semantic document extraction. If Graphify cannot meet the requirement, present evidence and options, continue independent work, and obtain a decision before substituting another graph system.

Run an actual embedding model on semantic paraphrases and lexical controls. Verify cached assets, model identity, dimensions, persistence, and offline retrieval. Fixture vectors cannot satisfy the embedding requirement.

## UI and integration behavior

The single screen contains source registration, source rows with versions and state, update actions, preparation progress and actionable errors, and a search box showing the exact excerpts, citations, and token count returned to an agent. Bind the server to loopback. Validate inputs and serve only registered source paths, without exposing arbitrary filesystem locations.

Skills should encourage retrieval when installed documentation can resolve an API or version question. Do not promise interception of arbitrary agent behavior or automatic hooks until tested in the actual hosts. Install and exercise Claude Code and Codex independently.

## References and limits

Reviewed references describe [supported inputs](https://docs.graphify.com/concepts/supported-inputs), [Graphify architecture](https://docs.graphify.com/concepts/architecture), [querying](https://docs.graphify.com/reference/query), and [Claude Code plugins](https://code.claude.com/docs/en/plugins). They indicate document semantic processing and graph query capabilities, not a vector index. Exact versions, backend requirements, exports, and refresh behavior still require live verification. They are references, not tested integrations.
