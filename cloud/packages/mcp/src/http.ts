import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

// Serve one Streamable-HTTP request statelessly: fresh transport, JSON
// response (no SSE), nothing kept afterwards. Web-standard Request/Response,
// so any host that has them — a Next.js route handler, Hono, a Worker — can
// mount the server with one call.
export async function serveStatelessHttp(
  server: McpServer,
  request: Request,
): Promise<Response> {
  // Omitting sessionIdGenerator (not passing undefined) is what the SDK
  // reads as "stateless".
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void transport.close().catch(() => undefined);
  }
}
