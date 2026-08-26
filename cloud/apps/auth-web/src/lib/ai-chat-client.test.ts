import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AiChatRequestError,
  AiChatTransportError,
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

  it("ignores pings and resumes from the last seen event when the stream drops mid-turn", async () => {
    const encoder = new TextEncoder();
    // One chunk, then the connection dies (what Chrome reports as "network error").
    let pulls = 0;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(
            encoder.encode('{"type":"chat","chatId":"c1","turnId":"t1"}\n{"type":"ping"}\n{"type":"delta","text":"Hel"}\n'),
          );
        } else {
          controller.error(new TypeError("network error"));
        }
      },
    });
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      if (url === "/api/ai/chat") {
        return new Response(broken, { headers: { "content-type": "application/x-ndjson" }, status: 200 });
      }
      return ndjsonResponse(['{"type":"delta","text":"lo"}\n{"type":"done","tool":"reply","reply":"Hello"}\n']);
    });
    vi.stubGlobal("fetch", fetchMock);

    const events: AiChatEvent[] = [];
    const resumes: number[] = [];
    await streamAiChat(
      { chatId: "c1", prompt: "hi" },
      {
        onEvent: (event) => void events.push(event),
        onResume: ({ attempt }) => resumes.push(attempt),
        sleep: async () => {},
      },
    );
    expect(events.map((event) => event.type)).toEqual(["chat", "delta", "delta", "done"]);
    expect(calls).toEqual(["/api/ai/chat", "/api/ai/chat/turns/t1?after=2"]);
    expect(resumes).toEqual([1]);
  });

  it("treats a stream that closes without a terminal event as dropped", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/ai/chat") {
        return ndjsonResponse(['{"type":"chat","chatId":"c1","turnId":"t1"}\n{"type":"delta","text":"Hel"}\n']);
      }
      return ndjsonResponse(['{"type":"done","tool":"reply","reply":"Hel"}\n']);
    });
    vi.stubGlobal("fetch", fetchMock);
    const events: AiChatEvent[] = [];
    await streamAiChat({ prompt: "hi" }, { onEvent: (event) => void events.push(event), sleep: async () => {} });
    expect(events.map((event) => event.type)).toEqual(["chat", "delta", "done"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up with a readable message once the turn is gone", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/ai/chat") {
        return ndjsonResponse(['{"type":"chat","chatId":"c1","turnId":"t1"}\n']);
      }
      return Response.json({ error: "turn_not_found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const failure = await streamAiChat({ prompt: "hi" }, { onEvent: () => {}, sleep: async () => {} }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AiChatTransportError);
    expect((failure as AiChatTransportError).turnId).toBe("t1");
    expect((failure as Error).message).toMatch(
      /^Connection to the assistant dropped after \d+s and could not be re-established\. The assistant may still finish/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries resumes with backoff and fails after the attempt budget", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/ai/chat") {
        return ndjsonResponse(['{"type":"chat","chatId":"c1","turnId":"t1"}\n']);
      }
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    const slept: number[] = [];
    const failure = await streamAiChat(
      { prompt: "hi" },
      {
        onEvent: () => {},
        resumeAttempts: 3,
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    ).catch((error: unknown) => error);
    expect(slept).toEqual([500, 1500, 3000]);
    expect((failure as AiChatTransportError).attempts).toBe(3);
  });

  it("does not resume when the stream dropped before a turn id arrived", async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(encoder.encode('{"type":"delta","text":"x"}\n'));
        } else {
          controller.error(new TypeError("network error"));
        }
      },
    });
    const fetchMock = vi.fn(async () => new Response(broken, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const failure = await streamAiChat({ prompt: "hi" }, { onEvent: () => {}, sleep: async () => {} }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AiChatTransportError);
    expect((failure as Error).message).toMatch(/before it started working/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rethrows the caller's abort instead of resuming", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        streamController = ctrl;
        ctrl.enqueue(encoder.encode('{"type":"chat","chatId":"c1","turnId":"t1"}\n'));
        // stays open until aborted
      },
    });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const response = new Response(body, { status: 200 });
      // What a real fetch does on abort: the body errors with an AbortError.
      init?.signal?.addEventListener("abort", () => {
        streamController.error(new DOMException("The operation was aborted.", "AbortError"));
      });
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const pending = streamAiChat({ prompt: "hi" }, { onEvent: () => {}, signal: controller.signal, sleep: async () => {} });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const failure = await pending.catch((error: unknown) => error);
    expect((failure as Error).name).toBe("AbortError");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
