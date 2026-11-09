# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Docify keeps documentation on disk and gives AI agents cited, token-bounded excerpts from it. Preparing a source (download, normalize, embed, optional Graphify graph) is an explicit step; queries are local and must stay side-effect free. `docs/design.md` is the contract, `docs/evaluation.md` holds the measurements behind the tuning, `docs/verification.md` records what was checked and how.

## Commands

```bash
bun install
bun test                              # whole suite
bun test tests/search.test.ts         # one file
bun test -t "budget"                  # tests whose name matches
bun run typecheck                     # tsc --noEmit -p .
bun src/cli.ts <command>              # the CLI without `bun link` (add, prepare, search, read, sources, pin, serve, mcp, setup)
bun scripts/eval.ts                   # retrieval evaluation; needs the fixture sources prepared in the store
bun scripts/mcp-smoke.ts              # drives the MCP server over stdio
bun scripts/release.ts <patch|minor|major|X.Y.Z> [--dry-run]   # bump the shared version, changelog, commit and tag; no push
make                                  # lists the Makefile shortcuts (check, app, app-run, clean, ...)
make app-run                          # builds and opens the macOS app with this checkout's CLI
```

Most tests use the real `Xenova/bge-small-en-v1.5` model from the store's `models/` (put there by `docify setup`), or from `DOCIFY_MODELS_DIR`. Without it about 13 tests fail with `ModelNotPreparedError`; that is a missing model, not a regression. Tests use no network and no LLM: each one builds a store in a temp dir (`newDocify(tempDir())` in `tests/helpers.ts`) and passes `fakeGraph` as the graph runner. `tests/process.test.ts` spawns `tests/helpers/prepare-child.ts` to test locks, SIGKILL recovery and readers across processes.

`index.ts` is the leftover starter greeting. The entry point is `src/cli.ts` (`bin` in package.json).

## Architecture

One core, thin adapters. `src/core/docify.ts` (class `Docify`: sources, preparation, generations, locks) and `src/core/search.ts` (`search`, `read`, `sources`) hold all logic. `src/cli.ts`, `src/mcp/` and `src/web/server.ts` only parse input and call them; the macOS app in turn only runs the CLI. The MCP server exposes queries only (`docs_search`, `docs_read`, `docs_sources`); preparation stays in the CLI and the web UI.

**MCP and HTTP layers.** `src/mcp/tools.ts` defines the tools over the core; `stdio.ts` (`docify mcp`) and `http.ts` (stateless Streamable HTTP, one server per POST) are transports with no logic of their own. `src/http/` holds framework-free guards, each `(req, ctx) => Response | null`, joined by `chain()`: `host.ts` (Host and Origin), `auth.ts` (bearer tokens from `DOCIFY_MCP_TOKENS`, compared as SHA-256 digests in constant time), `rate-limit.ts` (in-memory token bucket) and `client-ip.ts`. They know nothing about Docify. `src/web/server.ts` reads the environment once and composes `/mcp` as host, IP limit, auth, client limit, handler; keep that order, the IP limit before auth is what slows token guessing. Without MCP tokens `/mcp` is 404. The web UI token and MCP tokens are separate.

**Store** (`~/.config/docify`, or `DOCIFY_HOME`; `docifyHome()` falls back to a store left in `~/.cache/docify` while `~/.config/docify` does not exist, and `Settings.swift` mirrors it): `docify.sqlite` (WAL, schema in `src/core/db.ts`), `snapshots/<source>/<generation>/` with `raw/`, `normalized/` and `graph.json`, and `config.json`. `loadConfig()` spreads `config.json` over the defaults shallowly, so a partial `graph` object replaces the whole default graph provider.

**Generations.** Every prepare builds a new generation in `staging` and only an immediate transaction at the end makes it `active` (the previous one becomes `superseded`). Any failure or cancel leaves the previous generation serving and the source reads as `stale`. Writers hold a per-source lease (`lock_pid`, `lock_at`, heartbeat 10 s, dead after 60 s); `recoverInterrupted()` marks staging generations of dead writers `failed`. Old superseded generations are deleted beyond `keepGenerations`.

