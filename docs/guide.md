# Docify guide

Full reference for installing, configuring and running Docify. For the overview, see the [README](../README.md).

Docify keeps documentation on disk and gives AI agents cited, token-bounded excerpts from it. Preparation (download, normalization, embeddings, Graphify semantic graph) is an explicit step. Queries are local and offline, unless you choose an embedding server on another machine: a remote Ollama or an OpenAI-compatible server such as LiteLLM (see Embeddings).

## Install

```bash
bun install
bun link                 # puts `docify` on PATH (~/.bun/bin)
docify setup             # pinned Graphify into ~/.config/docify/graphify-venv, embedding model into ~/.config/docify/models
```

`setup` is the only command that downloads models. The store lives in `~/.config/docify` (override with `DOCIFY_HOME`), outside any plugin directory.

Older versions kept the store in `~/.cache/docify`. Docify keeps using it while `~/.config/docify` does not exist. To move it, first make sure every `docify` you run is this version (an older one would create a new empty store at the old path), stop `docify serve` and agent sessions running `docify mcp`, then:

```bash
mkdir -p ~/.config && mv ~/.cache/docify ~/.config/docify
rm -rf ~/.config/docify/graphify-venv && docify setup   # the venv's scripts hold absolute paths
```

`make` lists shortcuts for these and the other commands below: `make check` type-checks and tests.

## Collection summaries and discovery

After preparing a source, generate its collection overview explicitly:

```bash
docify summarize apple-his@unknown
docify prepare apple-his@unknown --summary  # generate after preparing, reuse if unchanged
docify sources "docs for Apple"
```

`summarize` sends a bounded sample of the active generation's indexed documents to the configured `graph` provider. It requires an OpenAI-compatible graph backend and uses its model, endpoint and credential environment variable names. This command authorizes that remote processing and any provider cost; merely setting credentials does not enable automatic calls. It saves the generated overview locally and reuses it for the same generation and model. `--force` regenerates it. Run it again after refreshing the source: summaries from old generations are not used for discovery.

In the web UI, open a source and use **Generate Summary** under **Collection summary**. **Regenerate Summary** replaces the current summary only after a successful provider response. The section shows the model, generation and age of the saved summary. Unprepared sources must be prepared first. Opening the page never generates a summary. While a summary is generating, **Cancel** stops the provider call and keeps the saved summary; settings, import, and preparing or removing that source wait until it ends.

Agents call `docs_sources` with `{"query":"docs for Apple"}` to match saved summaries, source ids, library names and locations. Without `query` it lists all sources. Returned source ids can be passed to `docs_search`, `docs_outline` and `docs_open`. Discovery makes no model or network calls. Summaries are document-derived discovery hints, not citation evidence or instructions. If there is no match, list all sources and check whether summaries have been generated.

## Embeddings

On macOS and glibc Linux, Docify disables native ONNX telemetry before loading the embedding backend. Setting only JavaScript's `process.env` does not update the environment seen by the native library in Bun.

The default is `Xenova/bge-small-en-v1.5` in process, with no server. For multilingual or larger corpora, docify can embed with `bge-m3` on an Ollama server instead:

```bash
docker compose up -d     # Ollama on 127.0.0.1:11434, pulls bge-m3 (about 1.5 GB the first time)
```

The models are stored in `./data/ollama` in the checkout. Set `OLLAMA_DATA_DIR` to an absolute path to keep them elsewhere or share them between checkouts.

