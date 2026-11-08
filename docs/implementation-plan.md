# Docify implementation plan

Status (2026-10-21, branch `feat/docify-mvp`): phases 0 to 6 implemented and verified on the fixture corpus; independent review done and its 12 findings fixed (`docs/verification.md`). Evidence: `docs/feasibility.md`, `docs/evaluation.md`, `docs/verification.md`.

| Phase | State | Notes |
| --- | --- | --- |
| 0 Workspace and feasibility | done | Git baseline, worktree, Graphify 0.9.70 via uv, LiteLLM `deepseek/deepseek-flash-nothink` chosen by the user, bge-small-en-v1.5 chosen by probe |
| 1 Storage and vertical slice | done | Local Markdown/MDX/HTML and bounded crawl, snapshots, generations, CLI slice |
| 2 Indices and retrieval | done | FTS5, vectors, grounded graph, four modes; graph fusion weight defaults to 0 on evidence |
| 3 Interfaces and jobs | done | CLI and MCP share the core; lock, progress, cancel, recovery |
| 4 UI | done | Loopback one-screen UI, browser smoke passed |
| 5 Clients | done | Claude Code and Codex installed and exercised separately |
| 6 Evaluate and close | done | 28 questions, targets met in combined mode; known limits in `docs/evaluation.md` |

Work after the MVP, outside these phases:

| Change | Date | Evidence |
| --- | --- | --- |
| Ollama embedding provider (`bge-m3`), per-model similarity thresholds, docker-compose | 2026-11-04 | `docs/evaluation.md` |
| OpenAI-compatible embedding provider for a remote LiteLLM, with request timeout and cancel | 2026-11-08 | `docs/verification.md` |
| macOS app (`apps/macos`) for sources and provider settings | 2026-11-08 | `docs/verification.md` |
| `Makefile` shortcuts and a project `CLAUDE.md` | 2026-11-08 | `docs/verification.md` |

Implement the MVP in small, reviewable commits, with a working vertical slice early. Use `docs/design.md` for scope and contracts. Do not remove Graphify, embeddings, or either client integration to declare completion. Proposed defaults become working assumptions when the implementation prompt is used; record any subsequent user decisions.

## Phase 0: establish the workspace and prove feasibility

Reinspect `/Users/me/Development/ai-docify`, applicable instructions, dependency files, installed runtimes, and existing user changes. The recorded starter state may have changed. Preserve unrelated files and use the project's Bun tooling.

First check for both a project repository and a containing repository. If neither exists, initialize Git in the project, deliberately stage reviewed project files and handoff documents, and create the initial baseline commit. Check exclusions and avoid secrets or generated artifacts. Do not use blind `git add -A`. Then create an isolated `feat/docify-mvp` worktree before editing product code. If that branch or worktree already exists, inspect it and reuse it only when it belongs to this work; otherwise choose a fresh branch name. Do not push, publish, or deploy.

Prepare a small public documentation fixture containing several related Markdown pages, an HTML page, an exact API symbol, a code block, a warning, and two distinguishable versions. Give expected passages stable fixture IDs. First verify that the evaluation harness can find known positive passages and reject absent ones. A broken measurement tool must not become a product diagnosis.

Pin and inspect Graphify in an isolated Python environment. Verify supported document ingestion, extraction backend selection, output structure, and query interfaces. Run real semantic extraction and inspect useful concepts and relationships against source evidence. Demonstrate passage grounding, persisted output, restart, and offline queries. Modify and delete a document and verify which supported operation actually refreshes semantic output. Record commands, versions, provider, duration, and observed cost without recording credentials.

Run a bounded local embedding comparison on exact queries and semantic paraphrases. Choose one model based on observed retrieval and machine limits, recording its identity and dimensions. Cache its assets and verify offline reload. Separate model preparation from query execution.

Exit condition: actual semantic document extraction and embeddings work, or a specific capability/provider decision is documented with evidence. If Graphify is infeasible, continue independent components but do not substitute it silently. If a suitable local provider is unavailable, ask one focused provider/budget question before paid or remote processing. Environment keys are not consent.

## Phase 1: source storage and an initial vertical slice

Implement local Markdown/HTML import first, then bounded public static URL ingestion. Enforce crawl origin, path, depth, page, and byte limits, including redirect handling. Preserve raw inputs and normalize readable Markdown without losing code, warnings, or citation mappings. Track known and unknown library versions separately from download timestamps.

