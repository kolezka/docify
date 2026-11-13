#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { Docify, DocifyError, type CrawlProvider } from "./core/docify.ts";
import { summarizeSource } from "./core/summary.ts";
import { discoverSources, open, outline, read, renderSources, scope, search, searchMany, sources, type Mode } from "./core/search.ts";
import { embedTexts, loadEmbedder } from "./core/embed.ts";
import { exportStore, importStore } from "./core/backup.ts";
import { VERSION, requireVersion } from "./version.ts";

const USAGE = `docify <command> [options]

Preparation (may use the network or the configured graph provider):
  setup                         install the pinned Graphify runtime and download the embedding model
  add <library> <path|url> [--version V] [--id ID] [--crawler builtin|crawl4ai|browserless]
  crawler <source-id> <builtin|crawl4ai|browserless|default>
  summarize <source-id> [--force] generate and save a collection summary using the configured OpenAI graph provider
  prepare <source-id> [--no-graph] [--force] [--summary]
  remove <source-id>

Queries (local and offline only):
  sources [topic] [--json]       discover collections using saved summaries, or list all sources
  search <query> [--library L] [--version V] [--source ID] [--mode combined|lexical|vector|graph] [--max-tokens N] [--graph-weight W] [--json]
  search --query Q [--query Q ...] [same options]
                                up to 8 queries in one call, sharing --max-tokens
                                (default 1400 per query)
  scope [--library L] [--version V] [--source ID] [--json]
                                show what search would search with these filters
  read <passage-id> [--max-tokens N] [--json]
  outline <source-id> [--path PREFIX] [--max-tokens N] [--json]
  open <source-id> <path> [--heading H] [--max-tokens N] [--json]
                                a whole document, or one section of it
  pin <library> [version]       pin (or unpin) a version in ./.docify.json

Backup (the database, settings and prepared snapshots; not models or the Graphify runtime):
  export <file.tar.gz> [--force]
                                write the whole store to one file; --force overwrites the file
  import <file.tar.gz> [--force] [--keep-config]
                                replace the store with a backup; --force when the store has
                                sources (they are moved aside, not deleted); --keep-config keeps
                                this machine's config.json. Restart running serve/mcp afterwards.

Servers:
  serve [--port 4747] [--host 127.0.0.1] [--allowed-host HOST]
                                web UI; optional DOCIFY_WEB_TOKEN, DOCIFY_ALLOWED_HOSTS
                                and DOCIFY_SOURCE_ROOTS are read from the environment;
                                DOCIFY_MCP_TOKENS also serves MCP over HTTP at /mcp
  mcp [--require X.Y.Z]         MCP server on stdio; refuses to start when docify is older than X.Y.Z

  --version                     print the docify version
`;

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  // Checked before parseArgs: elsewhere --version is the library version option.
  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      version: { type: "string" },
      id: { type: "string" },
      library: { type: "string" },
      source: { type: "string", multiple: true },
      query: { type: "string", multiple: true },
      mode: { type: "string" },
      "max-tokens": { type: "string" },
      path: { type: "string" },
      json: { type: "boolean" },
      "no-graph": { type: "boolean" },
      summary: { type: "boolean" },
      force: { type: "boolean" },
      "keep-config": { type: "boolean" },
      port: { type: "string" },
      host: { type: "string" },
      "allowed-host": { type: "string", multiple: true },
      "graph-weight": { type: "string" },
      require: { type: "string" },
      heading: { type: "string" },
      crawler: { type: "string" },
    },
  });
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }
  if (command === "mcp") {
    if (values.require) {
      try {
        requireVersion(values.require);
      } catch (err) {
        throw new DocifyError("version_mismatch", err instanceof Error ? err.message : String(err));
      }
    }
    await import("./mcp/stdio.ts").then((m) => m.startMcp());
    return;
  }
  if (command === "serve") {
    const port = Number(values.port ?? process.env.DOCIFY_PORT ?? 4747);
    const host = values.host ?? process.env.DOCIFY_HOST;
    await import("./web/server.ts").then((m) => m.startServer(port, { host, allowedHosts: values["allowed-host"] }));
    return;
  }
  const docify = new Docify();
  try {
    switch (command) {
      case "setup":
        await setup(docify);
        break;
      case "add": {
        const [library, locator] = positionals;
        if (!library || !locator) throw new DocifyError("invalid_input", "usage: docify add <library> <path|url> [--version V]");
        const kind = /^https?:\/\//.test(locator) ? "url" : "local";
        const s = docify.addSource({ library, locator, kind, version: values.version ?? null, id: values.id, crawlProvider: values.crawler as CrawlProvider | undefined });
        console.log(`added ${s.id} (${s.kind} ${s.locator}). Run: docify prepare ${s.id}`);
        break;
      }
      case "crawler": {
        const [id, provider] = positionals;
        if (!id || !provider) throw new DocifyError("invalid_input", "usage: docify crawler <source-id> <builtin|crawl4ai|browserless|default>");
        docify.updateSourceCrawler(id, provider === "default" ? null : provider as CrawlProvider);
        console.log(`updated crawler for ${id}: ${provider}`);
        break;
      }
      case "prepare": {
        const id = positionals[0];
        if (!id) throw new DocifyError("invalid_input", "usage: docify prepare <source-id>");
        const controller = new AbortController();
        process.on("SIGINT", () => controller.abort());
        const timer = setInterval(() => {
          const g = docify.generations(id)[0];
          if (g?.status === "staging") console.error(`  ${g.phase} ${g.progress ?? ""}`);
        }, 2000);
        try {
          const r = await docify.prepare(id, { graph: !values["no-graph"], force: values.force, signal: controller.signal });
          console.log(`${r.status} ${r.sourceId} generation ${r.generationId}: ${JSON.stringify(r.stats)}`);
          const missing = (r.stats.graphMissing as string[] | undefined) ?? [];
          const warned = ((r.stats.graphWarnings as string[] | undefined) ?? []).length > 0;
          if (r.status === "activated" && (missing.length || warned)) {
            const shown = missing.slice(0, 5).join(", ") + (missing.length > 5 ? ` (+${missing.length - 5} more)` : "");
            console.error(`warning: graph is partial${missing.length ? `, no nodes for ${missing.length} document(s): ${shown}` : ""}. The next prepare retries them.`);
          }
          if (values.summary) {
            try {
              console.log(JSON.stringify(await summarizeSource(docify, id, { signal: controller.signal }), null, 2));
            } catch (err) {
              console.error(`Preparation succeeded, but summary generation failed: ${err instanceof Error ? err.message : "unknown error"}. Retry with docify summarize ${id}.`);
              process.exitCode = 1;
            }
          }
        } finally {
          clearInterval(timer);
        }
        break;
      }
      case "remove":
        docify.removeSource(positionals[0] ?? "");
        console.log(`removed ${positionals[0]}`);
        break;
      case "summarize": {
        const id = positionals[0];
        if (!id) throw new DocifyError("invalid_input", "usage: docify summarize <source-id> [--force]");
        const controller = new AbortController();
        const cancel = () => controller.abort();
        process.once("SIGINT", cancel);
        try {
          const summary = await summarizeSource(docify, id, { force: values.force, signal: controller.signal });
          console.log(JSON.stringify(summary, null, 2));
        } finally {
          process.off("SIGINT", cancel);
        }
        break;
      }
      case "sources": {
        const list = positionals.length ? discoverSources(docify, positionals.join(" ")) : sources(docify);
        console.log(values.json ? JSON.stringify(list, null, 2) : positionals.length && !list.length ? "No matching documentation collections. Run docify sources to list all sources." : renderSources(list));
        break;
      }
      case "search": {
        const query = positionals.join(" ");
        const common = {
          library: values.library,
          version: values.version,
          sources: values.source,
          mode: (values.mode as Mode | undefined) ?? "combined",
          maxTokens: values["max-tokens"] ? Number(values["max-tokens"]) : undefined,
          project: process.env.DOCIFY_PROJECT ?? process.cwd(),
          graphWeight: values["graph-weight"] ? Number(values["graph-weight"]) : undefined,
        };
        if (values.query) {
          if (query) throw new DocifyError("invalid_input", "give a positional query or --query, not both");
          const m = await searchMany(docify, { ...common, queries: values.query });
          console.log(values.json ? JSON.stringify(m, null, 2) : m.text);
          if (m.queries.some((q) => q.status !== "ok")) process.exitCode = 3;
          break;
        }
        const r = await search(docify, { ...common, query });
        console.log(values.json ? JSON.stringify(r, null, 2) : r.text);
        if (r.status !== "ok") process.exitCode = 3;
        break;
      }
      case "scope": {
        const r = scope(docify, { library: values.library, version: values.version, sources: values.source, project: process.env.DOCIFY_PROJECT ?? process.cwd() });
        console.log(values.json ? JSON.stringify(r, null, 2) : r.text);
        if (r.status !== "ok") process.exitCode = 3;
        break;
      }
      case "read": {
        const r = read(docify, positionals[0] ?? "", values["max-tokens"] ? Number(values["max-tokens"]) : undefined);
        console.log(values.json ? JSON.stringify(r, null, 2) : r.text);
        if (r.status === "unavailable") process.exitCode = 3;
        break;
      }
      case "outline": {
        const r = outline(docify, { source: positionals[0] ?? "", path: values.path, maxTokens: values["max-tokens"] ? Number(values["max-tokens"]) : undefined });
        console.log(values.json ? JSON.stringify(r, null, 2) : r.text);
        if (r.status !== "ok") process.exitCode = 3;
        break;
      }
      case "open": {
        const r = open(docify, { source: positionals[0] ?? "", path: positionals[1] ?? "", heading: values.heading, maxTokens: values["max-tokens"] ? Number(values["max-tokens"]) : undefined });
        console.log(values.json ? JSON.stringify(r, null, 2) : r.text);
        if (r.status !== "ok") process.exitCode = 3;
        break;
      }
      case "pin": {
        const [library, version] = positionals;
        if (!library) throw new DocifyError("invalid_input", "usage: docify pin <library> [version]");
        const file = Docify.writePin(process.cwd(), library.toLowerCase(), version ?? null);
        console.log(version ? `pinned ${library}@${version} in ${file}` : `unpinned ${library} in ${file}`);
        break;
      }
      case "export": {
        const file = positionals[0];
        if (!file) throw new DocifyError("invalid_input", "usage: docify export <file.tar.gz> [--force]");
        const target = resolve(file);
        if (existsSync(target) && !values.force) throw new DocifyError("exists", `${target} exists; pass --force to overwrite it`);
        const { bytes, manifest } = await exportStore(docify);
        const tmp = `${target}.${process.pid}.tmp`;
        writeFileSync(tmp, bytes, { mode: 0o600 });
        renameSync(tmp, target);
        const mb = (bytes.length / 1024 / 1024).toFixed(1);
        console.log(`exported ${manifest.sources.length} source(s), ${Object.keys(manifest.files).length} files, ${mb} MB to ${target}`);
        break;
      }
      case "import": {
        const file = positionals[0];
        if (!file) throw new DocifyError("invalid_input", "usage: docify import <file.tar.gz> [--force] [--keep-config]");
        const r = await importStore(docify, readFileSync(resolve(file)), { force: values.force, keepConfig: values["keep-config"] });
        console.log(`imported ${r.sources.length} source(s) from a backup made ${r.createdAt} by Docify ${r.docifyVersion} into ${docify.config.home}`);
        if (r.movedAside) console.log(`the previous store is in ${r.movedAside}`);
        if (r.droppedConfigKeys.length) console.log(`kept this machine's ${r.droppedConfigKeys.join(", ")}; the backup's values were ignored`);
        console.log("restart running `docify serve` and `docify mcp` processes so they read the imported store");
        break;
      }
      default:
        throw new DocifyError("invalid_input", `unknown command ${command}\n\n${USAGE}`);
    }
  } finally {
    docify.close();
  }
}

