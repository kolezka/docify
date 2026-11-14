# Verification record

2026-10-21, Apple M4 Pro, macOS, Bun 1.4.2, TypeScript 7.0.2, Claude Code 2.1.305, Codex CLI 0.163.0-alpha.10.2.

## Automated checks

- `bun test`: 29 pass, 0 fail, 5 files (`tests/`). No network and no LLM: real bge-small embeddings from the local cache, a deterministic fake graph runner.
- `bunx tsc --noEmit -p .`: exit 0.
- Re-break checks: re-introducing each fixed bug made its test fail, and restoring the file made it pass. HTML fences, escaped underscores, the pipeline-version shortcut and quadratic token counting are all guarded. The exact-symbol fusion bonus is not isolated by its test (removing it at the default graph weight changes nothing measurable).

Invariants covered: offline restart with identical passage ids; version filters in all four modes; `version_unavailable` with available versions; project pins; no stale hits after edit and delete in any mode; old ids read their own snapshot as `superseded`, then `unavailable` after GC; unchanged snapshots skipped; failures at embed, graph and validate keep the previous generation and report `stale`; provider failure fails the update; `not_indexed`, `source_unknown`, `update_failed`; SIGKILL mid-prepare is recovered as `interrupted`, the lock blocks a second writer, and readers keep the old generation; readers during repeated writes from another process never mix generations; budgets hold and `tokens` equals the count of the returned text; truncation closes fences; absent questions are not `ok`; injected instructions stay inside excerpt delimiters after the untrusted-data header; queries never call `fetch`; crawl stays in origin and path, follows only in-scope redirects, and honours depth, size and page limits; crawled citations carry `url#anchor` and an unknown version.

## Offline queries after restart

Network denied with `sandbox-exec -p '(version 1)(allow default)(deny network*)'`; the control `curl https://example.com` failed with exit 6 inside the sandbox and returned 200 outside. In fresh processes against `~/.cache/docify`, `docify search` in combined, lexical, vector and graph modes, `docify read` and `docify sources` all succeeded. Embedding model reload under the same sandbox gave identical rankings (`docs/feasibility.md`).

## Web UI smoke (headless Chrome via agent-browser)

Against a scratch store on `127.0.0.1:4848`: added `bun@1.2.0` through the form, clicked "Prepare without graph", the row moved to `ready` with generation, passage count and download time; searched "bcrypt cost option for Bun.password.hash" with library and version; the page showed `status ok | 1445 of 1500 tokens | 4 hits`, the exact agent text, and citations; clicking the first citation showed the `read()` text with preceding context and the preserved source path. API checks: wrong Host 403, form-encoded POST 415, local path outside home 400, duplicate prepare 409, unknown raw passage 404, listener bound to 127.0.0.1 only.

## Claude Code (verified)

Host runs below used the code before the review fixes (`e006f11` to `a45f48a`). The fixes changed the excerpt frame text; `scripts/mcp-smoke.ts` passed against the final code, but the hosts were not re-run.

Installed with `claude plugin marketplace add integrations/claude-code` and `claude plugin install docify@docify-local` (user scope). `claude mcp list` showed `plugin:docify:docify: docify mcp - ✔ Connected`. Headless runs (`claude -p`, model `claude-opus-5-5[1m]`) in a scratch git project:

1. A natural question about removing WAL sidecar files: the agent loaded the tools, called `docs_search` (library bun, version 1.4.3), expanded the hit with `docs_read`, and answered citing passage ids.
2. With `docify pin bun 1.2.0` in the project: a search without a version returned only `bun@1.2.0` citations; a request for Bun 2.0 returned `version_unavailable` with available versions 1.2.0 and 1.4.3, which the agent reported verbatim.

## Codex (verified)

