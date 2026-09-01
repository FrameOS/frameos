import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { instrument } from "@posthog/mcp";
import { PostHog } from "posthog-node";
import { z } from "zod";
import { FrameosCloudClient, type FetchLike } from "./client";
import { explainError, type ToolContext } from "./result";
import { registerAccountTools } from "./tools/account";
import { registerAiTools } from "./tools/ai";
import { registerFrameTools } from "./tools/frames";
import { registerSceneTools } from "./tools/scenes";

// One McpServer per connection. Stateless by design: every tool call is
// an HTTP request to the cloud with the caller's token, so a server can be
// built per request (the /api/mcp route does) or once for a stdio process.

// Shared PostHog client — created once at module scope, never per request.
// Set POSTHOG_PROJECT_TOKEN and POSTHOG_HOST in the environment to enable.
export const posthog = new PostHog(process.env.POSTHOG_PROJECT_TOKEN ?? "", {
  host: process.env.POSTHOG_HOST ?? "https://eu.i.posthog.com",
});

export const serverVersion = "0.1.0";

export type FrameosMcpServerOptions = {
  /** Cloud API origin the tools call. */
  baseUrl: string;
  /** Fetch for user-supplied URLs (zip imports); defaults to global fetch. */
  fetchExternal?: FetchLike | undefined;
  /** Fetch for the cloud API itself; defaults to global fetch. */
  fetch?: FetchLike | undefined;
  /** Extra headers on every API call (the remote host forwards the client IP). */
  headers?: Record<string, string> | undefined;
  /** Public origin of the cloud UI for links (defaults to baseUrl). */
  publicOrigin?: string | undefined;
  /** Public origin of the scene store for links (defaults to publicOrigin). */
  storeOrigin?: string | undefined;
  token: string;
  userAgent?: string | undefined;
};

const instructions = `FrameOS Cloud: cloud-managed e-paper/LCD frames, the scenes they display, the public scene store, and an AI that builds scenes.

Vocabulary: a *frame* is a device enrolled with the cloud (frames_list). A *scene* is a graph of nodes (apps, code, events, state) that renders one screen; scenes live in the account as store scenes (private drafts or published), each with immutable numbered versions. A frame holds up to 20 assigned scenes and shows one at a time; a *schedule* switches between them. Scene JSON is the array from scenes.json — objects with id, name, nodes, edges, fields, settings (execution: "interpreted").

Typical flows:
- See what is on a frame: frame_get → frame_scenes_list → frame_screenshot; frame_logs when something looks wrong.
- Put a scene on a frame: store_browse or scenes_list → frame_scene_install (activate=true to show it now).
- Make a new scene: ai_scene_chat(prompt, apply="new_scene") or scene_create(scenes=…) → scene_render to preview → frame_scene_install.
- Change a scene: scene_get_content → edit → scene_lint → scene_update_content (new version) → frame_scene_install to re-deploy; or ai_scene_chat(scene_id, prompt, apply="save_version").
- Preview without a device: scene_render (real runtime, returns the image and logs).

Device actions are asynchronous: they return a command_id the frame applies when it next talks to the hub (frame_commands_list shows what is still queued). Deep-sleeping battery frames apply commands when they wake (frame_get: next_wake_at).

Destructive tools require confirm=true. Sudo-mode actions (revoking a frame, approving a device link) are never available to API tokens.`;

export function createFrameosMcpServer(options: FrameosMcpServerOptions) {
  const client = new FrameosCloudClient({
    baseUrl: options.baseUrl,
    fetch: options.fetch,
    headers: options.headers,
    token: options.token,
    userAgent: options.userAgent ?? `frameos-cloud-mcp/${serverVersion}`,
  });
  const publicOrigin = (options.publicOrigin ?? options.baseUrl).replace(/\/+$/, "");
  const ctx: ToolContext = {
    client,
    fetchExternal: options.fetchExternal ?? ((input, init) => fetch(input, init)),
    publicOrigin,
    storeOrigin: (options.storeOrigin ?? publicOrigin).replace(/\/+$/, ""),
  };

  const server = new McpServer(
    { name: "frameos-cloud", version: serverVersion },
    { capabilities: { logging: {} }, instructions },
  );
  instrument(server, posthog, {
    logger: (msg) => process.stderr.write(msg + "\n"),
  });

  registerAccountTools(server, ctx);
  registerFrameTools(server, ctx);
  registerSceneTools(server, ctx);
  registerAiTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server);

  return server;
}

