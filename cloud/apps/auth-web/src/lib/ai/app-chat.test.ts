import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maxAppFiles, readAppSources, runAppChat } from "./app-chat";
import { captureAiGeneration } from "./telemetry";

vi.mock("./telemetry", () => ({ captureAiGeneration: vi.fn() }));

function sseResponse(events: unknown[]): Response {
  const body = events.map((data) => `data: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
    status: 200,
  });
}

// streamResponse builds outputText from the deltas, so prose has to arrive
// that way — the completed payload only carries the structured output.
function completed(output: unknown[], text = ""): Response {
  return sseResponse([
    ...(text
      ? [{ delta: text, type: "response.output_text.delta" }]
      : []),
    { response: { output, status: "completed" }, type: "response.completed" },
  ]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readAppSources", () => {
  it("keeps string files and drops everything else", () => {
    expect(
      readAppSources({ "app.ts": "export default 1", bad: 5, worse: null }),
    ).toEqual({ "app.ts": "export default 1" });
  });

  it("is undefined when there is nothing usable", () => {
    expect(readAppSources(undefined)).toBeUndefined();
    expect(readAppSources({})).toBeUndefined();
    expect(readAppSources([])).toBeUndefined();
    expect(readAppSources({ a: 1 })).toBeUndefined();
  });

  it("bounds file count and total size instead of shipping an unbounded prompt", () => {
    const many = Object.fromEntries(
      Array.from({ length: maxAppFiles + 10 }, (_, index) => [`f${index}.ts`, "x"]),
    );
    expect(Object.keys(readAppSources(many) ?? {})).toHaveLength(maxAppFiles);

    const huge = readAppSources({ "app.ts": "y".repeat(500_000) });
    // Truncated, and it says so — a silently halved file reads as broken code.
    expect(huge?.["app.ts"]?.length).toBeLessThan(500_000);
    expect(huge?.["app.ts"]).toContain("truncated by FrameOS Cloud");
  });
});

describe("runAppChat", () => {
  const base = {
    apiKey: "sk-test",
    appKeyword: "code/weather",
    appName: "Weather",
    history: [],
    model: "gpt-5.5",
    nodeId: "node-1",
    prompt: "make the font bigger",
    sceneId: "scene-1",
    sources: { "app.ts": "export function render() {}" },
  };

  it("answers in prose when the model wrote no files", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      completed(
        [
          {
            content: [{ text: "It renders the temperature.", type: "output_text" }],
            role: "assistant",
            type: "message",
          },
        ],
        "It renders the temperature.",
      ),
    );
    const result = await runAppChat(base);
    expect(result).toEqual({
      reply: "It renders the temperature.",
      tool: "ask_about_app",
      // The counts the route meters the call with; this stub reports none.
      usage: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    });
  });

  it("returns edited files as edit_app, with the app's sources in the prompt", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      completed([
        {
          arguments: JSON.stringify({
            files: { "app.ts": "export function render() { /* bigger */ }" },
            reply: "Bumped the font size.",
          }),
          call_id: "call_1",
          name: "write_app_files",
          type: "function_call",
        },
      ]),
    );
    const result = await runAppChat(base);
    expect(result.tool).toBe("edit_app");
    expect(result.reply).toBe("Bumped the font size.");
    expect(result.files).toEqual({
      "app.ts": "export function render() { /* bigger */ }",
    });

    // The cloud hosts no app sources; they have to travel in the request or
    // the model is guessing at code it cannot see.
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(JSON.stringify(body.input)).toContain("export function render() {}");
    expect(JSON.stringify(body.input)).toContain("make the font bigger");
  });

  it("does not report an edit when the tool call carried no usable files", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      completed([
        {
          arguments: JSON.stringify({ files: {}, reply: "Rewrote it." }),
          call_id: "call_1",
          name: "write_app_files",
          type: "function_call",
        },
      ]),
    );
    const result = await runAppChat(base);
    // Anything but ask_about_app here would have the panel claim files were
    // written into an editor that received none.
    expect(result.tool).toBe("ask_about_app");
    expect(result.files).toBeUndefined();
  });

  // The surface used to be invisible to LLM telemetry: the meter saw its
  // tokens, PostHog saw no $ai_generation, and the reconcile between the two
  // could not tell that gap from a real leak.
  describe("telemetry", () => {
    const telemetry = { accountId: "acct-1", chatId: "chat-1", turnId: "turn-1" };

    beforeEach(() => {
      vi.mocked(captureAiGeneration).mockClear();
    });

    it("records the one model round under the route's turn id", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        completed([
          {
            arguments: JSON.stringify({ files: { "app.ts": "x" }, reply: "ok" }),
            call_id: "call_1",
            name: "write_app_files",
            type: "function_call",
          },
        ]),
      );
      await runAppChat({ ...base, reasoningEffort: "low", telemetry });
      expect(captureAiGeneration).toHaveBeenCalledTimes(1);
      expect(captureAiGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "acct-1",
          chatId: "chat-1",
          error: undefined,
          model: "gpt-5.5",
          reasoningEffort: "low",
          round: 1,
          status: "completed",
          toolCalls: ["write_app_files"],
          turnId: "turn-1",
        }),
      );
    });

    it("records a failed call with OpenAI's status, then rethrows", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "slow down" } }), {
          headers: { "Content-Type": "application/json" },
          status: 429,
        }),
      );
      await expect(runAppChat({ ...base, telemetry })).rejects.toThrow();
      expect(captureAiGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          httpStatus: 429,
          status: "failed",
          toolCalls: [],
          turnId: "turn-1",
        }),
      );
      const record = vi.mocked(captureAiGeneration).mock.calls[0]?.[0];
      expect(record?.error).toBeTruthy();
    });

    it("stays silent without a telemetry context", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(completed([], "hi"));
      await runAppChat(base);
      expect(captureAiGeneration).not.toHaveBeenCalled();
    });
  });
});
