import { afterEach, describe, expect, it, vi } from "vitest";
import {
  modelSupportsReasoning,
  resolveChatModel,
  resolveReasoningEffort,
  streamResponse,
} from "./openai";

function sseResponse(events: { event?: string; data: unknown }[]): Response {
  const body = events
    .map((entry) => {
      const lines = [];
      if (entry.event) {
        lines.push(`event: ${entry.event}`);
      }
      lines.push(`data: ${JSON.stringify(entry.data)}`);
      return lines.join("\n") + "\n\n";
    })
    .join("");
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
    status: 200,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("model resolution", () => {
  it("prefers chatModel, then model, then the default", () => {
    expect(resolveChatModel({})).toBe("gpt-5.5");
    expect(resolveChatModel({ model: "gpt-4.1" })).toBe("gpt-4.1");
    expect(resolveChatModel({ chatModel: "gpt-5.5-mini", model: "gpt-4.1" })).toBe(
      "gpt-5.5-mini",
    );
  });

  it("only accepts known reasoning efforts", () => {
    expect(resolveReasoningEffort({})).toBe("low");
    expect(resolveReasoningEffort({ chatReasoningEffort: "high" })).toBe("high");
    expect(resolveReasoningEffort({ chatReasoningEffort: "extreme" })).toBe("low");
  });

  it("knows which models take a reasoning param", () => {
    expect(modelSupportsReasoning("gpt-5.5")).toBe(true);
    expect(modelSupportsReasoning("o3")).toBe(true);
    expect(modelSupportsReasoning("gpt-4.1")).toBe(false);
  });
});

describe("streamResponse", () => {
  it("streams text deltas and returns the completed output", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        sseResponse([
          { data: { type: "response.created" } },
          { data: { delta: "Hel", type: "response.output_text.delta" } },
          { data: { delta: "lo", type: "response.output_text.delta" } },
          {
            data: {
              response: {
                output: [
                  {
                    content: [{ text: "Hello", type: "output_text" }],
                    role: "assistant",
                    type: "message",
                  },
                  {
                    arguments: '{"query":"clock"}',
                    call_id: "call_1",
                    name: "search_apps",
                    type: "function_call",
                  },
                ],
                status: "completed",
              },
              type: "response.completed",
            },
          },
        ]),
      );

    const deltas: string[] = [];
    const result = await streamResponse({
      apiKey: "sk-test",
      input: [],
      instructions: "test",
      model: "gpt-5.5",
      onTextDelta: (delta) => deltas.push(delta),
      tools: [],
    });

    expect(deltas).toEqual(["Hel", "lo"]);
    expect(result.outputText).toBe("Hello");
    expect(result.functionCalls).toHaveLength(1);
    expect(result.functionCalls[0]?.name).toBe("search_apps");
    expect(result.functionCalls[0]?.call_id).toBe("call_1");

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("omits the reasoning param for non-reasoning models", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        sseResponse([
          {
            data: {
              response: { output: [], status: "completed" },
              type: "response.completed",
            },
          },
        ]),
      );
    await streamResponse({
      apiKey: "sk-test",
      input: [],
      instructions: "test",
      model: "gpt-4.1",
      onTextDelta: () => {},
      tools: [],
    });
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.reasoning).toBeUndefined();
    expect(body.include).toBeUndefined();
  });

  it("surfaces stream failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([
        {
          data: {
            response: { error: { message: "boom" } },
            type: "response.failed",
          },
        },
      ]),
    );
    await expect(
      streamResponse({
        apiKey: "sk-test",
        input: [],
        instructions: "test",
        model: "gpt-5.5",
        onTextDelta: () => {},
        tools: [],
      }),
    ).rejects.toThrow("boom");
  });

  it("turns a 404 into a model-name hint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Not found" } }), {
        status: 404,
      }),
    );
    await expect(
      streamResponse({
        apiKey: "sk-test",
        input: [],
        instructions: "test",
        model: "gpt-nope",
        onTextDelta: () => {},
        tools: [],
      }),
    ).rejects.toThrow(/gpt-nope/);
  });
});
