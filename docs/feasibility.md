# Phase 0 feasibility evidence

Recorded 2026-10-21 on an Apple M4 Pro, 48 GB, macOS, Bun 1.4.2, uv 0.12.5.

## Graphify semantic extraction

- Runtime: `graphifyy[openai]==0.9.70`, pinned in `tools/graphify/pyproject.toml` with `uv.lock`, installed by `uv sync` into `~/.cache/docify/graphify-venv` (Python 3.13.7). The extra is required: without it the `openai` backend fails with "the 'openai' package is required".
- Provider (user decision, 2026-10-21): the user's LiteLLM proxy, model `deepseek/deepseek-flash-nothink`, reached through Graphify's `openai` backend with `OPENAI_BASE_URL`, `OPENAI_MODEL` and `OPENAI_API_KEY` set only in the subprocess environment.
- Corpus: Bun 1.4.3 docs `sqlite.mdx`, `hashing.mdx`, `secrets.mdx` (MIT, from `bun-types`).
- Run: `graphify extract <corpus> --backend openai --max-concurrency 4 --out <dir>`: 21 s, 13,114 input and 6,717 output tokens, Graphify's estimate $0.016. 44 nodes, 41 edges, 3 hyperedges.
- Concepts and relations are semantic and match the text, for example `Database.fileControl -references-> WAL mode` (source `sqlite.md:656-666`), `Database.close -references-> Statement.finalize` (`sqlite.md:113-137`), `Bun.password.hash -references-> argon2, bcrypt, PHC format, Modular Crypt Format`, and the hyperedge "SQLite Statement execution methods".
- Grounding gap: nodes and edges carry `source_file` but `source_location` is always null. Docify grounds each node to passages itself by matching the label inside passages of the same document.
- Sensitive-name filter: Graphify skipped `secrets.md` as "potentially sensitive". Docify must stage normalized documents under neutral file names.

## Refresh and deletion

Changed `hashing.md` (renamed argon2/bcrypt, added `Bun.password.needsRehash`) and deleted the credential-store page.

- `graphify update <path>` is code-only. The semantic graph was unchanged (old `argon2`, `Bun.secrets` nodes stayed) and it wrote a new `graphify-out/` into the corpus directory. Docify never calls it.
- `graphify extract` again without `--force`: "1 files cached/unchanged, 1 re-extracted, 1 deleted", 3,847 in / 2,644 out tokens, about $0.006. Deleted nodes gone, `Bun.password.needsRehash` present. The LLM output is not deterministic: the re-extracted file gained nodes such as `HMAC`.
- Graphify rewrites `graph.json` in place. Docify copies it into the generation, so a failed extraction never touches the active graph.

## Offline querying

- Network block validated with a positive control: `curl https://example.com` returned 200 normally and failed (exit 6) under `sandbox-exec -p '(version 1)(allow default)(deny network*)'`.
- `graphify query` in a fresh process under that sandbox answered from the persisted `graph.json` (exit 0). Its seed selection is noisy (a password question also seeded `safeIntegers option`), so Docify reads the stored graph in TypeScript and never needs Python at query time.

## Embeddings

`scripts/probes/embeddings.ts`, 38 heading passages from Bun `sqlite.mdx` and `hashing.mdx`, 8 paraphrase queries that avoid heading words plus 3 lexical controls, fp32, transformers.js 4.3.1 in-process (no daemon):

| Model | Dims | MRR | Top-1 | Top-3 | Index ms | Query ms |
| --- | --- | --- | --- | --- | --- | --- |
| Xenova/all-MiniLM-L6-v2 | 384 | 0.652 | 5/11 | 10/11 | 680 | 2 |
| Xenova/bge-small-en-v1.5 | 384 | 0.776 | 7/11 | 10/11 | 1198 | 4 |
| nomic-ai/nomic-embed-text-v1.5 | 768 | 0.689 | 6/11 | 10/11 | 5351 | 8 |

Chosen: `Xenova/bge-small-en-v1.5`, 384 dims, query prefix "Represent this sentence for searching relevant passages: ". Cache `~/.cache/docify/models`; `onnx/model.onnx` sha256 `828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35`. Rerun with `allowRemoteModels=false` under the network sandbox gave identical ranks for all three models.

## Storage

`bun:sqlite` is SQLite 3.54.0 with FTS5 (bm25 works). Dynamic extensions are disabled ("does not support dynamic extension loading"), so no `sqlite-vec`. Vectors are stored as Float32 BLOBs; a brute-force scan of 20,000 x 384 takes 5.7 ms, well inside the latency budget for a local doc corpus.