The `~/.local/bin/codex` symlink was stale; the working binary is `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`. Installed with `codex plugin marketplace add integrations/codex` and `codex plugin add docify@docify-local`; `codex plugin list` showed `installed, enabled` and `codex mcp list` listed `docify`. `codex exec --json -s read-only` in a scratch project called `docs_sources`, `docs_search`, `docs_read` twice and `docs_search` with version 2.0, all `completed`, and answered with passage ids and the exact `version_unavailable` status line.

Not verified in either host: that the skill alone makes the agent search unprompted (both prompts mentioned local docs or the tools), and interactive (non-headless) sessions.

## Independent review

Reviewer: `kolezka-bootstrap:route-gpt-sol` (`gpt-6-sol[1m]`), read-only, on commit `3258f1e`. 12 findings; all addressed:

| # | Finding | Fix | Regression test |
| --- | --- | --- | --- |
| 1 | Other local OS users could call the loopback API | Per-start random token in the URL fragment, required on `/api` (401 otherwise); store directory is 0700 | `tests/review.test.ts` token test |
| 2 | Cleanup failure after activation deleted the new active generation | Cleanup runs after the activation try, failures are reported only | generations test, fails on old code |
| 3 | Recovery could clear a lock taken between its check and its update | Recovery re-checks inside an immediate transaction and clears only the exact lock it observed | lease test |
| 4 | Vector cache keyed only by generation id leaked across stores | Cache keyed by store and generation; ranked passages restricted to selected generations | two-store test, fails on old code |
| 5 | Nested symlinks escaped the registered root | Symlinks are followed only while their real path stays inside the root | symlink test |
| 6 | Embedding await between scope and ranking could see a garbage-collected generation | Query embedded first; scope and all ranking reads share one read transaction | none (timing dependent) |
| 7 | Status-only and warning output could exceed `maxTokens` | Final rendering enforces the budget, dropping hits then warnings | budget test |
| 8 | A document could close the `>>>` frame and forge status lines | Per-response nonce delimiters, nonce scrubbed from content, citation fields one-line | framing test |
| 9 | Recovery left the staged snapshot directory | Recovery deletes it | snapshot test |
| 10 | Reused pid kept a dead lock alive | Lease renewed every 10 s; older than 60 s counts as dead | lease test |
| 11 | Graphify ignoring SIGTERM could hang prepare | SIGKILL after 5 s; pipes drained with a 5 s cap after exit | none (needs a misbehaving Graphify) |
| 12 | Truncated `~~~` fences closed with backticks | Closing marker matches the opening one | tilde test |

Each regression test with a "fails on old code" claim was run against the pre-fix source (7 of 8 in `tests/review.test.ts` failed there, the eighth was rewritten until it did). Final state: `bun test` 38 pass, 0 fail; tsc exit 0; eval combined 27/28, must-pass 16/16; MCP smoke and browser smoke pass on the token build.

## 2026-11-08: remote LiteLLM embeddings, macOS app, Makefile

Apple M4 Pro, macOS 27, Bun 1.4.4, Swift 6.4. bge-small came from `DOCIFY_MODELS_DIR=/tmp/docify-models`; without the model, 13 tests fail with `ModelNotPreparedError` on `main` and on the branch alike.

### Automated checks

- `make check` on the commit that adds this section: `tsc` exit 0, `bun test` 49 pass, 0 fail. `main` before this work (`9c2f351`) had 41, all passing in two runs; the 8 new tests are in `tests/openai-embed.test.ts`. The 3 Ollama tests from 2026-11-04 (`tests/ollama.test.ts`) pass in both.
- `make app` and `swift build`: exit 0.
- Re-break checks for the `openai` provider: each change below made exactly its own test fail, and the restored file was byte-identical to the original (`cmp`). Dropping the reorder by `index`; dropping the key masking in error bodies; the old identity without the `openai:` prefix; always appending `/v1`; dropping the `Authorization` header; not treating a 400 context-length error as too large; dropping the request timeout; not passing the cancel signal from prepare; not mapping the aborted request to `cancelled`.
- One full-suite run, the first after the model download, had one failure in `tests/generations.test.ts` ("a new process on the same store returns the same passage ids": the 9th hit differed). It did not repeat in five later runs on the branch and was not seen on `main`. Cause unknown.