Then put this in `~/.config/docify/config.json` and run `docify setup` (it checks the server) and `docify prepare` for each source:

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
  "embeddingModel": "bge-m3",
  "embeddingDims": 1024,
  "embeddingQueryPrefix": "",
  "strongVectorSim": 0.58,
  "weakVectorSim": 0.48
}
```

`embeddingModel` is the model name your server lists. The thresholds above were measured for `bge-m3` behind LiteLLM, and `bge-small-en` behind LiteLLM works with the defaults (`docs/evaluation.md`); for any other model, run `bun scripts/eval-similarity.ts` on the evaluation corpus before trusting `no_match`. `embeddingBaseUrlEnv` and `embeddingApiKeyEnv` change the variable names. `/v1` is added to the base URL unless it already ends with it, and each request gives up after `embeddingTimeoutSeconds` (default 120). Run `docify setup` to check the server, then prepare each source again. Every search sends the query text to that server, which adds its round trip to each search: about 170 to 250 ms with a remote LiteLLM, against about 13 ms in process.

`config.example.json` in the repository root is a complete LiteLLM setup: bge-m3 embeddings and the default graph provider, with every `graph` key written out. Copy it to `~/.config/docify/config.json` (or `$DOCIFY_HOME/config.json`), set `LITELLM_BASE_URL` and `LITELLM_API_KEY`, then run `docify setup`.

## Web UI

`docify serve` starts a local page on `127.0.0.1` and prints its URL once. Set `DOCIFY_WEB_TOKEN` to require an access token; without it the page needs none. Workspace registers, prepares and removes sources and shows the exact text a search hands to agents. Settings edits every `config.json` key, shows which environment variables the server sees (credential values are never shown) and edits project pins in `.docify.json`. `graphifyBin` and `modelsDir` are read-only there because Docify runs or loads code from them; change them in `config.json` or with `DOCIFY_GRAPHIFY_BIN` and `DOCIFY_MODELS_DIR`. A save is refused while the page is preparing a source. The theme follows the system unless you pick Light or Dark in the top bar.

The **Logs** tab uses a log viewer vendored from `kolezka/svelte-log-viewer` (`src/web/lib/log-viewer/`) for timestamped preparation progress, errors, warnings and live Graphify stdout/stderr. It polls once per second, offers text and stream filters and follows new lines. CLI and web preparations share the latest 10,000 log lines in `<DOCIFY_HOME>/logs.sqlite`; each line is limited to 8,192 characters. Configured embedding and graph API-key values are redacted before storage. Failed reads are reported in the view without clearing lines already loaded. Only runs made with this logging-enabled build are recorded; older runs have no history.

The **Graph** tab draws the active generation's Graphify graph in 3D with WebGL2. Click a node to see the page it came from, the passage that grounds it and what it links to. Faded nodes have no grounding passage. Pages Graphify left without nodes are listed in the inspector. A source prepared with **No graph** has nothing to show here. The browser needs WebGL2.

Moving around the graph:

| Action | Pointer | Keyboard (canvas focused) |
| --- | --- | --- |
| Orbit | drag | arrow keys |
| Pan | Shift-drag, right-drag, Shift-scroll, two-finger drag on touch | Shift with arrow keys |
| Zoom toward the pointer | scroll, pinch | `+` and `-` |
| Fly through the graph | | `W` `A` `S` `D`, `Q` down, `E` up |
| Go to a node | double-click it; double-click empty space to move in | |
| Fit, reset | buttons at the bottom right | `F`, `0` |

The buttons at the bottom right also turn a slow rotation on and off. Camera moves are short animations that any input cancels. With the system setting for reduced motion the camera jumps instead and the rotation button is not shown.

The search field (`/` focuses it) finds nodes by label, page, group, node id and grounding passage. It searches the graph already loaded in the browser, so it sends nothing to the server. Every word must match; quotes keep a phrase together. Filters narrow the result: `type:concept`, `page:buttons`, `group:"Setup steps"`, `is:grounded` or `is:ungrounded`, and `links:>5` for a minimum number of links. Matches get a ring in the graph and the rest fades. Up and Down step through the results and fly to each one, Return goes to the node and moves focus to the graph, Escape clears the field. **Show All in View** fits every match on screen.

The legend shows or hides a node type. A row under **Largest groups** highlights that group and brings it into view.

## Prepare documentation

```bash
docify add bun ./docs/bun --version 1.4.3          # local Markdown, MDX or HTML file or directory
docify add mylib https://example.com/docs/ --version 2.1   # bounded same-origin, same-path crawl of static pages
docify prepare bun@1.4.3                             # add --no-graph to skip semantic extraction, --force to rebuild
docify pin bun 1.4.3                                 # writes ./.docify.json for this project
docify remove mylib@2.1                              # deletes the source, its generations and snapshots
```

The source id is `library@version` (`library@unknown` without `--version`) unless `add --id` sets one.

URLs ending in `llm.txt` or `llms.txt` are read as Markdown indexes, including when served as `text/plain`. Docify follows inline links in all Markdown and MDX pages, not just these indexes. Both HTML and Markdown can link to extensionless documentation routes within the registered origin and directory.

When an HTML or `.md` page links to an extensionless route, Docify tries its `.md` export first, then the original route if the export is unavailable, fails to load or returns an unsupported content type. This supports sites such as Apple HIG, where Markdown links can point to broken HTML routes while their Markdown exports work. Sites without exports can incur one extra request per such link. HTML pages can also advertise Markdown through a `<link rel="alternate" type="text/markdown" href="...">`. Starting directly from that Markdown URL saves one link level.

By default, a crawl collects at most 50 documents (including the index), follows two link levels, and is limited to 5 MB per page and 50 MB total. This is a bounded crawl, not a guarantee that the whole site is indexed.

Set the global page and depth limits under Settings > Web Crawling, or set `maxPages` and `maxDepth` in `config.json`. The allowed ranges are 1 to 100,000 pages and 0 to 1,000 link levels; depth 0 collects only the start page. Each URL source can override either limit on its source page. Leave a field blank to inherit the global setting. Changes apply on the next prepare and do not expand the allowed origin or path scope. The source API accepts a `crawl` object with `maxPages` and `maxDepth`; a PATCH value of `null` removes that field's override.

### Ignore paths

Each source can carry two lists of regular expressions. `ignore` keeps matching documents out of the source: a URL source does not fetch those pages, a local source does not read those files, and neither can be searched. `graphIgnore` keeps matching documents searchable but leaves them out of the semantic graph, which saves LLM time on pages such as changelogs or generated API listings.

```bash
docify add mylib https://example.com/docs/ --ignore '^changelog/' --ignore '^blog/' --graph-ignore '^api/reference/'
docify ignore mylib@unknown                              # show both lists
docify ignore mylib@unknown --ignore '^legal/'           # replace the ignore list
docify ignore mylib@unknown --no-graph-ignore            # remove the graph list
```

Patterns are JavaScript regular expressions, case-sensitive and not anchored unless you write `^` or `$`. They are tested against the document path that Docify stores and cites: for a URL source the part of the URL path below the start URL's directory (`https://example.com/docs/changelog/v2.html` registered at `https://example.com/docs/` is `changelog/v2.html`, and the start directory itself is `index.html`), for a local source the path relative to the registered folder. A list holds at most 100 patterns of up to 500 characters; an invalid expression is rejected when it is saved.

Each `--ignore` or `--graph-ignore` option given to `docify ignore` replaces that whole list. The web UI has the same two fields in the New Source sheet and under Ignored paths on every source page, one pattern per line. A pattern the server rejects is reported at its field and nothing is saved. The source page and the Graph tab count the pages left out of the graph apart from pages Graphify missed, and say so when every page matches and no graph was built. The source API accepts `ignore` and `graphIgnore` arrays on `POST /api/sources` and `PATCH /api/sources/{id}`; a PATCH value of `null` or `[]` removes a list. A rejected list answers 400 with `field` set to `ignore` or `graphIgnore`.

Changes apply on the next prepare and are refused while the source is preparing. A link that redirects to an ignored path is skipped before the target is requested, and a start URL that matches `ignore` fails the prepare. Documents left out by `graphIgnore` do not count as missing from the graph, so they do not make it partial. If every document matches `graphIgnore`, no graph is built.

