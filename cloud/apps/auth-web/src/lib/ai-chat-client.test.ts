import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AiChatRequestError,
  parseAiChatLine,
  streamAiChat,
  type AiChatEvent,
} from "./ai-chat-client";

function ndjsonResponse(chunks: string[], init: ResponseInit = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson" },
    status: 200,
    ...init,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamAiChat", () => {
  it("reassembles events split across chunks and hands them over in order", async () => {
    const chunks = [
      '{"type":"chat","chatId":"c1"}\n{"type":"delta","te',
      'xt":"Hel"}\n{"type":"delta","text":"lo"}\n',
      'garbage line\n{"type":"tool","name":"search_apps","label":"Searching apps","status":"start"}\n',
      '{"type":"scenes","tool":"modify_scene","scenes":[{"id":"s1","name":"Clock"}]}\n',
      '{"type":"done","tool":"modify_scene","reply":"Hello"}',
    ];
    const fetchMock = vi.fn(async () => ndjsonResponse(chunks));
    vi.stubGlobal("fetch", fetchMock);

    const events: AiChatEvent[] = [];
    await streamAiChat(
      { chatId: "c1", prompt: "hi", sceneId: "s1" },
      { onEvent: (event) => void events.push(event) },
    );

    expect(events.map((event) => event.type)).toEqual([
      "chat",
      "delta",
      "delta",
      "tool",
      "scenes",
      "done",
    ]);
    expect(events[1]).toEqual({ text: "Hel", type: "delta" });
    expect(events[4]).toMatchObject({ scenes: [{ id: "s1" }], tool: "modify_scene" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/ai/chat");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ chatId: "c1", prompt: "hi", sceneId: "s1" });
  });

  it("throws AiChatRequestError with the server's error code before streaming", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ detail: "OpenAI backend API key not set", error: "missing_api_key" }, { status: 400 })),
    );
    const failure = await streamAiChat({ prompt: "hi" }, { onEvent: () => {} }).catch((error) => error);
    expect(failure).toBeInstanceOf(AiChatRequestError);
    expect((failure as AiChatRequestError).code).toBe("missing_api_key");
    expect((failure as AiChatRequestError).status).toBe(400);
    expect((failure as AiChatRequestError).message).toBe("OpenAI backend API key not set");
  });

  it("maps a bodyless 429 to rate_limited", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429 })));
    const failure = await streamAiChat({ prompt: "hi" }, { onEvent: () => {} }).catch((error) => error);
    expect((failure as AiChatRequestError).code).toBe("rate_limited");
  });

  it("forwards the abort signal to fetch", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBe(controller.signal);
      return ndjsonResponse(['{"type":"done","tool":"reply","reply":"ok"}\n']);
    });
    vi.stubGlobal("fetch", fetchMock);
    await streamAiChat({ prompt: "hi" }, { onEvent: () => {}, signal: controller.signal });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("parseAiChatLine", () => {
  it("accepts known events and rejects everything else", () => {
    expect(parseAiChatLine('{"type":"delta","text":"x"}')).toEqual({ text: "x", type: "delta" });
    expect(parseAiChatLine("")).toBeNull();
    expect(parseAiChatLine("not json")).toBeNull();
    expect(parseAiChatLine('{"type":"unknown"}')).toBeNull();
    expect(parseAiChatLine("[1,2]")).toBeNull();
  });
});