### macOS app, end to end

Against a temporary store and a fake OpenAI-compatible server on `127.0.0.1`, with the app started without any `LITELLM_*` variables and pointed at the branch CLI through `DOCIFY_BIN`. The app was driven with AppleScript (System Events) and real keystrokes; `agent-device` could not drive the unbundled binary because its runner took focus.

- Settings: typing provider LiteLLM, model, `4` dimensions and `0,6` (Polish decimal comma) and clicking Save while the dimensions field still had focus wrote `openai`, the model, `4`, `0.6` and `"graph": null` to `config.json`. The base URL was stored without the trailing `/v1/`, the key was in the Keychain and not in `config.json`, and the window said every source must be prepared again.
- Prepare from the window: the fake server received `POST /v1/embeddings` with `Authorization: Bearer <test key>`, so the key reached the CLI from the Keychain. The source became `ready` with `openai:<model>` in the Embeddings column. A vector search through the same server returned `ok`.
- Add (sheet), Remove (with confirmation) and Cancel worked. Before the cancel fix, Cancel took effect only after the request in flight finished; the source ended `failed` with "preparation cancelled".
- Found and fixed during this run: number fields only committed on Enter or focus loss, so Save could store the old value; a remote server that stopped answering could hang prepare and ignore Cancel.
- `make app-run` started the app with `DOCIFY_BIN` set to the checkout's `src/cli.ts` (read from the process environment).

Not verified: a real LiteLLM server, similarity thresholds for any remote model, Settings with Ollama selected, and day-to-day use beyond the scripted run. `make link`, `setup`, `serve`, `mcp`, `eval` and `mcp-smoke` were checked with `make -n` only.

## Web UI redesign (2026-11-09)

Svelte 5 and Tailwind v4 rebuild with the Settings view, branch `feat/web-ui-redesign`, Bun 1.4.4.

- `bun test` after rebasing on `b173422`: 74 pass, 0 fail, 12 files. `bun run typecheck`: exit 0. The Svelte compiler reported no warnings for any `.svelte` file; tsc does not check them.
- Re-break checks: each change below made its own test fail, and every file was restored byte-identical. The settings API accepting `graphifyBin`; writing a partial graph object; reading a malformed `config.json` as empty; exposing a credential value; not applying the config after a save; no busy check; pins written to the server's directory instead of the nearest `.docify.json`; Tailwind scanning the current directory (`@import "tailwindcss"` without `source(none)`); building without the Svelte plugin.
- Browser (agent-browser, Chrome, 1280x577, scratch store, server started without `LITELLM_*`): a search showed the status chip, token meter, warnings and citations, and a citation opened its passage. System theme followed the OS; Light and Dark overrode it and were remembered. Add with a path outside home showed the server error. Add inside home, then "No graph", went not indexed, preparing (progress bar, Cancel), ready with 22 passages. Remove asked for confirmation and the CLI no longer listed the source. Settings: switching to LiteLLM applied the bge-m3 preset, the variable chips matched the server environment, weak above strong showed an inline error and disabled Save, and a save wrote exactly the changed keys with no secret values.
- Found and fixed during this run: pasting the link of a restarted server into the same tab changed only the fragment, so the page kept the old token and got 401; the hidden switch checkbox had no positioned parent and stretched the page so the window scrolled.
- Not verified: Cancel from the page (the fixture prepared too fast to catch), pins edited from the page (covered by tests in temp directories), widths below 1280 px, Safari and Firefox.

## Store moved to ~/.config/docify (2026-11-09)

Branch `feat/config-home`, Bun 1.4.4, Swift 6.4. The machine had only `~/.cache/docify`, so the tests loaded bge-small through the new fallback.

