# Retrieval evaluation

Run on 2026-10-21, Apple M4 Pro 48 GB, store `~/.cache/docify`, pipeline version 5. Reproduce with `bun scripts/eval.ts --out eval/results.json`.

## Corpus and questions

Three sources from `fixtures/corpus`: Bun 1.4.3 (`sqlite.mdx`, `hashing.mdx`, 40 passages), Bun 1.2.0 (`sqlite.md`, `hashing.md`, 39 passages) and Python 3.13 `hashlib.html` (22 passages). `eval/questions.json` holds 28 questions: 8 exact API, 9 paraphrase, 4 relationship, 3 code with warnings, 4 version, 2 absent, 1 unavailable version. 16 are marked must-pass. Expected evidence is a locator (source, document, last heading, required text) rather than a passage id, because ids change with every generation.

Targets were fixed before scoring: all must-pass questions pass in combined mode, combined passage recall at least 0.8, every result within the 1500-token budget, 100% valid citations, zero version leaks, p95 latency at most 150 ms in a warm process.

## Measurement check

Before scoring, the harness checks that every expected locator resolves to a stored passage, that a negative-control locator resolves to nothing, and that changing one heading breaks the match. It refuses to score otherwise. Citation validity means the cited normalized lines equal the stored passage text exactly, and for Markdown the raw file has those lines.

## Results (budget 1500 tokens, one search call per question)

| Mode | Pass | Must-pass | Passage recall | MRR | Avg tokens | Max tokens | Version leaks | Bad citations | p50 ms | p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| combined (default) | 27/28 | 16/16 | 0.963 | 0.868 | 1359 | 1495 | 0 | 0 | 6.3 | 12.8 |
| lexical | 23/28 | 13/16 | 0.815 | 0.802 | 1232 | 1491 | 0 | 0 | 2.9 | 5.0 |
| vector | 28/28 | 16/16 | 1.000 | 0.859 | 1354 | 1492 | 0 | 0 | 7.3 | 10.3 |
| graph | 10/28 | 8/16 | 0.333 | 0.274 | 541 | 1473 | 0 | 0 | 0.1 | 3.8 |

Combined misses one non-must question: q25 (Bun password hashing compared with Python key derivation, no library filter) returns the Python passage but not the Bun one within budget. 5 combined results came back as `weak_match`. 11 hits were truncated with a `read()` hint; no question needed a second call to find its evidence.

All targets set in advance are met by combined mode.

## How the numbers moved, and what was changed after seeing results

These changes were made with this question set in view, so the final numbers are optimistic for unseen questions.

1. Baseline combined: 24/28, must-pass 13/16, recall 0.852. Two must-pass paraphrases (q04, q06) were hidden by the evidence gate.
2. The gate could not be fixed with a threshold: best bge-small similarity was 0.576 for q04 (real answer) and 0.616 for absent q27, 0.572 for absent q26. A `weak_match` status now returns hits with a low-confidence warning, and a query that names an API symbol found nowhere in scope returns `no_match` (q27, `Bun.redis`). q26 now passes as `weak_match` instead of `no_match`; this expectation was changed after the baseline and is recorded in the question file.
3. Method-name symbol tokens (`m_serialize`) and an exact-symbol fusion bonus fixed `Database.serialize`.
4. Graph fusion weight sweep, all else equal: weight 0 gives 27/28 and recall 0.963, 0.15 gives 25/28 and 0.889, 0.35 gives 23/28 and 0.815. Graph hits promote broad hub passages (`Database`, `Bun.hash`) over the precise answer. Combined therefore defaults to `graphWeight: 0`; the graph is still built, stored, queryable through `mode: "graph"`, and can be weighted per query.

## Graph findings

Graph extraction is real and semantic (for example `fileControl -conceptually_related_to-> WAL Mode`, `Bun.password -references-> argon2, bcrypt`), and 70 to 80% of nodes ground to passages. On this corpus it does not improve retrieval: graph mode alone finds a third of the expected passages, and fusing it lowers recall. A larger corpus with more cross-page relationships might change that; it was not tested.

Two extraction defects were found and fixed during evaluation:

- The model rewrote staged file names `d-<hash>.md` as `d_<hash>.md` in `source_file`, and Graphify dropped 34 of 37 Python nodes as out of scope. Staged names are now letters and digits only.
- Identical prompts are answered from a response cache upstream (a 10k-token extraction "completed" in 0 s), so retrying an unchanged prompt cannot recover from a bad extraction. Graphify also caches it; `docify prepare --force` passes `--force` to skip Graphify's cache.

## Preparation cost (measured)

Wall time for `docify prepare` with graph extraction through LiteLLM `deepseek/deepseek-flash-nothink`, cold Graphify cache: Python 3.13 21.6 s, Bun 1.4.3 14.2 s, Bun 1.2.0 13.1 s. Without the graph step, about 2 s per source (embedding 0.9 to 1.5 s). Graphify's cost estimates per source: $0.0156, $0.0109, $0.0097, about 10k input and 4k to 8k output tokens each. These are Graphify's estimates from token counts, not provider invoices. Whole-session extraction spend across all runs was under $0.25 by the same estimates.
