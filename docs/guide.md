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

The **Graph** tab draws the active generation's Graphify graph in 3D with WebGL2: drag to orbit, scroll to zoom, click a node to see the page it came from, the passage that grounds it and what it links to. Faded nodes have no grounding passage. Pages Graphify left without nodes are listed in the inspector. A source prepared with **No graph** has nothing to show here. The browser needs WebGL2.

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

Codex:

```bash
codex plugin marketplace add ./integrations/codex
codex plugin add docify@docify-local
# remove: codex plugin remove docify@docify-local && codex plugin marketplace remove docify-local
```

DeepSeek Harness loads the Claude Code plugin through the adapter in `integrations/claude-code/docify/dsh/`. The adapter imports the published [`claude-plugin-dsh`](https://www.npmjs.com/package/claude-plugin-dsh) runtime (pinned to 0.1.0 in `dsh/package.json` and `dsh/bun.lock`), so install its dependencies first. DSH does not install them for you:

```bash
cd /path/to/ai-docify/integrations/claude-code/docify/dsh && bun install --frozen-lockfile
```

To check what the adapter registers without DSH, run `bun x claude-plugin-dsh@0.1.0 inspect /path/to/ai-docify/integrations/claude-code/docify`; it lists the `docify` skill. Do not run that CLI's `sync` or `scaffold` on this adapter: they write a vendored copy of the runtime, which this adapter no longer uses. To move to a newer runtime, change the exact version in `dsh/package.json`, run `bun install` in `dsh/` and commit the updated `bun.lock`.

Start a Docify service with `DOCIFY_MCP_TOKENS` configured as described below. Set `DOCIFY_MCP_TOKEN` in the DSH process environment to the token for this client (the token only, not `name:token`). Optionally set `DOCIFY_MCP_URL`; it defaults to `http://127.0.0.1:4747/mcp`. Restart DSH after changing its environment. Do not commit tokens. Configure the embedding credentials in the service environment, not the DSH client.

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

The Claude Code and Codex plugins start `docify mcp`, so `docify` must be on PATH. Their `--require <version>` check refuses an older executable; update it with `bun link` in a current checkout. All three integrations ship a skill that tells the agent when to search and how to read statuses.

## Versions and releases

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
mkdir -p data/docify && sudo chown 10001:10001 data/docify   # Linux only, see below
docker compose -f docker-compose.prod.yml up -d --build
```

Open `http://127.0.0.1:4747/`, or `http://127.0.0.1:4747/#token=<DOCIFY_WEB_TOKEN>` when a token is set. The token is read from the URL fragment, so it never appears in server logs or proxy access logs; the public routes are `/healthz`, which returns `{"ok":true,"version":"X.Y.Z"}`, and the API reference at `/api/docs`, which holds no data.

`DOCIFY_ALLOWED_HOSTS` lists the hostnames the server answers for, comma separated; a bare hostname matches any port. When it is empty and the server binds a non-loopback address, any Host is accepted and a warning is logged, so set it in production. `DOCIFY_BIND` defaults to `127.0.0.1`: put a reverse proxy in front, or set it to `0.0.0.0` when the port must be reachable directly.

State (sqlite, snapshots, `config.json`) lives in a host directory bind-mounted at `/data`: `./data/docify` next to the compose file, or `DOCIFY_DATA_DIR` when set. The container runs as uid 10001. On Linux the directory must be owned by that uid, otherwise the entrypoint stops with a message naming the `chown` to run. Docker Desktop on macOS does not need it. Back up the directory while the container is stopped, or use `docify export`.

To change the embedding provider, edit `data/docify/config.json` on the host and restart:

```bash
docker compose -f docker-compose.prod.yml restart docify
```

Earlier versions of the compose file kept state in the named volume `docify-prod_docify-data`. To move it to the directory, stop the stack and copy it once:

```bash
docker compose -f docker-compose.prod.yml down
mkdir -p data/docify
docker run --rm -v docify-prod_docify-data:/from:ro -v "$PWD/data/docify":/to alpine cp -a /from/. /to/
sudo chown -R 10001:10001 data/docify   # Linux only
docker compose -f docker-compose.prod.yml up -d
```

Remove the old volume with `docker volume rm docify-prod_docify-data` once the UI shows your sources.

For a provider with a custom model, also set `DOCIFY_MODELS_DIR=/data/models` and `DOCIFY_SETUP=true` so the download goes to the writable data directory, then prepare every source again. See "Embeddings" for the provider settings.

### Local documentation

Mount a directory read-only and add it to `DOCIFY_SOURCE_ROOTS`:

```yaml
    volumes:
      - ${DOCIFY_DATA_DIR:-./data/docify}:/data
      - ./docs:/sources:ro
```

Then register and prepare it inside the container:

```bash
docker compose -f docker-compose.prod.yml exec docify bun src/cli.ts add handbook /sources
docker compose -f docker-compose.prod.yml exec docify bun src/cli.ts prepare <source-id> --no-graph
```

Drop `--no-graph` when LiteLLM is configured (`LITELLM_BASE_URL`, `LITELLM_API_KEY`); an unreachable graph provider fails the prepare. The UI can add and prepare the same sources, restricted to the configured roots.

### Coolify

1. Create a Docker Compose resource from the repository, using `docker-compose.prod.yml` as the compose file.
2. Optionally set `DOCIFY_WEB_TOKEN` (16+ characters) and `DOCIFY_ALLOWED_HOSTS` to the domain Coolify gives the app, in the resource's environment variables. Without a token, anyone who finds the domain can use the UI.
3. Set the domain to point at container port `4747`. Coolify's Traefik terminates TLS; the origin check accepts `https://<domain>` behind the proxy.
4. Keep `/data` persistent. Set `DOCIFY_DATA_DIR` to an absolute host path owned by uid 10001, or replace the bind mount with a Coolify-managed volume.
5. Deploy, open `https://<domain>/` (add `#token=<DOCIFY_WEB_TOKEN>` when a token is set), and check that `/healthz` returns 200.

If the domain changes, update `DOCIFY_ALLOWED_HOSTS` and redeploy.

### MCP over HTTP

`docify serve` also answers MCP at `/mcp` (Streamable HTTP, stateless, JSON responses) when `DOCIFY_MCP_TOKENS` is set. Without that variable `/mcp` returns 404. The tools are the same read-only ones as on stdio.

Give every agent its own token, so one can be revoked without touching the rest:

```bash
DOCIFY_MCP_TOKENS="claude:$(openssl rand -hex 32),openclaw-1:$(openssl rand -hex 32)"
```

Agents send `Authorization: Bearer <token>`. For Claude Code:

```bash
claude mcp add --transport http docify https://<domain>/mcp --header "Authorization: Bearer <token>"
```

Requests are checked in this order: Host and Origin, the per-IP limit, the token, the per-client limit. The per-IP limit runs before the token check, so guessing tokens is slow. Over a limit the server answers 429 with `Retry-After`. Request bodies over 1 MB get 413, and only POST is accepted.

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

- Runs as uid 10001 with all capabilities dropped and `no-new-privileges`. A bind mount under `/data` must be writable by that uid (`sudo chown -R 10001:10001 ./data`).
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
| `DOCIFY_ALLOWED_HOSTS` | Optional Host values the web server answers for, comma separated; `*` accepts any |
| `DOCIFY_SOURCE_ROOTS` | Directories the web UI may add local sources from, separated by `:` (default: home) |
| `DOCIFY_MCP_TOKENS` | `name:token` pairs, comma separated; enables MCP over HTTP at `/mcp` |
| `DOCIFY_MCP_RATE`, `DOCIFY_MCP_IP_RATE` | MCP limits per client and per IP (default `60/min`, `120/min`) |
| `DOCIFY_TRUST_PROXY` | `1` takes the client IP from `X-Forwarded-For`; only behind a proxy |
| `LITELLM_BASE_URL`, `LITELLM_API_KEY` | Graph provider and `openai` embeddings, by default |
| `DOCIFY_MCP_URL` | DSH client endpoint; defaults to `http://127.0.0.1:4747/mcp` |
| `DOCIFY_MCP_TOKEN` | DSH client bearer token, matching one token in the service's `DOCIFY_MCP_TOKENS` |

`.env.example` lists them with their defaults. Copy it to `.env` for commands run from the checkout root (`bun src/cli.ts`, `bun test`, `make serve`); Bun reads `.env` only from the current directory, so a linked `docify` elsewhere, and the MCP server need the variables in their own environment.

Design and status: `docs/design.md`, `docs/implementation-plan.md`, `docs/feasibility.md`, `docs/evaluation.md`, `docs/verification.md`.

## License

Copyright (c) 2026 Mariusz Rakus. All rights reserved. See `LICENSE`.
