// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RENDER_PREVIEWS, RENDER_CHECK_PREFIX, SceneAiPanel } from "./SceneAiPanel";

// The render check spins up the wasm preview worker — not something jsdom
// can do. Stub it and script its verdicts per test.
const renderCheckMock = vi.fn();
vi.mock("../lib/scene-render-check", () => ({
  renderSceneCheck: (options: unknown) => renderCheckMock(options),
}));

function ndjson(lines: object[]) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson" },
    status: 200,
  });
}

const fetchMock = vi.fn<typeof fetch>();
const scenes = [{ id: "scene-1", name: "Counter", nodes: [], edges: [] }];
const PNG_DATA_URL = "data:image/png;base64,AAAA";

function passedCheck(overrides: Record<string, unknown> = {}) {
  return {
    errors: [],
    height: 480,
    logs: [],
    pngDataUrl: PNG_DATA_URL,
    renderMs: 12,
    rendered: true,
    width: 800,
    ...overrides,
  };
}

function renderPanel(overrides: Partial<Parameters<typeof SceneAiPanel>[0]> = {}) {
  const onScenes = vi.fn();
  const utils = render(
    <SceneAiPanel
      getScenes={() => scenes}
      height={480}
      onScenes={onScenes}
      selectedSceneId="scene-1"
      settingsUrl="https://cloud.example/frames/settings#settings-openai"
      signedIn
      storeSceneId="store-1"
      width={800}
      {...overrides}
    />,
  );
  return { onScenes, ...utils };
}

function sendPrompt(text: string) {
  const box = screen.getByLabelText("Message the AI");
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  renderCheckMock.mockResolvedValue(passedCheck());
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  renderCheckMock.mockReset();
  vi.unstubAllGlobals();
});

