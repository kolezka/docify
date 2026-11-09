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
| combined (default) | 27/28 | 16/16 | 0.963 | 0.868 | 1348 | 1487 | 0 | 0 | 7.2 | 11.5 |
| lexical | 23/28 | 13/16 | 0.815 | 0.802 | 1238 | 1493 | 0 | 0 | 3.3 | 7.4 |
| vector | 27/28 | 16/16 | 0.963 | 0.859 | 1344 | 1493 | 0 | 0 | 6.6 | 13.4 |
| graph | 10/28 | 8/16 | 0.333 | 0.274 | 549 | 1479 | 0 | 0 | 0.1 | 5.2 |

Final run after the review fixes (nonce frame header, budget enforcement). Before them, vector scored 28/28 and recall 1.0; the slightly longer header now squeezes q25 out of the vector budget.

Combined misses one non-must question: q25 (Bun password hashing compared with Python key derivation, no library filter) returns the Python passage but not the Bun one within budget. 5 combined results came back as `weak_match`. 11 hits were truncated with a `read()` hint; no question needed a second call to find its evidence.

All targets set in advance are met by combined mode.

## How the numbers moved, and what was changed after seeing results

These changes were made with this question set in view, so the final numbers are optimistic for unseen questions.

1. Baseline combined: 24/28, must-pass 13/16, recall 0.852. Two must-pass paraphrases (q04, q06) were hidden by the evidence gate.
2. The gate could not be fixed with a threshold: best bge-small similarity was 0.576 for q04 (real answer) and 0.616 for absent q27, 0.572 for absent q26. A `weak_match` status now returns hits with a low-confidence warning, and a query that names an API symbol found nowhere in scope returns `no_match` (q27, `Bun.redis`). q26 now passes as `weak_match` instead of `no_match`; this expectation was changed after the baseline and is recorded in the question file.
3. Method-name symbol tokens (`m_serialize`) and an exact-symbol fusion bonus fixed `Database.serialize`. Rechecked after the graph decision: at graph weight 0 the bonus changes nothing measurable (27/28 either way, MRR 0.878 without, 0.868 with); at graph weight 0.35 it lifts combined from 20/28 to 23/28.
4. Graph fusion weight sweep, all else equal: weight 0 gives 27/28 and recall 0.963, 0.15 gives 25/28 and 0.889, 0.35 gives 23/28 and 0.815. Graph hits promote broad hub passages (`Database`, `Bun.hash`) over the precise answer. Combined therefore defaults to `graphWeight: 0`; the graph is still built, stored, queryable through `mode: "graph"`, and can be weighted per query.

## Graph findings

Graph extraction is real and semantic (for example `fileControl -conceptually_related_to-> WAL Mode`, `Bun.password -references-> argon2, bcrypt`), and 70 to 80% of nodes ground to passages. On this corpus it does not improve retrieval: graph mode alone finds a third of the expected passages, and fusing it lowers recall. A larger corpus with more cross-page relationships might change that; it was not tested.

Two extraction defects were found and fixed during evaluation:

- The model rewrote staged file names `d-<hash>.md` as `d_<hash>.md` in `source_file`, and Graphify dropped 34 of 37 Python nodes as out of scope. Staged names are now letters and digits only.
- Identical prompts are answered from a response cache upstream (a 10k-token extraction "completed" in 0 s), so retrying an unchanged prompt cannot recover from a bad extraction. Graphify also caches it; `docify prepare --force` passes `--force` to skip Graphify's cache.

## Preparation cost (measured)

Wall time for `docify prepare` with graph extraction through LiteLLM `deepseek/deepseek-flash-nothink`, cold Graphify cache: Python 3.13 21.6 s, Bun 1.4.3 14.2 s, Bun 1.2.0 13.1 s. Without the graph step, about 2 s per source (embedding 0.9 to 1.5 s). Graphify's cost estimates per source: $0.0156, $0.0109, $0.0097, about 10k input and 4k to 8k output tokens each. These are Graphify's estimates from token counts, not provider invoices. Whole-session extraction spend across all runs was under $0.25 by the same estimates.

