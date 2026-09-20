// @vitest-environment jsdom
//
// A frame that ran on its own before it joined FrameOS Cloud used to arrive
// empty: the cloud lists store-scene assignments, and the frame had none. The
// hub now asks such a frame what it holds and GET /api/frames/{id}/scenes
// carries the answer as `device_scenes`; the workspace offers the import.
// Pinned here: what the banner says (the wording IS the feature for someone
// looking at an "empty" frame that is visibly showing something), and that
// the model's import flow ends with the listing re-read whatever happened.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { initKea } from "../../../../../../frontend/src/initKea";
import {
  deviceSceneSkipReason,
  deviceScenesImportable,
  deviceScenesImportSummary,
  deviceScenesOffer,
  type CloudDeviceScenes,
  type CloudDeviceScenesImportResult,
} from "../../../../../../frontend/src/utils/cloudDeviceScenes";
import type { FrameType } from "../../../../../../frontend/src/types";

const apiFetchMock = vi.hoisted(() =>
  vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(),
);
vi.mock("../../../../../../frontend/src/utils/apiFetch", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    apiFetch: (input: string, init?: RequestInit) => apiFetchMock(input, init),
  };
});

import { framesModel } from "../../../../../../frontend/src/models/framesModel";

type CloudTestWindow = Window & {
  FRAMEOS_APP_CONFIG?: { cloudMode: boolean };
  FRAMEOS_EMBEDDED_NO_BACKEND?: boolean;
};
const testWindow = window as CloudTestWindow;

const report = (overrides: Partial<CloudDeviceScenes> = {}): CloudDeviceScenes => ({
  scene_count: 2,
  scenes: [
    { id: "clock", name: "Clock" },
    { id: "photos", name: "Photos" },
  ],
  skipped_compiled: 0,
  status: "ready",
  ...overrides,
});

const outcome = (
  overrides: Partial<CloudDeviceScenesImportResult> = {},
): CloudDeviceScenesImportResult => ({
  assigned: 2,
  connected: true,
  imported: [
    { assigned: true, device_scene_id: "clock", name: "Clock", scene_id: "s1", version: 1 },
    { assigned: true, device_scene_id: "photos", name: "Photos", scene_id: "s2", version: 1 },
  ],
  reused: [],
  skipped: [],
  skipped_compiled: 0,
  status: "imported",
  ...overrides,
});

describe("what the import banner says", () => {
  it("offers only a report that is waiting and holds something", () => {
    expect(deviceScenesImportable(report())).toBe(true);
    expect(deviceScenesImportable(null)).toBe(false);
    expect(deviceScenesImportable(report({ status: "imported" }))).toBe(false);
    expect(deviceScenesImportable(report({ status: "dismissed" }))).toBe(false);
    expect(deviceScenesImportable(report({ status: "importing" }))).toBe(false);
    expect(deviceScenesImportable(report({ scene_count: 0, scenes: [] }))).toBe(false);
  });

  it("names the scenes, and stops naming after three", () => {
    expect(deviceScenesOffer(report())).toBe(
      "This frame is running 2 scenes of its own: “Clock” and “Photos”.",
    );
    expect(deviceScenesOffer(report({ scene_count: 1, scenes: [{ id: "c", name: "Clock" }] }))).toBe(
      "This frame is running a scene of its own: “Clock”.",
    );
    const many = Array.from({ length: 6 }, (_, index) => ({ id: `s${index}`, name: `Scene ${index}` }));
    expect(deviceScenesOffer(report({ scene_count: 6, scenes: many }))).toBe(
      "This frame is running 6 scenes of its own: “Scene 0”, “Scene 1”, “Scene 2” and 3 more.",
    );
  });

  it("sums an import up, and never lets a refused scene just go missing", () => {
    expect(deviceScenesImportSummary(outcome())).toEqual([
      "2 imported as private drafts. The frame is taking them over now.",
    ]);
    expect(
      deviceScenesImportSummary(
        outcome({
          assigned: 1,
          connected: false,
          imported: [
            { assigned: true, device_scene_id: "clock", name: "Clock", scene_id: "s1", version: 1 },
            {
              assigned: false,
              device_scene_id: "tools",
              name: "Tools",
              not_assigned_reason: "scene_not_allowed",
              scene_id: "s3",
              version: 1,
            },
          ],
          reused: [{ assigned: true, device_scene_id: "photos", name: "Photos", scene_id: "s2", version: 4 }],
          skipped: [{ device_scene_id: "old", name: "Old", reason: "scene_requires_compilation" }],
          skipped_compiled: 2,
          status: "imported",
        }),
      ),
    ).toEqual([
      "2 imported as private drafts, 1 already in your scenes. The frame takes them over when it next connects.",
      "“Tools” is not on the frame: it runs shell commands, which a cloud frame never receives — it is saved as a draft only.",
      "“Old” was left out: it is a legacy compiled scene — convert it with the Nim converter first.",
      "2 compiled scenes stayed on the frame: the cloud only runs interpreted scenes.",
    ]);
    expect(
      deviceScenesImportSummary(
        outcome({
          assigned: 0,
          imported: [],
          skipped: [{ device_scene_id: "clock", name: "Clock", reason: "daily_scene_limit_exceeded" }],
          status: "partial",
        }),
      )[0],
    ).toBe("No scenes could be imported.");
    // An import shares no keys — a scene that uses one must say so, or it
    // just renders "please provide an API key" with no explanation.
    expect(
      deviceScenesImportSummary(
        outcome({
          imported: [
            {
              assigned: true,
              device_scene_id: "art",
              name: "Art",
              needs_settings_groups: ["unsplash", "openAI"],
              scene_id: "s1",
              version: 1,
            },
          ],
        }),
      ),
    ).toEqual([
      "1 imported as private drafts. The frame is taking them over now.",
      "“Art” uses your openAI, unsplash keys. Importing shares no keys with a frame: allow them per scene in the frame's settings, under Service settings.",
    ]);
    // A code the SPA has no words for is shown, not swallowed.
    expect(deviceSceneSkipReason("some_new_refusal")).toBe("some new refusal");
  });
});