**Prepare pipeline** (`Docify.prepare`): collect (`collect.ts`: local files with symlinks followed only inside the root, or a crawl limited to the start URL's origin and path with redirects checked by hand) → skip as `unchanged` when snapshot hash, `PIPELINE_VERSION`, graph status and embedding identity all match → normalize (`normalize.ts`: MDX and Markdoc are rewritten line for line so normalized line ranges equal raw ones; HTML becomes Markdown) → chunk (`chunk.ts`: heading sections up to 700 tokens, a code fence is never cut) → passages and FTS5 rows → embeddings → optional Graphify graph (`graph.ts`, a pinned Python CLI in a uv venv from `tools/graphify`, LLM reached through the LiteLLM variables) → validate counts → activate. Phases are separated by checkpoints that honour the cancel signal.

- URL sources are fetched by `crawl()` in `collect.ts` either directly (`crawlProvider: "builtin"`, the default) or through a Crawl4AI server (`"crawl4ai"`, `crawl4ai.ts`): a `Fetcher` that renders one URL per `POST /crawl` and turns the result back into a `Response`, so scope, redirect, depth and size rules stay in `crawl()`. Malformed responses and service errors throw; there is no fallback to the built-in crawler. The cancel signal aborts the request in flight.

- Graphify exits 0 when a chunk fails or the model leaves files out, and writes a graph of the rest. That graph activates as `graph_status = 'partial'` with the uncovered paths in `stats.graphMissing`; search uses it, and `partial` never counts as `unchanged`, so the next prepare retries the gaps from Graphify's cache. Throwing on those warnings instead failed the whole prepare, passages and vectors included. A graph with no grounded nodes still fails.

- Bump `PIPELINE_VERSION` (`docify.ts`) when normalization, chunking or indexing output changes, so unchanged sources are rebuilt. Bump `SCHEMA_VERSION` (`db.ts`) for schema changes; an old store then refuses to open.
- Passage ids are `p_` plus a hash of source, generation, snapshot, path, lines and content, so every generation has new ids. `read()` of an old id returns that snapshot marked `superseded`, then `unavailable` after cleanup. Never make an old id resolve to newer text.
- Unknown library versions stay `null`; `downloaded_at` is separate.

**Search** (`search.ts`): `resolveScope` applies library, version and source filters and project pins from `.docify.json` → modes `lexical` (FTS5 BM25 plus exact dotted-symbol matches, `symbols.ts`), `vector` (cosine over cached generation vectors, only for generations whose embedding identity matches the current config), `graph` (seeds from the query and top passages, one hop) and `combined` (reciprocal rank fusion; graph weight defaults to 0 because it lowered recall) → evidence gate (term coverage, per-model `strongVectorSim` / `weakVectorSim`, a named symbol absent from scope) → `finalize` renders the agent text and enforces `max_tokens` on that text, dropping lower hits and then warnings until the count holds. All token counts use js-tiktoken `o200k_base` (`tokens.ts`).

The statuses `ok`, `weak_match`, `no_match`, `not_indexed`, `version_unavailable`, `source_unknown` and `update_failed` are distinct on purpose; the agent skill tells agents how to react to each. Excerpts are untrusted data: they are framed by delimiters with a per-response nonce so a document cannot close its own frame and forge status lines.

**Embeddings** (`embed.ts`): `transformers` runs in process and only `docify setup` may download models; `ollama` calls a server (`embeddingUrl`); `openai` calls any OpenAI-compatible `/v1/embeddings` server such as a remote LiteLLM, with the base URL and key read from the environment variables named by `embeddingBaseUrlEnv` and `embeddingApiKeyEnv`. Server requests are split and shortened when the server rejects them as too large, and `openai` requests have a timeout and take the prepare cancel signal. Each generation records the provider and model (`ollama:bge-m3`, `openai:<model>`), and search skips vector mode for generations prepared with another one.

**Web UI** (`src/web/`): Svelte 5 components styled with Tailwind v4, tailwind-variants (`lib/ui.ts`) and tailwind-merge. `bundle.ts` builds `index.html` in memory with `Bun.build` on the first page request. The Svelte and Tailwind plugins are passed in code because Bun reads `bunfig.toml` from the current directory, and `app.css` lists its sources with `@source` because Tailwind would otherwise scan the current directory; `docify serve` runs from anywhere. `server.ts` serves the page on 127.0.0.1 with a CSP. Each start creates a token that is only in the URL fragment and required on `/api`; Host, Origin and JSON content type are checked, and local sources must be inside the home directory.

Settings go through `/api/config`: `validateConfigPatch()` and `saveConfig()` in `config.ts` accept only known keys, write only the changed ones (unknown keys in `config.json` survive) and refuse while this process prepares a source (`Docify.saveConfig`). `graphifyBin`, `modelsDir` and `home` are read-only there because Docify runs or loads code from them. Credential variables are reported as set or not set, never with a value. `/api/pins` edits the nearest `.docify.json` above the directory `docify serve` started in. The bge-m3 preset in `views/Settings.svelte` mirrors `Settings.swift`.

**macOS app** (`apps/macos`, SwiftUI, built with `swift build`): no logic of its own. Every action runs the `docify` CLI (`DOCIFY_BIN`, default `~/.bun/bin/docify`) and the table reads `sources --json`, so it shares the store and the locks. Settings edit `config.json` as a plain dictionary so unknown keys survive, keep the LiteLLM key in the Keychain and pass it to the CLI as environment variables. The defaults in `Settings.swift` mirror `loadConfig()`; change them together. `~/.bun/bin/docify` points at whichever checkout ran `bun link`, so to try new CLI behaviour in the app set `DOCIFY_BIN` (`make app-run` does).

**Agent integrations** (`integrations/claude-code`, `integrations/codex`): separate plugin packaging with the same skill text, both running `docify mcp`. Install commands are in README.md.

## Rules that are easy to break

- Queries never fetch sources, download models or call the graph provider. The only exception is an embedding server the user configured in `config.json`.
- API keys found in the environment do not authorize remote processing or spending. `config.json` holds names of environment variables, never secret values.
- Readers must never see a mix of generations; keep activation in one transaction.
- Build snapshot paths from `config.home`, never from the stored `snapshot_dir`, so a moved store keeps working and never deletes at its old path.
- Thresholds and fusion weights come from `docs/evaluation.md`. Change them with a measurement, not by feel.
- Docify and both plugins share one version (`src/version.ts` reads `package.json`). Change it only with `scripts/release.ts`; a new manifest or MCP config under `integrations/` goes into its `VERSION_FILES`.

## Bun

Use Bun throughout: `bun <file>`, `bun test`, `bun install`, `bun run`, `bunx`. Bun loads `.env` itself, so no dotenv. Use `bun:sqlite`, `Bun.serve`, `Bun.build` (the web UI, see `src/web/bundle.ts`) and `Bun.$`; not express, better-sqlite3, vite or execa. The core uses `node:fs` sync calls for store files, and that is fine.
