import { expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.ts";

const pluginRoot = join(import.meta.dir, "..", "integrations", "claude-code", "docify");
const readJson = (path: string) => JSON.parse(readFileSync(join(pluginRoot, path), "utf8"));
const RUNTIME = "claude-plugin-dsh";
const RUNTIME_VERSION = "0.1.0";
const RUNTIME_INTEGRITY = "sha512-oQXwpYcLwzxOOSeltN1E4vztrx4tFLkOA9ws0uo4Sw1RlojmL38djKJIiebhJkU78K9omu3YV/csnlM3+PFhIw==";

// Runs in a separate node process: imports the adapter, applies it to a minimal DSH host and
// prints where the runtime resolved from plus what the plugin registered.
const PROBE = `
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const adapterPath = process.argv[2];
const adapter = await import(pathToFileURL(adapterPath).href);
// Resolve from the adapter's directory, the way its own import is resolved.
const fromAdapter = createRequire(adapterPath);
const runtimeEntry = fromAdapter.resolve("${RUNTIME}");
const runtimePkg = fromAdapter.resolve("${RUNTIME}/package.json");
const providers = [], commands = [], sections = [], events = [], warnings = [];
const ctx = {
  logger: { warn: (m) => warnings.push(String(m)), info() {}, debug() {} },
  skills: { registerProvider: (create) => providers.push(create({ signal: new AbortController().signal, invalidate() {} })) },
  commands: { register: (d) => commands.push(d.name) },
  systemPrompt: { section: (s) => sections.push(s) },
  workingDirectory: { get: () => process.cwd() },
  inject: (_services, callback) => callback(ctx),
  effect() {},
  on: (event) => events.push(event),
};
await adapter.apply(ctx, {});
const skills = [];
for (const provider of providers)
  for (const candidate of await provider.list({})) skills.push({ name: candidate.name, content: (await provider.get(candidate, {}))?.content ?? "" });
console.log(JSON.stringify({ name: adapter.name, runtimeEntry, runtimeVersion: JSON.parse(readFileSync(runtimePkg, "utf8")).version, skills, commands, sections, events, warnings }));
`;

// Copies the plugin as a user would get it: no node_modules, no repo root around it.
function standalonePlugin() {
  const root = join(realpathSync(tempDir("docify-dsh-")), "docify");
  cpSync(pluginRoot, root, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)$/.test(src) });
  return root;
}

function install(root: string) {
  const result = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], { cwd: join(root, "dsh"), stdout: "pipe", stderr: "pipe" });
  expect({ exitCode: result.exitCode, stderr: result.exitCode === 0 ? "" : result.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
}

function probe(root: string) {
  const script = join(tempDir("docify-dsh-probe-"), "probe.mjs");
  writeFileSync(script, PROBE);
  const result = Bun.spawnSync(["node", script, join(root, "dsh", "index.js")], { stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

test("the DSH adapter depends on the published runtime directly, with no vendored copy", () => {
  const pkg = readJson("dsh/package.json");
  expect(pkg.dependencies).toEqual({ [RUNTIME]: RUNTIME_VERSION });
  expect(pkg.files).toContain("bun.lock");
  expect(pkg.files).not.toContain("claude-compat.js");
  expect(existsSync(join(pluginRoot, "dsh", "claude-compat.js"))).toBe(false);
  const source = readFileSync(join(pluginRoot, "dsh", "index.js"), "utf8");
  expect(source).toContain(`import { createPlugin, rootFrom } from '${RUNTIME}'`);
  expect(source).toContain("root: rootFrom(import.meta.url)");
  const lock = readFileSync(join(pluginRoot, "dsh", "bun.lock"), "utf8");
  expect(lock).toContain(`"${RUNTIME}@${RUNTIME_VERSION}"`);
  expect(lock).toContain(RUNTIME_INTEGRITY);
});

test("a standalone copy installs the runtime from the lockfile and registers the docify skill through it", () => {
  const root = standalonePlugin();
  install(root);
  const run = probe(root);
  expect({ exitCode: run.exitCode, stderr: run.stderr }).toEqual({ exitCode: 0, stderr: "" });
  const seen = JSON.parse(run.stdout);
  expect(seen.runtimeEntry).toBe(join(root, "dsh", "node_modules", RUNTIME, "dist", "claude-compat.js"));
  expect(seen.runtimeVersion).toBe(RUNTIME_VERSION);
  expect(seen.name).toBe("claude-compat-docify");
  expect(seen.skills.map((s: { name: string }) => s.name)).toEqual(["docify"]);
  expect(seen.skills[0].content).toContain("docs_search");
  expect({ commands: seen.commands, sections: seen.sections, events: seen.events, warnings: seen.warnings }).toEqual({ commands: [], sections: [], events: [], warnings: [] });
});

test("without the installed runtime the adapter fails to load and names the missing package", () => {
  const run = probe(standalonePlugin());
  expect(run.exitCode).not.toBe(0);
  expect(run.stderr).toContain(`Cannot find package '${RUNTIME}'`);
  expect(run.stdout).toBe("");
});

test("the DSH bundle patch loads this adapter and starts the same MCP server as plugin.json", () => {
  // The runtime does not read mcpServers, so the patch row is the only way DSH gets the tools.
  const rows = (Bun.YAML.parse(readFileSync(join(pluginRoot, "dsh", "cordis.patch.yml"), "utf8")) as { insert: any[] }[]).flatMap((patch) => patch.insert);
  expect(rows.map((row) => row.name)).toEqual([readJson("dsh/package.json").name, "@deepseek-ai/dsh-mcp-client"]);
  const server = readJson(".claude-plugin/plugin.json").mcpServers.docify;
  const config = rows[1].config;
  expect({ serverName: config.serverName, transport: config.transport, args: config.args }).toEqual({ serverName: "docify", transport: "stdio", args: server.args });
  expect(config.command).toBe(`process.env.DOCIFY_BIN || "${server.command}"`);
});
