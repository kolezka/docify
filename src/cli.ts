#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { Docify, DocifyError } from "./core/docify.ts";
import { read, renderSources, search, sources, type Mode } from "./core/search.ts";
import { embedTexts, loadEmbedder } from "./core/embed.ts";

const USAGE = `docify <command> [options]

Preparation (may use the network or the configured graph provider):
  setup                         install the pinned Graphify runtime and download the embedding model
  add <library> <path|url> [--version V] [--id ID]
  prepare <source-id> [--no-graph] [--force]
  remove <source-id>

Queries (local and offline only):
  sources                       list sources, versions and preparation state
  search <query> [--library L] [--version V] [--source ID] [--mode combined|lexical|vector|graph] [--max-tokens N] [--graph-weight W] [--json]
  read <passage-id> [--max-tokens N] [--json]
  pin <library> [version]       pin (or unpin) a version in ./.docify.json

Servers:
  serve [--port 4747] [--host 127.0.0.1] [--allowed-host HOST]
                                web UI; DOCIFY_WEB_TOKEN, DOCIFY_ALLOWED_HOSTS
                                and DOCIFY_SOURCE_ROOTS are read from the environment
  mcp                           MCP server on stdio
`;

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      version: { type: "string" },
      id: { type: "string" },
      library: { type: "string" },
      source: { type: "string", multiple: true },
      mode: { type: "string" },
      "max-tokens": { type: "string" },
      json: { type: "boolean" },
      "no-graph": { type: "boolean" },
      force: { type: "boolean" },
      port: { type: "string" },
      host: { type: "string" },
      "allowed-host": { type: "string", multiple: true },
      "graph-weight": { type: "string" },
    },
  });
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }
  if (command === "mcp") {
    await import("./mcp.ts").then((m) => m.startMcp());
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
        const s = docify.addSource({ library, locator, kind, version: values.version ?? null, id: values.id });
        console.log(`added ${s.id} (${s.kind} ${s.locator}). Run: docify prepare ${s.id}`);
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
        } finally {
          clearInterval(timer);
        }
        break;
      }
      case "remove":
        docify.removeSource(positionals[0] ?? "");
        console.log(`removed ${positionals[0]}`);
        break;
      case "sources": {
        const list = sources(docify);
        console.log(values.json ? JSON.stringify(list, null, 2) : renderSources(list));
        break;
      }
      case "search": {
        const query = positionals.join(" ");
        const r = await search(docify, {
          query,
          library: values.library,
          version: values.version,
          sources: values.source,
          mode: (values.mode as Mode | undefined) ?? "combined",
          maxTokens: values["max-tokens"] ? Number(values["max-tokens"]) : undefined,
          project: process.env.DOCIFY_PROJECT ?? process.cwd(),
          graphWeight: values["graph-weight"] ? Number(values["graph-weight"]) : undefined,
        });
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
      case "pin": {
        const [library, version] = positionals;
        if (!library) throw new DocifyError("invalid_input", "usage: docify pin <library> [version]");
        const file = Docify.writePin(process.cwd(), library.toLowerCase(), version ?? null);
        console.log(version ? `pinned ${library}@${version} in ${file}` : `unpinned ${library} in ${file}`);
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
