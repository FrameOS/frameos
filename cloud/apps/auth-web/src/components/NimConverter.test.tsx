// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NimConverter } from "./NimConverter";

afterEach(cleanup);

// jsdom has no Blob URLs; the download link only needs a string.
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:converted");
  URL.revokeObjectURL = vi.fn();
});

const scene = { id: "s1", name: "Heater", nodes: [], edges: [], settings: { execution: "compiled" } };

const report = {
  executionAfter: "interpreted",
  executionBefore: "compiled",
  items: [{ js: "1", kind: "code", nim: "1", nodeId: "c1", status: "converted", via: "deterministic" }],
  model: "fake-model",
  modelCalls: 1,
  needsManualPort: [],
  needsModel: [],
  sceneId: "s1",
  sceneName: "Heater",
  usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
};

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const { status, body } = handler(url, init);
    return { json: async () => body, ok: status < 300, status } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function props(overrides: Partial<Parameters<typeof NimConverter>[0]> = {}) {
  return {
    loginUrl: "https://cloud.example/login",
    myScenesUrl: "https://scenes.example/my-scenes",
    sharedModelPass: true,
    signedIn: false,
    ...overrides,
  };
}

describe("NimConverter", () => {
  it("converts pasted JSON and offers the download", async () => {
    const fetchMock = mockFetch(() => ({
      body: { lint: { errors: [], warnings: [] }, model: { calls: 1, name: "fake-model", source: "shared", usage: {} }, ok: true, render: null, reports: [report], scene: { ...scene, settings: { execution: "interpreted" } } },
      status: 200,
    }));
    render(<NimConverter {...props()} />);
    fireEvent.click(screen.getByText("Paste JSON instead"));
    fireEvent.change(screen.getByLabelText("Scene JSON"), { target: { value: JSON.stringify(scene) } });
    fireEvent.click(screen.getByText("Convert to JavaScript"));

    await waitFor(() => expect(screen.getByTestId("nim-converter-result")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/scenes/convert");
    expect(JSON.parse(init!.body as string)).toEqual({ scene });
    expect(screen.getByText("Converted — the scene is interpreted now.")).toBeTruthy();
    const download = screen.getByText(/Download Heater\.js\.json/).closest("a");
    expect(download?.getAttribute("href")).toBe("blob:converted");
    expect(download?.getAttribute("download")).toBe("Heater.js.json");
    expect(screen.getByText(/1 model call \(fake-model, on us\)/)).toBeTruthy();
    // Signed out: no save, a sign-in link instead.
    expect(screen.getByText("Sign in to save it to my scenes").closest("a")?.getAttribute("href")).toBe("https://cloud.example/login");
  });

  it("sends the visitor's own key when one is typed, and never stores it", async () => {
    const fetchMock = mockFetch(() => ({
      body: { lint: { errors: [], warnings: [] }, model: { calls: 0, name: null, source: "request", usage: {} }, ok: true, render: null, reports: [report], scene },
      status: 200,
    }));
    render(<NimConverter {...props()} />);
    fireEvent.click(screen.getByText("Paste JSON instead"));
    fireEvent.change(screen.getByLabelText("Scene JSON"), { target: { value: JSON.stringify(scene) } });
    fireEvent.change(screen.getByLabelText("OpenAI API key"), { target: { value: "sk-mine-0123456789abcdef" } });
    fireEvent.click(screen.getByText("Convert to JavaScript"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({ openaiApiKey: "sk-mine-0123456789abcdef", scene });
  });

  it("explains an exhausted budget and a bad file", async () => {
    mockFetch(() => ({ body: { error: "model_budget_exhausted" }, status: 429 }));
    render(<NimConverter {...props()} />);
    fireEvent.click(screen.getByText("Paste JSON instead"));
    fireEvent.change(screen.getByLabelText("Scene JSON"), { target: { value: "not json" } });
    fireEvent.click(screen.getByText("Convert to JavaScript"));
    expect((await screen.findByRole("alert")).textContent).toContain("not valid JSON");

    fireEvent.change(screen.getByLabelText("Scene JSON"), { target: { value: JSON.stringify(scene) } });
    fireEvent.click(screen.getByText("Convert to JavaScript"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("out of budget"));
  });

  it("saves to my scenes when signed in", async () => {
    const fetchMock = mockFetch((url) =>
      url === "/api/account/scenes"
        ? { body: { scene: { id: "new-1", name: "Heater" } }, status: 201 }
        : {
            body: { lint: { errors: [], warnings: [] }, model: { calls: 0, name: null, source: "none", usage: {} }, ok: true, render: null, reports: [report], scenes: [scene] },
            status: 200,
          },
    );
    render(<NimConverter {...props({ signedIn: true })} />);
    fireEvent.click(screen.getByText("Paste JSON instead"));
    fireEvent.change(screen.getByLabelText("Scene JSON"), { target: { value: JSON.stringify([scene]) } });
    fireEvent.click(screen.getByText("Convert to JavaScript"));
    await waitFor(() => expect(screen.getByText("Save to my scenes")).toBeTruthy());
    fireEvent.click(screen.getByText("Save to my scenes"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Saved as a private scene"));
    const save = fetchMock.mock.calls.find((call) => call[0] === "/api/account/scenes");
    expect(JSON.parse(save![1]!.body as string)).toEqual({ name: "Heater", scenes: [scene] });
    // A bare array went up as {"scenes": [...]}.
    const convert = fetchMock.mock.calls.find((call) => call[0] === "/api/scenes/convert");
    expect(JSON.parse(convert![1]!.body as string)).toEqual({ scenes: [scene] });
  });

  it("says what is left when the model pass did not run", async () => {
    mockFetch(() => ({
      body: {
        lint: { errors: [], warnings: [] },
        model: { calls: 0, name: null, source: "none", usage: {} },
        ok: false,
        render: null,
        reports: [{ ...report, executionAfter: "compiled", modelCalls: 0, needsModel: ["a1"] }],
        scene,
      },
      status: 200,
    }));
    render(<NimConverter {...props({ sharedModelPass: false })} />);
    fireEvent.click(screen.getByText("Paste JSON instead"));
    fireEvent.change(screen.getByLabelText("Scene JSON"), { target: { value: JSON.stringify(scene) } });
    fireEvent.click(screen.getByText("Convert to JavaScript"));
    expect(await screen.findByText("Partly converted — the rest needs the AI pass.")).toBeTruthy();
    expect(screen.getByText(/No AI pass ran/)).toBeTruthy();
  });
});
