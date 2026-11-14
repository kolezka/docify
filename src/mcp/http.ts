import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Docify } from "../core/docify.ts";
import type { Handler } from "../http/guard.ts";
import { createMcpServer, type McpHooks } from "./tools.ts";

// Stateless Streamable HTTP: one server and transport per POST, JSON responses, no sessions.
// The tools only read, so there is nothing to stream and nothing to resume.
// `hooks` is asked per request, so the caller can tie a search to whoever sent it.
export function mcpHttpHandler(docify: Docify, opts: { project: string; maxBodyBytes: number; hooks?: (req: Request) => McpHooks | undefined }): Handler {
  return async (req) => {
    if (req.method !== "POST") {
      return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "method not allowed; this server is stateless and takes POST only" }, id: null }, { status: 405, headers: { allow: "POST" } });
    }
    const server = createMcpServer(docify, opts.project, opts.hooks?.(req));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: opts.maxBodyBytes,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      await transport.close();
      await server.close();
    }
  };
}
