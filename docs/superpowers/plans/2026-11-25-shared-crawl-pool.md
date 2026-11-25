# Shared crawl pool implementation plan

**Goal:** Shorten collection for one large source and for multiple sources in one Docify instance. Measure collection and preparation separately.

**Architecture:** One fair admission queue per Docify instance; a bounded window per crawl fetches ahead but commits pages in discovery order. No external workers or new dependencies.

**Tech stack:** Bun, TypeScript, Fetch and AbortSignal.

**Spec:** `docs/superpowers/specs/2026-11-25-shared-crawl-pool-design.md`

## Global constraints

Keep source scope, redirects, exclusions, cancellation, content hashes and size limits. No cross-process coordination or changes to graph and embedding concurrency.

## Review focus

A slow first response must not change which pages survive maxPages. Two sources on one hostname share capacity. Closing a queued source must not leak slots. Streamed bodies must hold slots until consumed. Redirect aliases must not duplicate documents or accepted artifacts.

## Tasks

- [x] Benchmark: build `scripts/eval-crawl.ts` with a local Bun HTTP fixture, fixed pages and latency. Record repeated serial-baseline medians for single and concurrent sources, paths and content hashes. Measure the full prepare path as well as collection.
- [x] Admission: add `src/core/crawl-pool.ts` and tests in `tests/crawl-pool.test.ts`. Gate a page job by source and hostname. Rotate eligible sources; release capacity on success, error and abort. Test limits with held jobs, not elapsed-time thresholds.
- [x] Crawl: extend `CrawlOptions` in `src/core/collect.ts` with a pool. Fetch into a bounded window and apply outcomes in queue order. Test delayed siblings, redirect aliases, byte and page limits, cancellation during body reads and per-source progress in `tests/crawl.test.ts`.
- [x] Integration: pass the same pool from `src/core/docify.ts` to the builtin, Crawl4AI and Browserless crawl calls. Audit provider-specific side effects and keep accepted artifacts associated with accepted pages. Exercise two simultaneous prepare calls.
- [x] Verification: rerun the unchanged benchmark fixture, compare hashes and medians, run crawl/provider tests, typecheck and suite. Record fixture versus production scope; do not publish or deploy.

## Result

Baseline `29b3d78`, local HTTP server, 20 ms response delay, 25 pages per source, five runs per case. Median collect times: one source 549 to 109 ms; three simultaneous sources on the same host 550 to 292 ms. Median prepare times with graph disabled: 817 to 376 ms and 1322 to 568 ms respectively. Both stages matched baseline document digests. Final verification: typecheck and all 510 tests passed. The benchmark covers the builtin provider, not production sites or remote rendering throughput.

Independent review follow-up: scope speculative failures to entries still needed at acceptance time, retain renderer-specific deadlines and count both target and renderer hosts against pool limits. Existing page-skip policy on HTTP 429 is unchanged. Limits are fixed, not adaptive; one slow sibling can hold the ordered window. No deployment.
