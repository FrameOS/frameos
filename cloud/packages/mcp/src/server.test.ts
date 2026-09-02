import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { createFrameosMcpServer } from "./server";
import { serveStatelessHttp } from "./http";

// The server against a fake cloud: every tool is one or two HTTP calls, so
// the tests pin exactly which route each tool hits, with what, and how the
// API's refusals come back to the model. No network, no database.

type Recorded = { body: unknown; headers: Record<string, string>; method: string; url: string };

const frameId = "11111111-2222-3333-4444-555555555555";
const sceneId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let calls: Recorded[] = [];
let responders: ((call: Recorded) => Response | undefined)[] = [];

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

async function fakeFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(init?.headers ?? {})) {
    headers[key.toLowerCase()] = String(value);
  }
  let body: unknown = undefined;
  if (typeof init?.body === "string") {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = init.body;
    }
  } else if (init?.body instanceof FormData) {
    body = Object.fromEntries(
      [...init.body.entries()].map(([key, value]) => [
        key,
        value instanceof File ? { name: value.name, size: value.size } : value,
      ]),
    );
  }
  const call: Recorded = { body, headers, method: init?.method ?? "GET", url: input };
  calls.push(call);
  for (const responder of responders) {
    const response = responder(call);
    if (response) {
      return response;
    }
  }
  const path = new URL(input).pathname;
  if (path === "/api/frames" && call.method === "GET") {
    return json({
      frames: [
        {
          assigned_checksum: "abc",
          connected: true,
          frameos_version: "2026.8.40",
          hardware: { platform: "esp32-s3" },
          id: frameId,
          interval: 300,
          last_seen_at: "2026-08-29T10:00:00.000Z",
          name: "Kitchen",
          next_wake_at: null,
          scenes_checksum: "abc",
          sleep_reason: null,
          status: "active",
          timezone: "Europe/Brussels",
        },
      ],
    });
  }
  if (path === `/api/frames/${frameId}` && call.method === "GET") {
    return json({ frame: { id: frameId, name: "Kitchen", schedule: { events: [] }, timezone: "UTC" } });
  }
  if (path === `/api/frames/${frameId}/scenes` && call.method === "GET") {
    return json({
      assigned_checksum: "abc",
      scenes: [
        { name: "A", position: 0, scene_id: sceneId, scene_version: 2 },
        { name: "B", position: 1, scene_id: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee", scene_version: null },
      ],
      scenes_checksum: "abc",
    });
  }
  if (path === `/api/frames/${frameId}/scenes` && call.method === "POST") {
    return json({ assigned_checksum: "def", command_id: "cmd-1", status: "queued" });
  }
  if (path === `/api/frames/${frameId}/scenes/add`) {
    return json({ already_assigned: false, command_id: "cmd-2", connected: true, status: "queued" });
  }
  if (path === `/api/frames/${frameId}/event/setCurrentScene`) {
    return json({ command_id: "cmd-3", status: "queued", type: "set_current_scene" });
  }
  if (path === `/api/frames/${frameId}/image`) {
    return new Response(pngBytes, { headers: { "content-type": "image/png" } });
  }
  if (path === `/api/frames/${frameId}/logs`) {
    return json({
      has_more: false,
      logs: [
        { id: 1, line: '{"event":"render:done"}', timestamp: "t1", type: "log" },
        { id: 2, line: '{"event":"error:1","error":"boom"}', timestamp: "t2", type: "log" },
        { id: 3, line: "plain", timestamp: "t3", type: "log" },
      ],
    });
  }
  if (path === "/api/account/usage") {
    return json({
      account: { email: "me@example.com", id: "acc-1" },
      auth: { kind: "api_token", token_access: "full" },
      limits: { frames: { max_scenes_per_frame: 20 } },
      usage: { frames: { count: 1, max_count: 50 } },
    });
  }
  if (path === "/api/settings" && call.method === "GET") {
    return json({ openAI: { apiKey: "sk-1234567890abcdef", chatModel: "gpt-5.5" }, unsplash: { accessKey: "" } });
  }
  if (path === "/api/settings" && call.method === "POST") {
    return json(body);
  }
  if (path === "/api/account/scenes" && call.method === "GET") {
    return json({ scenes: [{ id: sceneId, latest_version: 3, name: "Clock", slug: "clock", visibility: "private" }] });
  }
  if (path === "/api/account/scenes" && call.method === "POST") {
    return json({ scene: { id: "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee", name: "New", slug: "new" }, status: "published" });
  }
  if (path === `/api/account/scenes/${sceneId}` && call.method === "GET") {
    return json({ images: [], scene: { id: sceneId, name: "Clock", slug: "clock" }, versions: [{ version: 3 }, { version: 2 }, { version: 1 }] });
  }
  if (path === `/api/account/scenes/${sceneId}/content`) {
    return json({ scene: { id: sceneId, latest_version: 4, name: (body as { scenes: { name: string }[] }).scenes[0]?.name ?? "Clock" }, status: "published", version: 4 });
  }
  if (path === `/api/store/scenes/${sceneId}/scenes.json`) {
    return json([{ edges: [], fields: [], id: "runtime-1", name: "Clock", nodes: [{ id: "n1" }], origin: { storeSceneId: sceneId } }]);
  }
  if (path === "/api/store/repository.json") {
    return json({ templates: [{ id: "clock", name: "Clock", sceneId }] });
  }
  if (path === "/api/store/account/repository.json") {
    return json({ templates: [] });
  }
  if (path === "/api/scenes/render") {
    return json({ errors: [], height: 480, logs: ["ok"], png_base64: pngBytes.toString("base64"), render_ms: 12, state: {}, width: 800 });
  }
  if (path === "/api/ai/chat" && call.method === "POST") {
    const lines = [
      { chatId: "chat-1", turnId: "turn-1", type: "chat" },
      { text: "Building", type: "delta" },
      { label: "Create scenes", name: "create_scenes", status: "done", type: "tool" },
      { scenes: [{ id: "s1", name: "Made", nodes: [] }], title: "Made", tool: "build_scene", type: "scenes" },
      { reply: "Done!", tool: "build_scene", type: "done" },
    ];
    return new Response(lines.map((line) => JSON.stringify(line)).join("\n") + "\n", {
      headers: { "content-type": "application/x-ndjson" },
    });
  }
  return json({ error: "not_found", path }, 404);
}