- `bun test`: 76 pass, 0 fail, 12 files (74 on `main` plus 2 new). `bun run typecheck` and `swift build`: exit 0.
- Re-break checks for `docifyHome()`, each restored byte-identical (`cmp`): always returning `~/.config/docify` failed the legacy assertion; preferring `~/.cache/docify` whenever it exists failed the both-exist assertion.
- The moved-store test failed on the old cleanup, which deleted the stored absolute `snapshot_dir` and so left the moved snapshot behind, and passes with paths built from `config.home`.
- CLI with a scratch `HOME`: an empty home created `.config/docify/docify.sqlite`; a home with only `.cache/docify` used it and created no `.config/docify`.
- One early run of `tests/generations.test.ts` had one failure whose name was not captured; seven later runs of the file and the full suite passed. Probably the intermittent failure recorded on 2026-11-08, not confirmed.
- Not verified: the macOS app reading the new path at runtime (compiled only), and the README move steps on a real store.

## Native ONNX telemetry shutdown (2026-11-09)

macOS 27.0.1, Bun 1.4.4, Transformers.js 4.3.1, ONNX Runtime 1.30.0, branch `feat/docify-logs`. Models came from the existing local cache through `DOCIFY_MODELS_DIR`; no models were downloaded.

- Before the fix, the full suite reported 110 passing tests and then aborted with exit 134. The native crash report showed `Microsoft::Applications::Events::HttpResponseDecoder` and `DebugEventSource::DispatchEvent` inside `libonnxruntime.1.dylib`, ending in `std::recursive_mutex::lock()` and an uncaught C++ system error.
- A direct native `getenv` probe returned no value after JavaScript set `process.env.ORT_DISABLE_TELEMETRY = "1"`. The version-matched Transformers entrypoint does set that flag before loading the binding, but this does not update Bun's native process environment.
- Positive control: native `setenv` wrote a fixture value that native `getenv` read back. Setting `ORT_DISABLE_TELEMETRY=1` in the shell before launching the unchanged suite produced 110 pass and exit 0.
- The fix applies native `setenv` before loading ONNX. It does not force process exit, skip tests, add a test-runner environment override or change the inference model. The standalone embedding probe uses the same bootstrap.
- Regression: a fresh child starts with the native flag `0`; an observer on the real `process.dlopen` call requires `1` before `onnxruntime_binding.node` loads. On the old entrypoint it failed with expected `["1"]`, received `["0"]`. Removing only the native write or moving the bootstrap after the Transformers import each reproduced that same assertion failure (exit 1). Restored sources passed (exit 0).
- Final full suite without a telemetry environment override: 111 pass, 0 fail, exit 0. `bun run typecheck`: exit 0.

Runtime verification is scoped to macOS. The Linux libc path and non-POSIX branch were source-reviewed, not executed. Rendered Logs browser acceptance and independent review of PR #18 remain separate pending gates.

## 2026-11-08: hosted deployment (Docker, Coolify)

Recorded on the branch before it was rebased onto `main` at `2ec9f08`; the rebased tree is checked in the next section.

Apple M4 Pro, macOS 27, Bun 1.4.4, Docker 29.9.2, Docker Compose v5.6.0. Docker Desktop had a 24 GB VM; unused build cache was pruned before the recorded build, after an earlier `bun install` failed with `ENOSPC`. bge-small came from `~/.cache/docify/models`.

### Automated checks

- `bun run typecheck`: exit 0.
- `bun test`: 55 pass, 0 fail, 708 `expect()` calls, 9 files. The 6 new tests are in `tests/host.test.ts` (host allowlist, Origin behind TLS, source roots, `/healthz`, token).
- `DOCIFY_WEB_TOKEN=... DOCIFY_ALLOWED_HOSTS=docify.example.com docker compose -f docker-compose.prod.yml config`: exit 0; the service publishes `127.0.0.1:4747`, mounts `docify-data` at `/data`, and the healthcheck requests `/healthz`.
- `docker build -t docify:hosting-test .`: exit 0; image 2.48 GB on linux/arm64. The build's own `setup` installed Graphify 0.9.70 and `Xenova/bge-small-en-v1.5` under `/opt/docify`; `graphify --version` runs as uid 10001.

