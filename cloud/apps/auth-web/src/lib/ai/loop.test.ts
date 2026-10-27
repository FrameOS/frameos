// The agent loop keeps Photos share links away from the model: the context,
// the history and every tool result carry placeholders, and the tool calls
// the model makes get the real link back before they run.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResponseInputItem, StreamedResponse } from "./openai";

const streamResponse = vi.hoisted(() => vi.fn());
const runTool = vi.hoisted(() => vi.fn());

vi.mock("./openai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openai")>()),
  streamResponse,
}));
vi.mock("./tools", () => ({
  runTool,
  toolDefinitions: [],
  toolLabels: {},
}));

const { buildInitialInput, estimatedImageTokens, estimatedUsage, photoLinkNote, runAgentLoop } =
  await import("./loop");

function text(value: string) {
  return { images: [], text: value };
}

const token = `pk_${"q7W3e9R1".repeat(4)}`;
const link = `https://cloud.frameos.net/api/photos/shared/${token}`;
const redactedLink = "https://cloud.frameos.net/api/photos/shared/pk_photo_link_1";
const otherToken = `pk_${"m2N4b6V8".repeat(4)}`;

const usage = { cachedInputTokens: 0, inputTokens: 1, outputTokens: 1, reasoningTokens: 0 };

function round(calls: { name: string; args: unknown }[]): StreamedResponse {
  const functionCalls = calls.map((call, index) => ({
    arguments: JSON.stringify(call.args),
    call_id: `call-${index}`,
    name: call.name,
    type: "function_call" as const,
  }));
  return { functionCalls, output: functionCalls, outputText: "", status: "completed", usage };
}

// The loop keeps appending to the one input array, so each round's input is
// copied as it is sent.
let sent: ResponseInputItem[][] = [];
let rounds: StreamedResponse[] = [];

function respond(...responses: StreamedResponse[]) {
  rounds = responses;
}

function seenInputs(): ResponseInputItem[][] {
  return sent;
}

async function run(input: ResponseInputItem[]) {
  return runAgentLoop({
    apiKey: "sk-test",
    emit: () => {},
    input,
    model: "gpt-test",
    reasoningEffort: "low",
    toolContext: {} as never,
  });
}

describe("runAgentLoop and Photos share links", () => {
  beforeEach(() => {
    sent = [];
    rounds = [];
    streamResponse.mockReset();
    streamResponse.mockImplementation(async ({ input }: { input: ResponseInputItem[] }) => {
      sent.push(structuredClone(input));
      return rounds.shift() ?? round([]);
    });
    runTool.mockReset();
  });

  it("sends placeholders and runs the tools with the real link", async () => {
    const scene = { id: "album", nodes: [{ data: { config: { album: link } }, id: "n1", type: "app" }] };
    respond(
      round([
        {
          args: {
            scene: {
              ...scene,
              nodes: [{ ...scene.nodes[0], data: { config: { album: redactedLink, fit: "contain" } } }],
            },
          },
          name: "update_scene",
        },
      ]),
    );
    runTool.mockResolvedValueOnce(
      text(JSON.stringify({ logs: [`HTTP request failed: ${link}/photo?index=2`], ok: true })),
    );

    await run(
      buildInitialInput({
        contextBlock: `The user has this scene open:\n${JSON.stringify(scene)}`,
        history: [{ content: `Use ${link}`, role: "user" }],
        prompt: "Make the photos fit inside the screen",
      }),
    );

    const [first, second] = seenInputs();
    expect(JSON.stringify(first)).not.toContain(token);
    expect(JSON.stringify(first)).toContain(redactedLink);
    // The note sits right before the prompt.
    expect(JSON.stringify(first!.at(-2))).toContain(photoLinkNote);
    expect(JSON.stringify(first!.at(-1))).toContain("Make the photos fit");

    // The tool got the real link back.
    const [, args] = runTool.mock.calls[0]!;
    expect(args.scene.nodes[0].data.config).toEqual({ album: link, fit: "contain" });

    // Its result reached the model redacted.
    expect(JSON.stringify(second)).not.toContain(token);
    const output = second!.find((item) => item.type === "function_call_output");
    expect(output?.output).toContain(`${redactedLink}/photo?index=2`);
  });

  it("notes a link that first arrives in a tool result, after the round's results", async () => {
    respond(
      round([{ args: { scene_id: "s" }, name: "get_store_scene" }]),
      round([{ args: { album: "/api/photos/shared/pk_photo_link_1" }, name: "save_scene" }]),
    );
    runTool
      .mockResolvedValueOnce(text(JSON.stringify({ album: `/api/photos/shared/${otherToken}` })))
      .mockResolvedValueOnce(text(JSON.stringify({ ok: true })));

    await run(buildInitialInput({ contextBlock: "", history: [], prompt: "Copy that album scene" }));

    const inputs = seenInputs();
    expect(JSON.stringify(inputs[0])).not.toContain(photoLinkNote);
    const second = inputs[1]!;
    expect(JSON.stringify(second)).not.toContain(otherToken);
    expect(second.at(-2)?.type).toBe("function_call_output");
    expect(JSON.stringify(second.at(-1))).toContain(photoLinkNote);
    // Noted once.
    expect(JSON.stringify(inputs[2]).split(photoLinkNote).length - 1).toBe(1);
    expect(runTool.mock.calls[1]![1]).toEqual({ album: `/api/photos/shared/${otherToken}` });
  });

  it("leaves a conversation without links as it is", async () => {
    const input = buildInitialInput({ contextBlock: "ctx", history: [], prompt: "hi pk_live_123" });
    const before = structuredClone(input);
    await run(input);
    expect(seenInputs()[0]).toEqual(before);
  });
});