describe("SceneAiPanel", () => {
  it("applies a listing event to the draft and sends the draft listing with each turn", async () => {
    fetchMock.mockResolvedValueOnce(
      ndjson([
        { chatId: "chat-1", type: "chat" },
        { label: "Editing the listing", name: "update_scene_listing", status: "start", type: "tool" },
        { listing: { description: "A map of everywhere I have been." }, type: "listing" },
        { label: "Editing the listing", name: "update_scene_listing", status: "done", type: "tool" },
        { reply: "Rewrote the description — Save publishes it.", tool: "reply", type: "done" },
      ]),
    );
    const onListing = vi.fn();
    renderPanel({
      getListing: () => ({ description: "Old text", tags: ["maps"] }),
      onListing,
    });

    sendPrompt("update the description");

    await waitFor(() =>
      expect(onListing).toHaveBeenCalledWith({ description: "A map of everywhere I have been." }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.listing).toEqual({ description: "Old text", tags: ["maps"] });
  });

  it("streams the reply, applies delivered scenes and reports the render check", async () => {
    fetchMock.mockResolvedValueOnce(
      ndjson([
        { chatId: "chat-1", type: "chat" },
        { label: "Searching apps", name: "search_apps", status: "start", type: "tool" },
        { label: "Searching apps", name: "search_apps", status: "done", type: "tool" },
        { text: "Made the ", type: "delta" },
        { text: "title **bigger**.", type: "delta" },
        {
          scenes: [{ id: "scene-1", name: "Counter", nodes: [{ id: "n1" }], edges: [] }],
          tool: "modify_scene",
          type: "scenes",
        },
        { reply: "Made the title bigger.", tool: "modify_scene", type: "done" },
      ]),
    );
    const { onScenes } = renderPanel();

    sendPrompt("make the title text bigger");

    expect(await screen.findByText("make the title text bigger")).toBeDefined();
    await waitFor(() => expect(screen.getByText("bigger")).toBeDefined());
    expect(screen.getByText("bigger").tagName).toBe("STRONG");
    expect(onScenes).toHaveBeenCalledOnce();
    expect(onScenes.mock.calls[0]![0]).toMatchObject({
      scenes: [{ id: "scene-1" }],
      tool: "modify_scene",
      type: "scenes",
    });
    expect(await screen.findByText(/Render check passed/)).toBeDefined();
    expect(screen.getByText("1 step")).toBeDefined();
    // The rendered frame sits in the assistant bubble, under the verdict.
    const preview = screen.getByRole("img", { name: "Rendered preview of the scene" }) as HTMLImageElement;
    expect(preview.src).toBe(PNG_DATA_URL);
    expect(preview.width).toBe(800);
    expect(preview.height).toBe(480);
    expect(preview.closest(".ai-panel__bubble--assistant")).not.toBeNull();
    const previewLink = preview.closest("a") as HTMLAnchorElement;
    expect(previewLink.href).toBe(PNG_DATA_URL);
    expect(previewLink.target).toBe("_blank");
    expect(previewLink.rel).toBe("noopener");
    expect(previewLink.hasAttribute("download")).toBe(false);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/ai/chat");
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({
      prompt: "make the title text bigger",
      scene: { id: "scene-1" },
      sceneId: "scene-1",
      scenes,
      storeSceneId: "store-1",
    });
    expect(typeof body.chatId).toBe("string");
    expect(renderCheckMock).toHaveBeenCalledWith(
      expect.objectContaining({ height: 480, sceneId: "scene-1", width: 800 }),
    );
    // The chat id the server confirmed is reused for the next turn.
    fetchMock.mockResolvedValueOnce(ndjson([{ reply: "Sure.", tool: "reply", type: "done" }]));
    sendPrompt("thanks");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const second = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);
    expect(second.chatId).toBe("chat-1");
    expect(second.history).toEqual([
      { content: "make the title text bigger", role: "user" },
      { content: "Made the title **bigger**.", role: "assistant" },
    ]);
  });

  it("feeds render-check errors back to the AI once, in a muted automatic turn", async () => {
    renderCheckMock
      .mockResolvedValueOnce(
        passedCheck({
          errors: ["render/text: font not found"],
          pngDataUrl: "data:image/png;base64,BBBB",
          renderMs: 3,
        }),
      )
      .mockResolvedValueOnce(passedCheck({ renderMs: 3 }));
    const scenesEvent = {
      scenes: [{ id: "scene-1", name: "Counter" }],
      tool: "modify_scene",
      type: "scenes",
    };
    fetchMock
      .mockResolvedValueOnce(ndjson([scenesEvent, { reply: "Done", tool: "modify_scene", type: "done" }]))
      .mockResolvedValueOnce(ndjson([scenesEvent, { reply: "Fixed", tool: "modify_scene", type: "done" }]));
    const { onScenes } = renderPanel();

    sendPrompt("add a title");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const feedback = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string).prompt as string;
    expect(feedback.startsWith(RENDER_CHECK_PREFIX)).toBe(true);
    expect(feedback).toContain("- render/text: font not found");
    expect(screen.getByText("Automatic render check")).toBeDefined();
    expect(screen.getByText(/Render check found 1 problem/)).toBeDefined();
    expect(await screen.findByText(/Render check passed/)).toBeDefined();
    expect(onScenes).toHaveBeenCalledTimes(2);
    // A frame that rendered with errors is still shown (it is what the
    // panel would display); the re-render gets its own image.
    const previews = screen.getAllByRole("img", { name: "Rendered preview of the scene" }) as HTMLImageElement[];
    expect(previews.map((image) => image.src)).toEqual(["data:image/png;base64,BBBB", PNG_DATA_URL]);
  });

  it("shows no preview when the render check produced no PNG", async () => {
    renderCheckMock.mockResolvedValue(passedCheck({ pngDataUrl: null }));
    fetchMock.mockResolvedValueOnce(
      ndjson([
        { scenes: [{ id: "scene-1", name: "Counter" }], tool: "modify_scene", type: "scenes" },
        { reply: "Done", tool: "modify_scene", type: "done" },
      ]),
    );
    renderPanel();

    sendPrompt("add a title");

    expect(await screen.findByText(/Render check passed/)).toBeDefined();
    expect(screen.queryByRole("img", { name: "Rendered preview of the scene" })).toBeNull();
  });

  it(`keeps only the last ${MAX_RENDER_PREVIEWS} previews, leaving older verdicts in place`, async () => {
    const turns = MAX_RENDER_PREVIEWS + 1;
    let turn = 0;
    renderCheckMock.mockImplementation(async () => {
      turn += 1;
      return passedCheck({ pngDataUrl: `data:image/png;base64,${turn}` });
    });
    fetchMock.mockImplementation(async () =>
      ndjson([
        { scenes: [{ id: "scene-1", name: "Counter" }], tool: "modify_scene", type: "scenes" },
        { reply: "Done", tool: "modify_scene", type: "done" },
      ]),
    );
    renderPanel();

    for (let index = 1; index <= turns; index += 1) {
      sendPrompt(`change ${index}`);
      await waitFor(() => expect(screen.getAllByText(/Render check passed/)).toHaveLength(index));
    }

    expect(screen.getAllByText(/Render check passed/)).toHaveLength(turns);
    const previews = screen.getAllByRole("img", { name: "Rendered preview of the scene" }) as HTMLImageElement[];
    expect(previews.map((image) => image.src)).toEqual(
      Array.from({ length: MAX_RENDER_PREVIEWS }, (_, offset) => `data:image/png;base64,${offset + 2}`),
    );
  });

  it("explains a missing OpenAI key and links to the settings page", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ detail: "OpenAI backend API key not set", error: "missing_api_key" }, { status: 400 }),
    );
    renderPanel();

    sendPrompt("hello");

    expect(await screen.findByText("The AI needs an OpenAI API key.")).toBeDefined();
    const link = screen.getByRole("link", { name: /API key for AI chat/ }) as HTMLAnchorElement;
    expect(link.href).toBe("https://cloud.example/frames/settings#settings-openai");
    // The prompt stays in the transcript; no empty assistant bubble is left behind.
    expect(screen.getByText("hello")).toBeDefined();
    expect(screen.queryByText("Thinking…")).toBeNull();
    expect(renderCheckMock).not.toHaveBeenCalled();
  });

  it("asks signed-out visitors to sign in, with a return link", () => {
    window.history.replaceState(null, "", "/s/counter#scene-editor-ai");
    renderPanel({ loginUrl: "https://cloud.example/login", signedIn: false });

    expect(screen.getByText("Sign in to use the AI.")).toBeDefined();
    const link = screen.getByRole("link", { name: "Sign in" }) as HTMLAnchorElement;
    expect(link.href).toContain("https://cloud.example/login?return_to=");
    expect(decodeURIComponent(link.href)).toContain("/s/counter#scene-editor-ai");
    expect((screen.getByLabelText("Message the AI") as HTMLTextAreaElement).disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits the initial prompt on mount and shows suggestion chips otherwise", async () => {
    fetchMock.mockResolvedValueOnce(ndjson([{ reply: "Hi", tool: "reply", type: "done" }]));
    const { unmount } = renderPanel({ initialPrompt: "make it blue" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).prompt).toBe("make it blue");
    unmount();

    renderPanel();
    expect(screen.getByRole("button", { name: "Change the colour scheme" })).toBeDefined();
  });
});