### Container, end to end

Image run as `-e DOCIFY_WEB_TOKEN=... -e DOCIFY_ALLOWED_HOSTS=docs.example.test -p 127.0.0.1:4799:4747 -v /tmp/docify-src:/sources:ro`:

- Startup: "Docify UI listening on 0.0.0.0:4747; the access token comes from DOCIFY_WEB_TOKEN."; `id` showed uid 10001(docify); the container reached `healthy`.
- `/healthz`: 200 without a token, also with `Host: evil.test`.
- `/api/sources`: 401 without a token, 200 with the token on loopback, 403 with `Host: evil.test`, 200 with `Host: docs.example.test`.
- POST `/api/search` with `Origin: https://docs.example.test`: reached the route (400 for an empty query). Cross-site Origin: 403. Form content type: 415.
- `bun src/cli.ts add demo /sources` and `prepare demo@unknown --no-graph` ran as uid 10001; generation 1 activated with `{"pipeline":5,"documents":1,"passages":1,"embedMs":305}`. `sources --json` showed `ready`, `Xenova/bge-small-en-v1.5`, 384 dimensions, `graphStatus: skipped`. The baked model produced embeddings inside the container.
- API search "where does the zebra live": `status: ok`, one hit from `demo@unknown`, `demo.md > Demo > Alpha`, lines 3-5.
- Adding `/etc` through the web API: 400, `local sources must be inside DOCIFY_SOURCE_ROOTS (/sources)`.

### Compose, end to end

`cp .env.example .env` with a random token, then `docker compose -f docker-compose.prod.yml up -d --build`: the stack reached `healthy`; volume `docify-prod_docify-data` was created. `/healthz` returned `{"ok":true}`; `/api/sources` returned 401 without the token and 200 with it. After `docker compose restart docify`, the same token still returned 200. The stack and its volume were removed after the run.

### Not verified

linux/amd64 (the Dockerfile has no architecture-specific steps, but the x64 onnxruntime binaries were not executed here), Coolify itself, a real Traefik or Caddy TLS proxy, `DOCIFY_SETUP=true` at container start, and more than one `DOCIFY_SOURCE_ROOTS` entry in production.

## 2026-11-09: hosted deployment rebased onto main

Rebased onto `main` at `2ec9f08` (logs, config home, Svelte UI). Conflicts in `src/web/server.ts` kept the logs route, the Svelte asset handler and the project pins, and added `/healthz` and the host, Origin and source-root checks. `.env.example` keeps the development variables and adds the hosted ones commented out.

- `bun run typecheck`: exit 0.
- `DOCIFY_MODELS_DIR=~/.cache/docify/models bun test`: 117 pass, 0 fail, 19 files, exit 0.
- `docker compose -f docker-compose.prod.yml config --quiet` with a token and allowed host set: exit 0.
- Not run on the rebased tree: `docker build`. `main` now depends on `svelte-log-viewer` through `git+ssh` to a private repository, and the image has no SSH key, so the build is expected to fail at `bun install` until that dependency is reachable from the build.

## 2026-11-09: MCP over HTTP

Branch `feat/mcp-http` on `feat/host-deployment` at `46553d7`, macOS 27, Bun 1.4.4, MCP SDK 1.32.1.

