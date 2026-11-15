# Changelog

## 0.2.1 (2026-11-15)

### Features

- feat: add docify compress to gzip existing snapshot files
- feat: store raw HTML and normalized copies gzipped
- feat: add Graphify request and retry settings
- feat: set the total crawl size limit in megabytes
- feat(web): add node search, camera movement and animation to the Graph tab
- feat: report ignore patterns at their field and in graph status
- feat: add per-source ignore patterns for collection and graph
- feat(web): show and generate collection summaries on the source page
- feat: generate collection summaries for topic discovery
- feat: reuse stored embeddings for unchanged passages
- feat: connect Claude Code plugin to a Docify service over HTTP
- feat: log crawler progress and skip reasons to Logs
- feat: mount ~/Development read-only as local sources
- feat: keep compose state in local host directories
- feat: make DOCIFY_WEB_TOKEN and DOCIFY_ALLOWED_HOSTS optional
- feat: configure total crawl byte limit
- feat: configure crawl page and depth limits
- feat: show indexed source document tree
- feat: configure Graphify runtime settings
- feat(web): rebuild every view in the Apple HIG style
- feat(web): add HIG tokens, sidebar shell and shared components
- feat: add DeepSeek Harness adapter for the docify plugin
- feat: extend per-source Crawl4AI crawling
- feat: select crawler per documentation source
- feat: export and import the whole store
- feat: default multi-query budget to 1400 tokens per query
- feat: add a 3D graph tab to the web UI
- feat: let docs_search take several queries in one call
- feat: add read-only docs_open MCP tool for whole documents and sections
- feat: add read-only docs_outline MCP tool
- feat: add read-only docs_scope MCP tool
- feat: add the docify crab-with-magnifier icon as SVG
- feat: share one version across docify and the agent plugins
- feat: serve Swagger UI for the web API at /api/docs
- feat: serve MCP over HTTP with per-client tokens and rate limits
- feat: add Docker and Coolify deployment
- feat: add live Docify logs with Graphify output
- feat: add optional Crawl4AI collection provider
- feat: keep the store in ~/.config/docify
- feat: rebuild the web UI in Svelte with settings and dark mode
- feat: add lexicalWeight for word matches in combined search
- feat: crawl llm.txt and llms.txt documentation indexes
- feat: add a macOS app for sources and provider settings
- feat: add an OpenAI-compatible embedding provider for remote LiteLLM
- feat: add an Ollama embedding provider with bge-m3 and a docker-compose
- feat: add one-screen loopback web UI
- feat: add retrieval evaluation and fix issues it exposed
- feat: add MCP server and Claude Code and Codex plugins
- feat: add core store, generations and CLI vertical slice

### Fixes

- fix(graph): treat graph timeoutSeconds as an inactivity limit
- fix: give the /sources mount an absolute default
- fix: require DOCIFY_SOURCES_DIR in the prod compose
- fix: request stealth browser from Crawl4AI
- fix: store compose state in /data/docify with exact permission hint
- fix: connect DSH adapter to HTTP MCP
- fix(web): put settings More menu in the section track
- fix(web): address review of the HIG redesign
- fix: show Crawl4AI settings only when active
- fix: keep queries read-only, derive interrupted generations at read time
- fix: keep browse tools on one snapshot and within max_tokens
- fix: disable native ONNX telemetry before loading embeddings
- fix: discover linked documentation and Markdown exports
- fix: keep a partial Graphify graph instead of failing prepare
- fix: build snapshot cleanup paths from the store home
- fix: give every crawled page its own snapshot file
- fix: address independent review findings
- fix: keep an activated generation when old-generation cleanup fails

### Other

- docs: record the checks after merging main
- docs: describe Graph tab search and camera controls
- docs: stop naming a HIG source id that no store has
- docs: record verification after merging main
- ci: add manual shared-version release action
- 0.2.0
- chore(dsh): match adapter version to plugin, use runtime 0.2.0
- build: join the external shared-services network in prod compose
- docs: add LiteLLM config.example.json
- refactor: load the DSH adapter runtime from the npm package
- docs: rewrite README as a product overview
- chore: add proprietary license, all rights reserved
- chore: remove the macOS app
- docs: add Docify and Apple HIG guidance to CLAUDE.md
- chore: ver. bump
- docs: measure multi-query budget in combined and vector modes
- docs: tell agents how to react to a too-small max_tokens error
- chore: vendor svelte-log-viewer into the web UI
- docs: describe partial graphs and record their verification
- chore: add .env.example with every variable Docify reads
- docs: describe the new web UI and record its verification
- docs: record the combined vs vector diagnosis and the lexical weight result
- docs: add a page-level evaluation and record the windows result
- docs: measure embedding thresholds through a remote LiteLLM
- docs: refresh the README for LiteLLM embeddings, the app and the CLI
- docs: bring docs up to date with LiteLLM embeddings, the app and the Makefile
- build: add a Makefile with shortcuts for common commands
- docs: replace the Bun starter CLAUDE.md with project guidance
- docs: amend the offline-query default for the Ollama provider
- docs: note UI token and close plan status
- docs: record verification evidence and plan status
- test: add invariant suite and fix quadratic token counting
- docs: record Graphify and embedding feasibility evidence
- chore: baseline Bun starter and Docify handoff docs

