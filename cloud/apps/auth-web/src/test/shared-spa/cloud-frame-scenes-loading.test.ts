// @vitest-environment jsdom
//
// Cloud frames arrive from /api/frames without their scenes; framesModel
// fetches them per frame straight after. In between, `frame.scenes` is empty
// for exactly the same reason it is empty on a frame that has none — so the
// workspace told everyone "This frame has no scenes yet" on every page load.
//
// `cloudFrameScenesLoaded` is what tells the two apart, and the failure mode
// of getting it wrong is worse than the bug: a frame whose flag never flips
// shows a spinner forever. These pin that it flips on every path out of
// hydrateCloudFrameScenes — the success, the failure, and the throttled
// early return that does no fetch at all.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { initKea } from "../../../../../../frontend/src/initKea";

// The real apiFetch answers every call with a synthetic 404 under
// FRAMEOS_EMBEDDED_NO_BACKEND (which framesModel needs to mount without
// dialing /api/frames/updates), and a hydration that never succeeds can never
// reach the throttle. Mocking it gives us both outcomes on demand.
const apiFetchMock = vi.hoisted(() => vi.fn<(input: string) => Promise<Response>>());
vi.mock("../../../../../../frontend/src/utils/apiFetch", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, apiFetch: (input: string) => apiFetchMock(input) };
});

import { framesModel } from "../../../../../../frontend/src/models/framesModel";

type CloudTestWindow = Window & {
  FRAMEOS_APP_CONFIG?: { cloudMode: boolean };
  FRAMEOS_EMBEDDED_NO_BACKEND?: boolean;
};
const testWindow = window as CloudTestWindow;

/** Scene-list calls only — framesModel makes others while it mounts. */
function sceneListCalls(): string[] {
  return apiFetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.endsWith("/scenes"));
}

beforeEach(() => {
  testWindow.FRAMEOS_APP_CONFIG = { cloudMode: true };
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async () => Response.json({ scenes: [] }));
  initKea();
});

afterEach(() => {
  delete testWindow.FRAMEOS_APP_CONFIG;
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

describe("cloudFrameScenesLoaded", () => {
  it("starts unset, so an empty scene list reads as 'not fetched yet'", () => {
    framesModel.mount();
    expect(framesModel.values.cloudFrameScenesLoaded["7"]).toBeUndefined();
  });

  it("is set once a hydration finishes", async () => {
    framesModel.mount();
    framesModel.actions.hydrateCloudFrameScenes("7");
    await waitFor(() =>
      expect(framesModel.values.cloudFrameScenesLoaded["7"]).toBe(true),
    );
    expect(sceneListCalls()).toEqual(["/api/frames/7/scenes"]);
  });

  it("is set even when the fetch fails — a spinner must not outlive the error", async () => {
    apiFetchMock.mockImplementation(async () => {
      throw new Error("offline");
    });
    framesModel.mount();
    framesModel.actions.hydrateCloudFrameScenes("8");
    await waitFor(() =>
      expect(framesModel.values.cloudFrameScenesLoaded["8"]).toBe(true),
    );
  });

  it("is set again on the throttled path, which does no fetch at all", async () => {
    // The once-a-minute throttle lives in a module-level map that outlives a
    // kea remount, while the reducer does not. Without a dispatch on that
    // early return the dashboard would wait for a hydration that never runs.
    framesModel.mount();
    framesModel.actions.hydrateCloudFrameScenes("9");
    await waitFor(() =>
      expect(framesModel.values.cloudFrameScenesLoaded["9"]).toBe(true),
    );
    expect(sceneListCalls()).toEqual(["/api/frames/9/scenes"]);

    initKea();
    framesModel.mount();
    expect(framesModel.values.cloudFrameScenesLoaded["9"]).toBeUndefined();

    framesModel.actions.hydrateCloudFrameScenes("9");
    await waitFor(() =>
      expect(framesModel.values.cloudFrameScenesLoaded["9"]).toBe(true),
    );
    // Still one call: this is the throttled path, not a second fetch.
    expect(sceneListCalls()).toEqual(["/api/frames/9/scenes"]);
  });

  it("does not mark other frames", async () => {
    framesModel.mount();
    framesModel.actions.hydrateCloudFrameScenes("10");
    await waitFor(() =>
      expect(framesModel.values.cloudFrameScenesLoaded["10"]).toBe(true),
    );
    expect(framesModel.values.cloudFrameScenesLoaded["11"]).toBeUndefined();
  });
});