- `bun run typecheck`: exit 0.
- `DOCIFY_MODELS_DIR=~/.cache/docify/models bun test`: 132 pass, 0 fail, 21 files, exit 0. New: `tests/http.test.ts` (9) and `tests/mcp-http.test.ts` (6, real server and SDK client).
- Re-break checks, one at a time, each file restored byte-identical: no bearer auth, auth before the IP limit, no client limit, no body limit, no host guard, GET accepted, `/mcp` on without tokens, first instead of last `X-Forwarded-For` entry, token prefix accepted. Each made its own test fail at an `expect` assertion (exit 1).
- Live `bun src/cli.ts serve --port 4791` with `DOCIFY_MCP_TOKENS` and `DOCIFY_MCP_RATE=3/min` from the environment: startup line named the client and limits; `tools/list` without a token returned 401, then three 200 responses listing `docs_search`, `docs_read`, `docs_sources`, then 429 with `Retry-After: 20`.
- `docker compose -f docker-compose.prod.yml config` with `DOCIFY_MCP_TOKENS` set: exit 0, rates default to `60/min` and `120/min`, `DOCIFY_TRUST_PROXY` to `1`.
- Not verified: OpenClaw as a client, Claude Code's `claude mcp add --transport http` against a deployed server, Traefik's `X-Forwarded-For` in Coolify, and `docker build` (same `svelte-log-viewer` blocker as above).

## 2026-11-12: compose state in host directories

Both compose files bind-mount a host directory instead of a named volume: `docker-compose.prod.yml` mounts `${DOCIFY_DATA_DIR:-./data/docify}` at `/data`, `docker-compose.yml` mounts `${OLLAMA_DATA_DIR:-./data/ollama}` at `/root/.ollama`. macOS 27, Docker 29.9.2 (Docker Desktop).

- `docker compose config --quiet` for both files: exit 0. The rendered prod mount is `type: bind` from `<checkout>/data/docify`, and from `/srv/docify` with `DOCIFY_DATA_DIR=/srv/docify`.
- `docker build`: exit 0. With the stack up from that image on the default path, `docify add bindtest /sources` wrote `docify.sqlite` and `logs.sqlite` into `./data/docify`. After `down` and `up`, `docify sources` still listed `bindtest@unknown`.
- Entrypoint guard: the image run with `--tmpfs /data:uid=0,mode=0755` exited 1 with `/data is not writable by uid 10001`. A shell run against a writable directory reached `bun ... serve`.
- Ollama dev service: reached `healthy` and wrote `models/`, `cache/` and its key into `./data/ollama`, which stayed after `down`. `git status` does not show `data/`.
- Not verified: a Linux host (Docker Desktop maps bind-mount ownership, so the `chown 10001:10001` step was not exercised there), Coolify, and the named-volume migration commands in the guide.

## 2026-11-13: /sources mount under Coolify

Coolify 4.7.5 deployed this compose file with `DOCIFY_SOURCES_DIR=/home/<user>/Development` set and still mounted `/data/coolify/applications/<id>/Development` at `/sources`. The same happened to `/data` at commit `323207e`: `DOCIFY_DATA_DIR=/data/docify` was set, the default was `./data/docify`, and the mount came from the application directory. After the default became `/data/docify`, the mount was `/data/docify`. Coolify used the default, not the variable. Observed on three deploys, not read in Coolify's code. The mount now has no default.

- `docker compose -f docker-compose.prod.yml --env-file /dev/null config` without the variable: exit 1, `required variable DOCIFY_SOURCES_DIR is missing a value`.
- With `--env-file .env.example`: exit 0, source `/Users/<user>/Development` (compose expands `~`), `read_only: true`.
- With `DOCIFY_SOURCES_DIR=/tmp`: exit 0, source `/tmp`.
- Coolify refused the deploy of `0eabe60`: `Invalid volume source: contains forbidden character '${'`. `${VAR:-/absolute}` passes its check, `${VAR:?message}` does not.

The mount went back to a default, now absolute: `${DOCIFY_SOURCES_DIR:-/srv/docify/sources}`. On RTX, `/srv/docify/sources` links to `/home/<user>/Development`. A container from the deployed image run as uid 10001 with `-v /srv/docify/sources:/sources:ro` listed `/sources/inkitt/knowledge-base` and found 274 Markdown files, so Docker follows the link.

### ~/Development mounted at /sources

`docker-compose.prod.yml` mounts `${DOCIFY_SOURCES_DIR:-~/Development}` read-only at `/sources`.

