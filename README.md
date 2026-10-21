# Docify

Docify keeps documentation on disk and gives AI agents cited, token-bounded excerpts from it. Preparation (download, normalization, embeddings, Graphify semantic graph) is an explicit step. Queries are local and offline.

## Install

```bash
bun install
bun link                 # puts `docify` on PATH (~/.bun/bin)
docify setup             # pinned Graphify into ~/.cache/docify/graphify-venv, embedding model into ~/.cache/docify/models
```

`setup` is the only command that downloads models. The store lives in `~/.cache/docify` (override with `DOCIFY_HOME`), outside any plugin directory.

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
