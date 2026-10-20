// The AI chat's MCP tools (docs/ai-chat.md): every tool the cloud MCP server
// (packages/mcp) offers, run in-process for the signed-in user. They reach the
// cloud's routes the way a browser does — the user's session cookie and the
// app origin the chat request came from — so the routes stay the one place
// behaviour, limits and permissions live, exactly as for an MCP client.
//
// A tool added to the MCP server is a tool the chat has; only the ones that
// make no sense from inside a chat are left out (EXCLUDED_MCP_TOOLS).
import { connectInProcessMcp, type InProcessMcp } from "@frameos-cloud/mcp";
import type { FetchLike } from "@frameos-cloud/mcp";
import type { ResponsesToolDefinition } from "./openai";
import { untrustedResult, type ExtraTools, type ToolOutput } from "./tools";

// The AI tools would start a chat inside the chat; API tokens are the owner's
// credentials; enrolling, revoking and deleting frames stay with the owner's
// own hands in the workspace (the routes also want a recent sign-in, which a
// chat's session cookie could otherwise lend).
export const EXCLUDED_MCP_TOOLS: ReadonlySet<string> = new Set([
  "ai_chat_delete",
  "ai_chat_get",
  "ai_chats_list",
  "ai_scene_chat",
  "ai_turn_cancel",
  "ai_turn_wait",
  "api_token_revoke",
  "api_tokens_list",
  "frame_claim_token_create",
  "frame_delete",
  "frame_revoke",
]);

export function mcpToolLabel(name: string, title?: string): string {
  if (title) {
    return title;
  }
  const words = name.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// An MCP input schema as Responses function parameters: the SDK's JSON
// Schema, minus the draft marker OpenAI does not want.
export function mcpToolDefinition(tool: InProcessMcp["tools"][number]): ResponsesToolDefinition {
  const { $schema: _schema, ...parameters } = tool.inputSchema;
  return {
    description: tool.description,
    name: tool.name,
    parameters: { properties: {}, type: "object", ...parameters },
    type: "function",
  };
}

// A tool result for the model. Text goes inside the untrusted frame: a
// frame's logs, a store scene's description, a photo's metadata are all
// written by someone other than the user. Images (frame_screenshot,
// scene_render) go beside it as data URLs, like render_scene's.
export function mcpResultOutput(
  name: string,
  result: Awaited<ReturnType<InProcessMcp["call"]>>,
): ToolOutput {
  const texts: string[] = [];
  const images: ToolOutput["images"] = [];
  for (const item of result.content) {
    if (item.type === "text" && typeof item.text === "string") {
      texts.push(item.text);
    } else if (item.type === "image" && typeof item.data === "string") {
      images.push({ dataUrl: `data:${item.mimeType || "image/png"};base64,${item.data}` });
    }
  }
  const text = texts.join("\n") || (images.length > 0 ? "(an image)" : "(no output)");
  if (result.isError) {
    return { images, text: JSON.stringify({ error: text, ok: false }) };
  }
  return { images, text: untrustedResult(name, text) };
}

export function sessionFetch({ cookie, origin }: { cookie: string; origin: string }): FetchLike {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    // The MCP client always sends a bearer; the chat has a session instead.
    headers.delete("authorization");
    headers.set("cookie", cookie);
    headers.set("origin", origin);
    return fetch(input, { ...init, headers });
  };
}

export async function connectChatMcpTools(options: {
  baseUrl: string;
  // The chat request's own credential: its session cookie (with the origin
  // the request passed the CSRF check with), or the API token it came with.
  credential: { cookie: string; origin: string } | { token: string };
  publicOrigin: string;
  storeOrigin: string;
  headers?: Record<string, string>;
  fetchExternal?: FetchLike;
  userAgent?: string;
}): Promise<ExtraTools & { close(): Promise<void> }> {
  const mcp = await connectInProcessMcp({
    baseUrl: options.baseUrl,
    fetch: "cookie" in options.credential ? sessionFetch(options.credential) : undefined,
    fetchExternal: options.fetchExternal,
    headers: options.headers,
    publicOrigin: options.publicOrigin,
    storeOrigin: options.storeOrigin,
    // With a session, never sent: sessionFetch drops the authorization header.
    token: "token" in options.credential ? options.credential.token : "session",
    userAgent: options.userAgent,
  });
  return extraToolsFrom(mcp);
}

export function extraToolsFrom(mcp: InProcessMcp): ExtraTools & { close(): Promise<void> } {
  const tools = mcp.tools.filter((tool) => !EXCLUDED_MCP_TOOLS.has(tool.name));
  const names = new Set(tools.map((tool) => tool.name));
  return {
    async call(name, args) {
      if (!names.has(name)) {
        return { images: [], text: JSON.stringify({ error: `Unknown tool: ${name}` }) };
      }
      return mcpResultOutput(name, await mcp.call(name, args));
    },
    close: () => mcp.close(),
    definitions: tools.map(mcpToolDefinition),
    labels: Object.fromEntries(tools.map((tool) => [tool.name, mcpToolLabel(tool.name, tool.title)])),
  };
}
