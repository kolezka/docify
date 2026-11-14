<p align="center">
  <img src="assets/icon.svg" alt="Docify" width="128" height="128">
</p>

<h1 align="center">Docify</h1>

<p align="center">
  <strong>The docs your AI agent should have read, on your disk, with citations.</strong>
</p>

<p align="center">
  Local documentation search for Claude Code, Codex and any MCP client.<br>
  Version-aware. Token-bounded. Offline at query time.
</p>

---

Coding agents answer API questions from memory. Memory is a blend of every version they saw in training, so you get options that were renamed, flags from the wrong release and confident answers with nothing behind them.

Docify fixes that at the source. You point it at the documentation you actually use, it prepares a local index once, and from then on your agent searches those docs before it answers. Every excerpt comes back with a passage id, the document and heading it came from, and the library version, so you can check it yourself.

## What you get

**Answers grounded in your exact versions.** Register `bun@1.4.3` and `bun@1.2.0` side by side. Pin a version per project in `.docify.json` and the agent searches that version, not whichever one it remembers.

**Citations you can verify.** Each hit points to `library@version, document > heading` and a stable passage id. The agent can expand any id to the surrounding text or open the whole section.

**A token budget it respects.** Ask for 1,500 tokens and you get at most 1,500 tokens. Lower-ranked hits are dropped first, and a shortened excerpt says so and points to the full passage.

**Honest about what it does not know.** Search tells the agent the difference between "found it", "found something weak", "not in these docs", "this version is not indexed" and "the last update failed". The bundled skill tells the agent how to act on each one, so a miss turns into "the docs don't cover this" instead of a guess.

**Fast and local.** Queries run against SQLite on your machine. No network, no model download and no LLM call at query time with the default setup. The p95 search latency on the evaluation corpus is about 12 ms.

**Safe with untrusted pages.** Documentation is treated as data. Excerpts are framed with a per-response nonce, so a page cannot fake its own status line or slip instructions to the agent.

## How it works

```
  add            prepare                         search / read / open
  ───            ───────                         ────────────────────
  local files    collect → normalize → chunk     lexical (BM25 + exact symbols)
  or a URL   →   → embed → optional graph    →   + vector similarity
                 → activate atomically           → fused, budgeted, cited
```

1. **Add** a source: a folder of Markdown, MDX or HTML, or a docs URL (including `llms.txt` indexes). JavaScript-heavy sites can be rendered through Crawl4AI or Browserless.
2. **Prepare** it once. Docify snapshots the pages, splits them by heading, builds full-text and vector indexes and, if you want, a semantic graph with Graphify. The new version goes live in one transaction. If anything fails, the previous one keeps serving.
3. **Search** from the agent, the CLI or the web UI. Hybrid retrieval combines word matches, exact API symbols and embeddings, then fits the result into your token budget.

URL collection stops if the total downloaded document content exceeds `maxTotalMb` megabytes (1 MB is 1,000,000 bytes). Set it in Settings > Web Crawling > Max total size, or set `"maxTotalMb": 100` in `~/.config/docify/config.json`. The default is 50 MB; whole numbers from 1 to 1000 are accepted. A `maxTotalBytes` value left in an older `config.json` is still read, rounded up to whole megabytes, until `maxTotalMb` is set. Higher limits can increase memory use. The change applies to the next preparation; restart the server after editing the file directly.

## Quick start

You need [Bun](https://bun.sh) and [uv](https://docs.astral.sh/uv/) (setup uses it to install the pinned Graphify runtime).

```bash
bun install && bun link        # puts `docify` on your PATH
docify setup                   # installs Graphify and the embedding model; the only step that downloads them

docify add mylib https://docs.example.com/llms.txt --version 2.1   # or a local folder
docify prepare mylib@2.1 --no-graph
docify search "how do I configure retries" --library mylib
```

Connect your agent:

```bash
# Claude Code
claude plugin marketplace add ./integrations/claude-code
claude plugin install docify@docify-local

# Codex
codex plugin marketplace add ./integrations/codex
codex plugin add docify@docify-local
```

The Codex plugin starts `docify mcp`. The Claude Code plugin and the DeepSeek Harness adapter connect to an existing Docify service over HTTP (`DOCIFY_MCP_URL`, `DOCIFY_MCP_TOKEN`). Each ships a skill that tells the agent when to search and how to read the results. Other MCP clients can use stdio or HTTP.

## Ways to use it

| Surface | What it is for |
| --- | --- |
| **Agent plugins** | Claude Code, Codex and DeepSeek Harness. Tools: `docs_search`, `docs_read`, `docs_open`, `docs_outline`, `docs_sources`, `docs_scope`. Read only. |
| **CLI** | `docify add`, `prepare`, `search`, `read`, `open`, `outline`, `pin`, `export`, `import` and more. Every query command has `--json`. |
| **Web UI** | `docify serve` opens a local page to add and prepare sources, watch progress logs, try searches and see the exact text an agent receives, explore the knowledge graph in 3D and change settings. |
| **Hosted** | A Docker image for a server or Coolify, with token-protected MCP over HTTP so a whole team's agents share one prepared library. |

## Measured, not guessed

Retrieval defaults come from an evaluation on 28 hand-written questions across Bun 1.4.3, Bun 1.2.0 and Python 3.13 docs (exact API, paraphrase, cross-version, absent answers):

| Combined search, 1,500-token budget | Result |
| --- | --- |
| Questions passed | 27 / 28 |
| Must-pass questions | 16 / 16 |
| Passage recall | 0.96 |
| Answers from the wrong version | 0 |
| Invalid citations | 0 |
| Latency p50 / p95 | 7 ms / 12 ms |

With `bge-m3` as the embedding model, the same set scores 28 / 28. Method, misses and the changes made after seeing results are in [`docs/evaluation.md`](docs/evaluation.md). The numbers come from a small corpus, so treat them as a floor check, not a promise for every site.

## Your choice of embeddings

| Provider | When to pick it |
| --- | --- |
| Built-in (`bge-small-en-v1.5`) | Default. Runs in process, fully offline, nothing to host. |
| Ollama (`bge-m3`) | Multilingual or larger corpora. `docker compose up -d` starts one locally. |
| OpenAI-compatible | A LiteLLM proxy or any `/v1/embeddings` server you already run. |

With a remote embedding server, each search sends the query text there. `config.json` stores the names of environment variables, never keys.

## Your data stays yours

- Everything lives in `~/.config/docify`: a SQLite database, page snapshots and a config file.
- Queries never fetch pages, download models or call an LLM. The only exception is an embedding server you configured.
- API keys in your environment do not authorize spending. The semantic graph calls an LLM only during `prepare`, and only through the provider you set.
- `docify export` packs the whole library into one checksummed archive. `docify import` restores it on another machine without preparing again.

## Documentation

- [Guide](docs/guide.md): installation, embeddings, crawlers, web UI, backup, agent clients, hosting, configuration reference
- [Design](docs/design.md): the contract the code follows
- [Evaluation](docs/evaluation.md): every measurement behind the defaults
- [Verification](docs/verification.md): what was checked and how

## License

Copyright (c) 2026 Mariusz Rakus. All rights reserved. See [`LICENSE`](LICENSE).
