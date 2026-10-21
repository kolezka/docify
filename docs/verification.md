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
