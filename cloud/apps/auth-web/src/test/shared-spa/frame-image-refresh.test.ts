import { describe, expect, it } from "vitest";
import {
  FRAME_IMAGE_REFRESH_MIN_INTERVAL_MS,
  planFrameImageRefresh,
} from "../../../../../../frontend/src/utils/frameImageRefresh";
import {
  STATUS_SCREEN_SCENE_ID,
  isSystemSceneId,
  publicSceneId,
  sceneIdsRefer,
} from "../../../../../../frontend/src/utils/systemScenes";
import {
  SCENE_ACTIVATION_TIMEOUT_MS,
  sceneIsActivating,
} from "../../../../../../frontend/src/utils/sceneActivation";

// The on-device admin panel re-fetches the frame's current image on every
// render signal, and the device encodes that PNG on demand (a second or more
// at 1080p on a Pi). One render fires two signals for two tiles, and the
// animated status screen renders every second — so refreshes are planned:
// first one now, the rest collapse into one trailing refresh.
describe("planFrameImageRefresh", () => {
  it("refreshes immediately when nothing was fetched recently", () => {
    expect(planFrameImageRefresh(undefined, 10_000)).toEqual({ refreshNow: true, delayMs: 0 });
    expect(planFrameImageRefresh(1_000, 1_000 + FRAME_IMAGE_REFRESH_MIN_INTERVAL_MS)).toEqual({
      refreshNow: true,
      delayMs: 0,
    });
  });

  it("collapses a burst into one trailing refresh at the window's end", () => {
    const plan = planFrameImageRefresh(10_000, 10_500);
    expect(plan.refreshNow).toBe(false);
    expect(plan.delayMs).toBe(FRAME_IMAGE_REFRESH_MIN_INTERVAL_MS - 500);
  });

  it("never schedules a zero delay", () => {
    expect(planFrameImageRefresh(10_000, 10_000 + FRAME_IMAGE_REFRESH_MIN_INTERVAL_MS - 0.5, 3000).delayMs).toBeGreaterThan(
      0,
    );
  });
});

describe("system scene ids", () => {
  it("knows the status screen and strips the device's uploaded/ prefix", () => {
    expect(isSystemSceneId(STATUS_SCREEN_SCENE_ID)).toBe(true);
    expect(isSystemSceneId("uploaded/abc")).toBe(false);
    expect(publicSceneId("uploaded/abc")).toBe("abc");
    expect(publicSceneId("abc")).toBe("abc");
    expect(publicSceneId(null)).toBe("");
  });

  it("matches a scene across the uploaded/ prefix, and nothing against nothing", () => {
    expect(sceneIdsRefer("uploaded/abc", "abc")).toBe(true);
    expect(sceneIdsRefer("abc", "uploaded/abc")).toBe(true);
    expect(sceneIdsRefer("abc", "def")).toBe(false);
    expect(sceneIdsRefer("", "")).toBe(false);
    expect(sceneIdsRefer(null, undefined)).toBe(false);
  });
});

// The Activate button spins from the click until the frame logs that scene's
// render:done — which names an interpreted scene `uploaded/<id>`.
describe("sceneIsActivating", () => {
  it("spins for the scene that was asked for, prefix or not", () => {
    expect(sceneIsActivating("abc", "abc")).toBe(true);
    expect(sceneIsActivating("uploaded/abc", "abc")).toBe(true);
    expect(sceneIsActivating("abc", "other")).toBe(false);
    expect(sceneIsActivating(null, "abc")).toBe(false);
  });

  it("gives up eventually rather than spinning forever", () => {
    expect(SCENE_ACTIVATION_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(SCENE_ACTIVATION_TIMEOUT_MS).toBeLessThanOrEqual(5 * 60_000);
  });
});