async function setup(docify: Docify) {
  const project = resolve(import.meta.dir, "..", "tools", "graphify");
  const venv = join(docify.config.home, "graphify-venv");
  console.log(`installing pinned Graphify from ${project} into ${venv}`);
  const proc = Bun.spawn(["uv", "sync", "--frozen", "--project", project], {
    env: { ...process.env, UV_PROJECT_ENVIRONMENT: venv },
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await proc.exited) !== 0) throw new Error("uv sync failed");
  if (!existsSync(docify.config.graphifyBin)) console.warn(`warning: graphify not found at ${docify.config.graphifyBin}; set DOCIFY_GRAPHIFY_BIN`);
  if (docify.config.embeddingProvider === "ollama") {
    // The model lives on the Ollama server (docker-compose.yml pulls it); check it answers.
    console.log(`checking Ollama at ${docify.config.embeddingUrl} for ${docify.config.embeddingModel}`);
    await embedTexts(docify.config, ["docify setup check"]);
    console.log(`setup complete; queries embed through ${docify.config.embeddingUrl}`);
  } else if (docify.config.embeddingProvider === "openai") {
    const urlEnv = docify.config.embeddingBaseUrlEnv;
    console.log(`checking the embedding server in ${urlEnv} for ${docify.config.embeddingModel}`);
    await embedTexts(docify.config, ["docify setup check"]);
    console.log(`setup complete; queries embed through the server in ${urlEnv}, so they need the network`);
  } else {
    console.log(`downloading embedding model ${docify.config.embeddingModel} into ${docify.config.modelsDir}`);
    await loadEmbedder(docify.config, true);
    console.log("setup complete; queries now run offline");
  }
}

main(Bun.argv.slice(2)).catch((err) => {
  if (err instanceof DocifyError) console.error(`error (${err.code}): ${err.message}`);
  else console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = process.exitCode || 1;
});