// Resources: the read-only views an MCP client may want to attach as
// context without a tool call — the frame list, one frame, one scene's JSON.
function registerResources(server: McpServer, ctx: ToolContext) {
  server.registerResource(
    "frames",
    "frameos://frames",
    {
      description: "The account's cloud-managed frames (summary list).",
      mimeType: "application/json",
      title: "Frames",
    },
    async (uri) => {
      const payload = await ctx.client.json("GET", "/api/frames");
      return {
        contents: [
          { mimeType: "application/json", text: JSON.stringify(payload, null, 2), uri: uri.href },
        ],
      };
    },
  );

  server.registerResource(
    "frame",
    new ResourceTemplate("frameos://frames/{frameId}", {
      list: async () => {
        const payload = await ctx.client.json<{ frames: { id: string; name: string }[] }>(
          "GET",
          "/api/frames",
        );
        return {
          resources: payload.frames.map((frame) => ({
            description: `Frame "${frame.name}"`,
            mimeType: "application/json",
            name: frame.name,
            uri: `frameos://frames/${frame.id}`,
          })),
        };
      },
    }),
    { description: "One frame's full detail.", mimeType: "application/json", title: "Frame" },
    async (uri, { frameId }) => {
      const payload = await ctx.client.json("GET", `/api/frames/${String(frameId)}`);
      return {
        contents: [
          { mimeType: "application/json", text: JSON.stringify(payload, null, 2), uri: uri.href },
        ],
      };
    },
  );

  server.registerResource(
    "scenes",
    "frameos://scenes",
    {
      description: "The account's own scenes (summary list).",
      mimeType: "application/json",
      title: "My scenes",
    },
    async (uri) => {
      const payload = await ctx.client.json("GET", "/api/account/scenes");
      return {
        contents: [
          { mimeType: "application/json", text: JSON.stringify(payload, null, 2), uri: uri.href },
        ],
      };
    },
  );

  server.registerResource(
    "scene-content",
    new ResourceTemplate("frameos://scenes/{sceneId}/content", {
      list: async () => {
        const payload = await ctx.client.json<{ scenes: { id: string; name: string }[] }>(
          "GET",
          "/api/account/scenes",
        );
        return {
          resources: payload.scenes.map((scene) => ({
            description: `Scene "${scene.name}" (scenes.json)`,
            mimeType: "application/json",
            name: scene.name,
            uri: `frameos://scenes/${scene.id}/content`,
          })),
        };
      },
    }),
    {
      description: "A scene's scenes.json (latest non-yanked version).",
      mimeType: "application/json",
      title: "Scene content",
    },
    async (uri, { sceneId }) => {
      const payload = await ctx.client.json(
        "GET",
        `/api/store/scenes/${String(sceneId)}/scenes.json`,
      );
      return {
        contents: [
          { mimeType: "application/json", text: JSON.stringify(payload, null, 2), uri: uri.href },
        ],
      };
    },
  );
}

function registerPrompts(server: McpServer) {
  server.registerPrompt(
    "diagnose_frame",
    {
      argsSchema: { frame_id: z.string().describe("Frame id from frames_list") },
      description: "Walk through a frame's status, recent logs, metrics and queued commands and explain what is wrong.",
      title: "Diagnose a frame",
    },
    ({ frame_id }) => ({
      messages: [
        {
          content: {
            text: `Diagnose frame ${frame_id}. Use frame_get for status/connectivity/sleep forecast, frame_commands_list for anything stuck in the queue, frame_logs (search for "error" first, then the last 100 lines), frame_metrics for memory/battery trends, and frame_screenshot to see what is on the display. Summarise the likely cause and the concrete next step (a tool call, or something the owner must do physically).`,
            type: "text",
          },
          role: "user",
        },
      ],
    }),
  );

  server.registerPrompt(
    "build_scene",
    {
      argsSchema: {
        description: z.string().describe("What the scene should show"),
        frame_id: z.string().optional().describe("Frame to build it for and install on"),
      },
      description: "Create a scene with the scene AI, preview it, and optionally install it on a frame.",
      title: "Build a scene",
    },
    ({ description, frame_id }) => ({
      messages: [
        {
          content: {
            text: `Build a FrameOS scene: ${description}${frame_id ? ` It is for frame ${frame_id} (call frame_get first for its size and platform).` : ""}
1. Call ai_scene_chat with a precise prompt (include the frame's width/height and platform) and apply="new_scene".
2. Preview it with scene_render at the frame's resolution; if the logs show errors, fix them with scene_get_content + scene_update_content (or another ai_scene_chat with scene_id) and re-render.
3. Show me the preview and, ${frame_id ? `if it looks right, install it with frame_scene_install(frame_id, scene_id, activate=true)` : "ask whether to install it on a frame"}.`,
            type: "text",
          },
          role: "user",
        },
      ],
    }),
  );
}

export { explainError };
