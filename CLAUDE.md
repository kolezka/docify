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
```

Most tests use the real `Xenova/bge-small-en-v1.5` model from `~/.cache/docify/models` (put there by `docify setup`), or from `DOCIFY_MODELS_DIR`. Without it about 13 tests fail with `ModelNotPreparedError`; that is a missing model, not a regression. Tests use no network and no LLM: each one builds a store in a temp dir (`newDocify(tempDir())` in `tests/helpers.ts`) and passes `fakeGraph` as the graph runner. `tests/process.test.ts` spawns `tests/helpers/prepare-child.ts` to test locks, SIGKILL recovery and readers across processes.

`index.ts` is the leftover starter greeting. The entry point is `src/cli.ts` (`bin` in package.json).

## Architecture

One core, thin adapters. `src/core/docify.ts` (class `Docify`: sources, preparation, generations, locks) and `src/core/search.ts` (`search`, `read`, `sources`) hold all logic. `src/cli.ts`, `src/mcp.ts` and `src/web/server.ts` only parse input and call them. The MCP server exposes queries only (`docs_search`, `docs_read`, `docs_sources`); preparation stays in the CLI and the web UI.

**Store** (`~/.cache/docify`, or `DOCIFY_HOME`): `docify.sqlite` (WAL, schema in `src/core/db.ts`), `snapshots/<source>/<generation>/` with `raw/`, `normalized/` and `graph.json`, and `config.json`. `loadConfig()` spreads `config.json` over the defaults shallowly, so a partial `graph` object replaces the whole default graph provider.

**Generations.** Every prepare builds a new generation in `staging` and only an immediate transaction at the end makes it `active` (the previous one becomes `superseded`). Any failure or cancel leaves the previous generation serving and the source reads as `stale`. Writers hold a per-source lease (`lock_pid`, `lock_at`, heartbeat 10 s, dead after 60 s); `recoverInterrupted()` marks staging generations of dead writers `failed`. Old superseded generations are deleted beyond `keepGenerations`.

**Prepare pipeline** (`Docify.prepare`): collect (`collect.ts`: local files with symlinks followed only inside the root, or a crawl limited to the start URL's origin and path with redirects checked by hand) → skip as `unchanged` when snapshot hash, `PIPELINE_VERSION`, graph status and embedding identity all match → normalize (`normalize.ts`: MDX and Markdoc are rewritten line for line so normalized line ranges equal raw ones; HTML becomes Markdown) → chunk (`chunk.ts`: heading sections up to 700 tokens, a code fence is never cut) → passages and FTS5 rows → embeddings → optional Graphify graph (`graph.ts`, a pinned Python CLI in a uv venv from `tools/graphify`, LLM reached through the LiteLLM variables) → validate counts → activate. Phases are separated by checkpoints that honour the cancel signal.

- Bump `PIPELINE_VERSION` (`docify.ts`) when normalization, chunking or indexing output changes, so unchanged sources are rebuilt. Bump `SCHEMA_VERSION` (`db.ts`) for schema changes; an old store then refuses to open.
- Passage ids are `p_` plus a hash of source, generation, snapshot, path, lines and content, so every generation has new ids. `read()` of an old id returns that snapshot marked `superseded`, then `unavailable` after cleanup. Never make an old id resolve to newer text.
- Unknown library versions stay `null`; `downloaded_at` is separate.

**Search** (`search.ts`): `resolveScope` applies library, version and source filters and project pins from `.docify.json` → modes `lexical` (FTS5 BM25 plus exact dotted-symbol matches, `symbols.ts`), `vector` (cosine over cached generation vectors, only for generations whose embedding identity matches the current config), `graph` (seeds from the query and top passages, one hop) and `combined` (reciprocal rank fusion; graph weight defaults to 0 because it lowered recall) → evidence gate (term coverage, per-model `strongVectorSim` / `weakVectorSim`, a named symbol absent from scope) → `finalize` renders the agent text and enforces `max_tokens` on that text, dropping lower hits and then warnings until the count holds. All token counts use js-tiktoken `o200k_base` (`tokens.ts`).

The statuses `ok`, `weak_match`, `no_match`, `not_indexed`, `version_unavailable`, `source_unknown` and `update_failed` are distinct on purpose; the agent skill tells agents how to react to each. Excerpts are untrusted data: they are framed by delimiters with a per-response nonce so a document cannot close its own frame and forge status lines.

**Embeddings** (`embed.ts`): `transformers` runs in process and only `docify setup` may download models; `ollama` calls a server (`embeddingUrl`). Each generation records the provider and model (`ollama:bge-m3`), and search skips vector mode for generations prepared with another one.

**Web UI** (`src/web/`): `Bun.serve` on 127.0.0.1 with an HTML import. Each start creates a token that is only in the URL fragment and required on `/api`; Host, Origin and JSON content type are checked, and local sources must be inside the home directory.

**Agent integrations** (`integrations/claude-code`, `integrations/codex`): separate plugin packaging with the same skill text, both running `docify mcp`. Install commands are in README.md.

## Rules that are easy to break

- Queries never fetch sources, download models or call the graph provider. The only exception is an embedding server the user configured in `config.json`.
- API keys found in the environment do not authorize remote processing or spending. `config.json` holds names of environment variables, never secret values.
- Readers must never see a mix of generations; keep activation in one transaction.
- Thresholds and fusion weights come from `docs/evaluation.md`. Change them with a measurement, not by feel.

## Bun

Use Bun throughout: `bun <file>`, `bun test`, `bun install`, `bun run`, `bunx`. Bun loads `.env` itself, so no dotenv. Use `bun:sqlite`, `Bun.serve` (with HTML imports for the frontend) and `Bun.$`; not express, better-sqlite3, vite or execa. The core uses `node:fs` sync calls for store files, and that is fine.
