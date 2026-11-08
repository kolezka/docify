# Docify

Docify keeps documentation on disk and gives AI agents cited, token-bounded excerpts from it. Preparation (download, normalization, embeddings, Graphify semantic graph) is an explicit step. Queries are local and offline, unless you point embeddings at an Ollama server on another machine (see Embeddings).

## Install

```bash
bun install
bun link                 # puts `docify` on PATH (~/.bun/bin)
docify setup             # pinned Graphify into ~/.cache/docify/graphify-venv, embedding model into ~/.cache/docify/models
```

`setup` is the only command that downloads models. The store lives in `~/.cache/docify` (override with `DOCIFY_HOME`), outside any plugin directory.

`make` lists shortcuts for these and the other commands below: `make check` type-checks and tests, `make app-run` builds and opens the macOS app with this checkout's CLI.

## Embeddings

The default is `Xenova/bge-small-en-v1.5` in process, with no server. For multilingual or larger corpora, docify can embed with `bge-m3` on an Ollama server instead:

```bash
docker compose up -d     # Ollama on 127.0.0.1:11434, pulls bge-m3 (about 1.5 GB the first time)
```

Then put this in `~/.cache/docify/config.json` and run `docify setup` (it checks the server) and `docify prepare` for each source:

```json
{
  "embeddingProvider": "ollama",
  "embeddingModel": "bge-m3",
  "embeddingDims": 1024,
  "embeddingQueryPrefix": "",
  "strongVectorSim": 0.58,
  "weakVectorSim": 0.48
}
```

`embeddingUrl` (or `DOCIFY_EMBED_URL`) points at another Ollama server. With a server on another machine, every search embeds its query over the network, so queries are no longer offline. The similarity thresholds are per model: bge-m3 scores about 0.08 lower than bge-small, and the bge-small defaults turned a must-pass question into `no_match` (`docs/evaluation.md`). Each generation records the provider and model (`ollama:bge-m3`); after a switch, search skips vector mode for sources prepared with the other model until they are prepared again.

Any OpenAI-compatible `/v1/embeddings` server works too, such as a remote LiteLLM proxy. `config.json` holds only the names of the variables with the base URL and API key (by default the same `LITELLM_BASE_URL` and `LITELLM_API_KEY` the graph uses), never the values:

```json
{
  "embeddingProvider": "openai",
  "embeddingModel": "text-embedding-3-small",
  "embeddingDims": 1536,
  "embeddingQueryPrefix": ""
}
```

`/v1` is added to the base URL unless it already ends with it. Every search then sends the query text to that server. The similarity thresholds have not been measured for remote models, so check `strongVectorSim` and `weakVectorSim` on your own questions before trusting `no_match`.

## macOS app

`apps/macos` is a small SwiftUI window for sources (add, prepare, cancel, remove) and provider settings. See `apps/macos/README.md`.

## Prepare documentation

```bash
docify add bun ./docs/bun --version 1.4.3          # local Markdown, MDX or HTML file or directory
docify add mylib https://example.com/docs/ --version 2.1   # bounded same-origin, same-path crawl of static pages
docify prepare bun@1.4.3                             # add --no-graph to skip semantic extraction, --force to rebuild
docify pin bun 1.4.3                                 # writes ./.docify.json for this project
```

Unknown versions stay `unknown`; `downloaded_at` is recorded separately. Each prepare builds a new generation in staging and activates it atomically. A failed or interrupted prepare keeps the previous generation and marks the source `stale`.

Graph extraction calls an LLM. The default provider is the LiteLLM proxy named by `LITELLM_BASE_URL` and `LITELLM_API_KEY`, model `deepseek/deepseek-flash-nothink`, passed to Graphify only for that subprocess. Change it in `~/.cache/docify/config.json` (`graph`), or set `"graph": null` to disable it.

## Query

```bash
docify search "keep WAL sidecar files after close" --library bun --max-tokens 1500
docify read p_0123456789abcdef0123
docify sources
docify serve             # one-screen UI; open the printed http://127.0.0.1:4747/#token=... URL
docify mcp               # MCP server on stdio: docs_search, docs_read, docs_sources
```

Search statuses: `ok`, `weak_match` (hits with a low-confidence warning), `no_match`, `not_indexed`, `version_unavailable`, `source_unknown`, `update_failed`. Modes: `combined` (default: lexical, vector and exact-symbol fusion), `lexical`, `vector`, `graph`. `--graph-weight` adds graph hits to combined fusion; it defaults to 0 because it lowered recall on the evaluation corpus (`docs/evaluation.md`).

## Agent clients

Claude Code:

```bash
claude plugin marketplace add ./integrations/claude-code
claude plugin install docify@docify-local
# remove: claude plugin uninstall docify@docify-local && claude plugin marketplace remove docify-local
```

Codex:

```bash
codex plugin marketplace add ./integrations/codex
codex plugin add docify@docify-local
# remove: codex plugin remove docify@docify-local && codex plugin marketplace remove docify-local
```

Both plugins start `docify mcp`, so `docify` must be on PATH. They ship a skill that tells the agent when to search and how to read statuses. Neither installs hooks, and neither forces the agent to search.

## Development

```bash
bun test                       # invariant tests (no network, no LLM)
bunx tsc --noEmit -p .
bun scripts/eval.ts            # retrieval evaluation against the prepared store
bun scripts/mcp-smoke.ts       # drives the MCP server over stdio
```

Design and status: `docs/design.md`, `docs/implementation-plan.md`, `docs/feasibility.md`, `docs/evaluation.md`, `docs/verification.md`.