## bge-m3 through Ollama (2026-11-04)

Same 28 questions, budget 1500, no graph (`--no-graph`), Ollama 0.40.6 with `bge-m3` on an RTX 3060 reached over the LAN. Reproduce: `docker compose up -d` (or another Ollama), the config in the README "Embeddings" section, prepare the three fixture sources, `bun scripts/eval.ts --modes combined,lexical,vector`.

| Model, mode | Pass | Must-pass | Passage recall | MRR | p95 ms |
| --- | --- | --- | --- | --- | --- |
| bge-small, combined | 27/28 | 16/16 | 0.963 | 0.872 | 13.4 |
| bge-m3, combined, bge-small thresholds (0.65 / 0.5) | 27/28 | 15/16 | 0.963 | 0.858 | 104.9 |
| bge-m3, combined, thresholds 0.58 / 0.48 | 28/28 | 16/16 | 1.000 | 0.872 | 26.4 |
| bge-m3, vector, thresholds 0.58 / 0.48 | 27/28 | 16/16 | 0.963 | 0.892 | 25.1 |

bge-m3 similarities run about 0.08 below bge-small on this corpus. With the bge-small thresholds the evidence gate hid must-pass q06 (`no_match`): its best similarity is 0.497. The best absent-question similarities are 0.497 (q26) and 0.491 (q19), so similarity alone does not separate them here either; both come back as `weak_match`. The thresholds 0.58 / 0.48 were picked after seeing these 28 questions, so the bge-m3 rows are optimistic for unseen questions. On this small English corpus bge-m3 does not change MRR in combined mode; the measured gain is larger on a bigger corpus (next section). p95 includes the LAN round trip to the embedding server.

## Embeddings through a remote LiteLLM (2026-11-08)

Same 28 questions, budget 1500, no graph, provider `openai` against a LiteLLM proxy on another machine that serves `bge-m3` (`ollama/bge-m3`) and `bge-small-en` (`ollama/bge-small-en:v1.5`). Reproduce: a store with the matching config from the README, the three fixture sources prepared with `--no-graph`, then `bun scripts/eval.ts --modes combined,vector` and `bun scripts/eval-similarity.ts`, which prints each question's best vector similarity.

| Model through LiteLLM, mode | Pass | Must-pass | Passage recall | MRR | p50 ms | p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
| bge-m3, combined, 0.58 / 0.48 | 28/28 | 16/16 | 1.000 | 0.872 | 167.8 | 234.8 |
| bge-m3, vector, 0.58 / 0.48 | 27/28 | 16/16 | 0.963 | 0.892 | 169.0 | 209.6 |
| bge-small-en, combined, 0.65 / 0.5 | 27/28 | 16/16 | 0.963 | 0.858 | 181.2 | 262.2 |
| bge-small-en, vector, 0.65 / 0.5 | 27/28 | 16/16 | 0.963 | 0.858 | 175.6 | 296.8 |

- bge-m3 through LiteLLM gives the same similarities as Ollama reached directly (q06 0.497, q26 0.497, q19 0.491) and the same scores, so 0.58 / 0.48 apply unchanged.
- bge-small-en through LiteLLM scores about 0.03 to 0.04 above the in-process bge-small: q04 0.614, absent q27 0.652 and q26 0.600, against 0.576, 0.616 and 0.572 in process. The in-process thresholds 0.65 / 0.5 still pass every must-pass question. Absent q27 is above 0.65 on similarity alone, yet it still ends as `no_match`, because `Bun.redis` occurs nowhere in scope. A weak threshold above 0.614 would hide must-pass q04, so the defaults stay.
- Latency misses the 150 ms p95 target. A bare `/v1/embeddings` request for one query took a median of 246 ms for bge-m3 and 196 ms for bge-small-en (10 requests each, outliers up to 1 s), so search time is the round trip to LiteLLM and its Ollama, not docify. Embedding one fixture source during prepare took 1.2 to 2 s.
- As before, the thresholds were chosen after seeing these questions.