async function connect() {
  const server = createFrameosMcpServer({
    baseUrl: "https://cloud.example",
    fetch: fakeFetch,
    fetchExternal: fakeFetch,
    publicOrigin: "https://cloud.example",
    storeOrigin: "https://scenes.example",
    token: "fc_api_test",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as { text?: string; type: string }[];
  return content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n");
}

beforeEach(() => {
  calls = [];
  responders = [];
});

describe("frameos-cloud MCP server", () => {
  it("lists the expected tool families", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of [
      "account_quota",
      "frames_list",
      "frame_scene_install",
      "frame_screenshot",
      "scenes_list",
      "scene_update_content",
      "scene_render",
      "scene_lint",
      "scene_convert",
      "store_browse",
      "ai_scene_chat",
      "api_tokens_list",
    ]) {
      expect(names).toContain(expected);
    }
    expect(tools.length).toBeGreaterThan(60);
    // Destructive tools say so.
    expect(tools.find((tool) => tool.name === "frame_delete")?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((tool) => tool.name === "frames_list")?.annotations?.readOnlyHint).toBe(true);
  });

  it("sends the bearer token and reads the frames list", async () => {
    const client = await connect();
    const result = await client.callTool({ arguments: {}, name: "frames_list" });
    expect(calls[0]?.headers.authorization).toBe("Bearer fc_api_test");
    const payload = JSON.parse(textOf(result)) as { frames: { in_sync: boolean; name: string; platform: string }[] };
    expect(payload.frames[0]).toMatchObject({ in_sync: true, name: "Kitchen", platform: "esp32-s3" });
  });

  it("removes one scene by re-assigning the rest with their pins", async () => {
    const client = await connect();
    const result = await client.callTool({
      arguments: { frame_id: frameId, scene_id: sceneId },
      name: "frame_scene_remove",
    });
    const post = calls.find((call) => call.method === "POST");
    expect(post?.url).toContain(`/api/frames/${frameId}/scenes`);
    expect(post?.body).toEqual({
      scenes: [{ scene_id: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee", scene_version: null }],
    });
    expect(JSON.parse(textOf(result))).toMatchObject({ removed: sceneId, remaining: 1 });
  });

  it("installs a scene from raw JSON by creating a private scene first, then activates it", async () => {
    const client = await connect();
    const result = await client.callTool({
      arguments: {
        activate: true,
        confirm: true,
        frame_id: frameId,
        name: "Fresh",
        scenes: [{ id: "x", name: "Fresh", nodes: [], edges: [], fields: [], settings: {} }],
      },
      name: "frame_scene_install",
    });
    const paths = calls.map((call) => `${call.method} ${new URL(call.url).pathname}`);
    expect(paths).toEqual([
      "POST /api/account/scenes",
      `POST /api/frames/${frameId}/scenes/add`,
      `POST /api/frames/${frameId}/event/setCurrentScene`,
    ]);
    expect(calls[0]?.body).toMatchObject({ name: "Fresh" });
    expect(calls[1]?.body).toEqual({ scene_id: "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee" });
    expect(JSON.parse(textOf(result))).toMatchObject({ created_private_scene: true, command_id: "cmd-2" });
  });

  it("resolves a store page URL to its scene id for installs, passing the grant along", async () => {
    const client = await connect();
    await client.callTool({
      arguments: {
        confirm: true,
        frame_id: frameId,
        settings_groups: ["unsplash"],
        url: "https://scenes.example/s/clock",
      },
      name: "frame_scene_install",
    });
    const add = calls.find((call) => call.url.includes("/scenes/add"));
    expect(add?.body).toEqual({ scene_id: sceneId, settings_groups: ["unsplash"] });
  });

  it("refuses to deploy to a frame without confirm", async () => {
    const client = await connect();
    for (const [name, args] of [
      ["frame_scene_install", { frame_id: frameId, scene_id: sceneId }],
      ["frame_scenes_set", { frame_id: frameId, scenes: [{ scene_id: sceneId }] }],
      ["frame_settings_update", { frame_id: frameId, settings: { interval: 60 } }],
      ["frame_service_settings_enable", { enabled: true, frame_id: frameId }],
      ["frame_firmware_update", { frame_id: frameId }],
    ] as const) {
      const result = await client.callTool({ arguments: { ...args }, name });
      expect(result.isError, name).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it("posts per-scene grants with frame_scenes_set", async () => {
    const client = await connect();
    await client.callTool({
      arguments: {
        confirm: true,
        frame_id: frameId,
        scenes: [{ scene_id: sceneId, settings_groups: ["openAI"] }],
      },
      name: "frame_scenes_set",
    });
    expect(calls[0]?.body).toEqual({
      scenes: [{ scene_id: sceneId, settings_groups: ["openAI"] }],
    });
  });

  it("returns screenshots as image content", async () => {
    const client = await connect();
    const result = await client.callTool({ arguments: { frame_id: frameId, refresh: true }, name: "frame_screenshot" });
    const content = result.content as { data?: string; mimeType?: string; type: string }[];
    const img = content.find((entry) => entry.type === "image");
    expect(img?.mimeType).toBe("image/png");
    expect(img?.data).toBe(pngBytes.toString("base64"));
    expect(new URL(calls[0]!.url).searchParams.get("t")).not.toBe("-1");
  });

  it("filters and caps frame logs", async () => {
    const client = await connect();
    const result = await client.callTool({
      arguments: { frame_id: frameId, limit: 5, search: "error" },
      name: "frame_logs",
    });
    const payload = JSON.parse(textOf(result)) as { logs: { id: number }[]; matched: number; newest_id: number };
    expect(payload.matched).toBe(1);
    expect(payload.logs.map((entry) => entry.id)).toEqual([2]);
    expect(payload.newest_id).toBe(3);
  });

  it("masks secrets in settings and offers no way to reveal them", async () => {
    const client = await connect();
    const masked = JSON.parse(textOf(await client.callTool({ arguments: {}, name: "account_settings_get" }))) as {
      openAI: { apiKey: string; chatModel: string };
    };
    expect(masked.openAI.apiKey).toMatch(/^•+cdef$/);
    expect(masked.openAI.chatModel).toBe("gpt-5.5");
    // `reveal` used to be an input; the cloud never hands a stored key to a
    // token, so the tool no longer pretends it can.
    const attempt = await client.callTool({ arguments: { reveal: true }, name: "account_settings_get" });
    expect(JSON.parse(textOf(attempt)).openAI.apiKey).toMatch(/^•+cdef$/);
  });

  it("merges a settings update over the current group before posting", async () => {
    const client = await connect();
    await client.callTool({
      arguments: { settings: { openAI: { apiKey: "sk-new" } } },
      name: "account_settings_update",
    });
    const post = calls.find((call) => call.method === "POST");
    expect(post?.body).toEqual({ openAI: { apiKey: "sk-new", chatModel: "gpt-5.5" } });
  });

  it("renames a scene through a content save and reports whether the listing followed", async () => {
    const client = await connect();
    const result = await client.callTool({
      arguments: { name: "Wall clock", scene_id: sceneId },
      name: "scene_rename",
    });
    const save = calls.find((call) => call.url.endsWith("/content"));
    const body = save?.body as { message: string; scenes: { name: string; origin?: unknown }[] };
    expect(body.scenes[0]?.name).toBe("Wall clock");
    expect(body.scenes[0]?.origin).toBeUndefined();
    expect(body.message).toBe("Renamed to Wall clock");
    expect(JSON.parse(textOf(result))).toMatchObject({ listing_renamed: true, previous_name: "Clock" });
  });

  it("restores a version by re-saving its content", async () => {
    const client = await connect();
    await client.callTool({ arguments: { scene_id: sceneId, version: 2 }, name: "scene_version_restore" });
    expect(new URL(calls[0]!.url).searchParams.get("version")).toBe("2");
    expect((calls[1]?.body as { message: string }).message).toBe("Restored version 2");
  });

  it("renders a scene and returns the image with the runtime's logs", async () => {
    const client = await connect();
    const result = await client.callTool({
      arguments: { scene_id: sceneId, width: 400, height: 300, time_zone: "Europe/Brussels" },
      name: "scene_render",
    });
    const render = calls.find((call) => call.url.endsWith("/api/scenes/render"));
    expect(render?.body).toMatchObject({ format: "json", height: 300, scene_id: sceneId, time_zone: "Europe/Brussels", width: 400 });
    const content = result.content as { type: string }[];
    expect(content.map((entry) => entry.type)).toEqual(["text", "image"]);
    expect(JSON.parse(textOf(result))).toMatchObject({ render_ms: 12, errors: [] });
  });

  it("drives an AI turn to completion and saves the result as a new scene", async () => {
    const client = await connect();
    const result = await client.callTool({
      arguments: { apply: "new_scene", prompt: "a clock", wait_seconds: 10 },
      name: "ai_scene_chat",
    });
    const chat = calls.find((call) => call.url.endsWith("/api/ai/chat"));
    expect(chat?.body).toMatchObject({ prompt: "a clock", surface: "store-new" });
    const save = calls.find((call) => call.url.endsWith("/api/account/scenes") && call.method === "POST");
    expect(save?.body).toMatchObject({ name: "Made" });
    const payload = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(payload).toMatchObject({ chat_id: "chat-1", reply: "Done!", status: "done", turn_id: "turn-1" });
    expect(payload.saved).toBeDefined();
  });

  it("hands the model a turn id when the turn outlives the wait", async () => {
    responders.push((call) => {
      if (!call.url.endsWith("/api/ai/chat")) {
        return undefined;
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify({ chatId: "chat-2", turnId: "turn-2", type: "chat" }) + "\n"),
          );
          // Never closes: the turn is still thinking.
        },
      });
      return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
    });
    const client = await connect();
    const result = await client.callTool({
      arguments: { prompt: "slow", wait_seconds: 5 },
      name: "ai_scene_chat",
    });
    const payload = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(payload).toMatchObject({ events_seen: 1, status: "running", turn_id: "turn-2" });
  }, 15_000);

  it("explains API refusals instead of throwing", async () => {
    responders.push((call) =>
      call.url.endsWith("/revoke") ? json({ error: "reauth_required", reauth: { path: "/login/reauth" } }, 403) : undefined,
    );
    const client = await connect();
    const result = await client.callTool({ arguments: { confirm: true, frame_id: frameId }, name: "frame_revoke" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("403 reauth_required");
    expect(textOf(result)).toContain("sudo mode");
  });

  it("refuses to delete without confirm", async () => {
    const client = await connect();
    const result = await client.callTool({ arguments: { frame_id: frameId }, name: "frame_delete" });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("serves resources", async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toContain("frameos://frames");
    const frame = await client.readResource({ uri: `frameos://frames/${frameId}` });
    expect(JSON.parse((frame.contents[0] as { text: string }).text)).toMatchObject({ frame: { name: "Kitchen" } });
  });
});

describe("serveStatelessHttp", () => {
  it("answers a JSON-RPC request over a web-standard Request", async () => {
    const server = createFrameosMcpServer({
      baseUrl: "https://cloud.example",
      fetch: fakeFetch,
      token: "fc_api_test",
    });
    const request = new Request("https://cloud.example/api/mcp", {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
          protocolVersion: "2025-06-18",
        },
      }),
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      method: "POST",
    });
    const response = await serveStatelessHttp(server, request);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { result: { serverInfo: { name: string } } };
    expect(payload.result.serverInfo.name).toBe("frameos-cloud");
  });
});
