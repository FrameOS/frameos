import { describe, expect, it } from "vitest";
import {
  liveSceneLabel,
  otherSceneIsLive,
} from "../../../../../../frontend/src/utils/systemScenes";

// The scene editor's Preview drawer shows the frame's live picture and dims
// it under "A different scene is live" when that picture is not the scene
// being edited. The device reports any scene it was handed ad hoc — every
// "Preview on frame", every interpreted scene loaded from disk — as
// `uploaded/<id>`, so comparing raw ids would put the notice over the
// editor's OWN scene the moment it is previewed.

describe("otherSceneIsLive", () => {
  it("is false for the scene itself, with or without the uploaded/ prefix", () => {
    expect(otherSceneIsLive("dvd-logo", "dvd-logo")).toBe(false);
    expect(otherSceneIsLive("uploaded/dvd-logo", "dvd-logo")).toBe(false);
    expect(otherSceneIsLive("dvd-logo", "uploaded/dvd-logo")).toBe(false);
  });

  it("is true for another scene, prefixed or not, and for a system screen", () => {
    expect(otherSceneIsLive("weather", "dvd-logo")).toBe(true);
    expect(otherSceneIsLive("uploaded/weather", "dvd-logo")).toBe(true);
    expect(otherSceneIsLive("system/index", "dvd-logo")).toBe(true);
  });

  it("does not mistake an id that merely ends with the scene id for the scene", () => {
    expect(otherSceneIsLive("uploaded/other-dvd-logo", "dvd-logo")).toBe(true);
    expect(otherSceneIsLive("uploaded/uploaded/dvd-logo", "dvd-logo")).toBe(
      true,
    );
  });

  it("claims nothing before the frame has said what it shows", () => {
    expect(otherSceneIsLive(null, "dvd-logo")).toBe(false);
    expect(otherSceneIsLive(undefined, "dvd-logo")).toBe(false);
    expect(otherSceneIsLive("", "dvd-logo")).toBe(false);
  });
});

describe("liveSceneLabel", () => {
  const scenes = [
    { id: "weather", name: "Weather" },
    { id: "unnamed" },
  ];

  it("names a frame scene through the uploaded/ prefix", () => {
    expect(liveSceneLabel("weather", scenes)).toBe("Weather");
    expect(liveSceneLabel("uploaded/weather", scenes)).toBe("Weather");
  });

  it("names the built-in screens", () => {
    expect(liveSceneLabel("system/index", scenes)).toBe("Status screen");
    expect(liveSceneLabel("system/wifiHotspot", scenes)).toBe(
      "A system screen",
    );
  });

  it("returns null when nothing names the scene", () => {
    expect(liveSceneLabel("uploaded/gone", scenes)).toBeNull();
    expect(liveSceneLabel("unnamed", scenes)).toBeNull();
    expect(liveSceneLabel(null, scenes)).toBeNull();
  });
});