## Findings from a larger corpus (ocdocs, 2026-11-04)

Measured in a separate project, ocdocs (hybrid BM25 plus embeddings with reciprocal rank fusion over docs.openclaw.ai: 1443 pages, 18405 chunks), on 50 questions whose relevant pages were labelled independently by a different model family, without using the search engine (219 relevant pages, 4.4 per question). They are not docify measurements; they say what to try and what to skip here.

- **Single-answer labels understated quality.** With one hand-picked page per question, hit@1 was 0.54; with every page that answers it, 0.66 for the same engine. Label all acceptable passages, and have them labelled by someone who has not seen the results.
- **bge-m3 beat bge-small:** hit@1 0.78 vs 0.66, hit@10 0.98 vs 0.92, MRR 0.855 vs 0.759. Dense-only bge-m3 was worse than hybrid (hit@1 0.76).
- **The BGE query prefix matters for bge-small** (hit@1 +0.04 to +0.06). fastembed and Ollama do not add it; docify already does (`embeddingQueryPrefix`). bge-m3 takes no prefix.
- **Cross-encoder rerankers did not help.** MiniLM-L6, MiniLM-L12 and jina-reranker-v1-turbo were equal or worse on every metric at 600 to 1800 ms per query, against 40 ms without. bge-reranker-v2-m3 (int8) reached 19 GB RSS and was killed.
- **Down-weighting navigation chunks** (link lists, "where each section moved" pages) changed hit@1 and hit@10 by one question each in opposite directions: noise.
- **Release notes crowd out guides** when they repeat feature names. Halving their score helped bge-small (unless the query names a release or version); with bge-m3 it made no difference.
- **Non-English questions:** five Polish questions went from hit@1 0.2 to 0.8 when the agent translated them to English before searching (bge-small). bge-m3 handles Polish better on its own (dense-only 0.6).
- **Never-cut code fences make huge passages.** On that corpus 76 chunks exceeded 20,000 characters and one reached 309,000. bge-small sees only the first 512 tokens of such a passage; Ollama answers HTTP 413. docify keeps fences whole too (`chunk.ts`), so the Ollama client splits batches and halves a single input on 413, and cuts inputs at 16,000 characters.

## Page-level evaluation on docs.openclaw.ai (2026-11-08)

The 28 fixture questions are saturated for bge-m3 (28/28, recall 1.0), so they cannot show smaller changes. This run uses the corpus from the previous section: 1,442 pages of docs.openclaw.ai, one Markdown file per page, 16,601 docify passages. Its 50 questions are labelled with every page that answers them (168 distinct pages; 10 keyword, 33 paraphrase, 5 Polish, 2 about releases). The questions belong to that project and are not in this repository. `scripts/eval-pages.ts` takes a question file in that format and reports hit@1, hit@3, hit@10 and MRR over the distinct pages a search cites.

bge-m3 through a remote LiteLLM, thresholds 0.58 / 0.48, no graph, a token budget large enough to return every candidate:

| Mode | hit@1 | hit@3 | hit@10 | MRR | p50 ms | p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
| combined (default) | 0.76 | 0.86 | 0.94 | 0.822 | 200.8 | 325.5 |
| vector | 0.74 | 0.94 | 0.96 | 0.843 | 178.6 | 329.4 |
| lexical | 0.56 | 0.72 | 0.84 | 0.652 | 30.5 | 142.5 |

