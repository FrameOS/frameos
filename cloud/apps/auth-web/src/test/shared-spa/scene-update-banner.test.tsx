// @vitest-environment jsdom
//
// The "Update available" banner over a scene's image
// (frontend/src/scenes/workspace/SceneUpdateBanner.tsx): there only while the
// scene's source has a newer version, and a click asks before anything is
// replaced. The version logic itself is pinned in
// scene-update-available.test.ts.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn<(input: string, init?: RequestInit) => Promise<Response>>());
vi.mock("../../../../../../frontend/src/utils/apiFetch", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, apiFetch: (input: string, init?: RequestInit) => apiFetchMock(input, init) };
});
const confirmMock = vi.hoisted(() => vi.fn<(request: { title?: string; message: string }) => Promise<boolean>>());
vi.mock("../../../../../../frontend/src/utils/confirmDialogLogic", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, confirmDialog: confirmMock };
});

import { initKea } from "../../../../../../frontend/src/initKea";
import { framesModel } from "../../../../../../frontend/src/models/framesModel";
import { repositoriesModel } from "../../../../../../frontend/src/models/repositoriesModel";
import { SceneUpdateBanner } from "../../../../../../frontend/src/scenes/workspace/SceneUpdateBanner";
import type { FrameType, RepositoryType } from "../../../../../../frontend/src/types";

type TestWindow = Window & { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean };
const testWindow = window as TestWindow;
const frameId = 31 as unknown as FrameType["id"];

const frame = {
  id: 31,
  project_id: 1,
  name: "Hallway",
  mode: "rpios",
  scenes: [
    {
      id: "installed",
      name: "Weather",
      nodes: [],
      edges: [],
      origin: { repositoryId: "repo-1", templateId: "weather", templateName: "Weather", sceneId: "t-1", version: "aaa" },
    },
    { id: "handmade", name: "My own scene", nodes: [], edges: [] },
  ],
};

function repository(version: string): RepositoryType {
  return {
    id: "repo-1",
    name: "Scenes",
    url: "https://repo.example/repository.json",
    templates: [{ id: "weather", name: "Weather", version }],
  } as unknown as RepositoryType;
}

beforeEach(() => {
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(false);
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (/\/api\/repositories/.test(url)) {
      return Response.json([repository("bbb")]);
    }
    return /\/api\/frames$/.test(url) ? Response.json({ frames: [frame] }) : Response.json({ frame });
  });
  initKea();
  framesModel.mount();
});

afterEach(() => {
  cleanup();
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

describe("SceneUpdateBanner", () => {
  it("shows over a scene whose template moved on, and asks before updating", async () => {
    render(<SceneUpdateBanner frameId={frameId} sceneId="installed" />);
    const banner = await screen.findByRole("button", { name: /Update available/ });

    fireEvent.click(banner);
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(confirmMock.mock.calls[0]![0].title).toBe("Update to the latest version?");
    expect(confirmMock.mock.calls[0]![0].message).toContain('"Weather"');
  });

  it("renders nothing for a scene with no source, or one that is current", async () => {
    render(
      <>
        <SceneUpdateBanner frameId={frameId} sceneId="handmade" />
        <SceneUpdateBanner frameId={frameId} sceneId="installed" />
      </>,
    );
    await screen.findByRole("button", { name: /Update available/ });
    expect(screen.getAllByRole("button")).toHaveLength(1);

    repositoriesModel.actions.loadRepositoriesSuccess([repository("aaa")]);
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
  });
});
