// @vitest-environment jsdom
//
// The on-device admin runs no AI. Its AI chat buttons used to open a
// "Coming soon" drawer that said the chat only worked from the backend; they
// now give the answer Generate scene gives there: where the generator lives,
// and how a scene made there gets back to the frame.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import { framesModel } from "../../../../../../frontend/src/models/framesModel";
import { WorkspaceChatDrawer } from "../../../../../../frontend/src/scenes/workspace/FrameosShell";
import { workspaceLogic } from "../../../../../../frontend/src/scenes/workspace/workspaceLogic";
import type { FrameId, FrameType } from "../../../../../../frontend/src/types";

type TestWindow = Window & {
  FRAMEOS_APP_CONFIG?: { frameAdminMode?: boolean };
  FRAMEOS_EMBEDDED_NO_BACKEND?: boolean;
};
const testWindow = window as TestWindow;

const frame = { id: 1 as unknown as FrameId, mode: "rpios", name: "Kitchen", status: "ready" } as unknown as FrameType;

beforeEach(() => {
  testWindow.FRAMEOS_APP_CONFIG = { frameAdminMode: true };
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  initKea();
  framesModel.mount();
  framesModel.actions.addFrame(frame);
});

afterEach(() => {
  cleanup();
  framesModel.unmount();
  delete testWindow.FRAMEOS_APP_CONFIG;
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

describe("the AI chat drawer on the on-device admin", () => {
  it("says where the AI is instead of coming soon, and links the frame to the cloud", () => {
    const unmount = workspaceLogic.mount();
    render(<WorkspaceChatDrawer frameId={frame.id} sceneId={null} />);
    expect(screen.getByText(/the frame has no AI to ask/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "scenes.frameos.net" }).getAttribute("href")).toBe(
      "https://scenes.frameos.net",
    );
    expect(screen.queryByText(/coming soon/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Connect to cloud" }));
    expect(workspaceLogic.values.chatDrawerSelection).toBeNull();
    expect(workspaceLogic.values.utilityPanel).toBe("settings");
    unmount();
  });
});