- **Embedding long passages in windows did not help.** The 93 passages longer than 16,000 characters were embedded as the length-weighted mean of windows of at most 16,000 characters instead of being cut. Their vectors moved (cosine to the old vector 0.89 to 1.00, median 0.96) and no other vector changed, yet every metric above stayed the same to three decimals in both modes. Only 3 of the 50 questions have an answer page with such a passage. The change was not merged.
- **Vector alone beat combined** at hit@3 (0.94 against 0.86) and MRR (0.843 against 0.822), the reverse of ocdocs, where hybrid beat dense-only. Per question, combined lost on 9: pages that only shared words with the question, never ranked by the vector, pushed the vector's answer down. All three Polish losses are among them. Combined won on 5, each where both methods found the answer.
- **Halving the weight of word matches fixed it.** At 0.5 a page found only by words ranks below every vector candidate, while a page both methods find still moves up. Combined then reached hit@1 0.80, hit@3 0.94, hit@10 0.96 and MRR 0.866, better than either method alone. On the 28 fixture questions it kept 28/28, must-pass 16/16 and recall 1.0, with MRR 0.878 against 0.872. The value was chosen after seeing these 50 questions, so the fixture set is the independent check; bge-small was not measured.
- Preparing the corpus took 761 s of embedding through LiteLLM, about 22 passages per second. On the first attempt LiteLLM began answering every request with HTTP 502 after about 2,700 passages and recovered later; the cause was not established.

## Several queries in one call (2026-11-09)

`docs_search` with `queries` runs `search()` once per query and packs all hits into one `max_tokens` budget. Two packing rules were compared: **equal** (each query first gets an equal share of the budget left after the header, filled with its own hits in rank order; a passage another query already shows costs nothing; leftover tokens then go round-robin by rank) and **sequential** (the first query takes what it wants, then the next). Equal is the default. This is an output policy, not a retrieval change: single-query search is unchanged.

Measured with `bun scripts/eval-many.ts`: the 24 questions of `eval/questions.json` that have expected passages, in batches of 3 that share library and version filters (10 batches), lexical mode. `scripts/eval.ts` could not run on this machine: the store holds none of the fixture sources (it stops with "Measurement fixture invalid, not scoring", q01 to q25 not in store), its embeddings are served remotely, and the local bge-small model is an incomplete download. The script therefore prepares the three fixture sources into a temp store with a loopback stub embedder, which limits it to lexical mode. As a check of the harness, one search call per question reproduces the lexical recall of the main table (0.815).

| Budget | Policy | Passage recall | Queries with no hit shown | Max tokens |
| --- | --- | --- | --- | --- |
| 1500 | one call per question | 0.815 | - | - |
| 1500 | equal | 0.741 | 0 | 1454 |
| 1500 | sequential | 0.444 | 3 | 1488 |
| 2000 (default) | one call per question | 0.815 | - | - |
| 2000 (default) | equal | 0.815 | 0 | 1963 |
| 2000 (default) | sequential | 0.444 | 2 | 1986 |

With 5 queries per call at budget 2000, equal reached 0.778 and sequential 0.444 (4 queries with nothing shown). At the default budget, three queries in one equal-split call found as many expected passages as three separate calls, in one response of at most 2000 tokens instead of three. Sequential lets the first query's long passages starve the rest. The split was chosen with these questions in view.

### Combined and vector mode with bge-small

Same questions and batches, run offline: `bun scripts/eval-many.ts --embedder local --mode combined|vector`, which prepares the three fixture sources into a temp store without a graph and embeds them in process with `Xenova/bge-small-en-v1.5` from `DOCIFY_MODELS_DIR`. No embedding server, no network. The script refuses to score when an active generation has a different embedding identity, so vector mode cannot silently skip sources.

Harness checks. `scripts/eval.ts` now runs on this machine against a temp store with the three fixture sources prepared with `--no-graph`: combined 27/28, recall 0.963, MRR 0.872; lexical 23/28, 0.815; vector 27/28, 0.963, MRR 0.859. These equal the published bge-small rows. In `eval-many.ts`, one call per question at 1500 gives 0.963 in combined and in vector, the same as the main table.

