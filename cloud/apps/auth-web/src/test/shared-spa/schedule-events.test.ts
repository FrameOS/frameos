import { describe, expect, it } from "vitest";
import { cloudFrameSupportsSettingsFrom } from "../../../../../../frontend/src/utils/cloudFrameSettings";
import {
  isScheduledCustomEvent,
  isScheduledSystemEvent,
  schedulableCustomEventGroups,
  scheduledEventIsSceneChange,
  scheduledEventOptions,
  scheduledEventTitle,
  scheduledSystemEvents,
  scheduledSystemEventsMinVersion,
} from "../../../../../../frontend/src/utils/scheduleEvents";

// The SPA's schedule-entry vocabulary (frontend/src/utils/scheduleEvents.ts):
// a scene change or one of two maintenance actions. Every surface that lists
// schedule entries — the panel, the workspace overview card, the dashboard —
// titles them through scheduledEventTitle, so a restart never reads as
// "Unknown scene".

describe("scheduled system events", () => {
  it("are exactly restart and reboot, offered after the scene change", () => {
    expect(scheduledSystemEvents.map((option) => option.value)).toEqual([
      "restart",
      "reboot",
    ]);
    expect(scheduledEventOptions.map((option) => option.value)).toEqual([
      "setCurrentScene",
      "restart",
      "reboot",
    ]);
    expect(isScheduledSystemEvent("restart")).toBe(true);
    expect(isScheduledSystemEvent("reboot")).toBe(true);
    expect(isScheduledSystemEvent("setCurrentScene")).toBe(false);
    expect(isScheduledSystemEvent(undefined)).toBe(false);
  });

  it("title a scene change by scene name and a maintenance entry by its label", () => {
    const names: Record<string, string> = { "scene-1": "Morning news" };
    const byId = (sceneId: string) => names[sceneId];
    expect(
      scheduledEventTitle(
        { event: "setCurrentScene", payload: { sceneId: "scene-1" } },
        byId,
      ),
    ).toBe("Morning news");
    expect(
      scheduledEventTitle(
        { event: "setCurrentScene", payload: { sceneId: "gone" } },
        byId,
      ),
    ).toBe("Unknown scene");
    expect(
      scheduledEventTitle(
        { event: "setCurrentScene", payload: {} },
        byId,
        "Unspecified scene",
      ),
    ).toBe("Unspecified scene");
    // A system entry never consults the scene list, even with a stray sceneId.
    expect(
      scheduledEventTitle(
        { event: "restart", payload: { sceneId: "scene-1" } },
        byId,
      ),
    ).toBe("Restart FrameOS");
    expect(scheduledEventTitle({ event: "reboot", payload: {} }, byId)).toBe(
      "Reboot device",
    );
  });

  it("offer a scene's custom event only when its declaration lets a schedule fire it", () => {
    // The device's reading of the same array (declaredCustomEventOrigins,
    // frameos/events.nim): no `origins`, no schedule; a contract name cannot
    // be declared.
    const groups = schedulableCustomEventGroups([
      {
        id: "a",
        name: "Book",
        customEvents: [
          { name: "nextPage", origins: ["cloud", "schedule"] },
          { name: " nextPage ", origins: ["schedule"] },
          { name: "cloudOnly", origins: ["cloud"] },
          { name: "undeclared" },
          { name: "render", origins: ["schedule"] },
          { name: "x".repeat(64), origins: ["schedule"] },
        ],
      },
      { id: "b", name: "Clock", customEvents: [] },
      { id: "c", customEvents: [{ name: "chime", origins: ["schedule"] }] },
    ]);
    expect(groups).toEqual([
      { label: "Book", options: [{ value: "nextPage", label: "nextPage" }] },
      { label: "c", options: [{ value: "chime", label: "chime" }] },
    ]);
    expect(schedulableCustomEventGroups(undefined)).toEqual([]);
  });

  it("title a custom event entry by its name, never as a scene", () => {
    expect(isScheduledCustomEvent("nextPage")).toBe(true);
    expect(isScheduledCustomEvent("setCurrentScene")).toBe(false);
    expect(isScheduledCustomEvent("restart")).toBe(false);
    expect(isScheduledCustomEvent("")).toBe(false);
    expect(scheduledEventIsSceneChange({ event: "nextPage", payload: {} })).toBe(false);
    expect(scheduledEventIsSceneChange({ event: "setCurrentScene", payload: {} })).toBe(true);
    expect(scheduledEventTitle({ event: "nextPage", payload: {} }, () => "Morning news")).toBe(
      "nextPage",
    );
  });

  it("gate on the firmware floor the way the settings batches do", () => {
    // Below the floor the panel disables the buttons with a reason; unknown
    // and missing versions follow cloudFrameSupportsSettingsFrom's rules.
    const min = scheduledSystemEventsMinVersion;
    expect(cloudFrameSupportsSettingsFrom(min, "2026.8.31")).toBe(false);
    expect(cloudFrameSupportsSettingsFrom(min, min)).toBe(true);
    expect(cloudFrameSupportsSettingsFrom(min, "2026.9.1+abc")).toBe(true);
    expect(cloudFrameSupportsSettingsFrom(min, undefined)).toBe(false);
  });
});