describe("runAgentLoop and rendered images", () => {
  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";

  beforeEach(() => {
    sent = [];
    rounds = [];
    streamResponse.mockReset();
    streamResponse.mockImplementation(async ({ input }: { input: ResponseInputItem[] }) => {
      sent.push(structuredClone(input));
      return rounds.shift() ?? round([]);
    });
    runTool.mockReset();
  });

  it("hands the model the image beside the tool's text, links still redacted", async () => {
    respond(round([{ args: {}, name: "render_scene" }]));
    runTool.mockResolvedValueOnce({
      images: [{ dataUrl }],
      text: JSON.stringify({ logs: [`fetching ${link}/photo`], ok: true }),
    });

    await run(buildInitialInput({ contextBlock: "", history: [], prompt: "It looks bad" }));

    const output = seenInputs()[1]!.find((item) => item.type === "function_call_output");
    expect(output?.output).toEqual([
      { text: JSON.stringify({ logs: [`fetching ${redactedLink}/photo`], ok: true }), type: "input_text" },
      { detail: "high", image_url: dataUrl, type: "input_image" },
    ]);
  });

  it("keeps a text-only result a plain string", async () => {
    respond(round([{ args: {}, name: "get_app" }]));
    runTool.mockResolvedValueOnce(text('{"ok":true}'));

    await run(buildInitialInput({ contextBlock: "", history: [], prompt: "Which fields?" }));

    const output = seenInputs()[1]!.find((item) => item.type === "function_call_output");
    expect(output?.output).toBe('{"ok":true}');
  });

  it("estimates an aborted round's image by count, not by the length of its base64", () => {
    // 400 KB of base64 would be 100,000 tokens at four characters each.
    const image = `data:image/png;base64,${"A".repeat(400_000)}`;
    const usage = estimatedUsage(
      "",
      [{ output: [{ detail: "high", image_url: image, type: "input_image" }], type: "function_call_output" }],
      0,
      "",
    );
    expect(usage.inputTokens).toBeGreaterThanOrEqual(estimatedImageTokens);
    expect(usage.inputTokens).toBeLessThan(estimatedImageTokens + 100);
  });
});

describe("runAgentLoop out of rounds", () => {
  beforeEach(() => {
    streamResponse.mockReset();
    runTool.mockReset();
    runTool.mockResolvedValue(text("{}"));
  });

  it("asks the model, with its tools off, to say where it stopped instead of ending on a canned line", async () => {
    const calls: { toolChoice: string | undefined; input: ResponseInputItem[] }[] = [];
    streamResponse.mockImplementation(
      async (options: { toolChoice?: string; input: ResponseInputItem[]; onTextDelta: (delta: string) => void }) => {
        calls.push({ input: structuredClone(options.input), toolChoice: options.toolChoice });
        if (options.toolChoice === "none") {
          options.onTextDelta("I fixed the radar and rendered it once; the list still overflows. Say continue.");
          return { functionCalls: [], output: [], outputText: "", status: "completed", usage };
        }
        return round([{ args: { edits: [] }, name: "edit_app_source" }]);
      },
    );
    const emitted: string[] = [];
    const result = await runAgentLoop({
      apiKey: "sk-test",
      emit: (event) => {
        if (event.type === "delta") emitted.push(event.text);
      },
      input: [],
      maxRounds: 3,
      model: "gpt-test",
      reasoningEffort: "low",
      toolContext: {} as never,
    });

    expect(calls.map((call) => call.toolChoice ?? "auto")).toEqual(["auto", "auto", "auto", "none"]);
    expect(JSON.stringify(calls[3]!.input.at(-1))).toContain("You have used all 3 steps");
    expect(result.reply).toBe("I fixed the radar and rendered it once; the list still overflows. Say continue.");
    expect(result.rounds).toBe(4);
    expect(runTool).toHaveBeenCalledTimes(3);
    expect(emitted.join("")).toBe(result.reply);
  });

  it("falls back to saying how to go on when the last round says nothing", async () => {
    streamResponse.mockImplementation(async (options: { toolChoice?: string }) =>
      options.toolChoice === "none"
        ? { functionCalls: [], output: [], outputText: "", status: "completed", usage }
        : round([{ args: {}, name: "render_scene" }]),
    );
    const result = await runAgentLoop({
      apiKey: "sk-test",
      emit: () => {},
      input: [],
      maxRounds: 1,
      model: "gpt-test",
      reasoningEffort: "low",
      toolContext: {} as never,
    });
    expect(result.reply).toContain('Say "continue"');
  });
});