### Choose a crawler

URL sources can use `builtin`, `crawl4ai` or `browserless`. Select one when registering a source, or change it later:

```bash
docify add mylib https://example.com/docs/ --crawler browserless
docify crawler mylib@unknown crawl4ai
docify crawler mylib@unknown default
```

`default` removes the source-specific choice. Sources without one, including existing sources, inherit the global `crawlProvider` in `config.json`, which defaults to `builtin` and accepts `builtin` or `crawl4ai`. Browserless is selected per source, not as the global default. The web UI offers the same choice when adding a URL and on each URL source card; Settings controls the global default and provider settings. Changing a selection takes effect on the next prepare, and is refused while that source is preparing. Local sources do not use a crawler.

### JavaScript-rendered documentation

Pages that only fill in with JavaScript can be rendered by a [Crawl4AI](https://docs.crawl4ai.com/core/self-hosting/) server. Configure it in `config.json` (or the web UI's Settings, under Web crawling). The example also makes it the global default:

```json
{
  "crawlProvider": "crawl4ai",
  "crawl4aiUrl": "http://127.0.0.1:11235",
  "crawl4aiApiKeyEnv": "CRAWL4AI_API_KEY",
  "crawl4aiTimeoutSeconds": 120
}
```

`crawl4aiApiKeyEnv` names the environment variable holding the server's bearer token, never the token itself. To select Crawl4AI for only one source, leave the global default unchanged and use `--crawler crawl4ai` instead.

Each URL source card has Crawl4AI settings for streaming, SPA waits and optional captures. `stream` selects `/crawl/stream` instead of `/crawl`; Docify buffers the bounded response and requires one result and a completion record. `waitUntil` accepts `load`, `domcontentloaded`, `networkidle` or `commit`; `waitFor` is at most 1,000 characters; `delayBeforeReturnHtml` is 0 to 60 seconds; and `scanFullPage` is a boolean. Unset fields use the service defaults, except streaming defaults to off. These settings apply on the next prepare and only to Crawl4AI. The source API's `PATCH /api/sources/:id` accepts a `crawl4ai` object that replaces these per-source options.

For Crawl4AI sources, linked `.pdf` URLs are fetched directly by Docify, not rendered by Crawl4AI. Responses identified as `application/pdf`, or `.pdf` responses served without a type or as `application/octet-stream`, are extracted as text and indexed as Markdown. The stored raw document is extracted text, not the original PDF; citation lines refer to normalized text, not PDF page or line numbers. Extraction allows at most 20 MiB, 500 pages and 2,000,000 characters, in addition to the crawl's byte limits. It does not perform OCR; a scan without extractable text fails preparation. Local sources and the other URL providers do not use this PDF extraction path.

Optional screenshot and PDF captures use the same Crawl4AI request and SPA settings as the start page, not every crawled page. They are output artifacts, not PDF inputs or indexed text. Each is limited to the per-page byte limit (5 MB by default), validated, saved in the generation's `artifacts/` directory and downloadable from the active source card. A capture failure fails preparation. Docify checks the reported final URL after rendering, not each browser navigation; it cannot guarantee the capture and HTML came from the same URL if the page navigates during capture.

Browserless uses its `/function` endpoint to render pages. Configure its base URL and token variable name, then select `browserless` for each source that needs it:

```json
{
  "browserlessUrl": "http://127.0.0.1:3000",
  "browserlessApiKeyEnv": "BROWSERLESS_API_KEY",
  "browserlessTimeoutSeconds": 120
}
```

These are the defaults. The base URL must be HTTP or HTTPS without credentials, query parameters or a fragment. Set `BROWSERLESS_API_KEY` in the environment of the CLI or `docify serve` process if the server requires a token; Docify sends it as a bearer token. If the variable is unset, it sends no authorization header. Do not put the token in `config.json` or the URL. Use HTTPS for a remote service and restrict access to the service.

Docify discovers links and applies origin, path, depth, page and byte limits to the documents it collects. Neither browser provider is a network sandbox. Crawl4AI can follow redirects and load subrequests before Docify checks the returned page. Browserless intercepts later main-frame navigation requests and lets Docify check their destination before following them, but does not confine subresources, frames, popups, service workers or other browser activity. These checks do not block access to private networks or guarantee safe browser egress. Run rendering services in a trusted, isolated environment with network-level egress controls appropriate for the URLs being crawled.

Both rendering providers skip `.md` export probes. Crawl4AI preserves Markdown links when its browser wraps Markdown pages and `llms.txt` indexes in HTML. If a remote provider fails, times out or returns malformed data, preparation fails rather than switching to another crawler; the previous generation keeps serving. Queries never use these providers.

```bash
docify add openclaw https://docs.openclaw.ai/llms.txt --id openclaw
docify prepare openclaw --no-graph
```

Unknown versions stay `unknown`; `downloaded_at` is recorded separately. Each prepare builds a new generation in staging and activates it atomically. A failed or interrupted prepare keeps the previous generation and marks the source `stale`.

Graph extraction calls an LLM. The default provider is the LiteLLM proxy named by `LITELLM_BASE_URL` and `LITELLM_API_KEY`, model `deepseek/deepseek-flash-nothink`, passed to Graphify only for that subprocess. Change it in `~/.config/docify/config.json` (`graph`), or set `"graph": null` to disable it.

When the model leaves some documents out or a request fails, Graphify still returns a graph of the rest. Docify activates it with graph status `partial`, lists the documents without nodes in the generation stats (`graphMissing`) and warns in the `prepare` output. A partial graph is searched like a complete one. The next `prepare` rebuilds the source even if nothing changed, and Graphify sends only the missing documents again, because it caches the complete ones.

`graph.timeoutSeconds` (default 900) is an inactivity limit: Graphify is stopped only after that many seconds without any output, so a large source can take longer as long as chunks keep finishing. A stopped run fails the prepare and keeps the previous generation; Graphify has cached the finished chunks, so the next `prepare` continues from there.

Five more `graph` keys tune the model requests. They are also in Settings, under Semantic Graph. Graphify runs with a clean environment, so a `GRAPHIFY_*` variable set in your shell does not reach it; use these keys instead.

| Key | Default | What it does |
| --- | --- | --- |
| `maxOutputTokens` | `null` | Upper limit for one model reply. `null` keeps Graphify's default for the backend. Raise it when replies are cut off. |
| `temperature` | `null` | Sampling temperature from 0 to 2. `null` keeps Graphify's default, which is 0 for most models. |
| `maxRetries` | `6` | How many times a request is retried after a rate limit or network error. 0 turns retries off. |
| `maxRetryDepth` | `3` | How many times a cut-off chunk is halved and sent again. Each level can double the requests for that chunk. 0 sends every chunk once. |
| `disableThinking` | `false` | Asks a reasoning model not to think. Runs get steadier, but Graphify measured lower extraction quality and more cut-off replies. |

Graphify caches finished chunks, so a changed setting reaches documents that already have nodes only on a forced prepare.

## Query

```bash
docify search "keep WAL sidecar files after close" --library bun --max-tokens 1500
docify read p_0123456789abcdef0123
docify outline bun@1.4.3 --path api/   # documents, headings and section ids of one source
docify open bun@1.4.3 sqlite.mdx --heading "Transactions"
docify sources
docify scope --library bun   # what a search would search: pins, chosen versions, generations
docify serve             # one-screen UI; open the printed http://127.0.0.1:4747/ URL (--port to change)
docify mcp               # MCP server on stdio: docs_search, docs_read, docs_outline, docs_open, docs_sources, docs_scope
```

`search` also takes `--version`, `--source` (repeatable), `--mode` and `--graph-weight`; `search`, `read`, `outline` and `open` take `--json` for the full result. `outline` (MCP `docs_outline`) lists the documents of a source's active generation with the passage id of each section, for browsing when search finds nothing; `--path` keeps documents under a path prefix and `--max-tokens` caps the output (default 2000). `open` (MCP `docs_open`) returns a whole document, or one section with its subsections when `--heading` is given, from the active generation, cut at a passage boundary to fit `--max-tokens` (default 3000) with the passage id to continue from. Its statuses are `ok`, `not_found`, `not_indexed` and `source_unknown`. `docify search --query A --query B` runs up to 8 queries in one call.

The MCP tool `docs_search` takes `query` or `queries` (1 to 8, exactly one of the two), plus `library`, `version`, `sources`, `mode`, `max_tokens` and `graph_weight`. With `queries`, every query runs with the same filters and keeps its own status line, all of them share `max_tokens`, and a passage found by several queries is shown once with the query numbers that hit it. Each query first gets an equal share of the budget, then the leftover goes to the remaining hits round-robin by rank (`docs/evaluation.md`, "Several queries in one call"). Without `max_tokens`, several queries get 1400 tokens each (2800 for two, 4200 for three, at most 20000); one query keeps the 2000 default. A single `query` returns the same text as before. Project pins are read from `./.docify.json`, or from the directory in `DOCIFY_PROJECT`.

Search statuses: `ok`, `weak_match` (hits with a low-confidence warning), `no_match`, `not_indexed`, `version_unavailable`, `source_unknown`, `update_failed`. Modes: `combined` (default: lexical, vector and exact-symbol fusion), `lexical`, `vector`, `graph`. `--graph-weight` adds graph hits to combined fusion; it defaults to 0 because it lowered recall on the evaluation corpus (`docs/evaluation.md`). `lexicalWeight` in `config.json` (default 1) sets the weight of word matches in that fusion. With bge-m3, `0.5` measured better: pages that only share words with a question, common with non-English questions, no longer push the vector's answer down.

## Backup and moving to another machine

```bash
docify export ~/docify-backup.tar.gz      # --force overwrites an existing file
docify import ~/docify-backup.tar.gz      # --force replaces a store that has sources; --keep-config keeps this machine's settings
```

A backup holds the database, `config.json` and the snapshot files of every active and superseded generation, so the imported store answers queries without preparing again. Models and the Graphify runtime are not in it; run `docify setup` on the new machine. Export is refused while a source is being prepared.

Import checks every file against the backup's manifest (SHA-256) and the database's own hashes before it touches the store. A store with sources is replaced only with `--force`, and its files are moved to `<store>.before-import-<time>`, never deleted. From the backup's `config.json`, `graphifyBin` and `modelsDir` are ignored, because they point at code Docify runs; this machine's values stay. Restart running `docify serve` and `docify mcp` processes afterwards. The web UI has the same two actions under Settings → Backup; there, local sources in the backup must be inside `DOCIFY_SOURCE_ROOTS`, and uploads are limited to 1 GiB.

A backup made by a Docify with another store schema is refused; import it with the version named in the error. A backup from an older `PIPELINE_VERSION` imports fine, and the next `prepare` rebuilds it.

## Agent clients

Claude Code:

```bash
claude plugin marketplace add ./integrations/claude-code
claude plugin install docify@docify-local
# remove: claude plugin uninstall docify@docify-local && claude plugin marketplace remove docify-local
```

The Claude Code plugin does not start Docify. It connects to a running Docify service over HTTP (see MCP over HTTP below), local or remote. Set these in the environment of the `claude` process, for example in your shell profile or under `env` in Claude Code's `settings.json`, then restart Claude Code:

- `DOCIFY_MCP_TOKEN`: the token for this client. Either a personal key you made under Account in the service's web UI (when it has user accounts), or one of the tokens in the service's `DOCIFY_MCP_TOKENS` (the token only, not `name:token`).
- `DOCIFY_MCP_URL`: the service's `/mcp` endpoint, such as `https://<domain>/mcp`. Defaults to `http://127.0.0.1:4747/mcp`.

`claude mcp list` shows `plugin:docify:docify: <url> (HTTP) - ✔ Connected` when it works. A wrong token shows HTTP 401, and an unreachable service shows a connection error; in both cases the `docs_*` tools are not registered. Do not commit the token.

Codex:

```bash
codex plugin marketplace add ./integrations/codex
codex plugin add docify@docify-local
# remove: codex plugin remove docify@docify-local && codex plugin marketplace remove docify-local
```

DeepSeek Harness loads the Claude Code plugin through the adapter in `integrations/claude-code/docify/dsh/`. The adapter imports the published [`claude-plugin-dsh`](https://www.npmjs.com/package/claude-plugin-dsh) runtime (pinned to 0.2.0 in `dsh/package.json` and `dsh/bun.lock`), so install its dependencies first. DSH does not install them for you:

```bash
cd /path/to/ai-docify/integrations/claude-code/docify/dsh && bun install --frozen-lockfile
```

To check what the adapter registers without DSH, run `bun x claude-plugin-dsh@0.2.0 inspect /path/to/ai-docify/integrations/claude-code/docify`; it lists the `docify` skill. Do not run that CLI's `sync` or `scaffold` on this adapter: they write a vendored copy of the runtime, which this adapter no longer uses. To move to a newer runtime, change the exact version in `dsh/package.json`, run `bun install` in `dsh/` and commit the updated `bun.lock`.

Start a Docify service with user accounts or with `DOCIFY_MCP_TOKENS` configured as described below. Set `DOCIFY_MCP_TOKEN` in the DSH process environment to the token for this client: a personal key from the Account view, or a shared token (the token only, not `name:token`). Optionally set `DOCIFY_MCP_URL`; it defaults to `http://127.0.0.1:4747/mcp`. Restart DSH after changing its environment. Do not commit tokens. Configure the embedding credentials in the service environment, not the DSH client.

Then install the bundle, which brings the `docify` skill and connects to that service:

```bash
dsh plugin --profile <profile> add file:/path/to/ai-docify/integrations/claude-code/docify/dsh
```

Or, for every profile, add the rows from `dsh/cordis.patch.yml` to `~/.dsh/cordis.patch.yml` (DSH picks them up without a restart). The adapter reads skills only, so the MCP server needs its own row:

```yaml
- insert:
    - id: claude-compat-docify
      name: "file:///path/to/ai-docify/integrations/claude-code/docify/dsh/index.js"
    - id: claude-compat-docify-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: docify
        transport: streamable-http
        url: !!js 'process.env.DOCIFY_MCP_URL || "http://127.0.0.1:4747/mcp"'
        headers:
          Authorization: !!js '`Bearer ${process.env.DOCIFY_MCP_TOKEN || ""}`'
        failOnStartupError: false
```

The tools appear as `mcp__docify__docs_search` and so on. If the service or token is missing, the connection fails and the tools are not registered. HTTP uses the server's project pins and does not enforce the plugin's minimum version; keep the service current.

The Codex plugin starts `docify mcp`, so `docify` must be on PATH. Its `--require <version>` check refuses an older executable; update it with `bun link` in a current checkout. The Claude Code plugin and the DeepSeek Harness adapter use HTTP: they get the server's project pins and do not check its version, so keep the service current. All three integrations ship a skill that tells the agent when to search and how to read statuses.

## Versions and releases

For a release on GitHub, open **Actions > Release > Run workflow**, select **main**, choose **patch**, **minor** or **major**, and run it. The workflow checks types and release tests, calls the shared release script, verifies the bumped versions, then atomically pushes the commit to `main` and the new annotated `vX.Y.Z` tag. Other branches are skipped; releases run one at a time. If `main` moves during the run, the push fails without publishing either ref. Branch protection must allow the workflow's `GITHUB_TOKEN` to push; the workflow does not bypass protection. It does not publish packages or create a GitHub Release.

For a local release, use the same script and push yourself:

Docify, both plugins and the DeepSeek Harness adapter share one version. `package.json` holds it; `docify --version`, the MCP server info and `/healthz` report it. `scripts/release.ts` is the only thing that should change it:

```bash
bun scripts/release.ts patch --dry-run   # show the next version and its changelog section, write nothing
bun scripts/release.ts minor             # or patch, major, or an explicit X.Y.Z
git push --follow-tags
```

It needs a clean working tree. It writes the new version into `package.json`, both plugin manifests, the DSH adapter's `package.json` and the `--require` arguments, adds a `CHANGELOG.md` section built from the Conventional Commits since the last `v*` tag, then commits `chore: release vX.Y.Z` and creates an annotated tag. It does not push. `tests/version.test.ts` fails when the files disagree.

## Hosting (Docker, Coolify)

The image runs the web UI on port 4747 and keeps state in `/data`. It ships the bge-small model and the Graphify runtime, so the default `transformers` provider works without network access. `DOCIFY_WEB_TOKEN` and `DOCIFY_ALLOWED_HOSTS` are both optional. Without a token, `/api` is open to anyone who can reach the port; Host and Origin checks still apply.

### Compose

```bash
cp .env.example .env          # optional: DOCIFY_WEB_TOKEN (16+ characters) and DOCIFY_ALLOWED_HOSTS
docker network create shared-services    # once per host
sudo mkdir -p /data/docify && sudo chown 10001:10001 /data/docify && sudo chmod 0750 /data/docify
docker compose -f docker-compose.prod.yml up -d --build
```

The container joins the external `shared-services` network, so it reaches a crawler on the same host by name. Put the Crawl4AI or Browserless stack on that network with an alias, for example `crawl4ai`, and set the crawler URL to `http://crawl4ai:11235`. `127.0.0.1` inside the container is the container itself.

Open `http://127.0.0.1:4747/`, or `http://127.0.0.1:4747/#token=<DOCIFY_WEB_TOKEN>` when a token is set. The token is read from the URL fragment, so it never appears in server logs or proxy access logs; the public routes are `/healthz`, which returns `{"ok":true,"version":"X.Y.Z"}`, and the API reference at `/api/docs`, which holds no data.

`DOCIFY_ALLOWED_HOSTS` lists the hostnames the server answers for, comma separated; a bare hostname matches any port. When it is empty and the server binds a non-loopback address, any Host is accepted and a warning is logged, so set it in production. `DOCIFY_BIND` defaults to `127.0.0.1`: put a reverse proxy in front, or set it to `0.0.0.0` when the port must be reachable directly.

State (sqlite, snapshots, `config.json`) lives in a host directory bind-mounted at `/data`: `/data/docify`, or `DOCIFY_DATA_DIR` when set. The container runs as uid 10001, so the directory must be owned by that uid; mode `0750` keeps it private to it. Docker creates a missing bind-mount directory as root, and the entrypoint then stops with the `mkdir`, `chown` and `chmod` to run. Docker Desktop on macOS cannot create `/data`; set `DOCIFY_DATA_DIR=./data/docify` there. Back up the directory while the container is stopped, or use `docify export`.

To change the embedding provider, edit `config.json` in the data directory on the host and restart:

```bash
docker compose -f docker-compose.prod.yml restart docify
```

Earlier versions of the compose file kept state in the named volume `docify-prod_docify-data` (in Coolify: `<app-uuid>_docify-data`, listed by `docker volume ls`). To move it to the directory, stop the stack and copy it once:

```bash
docker compose -f docker-compose.prod.yml down
sudo mkdir -p /data/docify
docker run --rm -v docify-prod_docify-data:/from:ro -v /data/docify:/to alpine cp -a /from/. /to/
sudo chown -R 10001:10001 /data/docify
sudo chmod -R u+rwX,g+rX,g-w,o-rwx /data/docify
docker compose -f docker-compose.prod.yml up -d
```

Remove the old volume with `docker volume rm docify-prod_docify-data` once the UI shows your sources.

For a provider with a custom model, also set `DOCIFY_MODELS_DIR=/data/models` and `DOCIFY_SETUP=true` so the download goes to the writable data directory, then prepare every source again. See "Embeddings" for the provider settings.

### Local documentation

The compose file mounts `DOCIFY_SOURCES_DIR` read-only at `/sources`, which is the default `DOCIFY_SOURCE_ROOTS`. `.env.example` sets it to `~/Development`. Without it the mount comes from `/srv/docify/sources`; on a server, make that a link to the repositories: `sudo mkdir -p /srv/docify && sudo ln -s /home/<user>/Development /srv/docify/sources`. Each repository is then `/sources/<repo>`. Only Markdown and HTML files are indexed; dot directories, `node_modules`, `.git` and `graphify-out` are skipped. On Linux the files must be readable by uid 10001.

Register and prepare a repository inside the container:

```bash
docker compose -f docker-compose.prod.yml exec docify bun src/cli.ts add docify /sources/docify
docker compose -f docker-compose.prod.yml exec docify bun src/cli.ts prepare <source-id> --no-graph
```

Drop `--no-graph` when LiteLLM is configured (`LITELLM_BASE_URL`, `LITELLM_API_KEY`); an unreachable graph provider fails the prepare. The UI can add and prepare the same sources, restricted to the configured roots.

### Coolify

1. Run `docker network create shared-services` once on the server, then create a Docker Compose resource from the repository, using `docker-compose.prod.yml` as the compose file.
2. Optionally set `DOCIFY_WEB_TOKEN` (16+ characters) and `DOCIFY_ALLOWED_HOSTS` to the domain Coolify gives the app, in the resource's environment variables. Without a token, anyone who finds the domain can use the UI.
3. Set the domain to point at container port `4747`. Coolify's Traefik terminates TLS; the origin check accepts `https://<domain>` behind the proxy.
4. Keep `/data` persistent. Before the first deploy, create `/data/docify` on the server owned by uid 10001 (the commands under "Compose"), or set `DOCIFY_DATA_DIR` to another absolute host path prepared the same way.
5. Create the `/srv/docify/sources` link from "Local documentation". Coolify mounts the compose default and ignores `DOCIFY_SOURCES_DIR` set in its UI; it also rejects `${VAR:?}` in a volume path. Leave `DOCIFY_SOURCE_ROOTS` unset or `/sources`: it is a path inside the container, so `~` there means `/home/docify`.
6. Deploy, open `https://<domain>/` (add `#token=<DOCIFY_WEB_TOKEN>` when a token is set), and check that `/healthz` returns 200.

If the domain changes, update `DOCIFY_ALLOWED_HOSTS` and redeploy.

### User accounts (GitHub sign-in)

By default the web UI has no accounts: it is open, or guarded by the one shared `DOCIFY_WEB_TOKEN`. To give each person their own account, turn on GitHub sign-in. The store stays shared; accounts decide who may use it and who may change it.

1. On GitHub, open Settings, Developer settings, OAuth Apps, New OAuth App. Set the homepage URL to the public address of the UI and the authorization callback URL to `<public address>/auth/github/callback`.
2. Set `DOCIFY_GITHUB_CLIENT_ID` and `DOCIFY_GITHUB_CLIENT_SECRET` from that app, `DOCIFY_ADMINS` to your GitHub login, and `DOCIFY_PUBLIC_URL` to the public address (`https://docify.example.com`, scheme and host only). Remove `DOCIFY_WEB_TOKEN`: the server refuses to start with both. It also refuses to start without `DOCIFY_PUBLIC_URL` unless it listens on loopback only, which is every Docker deployment.
3. Restart and open the UI. It shows "Sign In with GitHub".

- **Administrators** are the logins in `DOCIFY_ADMINS` (comma separated; `id:<number>` names an account by its GitHub id). They are administrators from their first sign-in, and nobody becomes one by arriving first. A login is tied to the first GitHub account that signs in with it: if that person later renames their account they stay an administrator, and someone else who registers the freed login does not become one (the log says so). So sign in yourself right after setting the variable, before sharing the address. The log line for that first sign-in shows your GitHub id, in case you prefer to name it as `id:<number>`. They add, prepare and remove sources, change settings, read logs, export and import backups, and manage accounts under Users.
- **Members** search, read passages and view sources and graphs. Under Account each person makes their own MCP keys and sees their own recent searches (below). Who becomes a member is the administrators' decision: the access list under Users lets people in at sign-in, and anyone else waits for approval or is refused (below). An administrator can also make a member an administrator, disable an account (its sessions and MCP keys end at once) or remove it.
- An account named in `DOCIFY_ADMINS` cannot be demoted, disabled or removed in the UI; change the variable and restart. At that start, anyone who was an administrator only through the variable becomes a member and is signed out; the account stays active, so disable or remove it under Users if it should lose access altogether. An administrator made in the UI is not affected. Nobody can change their own account.

With an empty access list Docify asks GitHub for no scope: it reads the public profile (id, login, name). An organization entry adds `read:org` and an email entry adds `user:email`, and the sign-in page says so before the person goes to GitHub. Docify does not keep the GitHub token, the memberships or the addresses. A session is an `HttpOnly`, `SameSite=Lax` cookie valid for 30 days; the server stores only its SHA-256 hash. Signing in again ends the session that browser had, and a person keeps at most ten. When `DOCIFY_PUBLIC_URL` starts with `https://` the cookie is `Secure` and named `__Host-docify_session`, which stops a sibling subdomain from planting its own, and the page sends `Strict-Transport-Security`. With an `http://` address none of that applies and the start-up line says so; use that only inside a trusted network. Another site cannot use the cookie: writes need a JSON content type and an `Origin` equal to `DOCIFY_PUBLIC_URL`, and any `/api` request a browser marks as cross-site is refused, including a plain link to the backup export.

What an administrator can do is close to what the operator can do: change settings, import a store, read the logs. Settings refuse to use Docify's own variables (`DOCIFY_GITHUB_CLIENT_SECRET`, `DOCIFY_MCP_TOKENS`, `DOCIFY_WEB_TOKEN`) as a credential, but an administrator can still point a credential setting at another variable of the server's environment and at a server of their choice. Make administrators only of people you would give the server's `.env`. Members see source names and passages, not local paths on the server or prepare errors.

Accounts, sessions, personal MCP keys and search history live in `accounts.sqlite` in the store directory, apart from `docify.sqlite`. A backup (`docify export`) does not contain them and an import does not replace them, so restoring a store never changes who can sign in. Deleting `accounts.sqlite` while the server is stopped removes every account; administrators come back at their next sign-in.

**Who gets in.** Under Users, the access list holds three kinds of entries: a GitHub organization (every member), a GitHub login (one person) and an email address (the person who has verified it at GitHub). Someone who matches an entry is a member from their first sign-in, with no approval step. "Everyone else" decides about people who match nothing: they wait for approval, which is how it works with an empty list, or they are refused and get no account at all. The list holds up to 500 entries, ten of them organizations.

- A login entry is tied to the first GitHub account that signs in with it, like a login in `DOCIFY_ADMINS`, because GitHub logins can be registered again by someone else.
- An organization entry needs the person to grant `read:org` at GitHub, and an organization that restricts OAuth apps has to approve this one first. When GitHub will not answer, the person is treated as not matching, and the log says why. Only an active membership counts, not a pending invitation.
- The match is checked again at every sign-in. A person who was let in by an entry and no longer matches any (they left the organization, the entry was removed) goes back to waiting and loses their sessions and MCP keys. If GitHub gives no answer that day, nothing is taken away.
- Removing an entry does the same at once to everyone it let in. Accounts an administrator approved by hand, and administrators, are not touched.
- A session lasts 30 days, so someone who leaves the organization keeps access until their next sign-in. Disable the account under Users to end it at once.
- A disabled account stays disabled whatever the list says.

**Personal MCP keys.** Every approved person can connect their own agent. Under Account, New Key… asks for a name (such as the computer it is for) and shows the key once, with the command for Claude Code. The server keeps only the key's SHA-256 hash, so a lost key cannot be shown again: revoke it and make a new one. A person has at most ten keys. A key works at `/mcp` like a shared token (below) and stops at once when it is revoked or its owner is disabled or removed; re-enabling the account does not bring old keys back. All keys of one person share that person's request limit. Through a member's key the source list shows no server paths or prepare errors, the same as in the UI.

**Recent searches.** Account also lists the person's own searches, from the page and through their keys: the query, the scope, the result status and the number of passages, never the passages themselves. Only that person can read the list in the UI or through the API; administrators cannot. Whoever runs the server can, since it is a file there. The newest 200 per person are kept, and Clear History… deletes them. Searches made with a shared `DOCIFY_MCP_TOKENS` token belong to nobody and are not recorded.

The CLI works on the store directly and is outside accounts.

### MCP over HTTP

`docify serve` also answers MCP at `/mcp` (Streamable HTTP, stateless, JSON responses) when user accounts are on or `DOCIFY_MCP_TOKENS` is set. With neither, `/mcp` returns 404. The tools are the same read-only ones as on stdio.

With user accounts, people make their own keys in the web UI (Personal MCP keys above) and you need no variable. `DOCIFY_MCP_TOKENS` is for agents that belong to no person, and for a service without accounts. Give every such agent its own token, so one can be revoked without touching the rest:

```bash
DOCIFY_MCP_TOKENS="claude:$(openssl rand -hex 32),openclaw-1:$(openssl rand -hex 32)"
```

Agents send `Authorization: Bearer <token>`. For Claude Code:

```bash
claude mcp add --transport http docify https://<domain>/mcp --header "Authorization: Bearer <token>"
```

Requests are checked in this order: Host and Origin, the per-IP limit, the token or personal key, the per-client limit (per person for personal keys). The per-IP limit runs before the token check, so guessing tokens is slow. Over a limit the server answers 429 with `Retry-After`. Request bodies over 1 MB get 413, and only POST is accepted.

- `DOCIFY_MCP_RATE`: per client, default `60/min`. `DOCIFY_MCP_IP_RATE`: per IP, default `120/min`. Units are `s`, `min` and `h`.
- `DOCIFY_TRUST_PROXY=1` takes the client IP from the last `X-Forwarded-For` entry. `docker-compose.prod.yml` sets it because Traefik is in front. Without a proxy in front, leave it unset, otherwise a client can choose its own IP.
- Limits are kept in memory per process. A restart resets them, and several replicas would each count separately.
- Version pins come from the server's `.docify.json` (`DOCIFY_PROJECT`, default the working directory), not from the agent's project. Pass `version` in the tool call to pick another.

### Reverse proxy on a dedicated server

With the default loopback publish, point nginx or Caddy at `127.0.0.1:4747`:

```caddy
docify.example.com {
    reverse_proxy 127.0.0.1:4747
}
```

The proxy must preserve the public `Host` header (Caddy and nginx do by default), and `DOCIFY_ALLOWED_HOSTS` must contain that hostname. TLS ends at the proxy; the app itself serves plain HTTP.

### Container details

- Runs as uid 10001 with all capabilities dropped and `no-new-privileges`. The host directory mounted at `/data` must be writable by that uid (`sudo chown -R 10001:10001 /data/docify`).
- `docker compose -f docker-compose.prod.yml exec docify bun src/cli.ts setup` re-runs setup inside a running container; the image already did it at build time.
- `DOCIFY_SOURCE_ROOTS` accepts several paths separated by `:`, the same as `PATH`.

## Development

```bash
make check                     # type check and tests (bun run typecheck, bun test)
bun test tests/search.test.ts  # one file; -t "name" runs matching tests
bun scripts/eval.ts            # retrieval evaluation against the prepared store
bun scripts/mcp-smoke.ts       # drives the MCP server over stdio
```

The tests use no network and no LLM, but most need the bge-small model from `docify setup` (or a copy in `DOCIFY_MODELS_DIR`); without it about 13 fail with `ModelNotPreparedError`. `make` lists the other shortcuts.

| Variable | Effect |
| --- | --- |
| `DOCIFY_HOME` | Store location (default `~/.config/docify`, or `~/.cache/docify` while only that exists) |
| `DOCIFY_MODELS_DIR` | Embedding model cache (default `<store>/models`) |
| `DOCIFY_EMBED_URL` | Ollama server URL when `config.json` sets none |
| `DOCIFY_GRAPHIFY_BIN` | Graphify executable (default `<store>/graphify-venv/bin/graphify`) |
| `DOCIFY_PROJECT` | Project directory whose `.docify.json` pins apply (CLI search and MCP) |
| `DOCIFY_HOST`, `DOCIFY_PORT` | Web bind address and port (`serve` also takes `--host`/`--port`) |
| `DOCIFY_WEB_TOKEN` | Optional web token (16+ characters); without it the web UI and `/api` need no token |
| `DOCIFY_GITHUB_CLIENT_ID`, `DOCIFY_GITHUB_CLIENT_SECRET` | GitHub OAuth app; set both to turn on user accounts with GitHub sign-in (not together with `DOCIFY_WEB_TOKEN`) |
| `DOCIFY_ADMINS` | GitHub logins or `id:<number>` of the administrators, comma separated; required with accounts |
| `DOCIFY_PUBLIC_URL` | Public address of the UI (scheme and host); builds the GitHub callback URL and makes the session cookie `Secure` with https |
| `DOCIFY_ALLOWED_HOSTS` | Optional Host values the web server answers for, comma separated; `*` accepts any |
| `DOCIFY_SOURCE_ROOTS` | Directories the web UI may add local sources from, separated by `:` (default: home) |
| `DOCIFY_MCP_TOKENS` | `name:token` pairs, comma separated; shared tokens for MCP over HTTP at `/mcp`. Not needed with user accounts, where people make personal keys |
| `DOCIFY_MCP_RATE`, `DOCIFY_MCP_IP_RATE` | MCP limits per client and per IP (default `60/min`, `120/min`) |
| `DOCIFY_TRUST_PROXY` | `1` takes the client IP from `X-Forwarded-For`; only behind a proxy |
| `LITELLM_BASE_URL`, `LITELLM_API_KEY` | Graph provider and `openai` embeddings, by default |
| `DOCIFY_MCP_URL` | DSH client endpoint; defaults to `http://127.0.0.1:4747/mcp` |
| `DOCIFY_MCP_TOKEN` | Client bearer token: a personal key from the Account view, or one token in the service's `DOCIFY_MCP_TOKENS` |

`.env.example` lists them with their defaults. Copy it to `.env` for commands run from the checkout root (`bun src/cli.ts`, `bun test`, `make serve`); Bun reads `.env` only from the current directory, so a linked `docify` elsewhere, and the MCP server need the variables in their own environment.

Design and status: `docs/design.md`, `docs/implementation-plan.md`, `docs/feasibility.md`, `docs/evaluation.md`, `docs/verification.md`.

## License

Copyright (c) 2026 Mariusz Rakus. All rights reserved. See `LICENSE`.
