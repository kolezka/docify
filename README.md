# Docify

Docify keeps documentation on disk and gives AI agents cited, token-bounded excerpts from it. Preparation (download, normalization, embeddings, Graphify semantic graph) is an explicit step. Queries are local and offline, unless you choose an embedding server on another machine: a remote Ollama or an OpenAI-compatible server such as LiteLLM (see Embeddings).

## Install

```bash
bun install
bun link                 # puts `docify` on PATH (~/.bun/bin)
docify setup             # pinned Graphify into ~/.config/docify/graphify-venv, embedding model into ~/.config/docify/models
```

`setup` is the only command that downloads models. The store lives in `~/.config/docify` (override with `DOCIFY_HOME`), outside any plugin directory.

Older versions kept the store in `~/.cache/docify`. Docify keeps using it while `~/.config/docify` does not exist. To move it, first make sure every `docify` you run is this version (an older one would create a new empty store at the old path), stop `docify serve`, the macOS app and agent sessions running `docify mcp`, then:

```bash
mkdir -p ~/.config && mv ~/.cache/docify ~/.config/docify
rm -rf ~/.config/docify/graphify-venv && docify setup   # the venv's scripts hold absolute paths
```

`make` lists shortcuts for these and the other commands below: `make check` type-checks and tests, `make app-run` builds and opens the macOS app with this checkout's CLI.

## Embeddings

On macOS and glibc Linux, Docify disables native ONNX telemetry before loading the embedding backend. Setting only JavaScript's `process.env` does not update the environment seen by the native library in Bun.

The default is `Xenova/bge-small-en-v1.5` in process, with no server. For multilingual or larger corpora, docify can embed with `bge-m3` on an Ollama server instead:

```bash
docker compose up -d     # Ollama on 127.0.0.1:11434, pulls bge-m3 (about 1.5 GB the first time)
```

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

## Web UI

`docify serve` starts a local page on `127.0.0.1` and prints its URL once, with a per-start access token. Workspace registers, prepares and removes sources and shows the exact text a search hands to agents. Settings edits every `config.json` key, shows which environment variables the server sees (credential values are never shown) and edits project pins in `.docify.json`. `graphifyBin` and `modelsDir` are read-only there because Docify runs or loads code from them; change them in `config.json` or with `DOCIFY_GRAPHIFY_BIN` and `DOCIFY_MODELS_DIR`. A save is refused while the page is preparing a source. The theme follows the system unless you pick Light or Dark in the top bar.

The **Logs** tab uses a log viewer vendored from `kolezka/svelte-log-viewer` (`src/web/lib/log-viewer/`) for timestamped preparation progress, errors, warnings and live Graphify stdout/stderr. It polls once per second, offers text and stream filters and follows new lines. CLI and web preparations share the latest 10,000 log lines in `<DOCIFY_HOME>/logs.sqlite`; each line is limited to 8,192 characters. Configured embedding and graph API-key values are redacted before storage. Failed reads are reported in the view without clearing lines already loaded. Only runs made with this logging-enabled build are recorded; older runs have no history.

The **Graph** tab draws the active generation's Graphify graph in 3D with WebGL2: drag to orbit, scroll to zoom, click a node to see the page it came from, the passage that grounds it and what it links to. Faded nodes have no grounding passage. Pages Graphify left without nodes are listed in the inspector. A source prepared with **No graph** has nothing to show here. The browser needs WebGL2.

## macOS app

`apps/macos` is a small SwiftUI window (macOS 14 or later, built with the Swift toolchain) that lists sources and adds, prepares, cancels and removes them. Its Settings window switches the embedding provider and the graph model, and keeps the LiteLLM URL and key; the key goes to the macOS Keychain, never to `config.json`. The app runs the `docify` CLI, so it shares the store with the CLI and the web UI.

```bash
make app-run             # build and open it with this checkout's CLI
```

See `apps/macos/README.md` for details.

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

The usual crawl limits apply: at most 50 documents (including the index), two link levels, 5 MB per page and 50 MB total. This is a bounded crawl, not a guarantee that the whole site is indexed.

### JavaScript-rendered documentation (Crawl4AI)