Build source registration, snapshots, passages, project pins, and a user-local shared cache. Add generation staging and atomic activation before refreshes can overwrite active data. Readers must retain a consistent generation while writers prepare replacements. Report progress and failures visibly.

Deliver the first usable flow: import a fixture, perform lexical search through the CLI, read an excerpt, and follow its citation to the preserved source. This is an intermediate milestone, not completion of the semantic MVP.

## Phase 2: actual indices and grounded retrieval

Integrate the real local embedding model and verified Graphify path. Map graph evidence to canonical passages and keep vectors and graph artifacts within the same generation. Implement version/source filters, exact and symbol-aware lexical ranking, vector retrieval, graph expansion, and comparable retrieval modes.

Add bounded excerpt assembly with citations, stable IDs, token accounting, and explicit truncation. Exercise code and warning boundaries. Confirm that absent answers and unavailable versions return distinct states. Query operations may not trigger preparation or network calls.

Exit condition: real queries retrieve expected source content through lexical, vector, graph, and combined modes after restart with networking disabled. Graph behavior must demonstrate relationships beyond a heading hierarchy.

## Phase 3: shared interfaces and job lifecycle

Expose the same core through CLI and MCP search, read, and sources operations. Define preparation/update commands separately. Include source/version selection, clear error responses, cancellation behavior, and observable job progress. Prevent duplicate writers for a source while supporting consistent concurrent readers.

Add fixture coverage for successful refresh, failed refresh, interrupted staging, changed/deleted documents, version isolation, and concurrent reads and updates. A failure must preserve the prior good generation and expose the failed status. A successful update must not return deleted or superseded content as active.

## Phase 4: the one-screen local UI

Use the repository's Bun conventions, verifying installed frontend dependencies before choosing them. Build source registration, version/state rows, update actions, preparation progress, actionable errors, and search result inspection. Display the same excerpts and citations that MCP returns, with token usage.

Bind to loopback, validate requests, and restrict filesystem access to registered inputs. Run a headless browser smoke test that adds a source, observes preparation, searches, and opens a cited excerpt. A successful build alone does not demonstrate this workflow.

## Phase 5: package both agent clients

Verify current plugin and MCP mechanisms for Claude Code and Codex independently. Supply client-specific packaging plus shared retrieval guidance where supported. Document installation, preparation, project pins, update behavior, offline operation, and removal. Avoid unsupported hooks or claims of guaranteed autonomous retrieval.

In each real host, install the integration, confirm discovery, retrieve a cited passage, expand it, and request an unavailable version. Record results separately. If a host is unavailable, complete all unaffected work and mark its integration unverified rather than claiming parity.

## Phase 6: evaluate, review, and close

Review 20 to 30 questions spanning exact APIs, paraphrases, relationships across pages, version ambiguity, code with warnings, and absent answers. Ground truth consists of expected passage IDs and content, reviewed before benchmarking. Mark must-pass questions in advance. The default combined retrieval path must return their expected supporting evidence within the configured output budget, with valid citations and correct version filtering; unsupported questions must produce the expected missing-evidence state. Set and record corpus-specific quality and latency targets before the final evaluation, using the observed baseline and intended machine. Compare retrieval modes on the same corpus, filters, and token budget. Individual diagnostic modes may fail cases that the combined path must pass.

Report passage recall and rank, citation and version validity, returned tokens, tool calls, latency, and measured preprocessing cost. Do not invent universal numeric quality targets or infer usefulness from node counts. Explain where combined retrieval improves or worsens results and what remains uncertain.

Required invariant fixtures must pass: offline retrieval after restart; no cross-version leakage; no stale active hits after successful changes or deletions; old passage IDs never resolving to newer content; preserved prior generation after failed updates; consistent readers during writes; safe interrupted preparation; bounded output; and source content treated as data.

Run focused Bun tests, TypeScript checks, runtime smoke tests, actual semantic and embedding checks, the UI browser smoke, and both available host evaluations. For bug fixes, demonstrate the regression test failing before the fix and passing afterward. Delegate independent implementation units and obtain independent review before completion.

Close with changed paths, exact checks and outcomes, installation commands, remaining limitations, and separately labeled unverified integrations. Update this plan's status as phases advance. Do not equate lint, build, fixtures, or a plugin manifest with a functioning product.
