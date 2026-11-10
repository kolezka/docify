import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const pluginRoot = join(import.meta.dir, "..", "integrations", "claude-code", "docify");
const readJson = (path: string) => JSON.parse(readFileSync(join(pluginRoot, path), "utf8"));

// A minimal DSH host, shaped like the one `claude-plugins-dsh inspect` uses.
async function applyAdapter() {
  const adapter = await import(pathToFileURL(join(pluginRoot, "dsh", "index.js")).href);
  const providers: any[] = [];
  const commands: string[] = [];
  const sections: unknown[] = [];
  const events: string[] = [];
  const warnings: string[] = [];
  const ctx: any = {
    logger: { warn: (message: string) => warnings.push(message) },
    skills: { registerProvider: (create: any) => providers.push(create({ signal: new AbortController().signal, invalidate() {} })) },
    commands: { register: (definition: { name: string }) => commands.push(definition.name) },
    systemPrompt: { section: (section: unknown) => sections.push(section) },
    workingDirectory: { get: () => process.cwd() },
    inject: (_services: unknown, callback: (c: unknown) => void) => callback(ctx),
    effect() {},
    on: (event: string) => events.push(event),
  };
  await adapter.apply(ctx, {});
  const skills: { name: string; content: string }[] = [];
  for (const provider of providers) {
    for (const candidate of await provider.list({})) skills.push({ name: candidate.name, content: (await provider.get(candidate, {}))?.content ?? "" });
  }
  return { name: adapter.name as string, skills, commands, sections, events, warnings };
}

test("the DSH adapter registers the plugin's docify skill and nothing else", async () => {
  const seen = await applyAdapter();
  expect(seen.name).toBe("claude-compat-docify");
  expect(seen.skills.map((s) => s.name)).toEqual(["docify"]);
  expect(seen.skills[0]!.content).toContain("docs_search");
  expect({ commands: seen.commands, sections: seen.sections, events: seen.events, warnings: seen.warnings }).toEqual({ commands: [], sections: [], events: [], warnings: [] });
});

test("the DSH bundle patch loads this adapter and starts the same MCP server as plugin.json", () => {
  // claude-compat does not read mcpServers, so the patch row is the only way DSH gets the tools.
  const rows = (Bun.YAML.parse(readFileSync(join(pluginRoot, "dsh", "cordis.patch.yml"), "utf8")) as { insert: any[] }[]).flatMap((patch) => patch.insert);
  expect(rows.map((row) => row.name)).toEqual([readJson("dsh/package.json").name, "@deepseek-ai/dsh-mcp-client"]);
  const server = readJson(".claude-plugin/plugin.json").mcpServers.docify;
  const config = rows[1].config;
  expect({ serverName: config.serverName, transport: config.transport, args: config.args }).toEqual({ serverName: "docify", transport: "stdio", args: server.args });
  expect(config.command).toBe(`process.env.DOCIFY_BIN || "${server.command}"`);
});