Pages that only fill in with JavaScript can be rendered by a [Crawl4AI](https://docs.crawl4ai.com/core/self-hosting/) server you run yourself. It is off by default; turn it on in `config.json` (or the web UI's Settings, under Web crawling):

```json
{
  "crawlProvider": "crawl4ai",
  "crawl4aiUrl": "http://127.0.0.1:11235",
  "crawl4aiApiKeyEnv": "CRAWL4AI_API_KEY",
  "crawl4aiTimeoutSeconds": 120
}
```

`crawl4aiApiKeyEnv` is the name of the variable holding the server's bearer token, never the token. Docify still runs the crawl: it asks the server to render one page per request (`POST /crawl`), reads links from the rendered HTML and applies the same origin, path, depth and size limits. The server's browser loads each page's scripts, redirects and subrequests by itself, so a page that ends outside the source is dropped after rendering, not prevented. Markdown pages and `llms.txt` indexes keep their Markdown links when the browser wraps their text in HTML. `.md` exports are not probed in this mode. If the server is down, times out or answers with something malformed, the prepare fails and the previous generation keeps serving; Docify does not fall back to the built-in crawler. Local sources and queries never use it. The macOS app has no control for it yet; it keeps these keys when it saves `config.json`.

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
docify serve             # one-screen UI; open the printed http://127.0.0.1:4747/#token=... URL (--port to change)
docify mcp               # MCP server on stdio: docs_search, docs_read, docs_outline, docs_open, docs_sources, docs_scope
```

`search` also takes `--version`, `--source` (repeatable), `--mode` and `--graph-weight`; `search`, `read`, `outline` and `open` take `--json` for the full result. `outline` (MCP `docs_outline`) lists the documents of a source's active generation with the passage id of each section, for browsing when search finds nothing; `--path` keeps documents under a path prefix and `--max-tokens` caps the output (default 2000). `open` (MCP `docs_open`) returns a whole document, or one section with its subsections when `--heading` is given, from the active generation, cut at a passage boundary to fit `--max-tokens` (default 3000) with the passage id to continue from. Its statuses are `ok`, `not_found`, `not_indexed` and `source_unknown`. `docify search --query A --query B` runs up to 8 queries in one call.

The MCP tool `docs_search` takes `query` or `queries` (1 to 8, exactly one of the two), plus `library`, `version`, `sources`, `mode`, `max_tokens` and `graph_weight`. With `queries`, every query runs with the same filters and keeps its own status line, all of them share `max_tokens`, and a passage found by several queries is shown once with the query numbers that hit it. Each query first gets an equal share of the budget, then the leftover goes to the remaining hits round-robin by rank (`docs/evaluation.md`, "Several queries in one call"). A single `query` returns the same text as before. Project pins are read from `./.docify.json`, or from the directory in `DOCIFY_PROJECT`.

Search statuses: `ok`, `weak_match` (hits with a low-confidence warning), `no_match`, `not_indexed`, `version_unavailable`, `source_unknown`, `update_failed`. Modes: `combined` (default: lexical, vector and exact-symbol fusion), `lexical`, `vector`, `graph`. `--graph-weight` adds graph hits to combined fusion; it defaults to 0 because it lowered recall on the evaluation corpus (`docs/evaluation.md`). `lexicalWeight` in `config.json` (default 1) sets the weight of word matches in that fusion. With bge-m3, `0.5` measured better: pages that only share words with a question, common with non-English questions, no longer push the vector's answer down.

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

The plugins start `docify mcp --require <their version>`. If the `docify` on PATH is older, the MCP server does not start and the error names both versions; run `bun link` in a current checkout. A `docify` from before this check does not know `--require` and fails on the unknown option, which also means it needs updating.

## Versions and releases

Docify and both plugins share one version. `package.json` holds it; `docify --version`, the MCP server info and `/healthz` report it. `scripts/release.ts` is the only thing that should change it:

```bash
bun scripts/release.ts patch --dry-run   # show the next version and its changelog section, write nothing
bun scripts/release.ts minor             # or patch, major, or an explicit X.Y.Z
git push --follow-tags
```

It needs a clean working tree. It writes the new version into `package.json`, both plugin manifests and the `--require` arguments, adds a `CHANGELOG.md` section built from the Conventional Commits since the last `v*` tag, then commits `chore: release vX.Y.Z` and creates an annotated tag. It does not push. `tests/version.test.ts` fails when the files disagree.

## Hosting (Docker, Coolify)

The image runs the web UI on port 4747 and keeps state in `/data`. It ships the bge-small model and the Graphify runtime, so the default `transformers` provider works without network access. Every request to `/api` needs the access token; there is no anonymous mode.

### Compose

```bash
cp .env.example .env          # set DOCIFY_WEB_TOKEN (16+ characters) and DOCIFY_ALLOWED_HOSTS
docker compose -f docker-compose.prod.yml up -d --build
```

Open `http://127.0.0.1:4747/#token=<DOCIFY_WEB_TOKEN>`. The token is read from the URL fragment, so it never appears in server logs or proxy access logs; the public routes are `/healthz`, which returns `{"ok":true,"version":"X.Y.Z"}`, and the API reference at `/api/docs`, which holds no data.

`DOCIFY_ALLOWED_HOSTS` lists the hostnames the server answers for, comma separated; a bare hostname matches any port. When it is empty and the server binds a non-loopback address, any Host is accepted and a warning is logged, so set it in production. `DOCIFY_BIND` defaults to `127.0.0.1`: put a reverse proxy in front, or set it to `0.0.0.0` when the port must be reachable directly.

State lives in the `docify-prod_docify-data` volume (sqlite, snapshots, `config.json`). To change the embedding provider, edit that file and restart:

```bash
docker compose -f docker-compose.prod.yml cp docify:/data/config.json ./config.json
# edit ./config.json
docker compose -f docker-compose.prod.yml cp ./config.json docify:/data/config.json
docker compose -f docker-compose.prod.yml restart docify
```

For a provider with a custom model, also set `DOCIFY_MODELS_DIR=/data/models` and `DOCIFY_SETUP=true` so the download goes to the writable volume, then prepare every source again. See "Embeddings" for the provider settings.

### Local documentation

Mount a directory read-only and add it to `DOCIFY_SOURCE_ROOTS`:

```yaml
    volumes:
      - docify-data:/data
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
2. Set `DOCIFY_WEB_TOKEN` (16+ characters) and `DOCIFY_ALLOWED_HOSTS` to the domain Coolify gives the app, in the resource's environment variables.
3. Set the domain to point at container port `4747`. Coolify's Traefik terminates TLS; the origin check accepts `https://<domain>` behind the proxy.
4. Keep `/data` persistent. The named volume in the compose file is enough; a Coolify-managed volume works too.
5. Deploy, open `https://<domain>/#token=<DOCIFY_WEB_TOKEN>`, and check that `/healthz` returns 200.

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
| `DOCIFY_WEB_TOKEN` | Stable web token (16+ characters); without it every `serve` start generates a new one |
| `DOCIFY_ALLOWED_HOSTS` | Host values the web server answers for, comma separated; `*` accepts any |
| `DOCIFY_SOURCE_ROOTS` | Directories the web UI may add local sources from, separated by `:` (default: home) |
| `DOCIFY_MCP_TOKENS` | `name:token` pairs, comma separated; enables MCP over HTTP at `/mcp` |
| `DOCIFY_MCP_RATE`, `DOCIFY_MCP_IP_RATE` | MCP limits per client and per IP (default `60/min`, `120/min`) |
| `DOCIFY_TRUST_PROXY` | `1` takes the client IP from `X-Forwarded-For`; only behind a proxy |
| `LITELLM_BASE_URL`, `LITELLM_API_KEY` | Graph provider and `openai` embeddings, by default |
| `DOCIFY_BIN` | `docify` executable the macOS app runs |

`.env.example` lists them with their defaults. Copy it to `.env` for commands run from the checkout root (`bun src/cli.ts`, `bun test`, `make serve`); Bun reads `.env` only from the current directory, so a linked `docify` elsewhere, the MCP server and the macOS app need the variables in their own environment.

Design and status: `docs/design.md`, `docs/implementation-plan.md`, `docs/feasibility.md`, `docs/evaluation.md`, `docs/verification.md`.
