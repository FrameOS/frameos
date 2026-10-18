import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  notifyFrameAdded,
  notifyScenePublished,
} from "./activity-notifications";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
  delete process.env.FRAMEOS_SCENES_APP_URL;
});

function captured() {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(String(url)).toBe("https://ph.example/capture/");
  return JSON.parse(String(init?.body));
}

function configure() {
  process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
  process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://ph.example";
  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
}

describe("notifyFrameAdded", () => {
  const input = {
    accountId: "acc-1",
    frameId: "frame-1",
    frameosVersion: "2026.10.15",
    hardware: { device: "seeed-e1002", platform: "esp32-s3" },
    name: "Kitchen",
    via: "claim_token" as const,
  };

  it("does nothing when PostHog is not configured", async () => {
    await notifyFrameAdded(input);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("captures the frame keyed on the account id", async () => {
    configure();
    await notifyFrameAdded(input);
    expect(captured()).toEqual({
      api_key: "phc_test",
      distinct_id: "acc-1",
      event: "cloud frame added",
      properties: {
        $lib: "frameos-cloud-auth-web",
        device: "seeed-e1002",
        frame_id: "frame-1",
        frame_name: "Kitchen",
        frameos_version: "2026.10.15",
        platform: "esp32-s3",
        via: "claim_token",
      },
    });
  });

  it("never throws", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    fetchMock.mockRejectedValue(new Error("network down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      notifyFrameAdded({ ...input, hardware: null }),
    ).resolves.toBeUndefined();
    warnSpy.mockRestore();
  });
});

describe("notifyScenePublished", () => {
  it("captures the scene with its store page", async () => {
    configure();
    process.env.FRAMEOS_SCENES_APP_URL = "https://scenes.example";
    await notifyScenePublished({
      accountId: "acc-1",
      name: "Moon phases",
      sceneId: "scene-1",
      slug: "moon-phases",
      version: 3,
      via: "publish",
    });
    expect(captured()).toEqual({
      api_key: "phc_test",
      distinct_id: "acc-1",
      event: "cloud scene published",
      properties: {
        $lib: "frameos-cloud-auth-web",
        scene_id: "scene-1",
        scene_name: "Moon phases",
        scene_url: "https://scenes.example/s/moon-phases",
        version: 3,
        via: "publish",
      },
    });
  });
});
