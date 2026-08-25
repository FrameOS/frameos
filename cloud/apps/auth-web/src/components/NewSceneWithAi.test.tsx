// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewSceneWithAi } from "./NewSceneWithAi";

// The embedded editor stood in for by a stub that answers the host's rename
// through apiRef the way the real editor does: an echo of the renamed
// scenes through onScenesChanged.
type StubEditorApi = { renameScene: (sceneId: string, name: string) => void };
type StubEditorProps = {
  scenes: { id: string }[];
  onScenesChanged?: ((scenes: unknown[]) => void) | undefined;
  apiRef?: { current: StubEditorApi | null } | undefined;
};
function StubEditor(props: StubEditorProps) {
  const currentRef = useRef<{ id: string }[]>(props.scenes);
  useEffect(() => {
    currentRef.current = props.scenes;
  }, [props.scenes]);
  useEffect(() => {
    const apiRef = props.apiRef;
    if (!apiRef) {
      return;
    }
    apiRef.current = {
      renameScene: (sceneId, name) => {
        currentRef.current = currentRef.current.map((scene) =>
          scene.id === sceneId ? { ...scene, name } : scene,
        );
        props.onScenesChanged?.(currentRef.current);
      },
    };
    return () => {
      apiRef.current = null;
    };
  });
  return <div data-testid="editor" />;
}
vi.mock("next/dynamic", () => ({ default: () => StubEditor }));
vi.mock("./SceneLivePreview", () => ({ SceneLivePreviewPanel: () => null }));
vi.mock("./SceneAiPanel", () => ({ SceneAiPanel: () => <div data-testid="ai-panel" /> }));

const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/api/account/scenes")) {
    return Response.json({ error: "scene_quota_exceeded" }, { status: 429 });
  }
  throw new Error(`Unexpected fetch: ${url}`);
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
});

describe("NewSceneWithAi scene name", () => {
  it("names the new scene from the bar, and Save to my scenes sends that name", async () => {
    render(<NewSceneWithAi myScenesUrl="/scenes" />);
    await waitFor(() => expect(screen.getByTestId("editor")).toBeTruthy());
    expect(screen.getByText("New scene")).toBeTruthy();
    expect(screen.queryByText("Not saved yet")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Rename scene" }));
    const input = screen.getByRole("textbox", { name: "Scene name" }) as HTMLInputElement;
    expect(input.value).toBe("New scene");
    fireEvent.change(input, { target: { value: "Birthday board" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByText("Birthday board")).toBeTruthy();
    expect(screen.getByText("Not saved yet")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Save to my scenes/ }));
    await screen.findByText("Scene limit reached");
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as { name: string; scenes: { name: string }[] };
    expect(body.name).toBe("Birthday board");
    expect(body.scenes[0]?.name).toBe("Birthday board");
  });
});