- `docker compose config`: the source renders as `/Users/<user>/Development` (compose expands `~`), and as `/tmp` with `DOCIFY_SOURCES_DIR=/tmp`; `read_only: true`.
- In the running container, `touch /sources/x` failed with `Read-only file system`.
- `docify add docify /sources/docify` and `prepare docify@unknown --no-graph`: generation 1 activated with 19 documents and 225 passages.
- `docify search "how are generations activated" --source docify@unknown --max-tokens 300`: status `weak_match`, top hit `CLAUDE.md > Architecture`, lines 36-46.
- Not verified: a Linux host, where the files must be readable by uid 10001.

## 2026-11-14: per-source ignore patterns

Branch `feat/ignore-paths` on `5d0cd58`, macOS, Bun 1.4.4. The model cache in the default store held only an interrupted download (`onnx/model.onnx.tmp.*`, no `model.onnx`), so the suite ran with `DOCIFY_MODELS_DIR` pointing at a fresh copy of the model. Without it `main` and the branch fail the same 30 tests with `ModelFileNotFoundError`.

- `bun test`: 318 pass, 0 fail in 56 files (313 in 55 before the web UI pass). `main` with the same model: 304 pass, 0 fail in 54 files. `bun run typecheck`: exit 0.
- After merging `main` at `4c114ac` (collection summaries in the web UI): `bun test` 322 pass, 0 fail in 57 files, `bun run typecheck` exit 0. The one conflict was an import line in `SourcePage.svelte`; `main` also turned `busy` into a derived value, so `saveIgnore` now sets `actionBusy`. The source page was opened again in Chromium: Collection summary and Ignored paths both render, and a rejected pattern still lands at its field with Save enabled afterwards.
- `tests/ignore-paths.test.ts` against a local server that records every request: with `ignore: ["^changelog/"]` no `/docs/changelog/` path was requested, including the target of a 301 from `moved.html`. The first version checked the pattern after the redirect was followed and did fetch that page; the test caught it.
- Same file: `graphIgnore` documents were not passed to the graph runner, got no nodes, were found by lexical search, and the generation had `graph_status = ok` with an empty `graphMissing`. A second prepare was `unchanged`; changing or removing the list activated a new generation. A list matching every document gave `graph_status = skipped` and the runner was not called.
- Each guard was switched off in turn (link filter, redirect check, local file filter, start URL check, runner input, `importGraph` input, the unchanged comparison, the skip when every document matches, PATCH validation). All nine made a test fail; the sources were restored and compared by SHA-256. The same was done for the two web UI inputs: without `field` in the error response `tests/web.test.ts` fails, and without the ignored count in `graphView` `tests/graph-view.test.ts` fails.
- Web UI in Chromium through `docify serve` on a scratch store, first version: the source page showed both lists, a valid edit was stored, a local source has the same group, and New Source stored both lists. In a 720 px high window the sheet body scrolled (690 px of content in 552 px) and Add Source stayed visible. A rejected pattern only appeared in the page banner; the next bullet covers the change.
- Web UI, second pass (same setup, sources prepared with `fakeGraph`): saving `^api/(v1` under Do not collect kept the form open, focused that field, gave it `aria-invalid="true"` and a red border, and showed `"^api/(v1" is not a valid regular expression (missing ))` under it; the other field stayed valid and the stored lists did not change. Editing the field cleared the message and a valid save closed the form. New Source with `[a-` under Leave out of the graph kept the sheet open with the message at that field in view, added no source, and added it once the pattern was fixed. A source with two of three pages matching `graphIgnore` read "2 pages left out by ignore patterns. Every other page has graph nodes" on its page and "Ignored pages 2" on the Graph tab. A source whose only page matches read "Every page matches the ignore patterns, so no graph was built", and the Graph tab said the same with a pointer to the source page.
- Not verified: a prepare against a real website or a real Graphify run with these lists (tests use a local server and `fakeGraph`), the Crawl4AI and Browserless collectors (they share `crawl()`, but no test ran them with `ignore`), and the macOS app.