describe("the import flow in framesModel", () => {
  let listing: { device_scenes: CloudDeviceScenes | null; scenes: unknown[] };
  // framesModel lists the fleet as it mounts; the frames come from there, as
  // they do in the workspace, rather than being pushed into the store.
  const frames = ["9101", "9102", "9103"].map(
    (id) => ({ id, name: "Hallway", scenes: [], status: "active" }) as unknown as FrameType,
  );
  const loaded = (id: string) =>
    waitFor(() => expect(framesModel.values.frames[id]).toBeDefined());

  beforeEach(() => {
    testWindow.FRAMEOS_APP_CONFIG = { cloudMode: true };
    testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
    listing = { device_scenes: report(), scenes: [] };
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async (input, init) => {
      if (input.endsWith("/device-scenes") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { action: string };
        if (body.action === "import") {
          listing = { device_scenes: report({ status: "imported" }), scenes: [] };
          return Response.json(outcome());
        }
        listing = { device_scenes: report({ status: "dismissed" }), scenes: [] };
        return Response.json({ status: "dismissed" });
      }
      return input === "/api/frames" ? Response.json({ frames }) : Response.json(listing);
    });
    initKea();
    framesModel.mount();
  });

  afterEach(() => {
    delete testWindow.FRAMEOS_APP_CONFIG;
    delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
  });


  it("picks the report up with the scene listing, imports it, and re-reads the listing", async () => {
    await loaded("9101");
    await waitFor(() =>
      expect(framesModel.values.cloudDeviceScenes["9101"]?.status).toBe("ready"),
    );

    framesModel.actions.importCloudDeviceScenes("9101");
    expect(framesModel.values.cloudDeviceScenesBusy["9101"]).toBe("importing");
    await waitFor(() =>
      expect(framesModel.values.cloudDeviceScenes["9101"]?.status).toBe("imported"),
    );
    expect(framesModel.values.cloudDeviceScenesBusy["9101"]).toBeUndefined();
    expect(framesModel.values.cloudDeviceScenesNotices["9101"]).toEqual({
      error: false,
      lines: ["2 imported as private drafts. The frame is taking them over now."],
    });
    const post = apiFetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post?.[0]).toBe("/api/frames/9101/device-scenes");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ action: "import" });

    framesModel.actions.clearCloudDeviceScenesNotice("9101");
    expect(framesModel.values.cloudDeviceScenesNotices["9101"]).toBeUndefined();
  });

  it("says why an import failed and still re-reads the listing", async () => {
    await loaded("9102");
    apiFetchMock.mockImplementation(async (input, init) =>
      init?.method === "POST"
        ? Response.json({ error: "import_in_progress" }, { status: 409 })
        : input === "/api/frames"
          ? Response.json({ frames })
          : Response.json(listing),
    );
    framesModel.actions.importCloudDeviceScenes("9102");
    await waitFor(() =>
      expect(framesModel.values.cloudDeviceScenesNotices["9102"]?.error).toBe(true),
    );
    expect(framesModel.values.cloudDeviceScenesBusy["9102"]).toBeUndefined();
    await waitFor(() =>
      expect(framesModel.values.cloudDeviceScenes["9102"]?.status).toBe("ready"),
    );
  });

  it("dismissing drops the offer at once", async () => {
    await loaded("9103");
    framesModel.actions.setCloudDeviceScenes("9103", report());
    framesModel.actions.dismissCloudDeviceScenes("9103");
    expect(framesModel.values.cloudDeviceScenesBusy["9103"]).toBe("dismissing");
    await waitFor(() => expect(framesModel.values.cloudDeviceScenes["9103"]).toBeNull());
    expect(framesModel.values.cloudDeviceScenesBusy["9103"]).toBeUndefined();
  });
});
