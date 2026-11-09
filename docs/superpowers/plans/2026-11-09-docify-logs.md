# Docify Logs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show live Docify preparation logs, including Graphify stdout and stderr, in a Logs tab using kolezka/svelte-log-viewer.

**Architecture:** Keep bounded, cross-process log history in a separate `logs.sqlite` under the configured Docify home. Preparation writes structured entries; Graphify pipes stream into it while retaining their existing result text and timeout behavior. An authenticated, cursor-based GET endpoint feeds a polling Svelte view.

**Tech Stack:** Bun, bun:sqlite, Svelte 5, Tailwind v4, svelte-log-viewer pinned to an immutable Git revision.

**Spec:** User-approved description in this session: a Logs tab for Docify preparation progress, warnings and errors with timestamps and levels, updated live; also include Graphify output. macOS operating-system logs are out of scope.

## Delivery status

Draft PR #18 contains the implementation. The full suite passes (111 tests, exit 0), as does typecheck. An isolated server exposed both Graphify streams while preparation was still in the graph phase, followed by an activation log and a ready source. The production bundle includes the real viewer.

The native shutdown failure is resolved on macOS with Bun 1.4.4. The crash stack was in ONNX Runtime's telemetry worker. Bun's JavaScript environment writes did not reach native getenv, so the dependency's opt-out was ineffective. A bootstrap now sets the native opt-out before the ONNX binding loads. A fresh-process regression observes the flag at the real binding load and fails if the native write is removed or applied too late. See docs/verification.md for the controls.

Acceptance is still not complete. Browser automation opened Workspace and exposed the Logs navigation, but subsequent commands and positive-control pages timed out; the rendered Logs view is not verified. Independent review could not start because both configured cross-family reviewer models returned API rate limits.

The pinned private viewer has no dist directory. Bun compiles its source through a tsconfig path alias, with the config path passed explicitly to the bundle so it also works from another directory.

## Global Constraints

- Work only in this task's isolated worktree. Do not commit or push without a user request.
- Use the existing web UI and authentication. Never include the server access token in logs.
- Logging must not trigger source downloads, model downloads, graph extraction, or remote spending from queries.
- Preserve the main store schema, activation transaction, Graphify cancellation, pipe draining, and partial-graph behavior.
- Log storage must be bounded and shared by CLI and web processes using the same Docify home.
- Treat log content as untrusted text. Redact configured credential values before storage.
- No log history exists before this feature begins recording it.

## Review Focus

- Split UTF-8 bytes, carriage-return progress lines and final unterminated Graphify output must decode correctly.
- Missing history is empty; corrupt or unreadable history is an explicit error, not successful emptiness.
- Concurrent processes and retained-history gaps must not duplicate or reorder viewer lines.
- Switching views and slow/failed polling must not lose entries or falsely report a live connection.
- Log retention or a logging write failure must not invalidate an otherwise successful preparation.

### Task 1: Structured preparation history and API

**Files:** Create `src/core/logs.ts`, `tests/logs.test.ts`; modify `src/core/docify.ts`, `src/core/graph.ts`, `src/web/server.ts`; extend `tests/graph-partial.test.ts` and `tests/web.test.ts`.

**Interfaces:**
- `LogEntry`: `seq: number`, `ts: string`, `source: string`, `stream: 'stdout' | 'stderr' | 'system'`, `text: string`, `level: 'info' | 'warn' | 'error'`.
- `GET /api/logs?after=<nonnegative integer>&limit=<1..1000>` returns `{ lines: LogEntry[], cursor: number, capped: boolean }`, oldest first. Use the existing `x-docify-token` guard. `cursor` is the last returned sequence or the requested cursor when no lines are returned. `capped` reports a retention gap. Initial requests begin at zero. Invalid parameters return 400.
- Add an optional final output callback to `runGraphify`, preserving all existing arguments and fake graph runners.
- Lazy writer to `logs.sqlite`, WAL and bounded retention of the most recent 10,000 lines. Read existing history read-only without creating an absent database. Storage errors are visible; append errors warn on stderr but do not mask the preparation result.

- [ ] Write focused tests for ordered entries, cursor pagination, retention, cross-instance history, missing history, corrupt history, redaction and auth/invalid API input. Keep valid-history controls alongside malformed fixtures.
- [ ] Run the focused tests and retain the failing behavioral assertions before implementation.
- [ ] Implement history, lifecycle entries, phase updates, partial-graph warnings, failures and cancellations. Include source registration/removal and relevant web errors, but never log request headers, complete configuration or search/document text.
- [ ] Replace whole-pipe Graphify reads with incremental UTF-8 decoding, CR/LF line framing, and optional per-stream callbacks. Preserve accumulated stdout/stderr for existing parsing and diagnostics. Set Python unbuffered output for live delivery.
- [ ] Test an executable fixture that emits both streams before a controlled exit, split Unicode, final unterminated lines and nonzero exit. Prove meaningful callback output arrives before exit. Preserve cancellation and bounded drain behavior.
- [ ] Run `bun test tests/logs.test.ts tests/graph-partial.test.ts tests/web.test.ts` and `bun run typecheck`.

### Task 2: Logs tab and real viewer

**Files:** Modify `package.json`, `bun.lock`, `src/web/App.svelte`, `src/web/components/TopBar.svelte`, `src/web/lib/api.ts`, `src/web/app.css`; create `src/web/views/Logs.svelte`; extend `tests/web.test.ts` as needed.

**Consumes:** Task 1's exact `/api/logs` response and cursor semantics. Import `LogViewer` and `LogLine` from `svelte-log-viewer`.

- [ ] Inspect the dependency's exact Git revision and install it with Bun, ensuring its `dist` entry exists and the existing Bun production bundle resolves it. Do not substitute a hand-written viewer.
- [ ] Add Logs navigation and remembered-view handling without resetting workspace results.
- [ ] Poll authenticated history while the view is mounted. Fetch every page before waiting, bound browser memory to 10,000 lines, reject malformed payloads, avoid overlapping requests and stop polling on unmount. Show polling failures with retry and do not clear successfully loaded lines.
- [ ] Render `<LogViewer>` with source labels, timestamped entries, native filters/follow controls and truthful capped/connection states. Map its `--lv-*` tokens to the app's light and dark themes.
- [ ] Verify production bundling, Logs navigation, empty history, streamed fixture output, filtering, theme and visible API-error handling in the real browser.

### Task 3: Integration gates

- [ ] Review the full diff and all changed-symbol call sites. Use an independent cross-family reviewer after implementation.
- [ ] Run the full `bun test` suite once and `bun run typecheck`. Report any missing-model failures separately, with completed runner results.
- [ ] Serve an isolated fixture store and confirm the real page displays decoded preparation and Graphify output. No live provider calls are needed or authorized.
- [ ] Run `git diff --check`, inspect final status, and update the Outline task with evidence and remaining limits. Leave the branch uncommitted unless instructed otherwise.