Each row ran 5 times on fresh stores. Recall moves by one passage (0.037) between runs in a few rows, because passage ids and the response nonce change and so change token counts at the budget edge; the table gives the mean and the range where it moved. "One call per question at N" gives each question alone the batch budget divided by the batch size, so it spends the same tokens as one batched call.

| Mode | Batch | Budget | Policy | Passage recall | Queries with no hit shown | Max tokens |
| --- | --- | --- | --- | --- | --- | --- |
| combined | 3 | 1500 | one call per question | 0.963 | - | - |
| combined | 3 | 1500 | one call per question at 500 | 0.726 (0.704 to 0.741) | - | - |
| combined | 3 | 1500 | equal | 0.741 | 0 | 1494 |
| combined | 3 | 1500 | sequential | 0.519 | 5 | 1494 |
| combined | 3 | 2000 (default) | one call per question | 1.000 | - | - |
| combined | 3 | 2000 (default) | one call per question at 666 | 0.778 | - | - |
| combined | 3 | 2000 (default) | equal | 0.815 | 0 | 1985 |
| combined | 3 | 2000 (default) | sequential | 0.556 | 3 to 4 | 1985 |
| combined | 5 | 2000 (default) | one call per question at 400 | 0.704 | - | - |
| combined | 5 | 2000 (default) | equal | 0.778 | 0 | 1973 |
| combined | 5 | 2000 (default) | sequential | 0.519 | 5 to 6 | 1980 |
| vector | 3 | 1500 | one call per question | 0.963 | - | - |
| vector | 3 | 1500 | one call per question at 500 | 0.704 | - | - |
| vector | 3 | 1500 | equal | 0.741 | 0 | 1485 |
| vector | 3 | 1500 | sequential | 0.407 | 5 | 1488 |
| vector | 3 | 2000 (default) | one call per question | 1.000 | - | - |
| vector | 3 | 2000 (default) | one call per question at 666 | 0.808 (0.778 to 0.815) | - | - |
| vector | 3 | 2000 (default) | equal | 0.867 (0.852 to 0.889) | 0 | 1990 |
| vector | 3 | 2000 (default) | sequential | 0.444 | 4 to 5 | 1983 |
| vector | 5 | 2000 (default) | one call per question at 400 | 0.704 | - | - |
| vector | 5 | 2000 (default) | equal | 0.815 | 0 | 1990 |
| vector | 5 | 2000 (default) | sequential | 0.370 | 5 to 7 | 1990 |

Larger budgets for a batch, combined mode, one run each: 3 queries at 4000 tokens, equal 1.000 and sequential 0.889; at 6000, equal 1.000. 5 queries at 6000 and at 10000, equal 1.000.

- **At the default budget, equal is clearly worse than separate calls in combined mode:** 0.815 against 1.000 with 3 queries, 0.778 with 5. The split rule is not the cause. Separate calls given the same total tokens do worse than equal (0.778 and 0.704), and equal never leaves a query with nothing shown. The loss comes from fitting three questions into the budget of one: combined and vector often need more than 666 tokens per query to reach the expected passage. Lexical has a lower ceiling (0.815) and lost nothing at 2000.
- Sequential stays far behind in every mode.
- **Proposal, not implemented:** when `queries` has more than one entry and the caller gives no `max_tokens`, default the budget to about 1400 tokens per query (3 queries 4200, 5 queries 7000, capped at the existing 20000 limit) instead of 2000 for the whole call. Here about 1300 tokens per query already gave 1.000. The alternative is to keep 2000 and have the agent skill tell agents to raise `max_tokens` with the number of queries. Both trade a larger response for recall, and the number was found with these questions in view.
- Rerun of the lexical rows above at this commit with the stub embedder, 5 runs: the same within one passage, except sequential at 1500, now 0.481 in every run, and maximum tokens up to 1486 at 1500. The lexical table was left as first measured.
