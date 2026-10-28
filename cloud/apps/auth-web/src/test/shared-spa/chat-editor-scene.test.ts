// @vitest-environment jsdom
//
// "Convert it into a JSX app", asked on the workspace's scene page about a
// rainbow clock, converted the frame's Immich scene: the chat took "the scene
// open in the editor" from the editor panels alone, which the scene page
// never opens, so it sent no scene, or the last one a panel had open. The
// scene the drawer was opened on (`?drawer=chat&sceneId=`) is the one now.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import { framesModel } from "../../../../../../frontend/src/models/framesModel";
import { frameEditorsLogic } from "../../../../../../frontend/src/scenes/frame/frameEditorsLogic";
import { chatLogic } from "../../../../../../frontend/src/scenes/frame/panels/Chat/chatLogic";
import type { FrameId, FrameType } from "../../../../../../frontend/src/types";

type TestWindow = Window & { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean };
const testWindow = window as TestWindow;

const frameId = 70 as unknown as FrameId;
const scene = (id: string, name: string) => ({ edges: [], fields: [], id, name, nodes: [], settings: {} });
const frame = {
  id: frameId,
  mode: "rpios",
  name: "Kitchen Wall",
  scenes: [scene("immich", "Immich"), scene("rainbow", "Rainbow clock")],
  status: "ready",
} as unknown as FrameType;

const unmounts: (() => void)[] = [];

beforeEach(() => {
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  initKea();
  unmounts.push(framesModel.mount());
  framesModel.actions.addFrame(frame);
  unmounts.push(frameEditorsLogic({ frameId }).mount());
  // A panel opened the Immich scene's diagram some time before.
  frameEditorsLogic({ frameId }).actions.editScene("immich");
});

afterEach(() => {
  while (unmounts.length) {
    unmounts.pop()!();
  }
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

describe("the chat's open scene", () => {
  it("is the scene the drawer was opened on, over an editor panel's", () => {
    unmounts.push(chatLogic({ frameId, sceneId: "rainbow" }).mount());
    const chat = chatLogic({ frameId, sceneId: "rainbow" });
    expect(chat.values.selectedScene?.name).toBe("Rainbow clock");
    expect(chat.values.defaultChatContext).toEqual({ id: "rainbow", type: "scene" });
  });

  it("is the editor panel's on a page that names no scene", () => {
    unmounts.push(chatLogic({ frameId, sceneId: null }).mount());
    expect(chatLogic({ frameId, sceneId: null }).values.selectedScene?.name).toBe("Immich");
  });
});
