// @vitest-environment jsdom
//
// A custom event's `origins` (docs/events.md): the scene opts a schedule or
// the cloud into firing it, and the device's dispatcher refuses them
// otherwise. The Events panel writes the declaration, so what it stores has to
// be what `declaredCustomEventOrigins` (frameos/events.nim) reads: only the
// contract's declarable origins, sorted, and no key at all when none is ticked
// — a scene that never opted in must not show up as changed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import type { FrameEvent, FrameScene, FrameType } from "../../../../../../frontend/src/types";

vi.mock("../../../../../../frontend/src/scenes/frame/frameLogic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../../frontend/src/scenes/frame/frameLogic")>();
  const { embedFrameLogic } = await import("../../../../../../frontend/src/embed/embedFrameLogic");
  return { ...actual, frameLogic: embedFrameLogic };
});
vi.mock("../../../../../../frontend/src/scenes/frame/panels/Logs/logsLogic", async () => {
  return await import("../../../../../../frontend/src/embed/logsLogicShim");
});

import { embedFrameLogic } from "../../../../../../frontend/src/embed/embedFrameLogic";
import {
  customEventOriginOptions,
  eventsLogic,
} from "../../../../../../frontend/src/scenes/frame/panels/Events/eventsLogic";
import { withEventType } from "../../../../../../frontend/src/scenes/frame/panels/Schedule/scheduleLogic";
import { customEventDeclarableOrigins } from "../../../../../../frontend/src/utils/eventsContract.gen";
import { duplicateScenes } from "../../../../../../frontend/src/utils/duplicateScenes";
import {
  normalizeCustomEvent,
  normalizeCustomEventOrigins,
  withCustomEventOrigin,
} from "../../../../../../frontend/src/utils/frameEvents";

const frameId = 1 as unknown as FrameType["id"];
const sceneId = "origins-scene";

const nextPage: FrameEvent = { name: "nextPage", description: "Turn the page", fields: [] };
const refresh: FrameEvent = { name: "refresh", description: "", fields: [] };

const scene = {
  id: sceneId,
  name: "Origins",
  nodes: [],
  edges: [],
  fields: [],
  customEvents: [nextPage, refresh],
  settings: { execution: "interpreted" },
} as unknown as FrameScene;

type EmbedTestWindow = Window & { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean };
const testWindow = window as EmbedTestWindow;

function customEventsInForm(): FrameEvent[] {
  return (
    embedFrameLogic({ frameId }).values.frameForm.scenes!.find((candidate) => candidate.id === sceneId)!
      .customEvents ?? []
  );
}

describe("custom event origins: the helpers", () => {
  it("keeps only the contract's declarable origins, deduplicated and sorted", () => {
    expect(normalizeCustomEventOrigins(["schedule", "cloud", "schedule"])).toEqual(["cloud", "schedule"]);
    expect(normalizeCustomEventOrigins(["system", "http:admin", "nonsense", 7])).toEqual([]);
    expect(normalizeCustomEventOrigins("schedule")).toEqual([]);
    expect(normalizeCustomEventOrigins(undefined)).toEqual([]);
  });

  it("writes `origins` when one is ticked and removes the key with the last one", () => {
    const scheduled = withCustomEventOrigin(nextPage, "schedule", true);
    expect(scheduled.origins).toEqual(["schedule"]);
    const both = withCustomEventOrigin(scheduled, "cloud", true);
    expect(both.origins).toEqual(["cloud", "schedule"]);
    expect(withCustomEventOrigin(both, "cloud", true)).toEqual(both);

    const none = withCustomEventOrigin(withCustomEventOrigin(both, "cloud", false), "schedule", false);
    expect("origins" in none).toBe(false);
    expect(none).toEqual(nextPage);
    // An origin no scene can opt into is never stored.
    expect("origins" in withCustomEventOrigin(nextPage, "system", true)).toBe(false);
  });

  it("normalizeCustomEvent (the scene sanitizer) carries the declaration and drops an empty one", () => {
    expect(normalizeCustomEvent({ ...nextPage, origins: ["schedule", "cloud"] }).origins).toEqual([
      "cloud",
      "schedule",
    ]);
    expect("origins" in normalizeCustomEvent({ ...nextPage, origins: [] })).toBe(false);
    expect("origins" in normalizeCustomEvent(nextPage)).toBe(false);
  });

  it("a duplicated scene keeps its declarations", () => {
    const [copy] = duplicateScenes([
      { ...scene, customEvents: [{ ...nextPage, origins: ["schedule"] }, refresh] } as FrameScene,
    ]);
    expect(copy!.customEvents?.map((event) => event.origins)).toEqual([["schedule"], undefined]);
  });

  it("offers exactly the contract's declarable origins", () => {
    expect(customEventOriginOptions.map((option) => option.origin)).toEqual([...customEventDeclarableOrigins]);
    expect(customEventOriginOptions.every((option) => option.label.length > 0)).toBe(true);
  });
});

describe("a schedule entry that fires a custom event", () => {
  const entry = {
    id: "e1",
    hour: 7,
    minute: 30,
    weekday: 8,
    event: "setCurrentScene",
    payload: { sceneId, state: { page: 2 } },
  };

  it("carries an empty payload, and gets its scene payload back when switched back", () => {
    const custom = withEventType(entry, "nextPage");
    expect(custom).toEqual({ id: "e1", hour: 7, minute: 30, weekday: 8, event: "nextPage", payload: {} });
    expect(withEventType(custom, "setCurrentScene").payload).toEqual({ sceneId: "", state: {} });
  });
});

describe("eventsLogic: setCustomEventOrigin", () => {
  let unmount: () => void = () => {};

  beforeEach(() => {
    testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("null", { status: 404 })));
    initKea({ memoryRouter: true });
    embedFrameLogic({ frameId }).mount();
    embedFrameLogic({ frameId }).actions.initEmbedFrame({
      id: frameId,
      name: "Embedded",
      scenes: [scene],
      width: 800,
      height: 480,
    } as Partial<FrameType>);
    unmount = eventsLogic({ frameId, sceneId }).mount();
  });

  afterEach(() => {
    unmount();
    vi.unstubAllGlobals();
    delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
  });

  it("ticking a box declares the origin on that event only", () => {
    const logic = eventsLogic({ frameId, sceneId });
    logic.actions.setCustomEventOrigin(0, "schedule", true);

    expect(customEventsInForm()[0]!.origins).toEqual(["schedule"]);
    expect("origins" in customEventsInForm()[1]!).toBe(false);
    expect(logic.values.customEventRows[0]!.originsSummary).toBe("a schedule");
    expect(logic.values.customEventRows[1]!.originsSummary).toBe("");

    logic.actions.setCustomEventOrigin(0, "cloud", true);
    expect(customEventsInForm()[0]!.origins).toEqual(["cloud", "schedule"]);
    expect(logic.values.customEventRows[0]!.originsSummary).toBe("a schedule, FrameOS Cloud");
  });

  it("unticking the last box removes `origins` rather than leaving []", () => {
    const logic = eventsLogic({ frameId, sceneId });
    logic.actions.setCustomEventOrigin(0, "schedule", true);
    logic.actions.setCustomEventOrigin(0, "schedule", false);

    expect("origins" in customEventsInForm()[0]!).toBe(false);
    expect(customEventsInForm()[0]!.name).toBe("nextPage");
  });
});
