import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Docify } from "../core/docify.ts";
import { createMcpServer } from "./tools.ts";

export async function startMcp() {
  const docify = new Docify();
  const server = createMcpServer(docify);
  await server.connect(new StdioServerTransport());
}
