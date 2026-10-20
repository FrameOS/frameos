import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFrameosMcpServer, serverVersion, type FrameosMcpServerOptions } from "./server";

// The MCP server and a client for it in one process, joined by an in-memory
// transport: how the cloud's AI chat gets every MCP tool (docs/ai-chat.md)
// without a network hop for the protocol itself. The tools still call the
// cloud's routes over HTTP, with whatever credential `options` carries.

export type ToolResultContent = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
};

export type InProcessTool = {
  name: string;
  title?: string | undefined;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type InProcessMcp = {
  tools: InProcessTool[];
  call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: ToolResultContent[]; isError: boolean }>;
  close(): Promise<void>;
};

export async function connectInProcessMcp(options: FrameosMcpServerOptions): Promise<InProcessMcp> {
  const server = createFrameosMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "frameos-ai-chat", version: serverVersion });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  return {
    async call(name, args) {
      const result = await client.callTool({ arguments: args, name });
      return {
        content: Array.isArray(result.content) ? (result.content as ToolResultContent[]) : [],
        isError: result.isError === true,
      };
    },
    async close() {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
    tools: tools.map((tool) => ({
      description: tool.description ?? "",
      inputSchema: tool.inputSchema as Record<string, unknown>,
      name: tool.name,
      title: tool.title ?? tool.annotations?.title,
    })),
  };
}
