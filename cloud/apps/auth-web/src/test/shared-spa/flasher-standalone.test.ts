// A standalone ESP32 set up by flash.frameos.net
// (cloud-frontend/src/flasher/standalone.ts, cloud/docs/flasher.md): what the
// console is told, in what order, and which scenes the frame starts with.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FlasherSample } from "../../../../../../cloud-frontend/src/flasher/sampleCatalog";
import {
  CUSTOM_BOARD,
  TOUCH_PRESETS,
  boardFromQuery,
  defaultScenePreset,
  pickedScenes,
  pickedScenesProblem,
  pinSpecProblem,
  presetPicks,
  sceneUploadSeconds,
  standaloneBoardKind,
  standaloneBoards,
  standaloneHostname,
  standaloneProblem,
  standaloneProvisioning,
  standaloneSceneRoom,
  starterSceneSet,
  storeCoversFromListing,
  type StandaloneChoices,
} from "../../../../../../cloud-frontend/src/flasher/standalone";

function choices(overrides: Partial<StandaloneChoices> = {}): StandaloneChoices {
  return {
    board: "seeed_reterminal_e1002",
    panel: "",
    pins: "",
    name: "Kitchen frame",
    timeZone: "Europe/Brussels",
    wifi: { ssid: "Home", password: "hunter2" },
    ...overrides,
  };
}

describe("standalone boards", () => {
  it("offers the ESP32-S3 presets and nothing a frame would need a plane to draw for", () => {
    const keys = standaloneBoards.map((board) => board.key);
    expect(keys).toContain("seeed_reterminal_e1002");
    expect(keys).toContain("seeed_sensecap_indicator_d1");
    expect(keys).toContain("seeed_xiao_ee04");
    // A C3 or a Pico is a thin client.
    for (const thin of ["trmnl_og", "trmnl_bwry", "xteink_x4", "esp32_c3_042_oled"]) {
      expect(keys).not.toContain(thin);
    }
    expect(keys.some((key) => key.startsWith("pimoroni"))).toBe(false);
  });

  it("reads a ?board= link", () => {
    expect(boardFromQuery("?board=seeed_reterminal_e1002")).toBe("seeed_reterminal_e1002");
    expect(boardFromQuery("?board=custom")).toBe(CUSTOM_BOARD);
    expect(boardFromQuery("?board=trmnl_og")).toBeNull();
    expect(boardFromQuery("")).toBeNull();
  });
});

describe("standaloneProvisioning", () => {
  it("sends the board bundle first, then what overrides it, and no plane", () => {
    const plan = standaloneProvisioning(choices());
    expect(plan.settings).toEqual([
      { key: "hardware", value: "seeed_reterminal_e1002", secret: false },
      { key: "hostname", value: "kitchen-frame", secret: false },
      { key: "time_zone", value: "Europe/Brussels", secret: false },
    ]);
    expect(plan.wifi).toEqual({ ssid: "Home", password: "hunter2" });
    const keys = plan.settings.map((setting) => setting.key as string);
    for (const plane of ["backend", "api_key", "cloud_url", "claim_token"]) {
      expect(keys).not.toContain(plane);
    }
  });

  it("holds the Sticky at its rotation and a carrier board to its panel", () => {
    expect(standaloneProvisioning(choices({ board: "seeed_reterminal_sticky" })).settings[1]).toEqual({
      key: "rotate",
      value: "270",
      secret: false,
    });
    const carrier = standaloneProvisioning(choices({ board: "seeed_xiao_ee04", panel: "EPD_7in3e" })).settings;
    expect(carrier.slice(0, 2)).toEqual([
      { key: "hardware", value: "seeed_xiao_ee04", secret: false },
      { key: "panel", value: "EPD_7in3e", secret: false },
    ]);
  });

  it("wires any other S3 by its panel, the XIAO's pins unless told", () => {
    const custom = standaloneProvisioning(choices({ board: CUSTOM_BOARD, panel: "EPD_7in5_V2" })).settings;
    expect(custom[0]).toEqual({ key: "panel", value: "EPD_7in5_V2", secret: false });
    expect(custom.map((setting) => setting.key)).not.toContain("pins");
    const pinned = standaloneProvisioning(
      choices({ board: CUSTOM_BOARD, panel: "EPD_7in5_V2", pins: "rst=5, dc=4,cs=3" })
    ).settings;
    expect(pinned[1]).toEqual({ key: "pins", value: "rst=5,dc=4,cs=3", secret: false });
  });

  it("joins no network when given none", () => {
    expect(standaloneProvisioning(choices({ wifi: null })).wifi).toBeNull();
  });

  it("says what is missing", () => {
    expect(standaloneProblem(choices({ board: "" }))).toMatch(/Pick the board/);
    expect(standaloneProblem(choices({ board: CUSTOM_BOARD }))).toMatch(/panel/);
    expect(standaloneProblem(choices({ board: CUSTOM_BOARD, panel: "EPD_7in5_V2", pins: "rst five" }))).toMatch(/Pins/);
    expect(standaloneProblem(choices({ wifi: { ssid: "Home\nx", password: "" } }))).toMatch(/Wi-Fi/);
    expect(standaloneProblem(choices())).toBeNull();
    expect(pinSpecProblem("")).toBeNull();
  });

  it("makes a DHCP hostname of the name", () => {
    expect(standaloneHostname("Kitchen Frame")).toBe("kitchen-frame");
    expect(standaloneHostname("  ***  ")).toBe("frameos");
    expect(standaloneHostname("a".repeat(40))).toHaveLength(31);
  });
});

describe("starterSceneSet", () => {
  const store = [{ id: "scene-store", default: true }];
  const clock = [{ id: "clock" }];
  const layoutAndScene = [{ id: "a-layout", settings: { isLayout: true } }, { id: "flip-clock", default: true }];

  it("boots a board of keys into the first picked scene that is not the store", () => {
    const scenes = starterSceneSet([clock, store], { touch: false });
    expect(scenes.map((scene) => scene.id)).toEqual(["scene-store", "clock"]);
    expect(scenes.filter((scene) => scene.default).map((scene) => scene.id)).toEqual(["clock"]);
    // What was fetched is left as it was.
    expect(store[0]).toEqual({ id: "scene-store", default: true });
  });

  it("never marks a layout", () => {
    const scenes = starterSceneSet([store, layoutAndScene], { touch: false });
    expect(scenes.filter((scene) => scene.default).map((scene) => scene.id)).toEqual(["flip-clock"]);
  });

  it("shows the store when it is all there is", () => {
    expect(starterSceneSet([store], { touch: false })).toEqual([{ id: "scene-store", default: true }]);
  });

  it("marks nothing on a board that takes taps: it opens on its scene list", () => {
    const scenes = starterSceneSet([store, clock, layoutAndScene], { touch: true });
    expect(scenes.some((scene) => "default" in scene)).toBe(false);
  });
});

describe("the boards' screens", () => {
  const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));

  it("takes taps on exactly the boards whose firmware event map swipes", () => {
    // A standalone frame runs the event map its firmware has for its preset.
    const board = readFileSync(`${repoRoot}embedded/esp32/main/fos_board.c`, "utf8");
    const swiping = [...board.matchAll(/\{"([a-z0-9_]+)",[^\n]*\btrue\},/g)].map((match) => match[1]);
    expect(swiping.length).toBeGreaterThan(3);
    expect(new Set(swiping)).toEqual(TOUCH_PRESETS);
    for (const option of standaloneBoards) {
      expect(option.touch).toBe(TOUCH_PRESETS.has(option.key));
    }
  });

  it("knows a fast screen and the flash of each board", () => {
    expect(standaloneBoardKind("seeed_sensecap_indicator_d1")).toEqual({ touch: true, fast: true, flashSize: "8MB" });
    expect(standaloneBoardKind("seeed_reterminal_sticky")).toEqual({ touch: true, fast: false, flashSize: "32MB" });
    expect(standaloneBoardKind("seeed_reterminal_e1002")).toEqual({ touch: false, fast: false, flashSize: "32MB" });
    expect(standaloneBoardKind(CUSTOM_BOARD)).toEqual({ touch: false, fast: false, flashSize: null });
    expect(standaloneBoardKind("")).toEqual({ touch: false, fast: null, flashSize: null });
  });

  it("keeps a share of /state for scenes, by layout", () => {
    expect(standaloneSceneRoom({ touch: false, fast: false, flashSize: "32MB" })).toEqual({
      bytes: Math.floor(24 * 1024 * 1024 * 0.7),
      flashSize: "32MB",
      assumed: false,
    });
    expect(standaloneSceneRoom({ touch: false, fast: false, flashSize: "16MB" }).bytes).toBe(
      Math.floor(8 * 1024 * 1024 * 0.7),
    );
    // Another S3 board: counted as the smallest layout until esptool reads it.
    expect(standaloneSceneRoom({ touch: false, fast: false, flashSize: null })).toEqual({
      bytes: Math.floor(1024 * 1024 * 0.7),
      flashSize: "8MB",
      assumed: true,
    });
  });
});

describe("the scenes to start with", () => {
  function sample(name: string, overrides: Partial<FlasherSample> = {}): FlasherSample {
    return {
      name,
      description: "",
      category: "Clocks & time",
      needs: [],
      bytes: 10 * 1024,
      scenes: 1,
      file: `${name.toLowerCase().replace(/\W+/g, "-")}.json`,
      store: false,
      ...overrides,
    };
  }
  const samples = [
    sample("Scene store", { store: true, category: "Notes & tools", needs: ["touch"], bytes: 64 * 1024 }),
    sample("Clock"),
    sample("Weather", { category: "Weather" }),
    sample("Word clock"),
    sample("Year progress"),
    sample("Files", { category: "Notes & tools", needs: ["touch", "keys"] }),
    sample("Code editor", { category: "System", needs: ["touch", "keys"] }),
    sample("Calculator", { category: "Notes & tools", needs: ["touch"] }),
    sample("Snake", { category: "Games", needs: ["touch", "keys"] }),
    sample("Star shooter", { category: "Games", needs: ["fast", "touch"] }),
    sample("Touch test", { category: "Demos & examples", needs: ["touch"] }),
    sample("Big photo", { category: "Photos", bytes: 700 * 1024 }),
  ];
  const paper = { touch: false, fast: false, flashSize: "32MB" };
  const stickyKind = { touch: true, fast: false, flashSize: "32MB" };
  const lcd = { touch: true, fast: true, flashSize: "16MB" };
  const small = { touch: false, fast: false, flashSize: "8MB" };

  it("starts a board of keys on the store, a clock and a few calm scenes", () => {
    expect(defaultScenePreset()).toBe("starter");
    expect(presetPicks("starter", samples, paper).picked).toEqual([
      "Scene store",
      "Clock",
      "Weather",
      "Word clock",
      "Year progress",
    ]);
  });

  it("starts a touch board with the frame's tools", () => {
    expect(presetPicks("starter", samples, stickyKind).picked).toEqual([
      "Scene store",
      "Clock",
      "Weather",
      "Code editor",
      "Files",
      "Calculator",
    ]);
  });

  it("ticks what is used by hand on an LCD, and leaves the demos out", () => {
    expect(presetPicks("interactive", samples, lcd).picked).toEqual([
      "Scene store",
      "Files",
      "Code editor",
      "Calculator",
      "Snake",
      "Star shooter",
    ]);
  });

  it("ticks what is only looked at for e-paper", () => {
    expect(presetPicks("paper", samples, paper).picked).toEqual([
      "Scene store",
      "Clock",
      "Weather",
      "Word clock",
      "Year progress",
      "Big photo",
    ]);
  });

  it("ticks everything on any board: a fast scene runs on e-paper too", () => {
    expect(presetPicks("everything", samples, paper).picked).toContain("Star shooter");
    expect(presetPicks("everything", samples, lcd).picked).toHaveLength(samples.length);
    expect(presetPicks("store", samples, lcd)).toEqual({ picked: ["Scene store"], noRoom: [] });
  });

  it("fills a small board while it has room, and says what did not fit", () => {
    const { picked, noRoom } = presetPicks("everything", samples, small);
    expect(picked).not.toContain("Big photo");
    expect(noRoom).toEqual(["Big photo"]);
    const chosen = pickedScenes(samples, picked);
    expect(chosen.bytes).toBeLessThanOrEqual(standaloneSceneRoom(small).bytes);
    expect(pickedScenesProblem(chosen, small, samples)).toBeNull();
  });

  it("refuses a set the board cannot take", () => {
    const tooBig = pickedScenes(samples, ["Big photo", "Clock"]);
    expect(pickedScenesProblem(tooBig, small, samples)).toMatch(/keeps about 717 KB of scenes.*untick some/);
    // No panel holds a scene back: the DVD logo runs on a fast e-paper.
    expect(pickedScenesProblem(pickedScenes(samples, ["Star shooter"]), paper, samples)).toBeNull();
    const many = Array.from({ length: 130 }, (_, index) => sample(`Scene ${index}`, { bytes: 1024 }));
    expect(
      pickedScenesProblem(pickedScenes(many, many.map((entry) => entry.name)), paper, many),
    ).toMatch(/up to 128 scenes/);
    // The store is always among the picked, ticked or not.
    expect(pickedScenes(samples, []).samples.map((entry) => entry.name)).toEqual(["Scene store"]);
  });

  it("reads the store's listing for the samples' thumbnails, by name", () => {
    const listingUrl = "https://flash.frameos.net/api/store/repository.json";
    const covers = storeCoversFromListing(
      {
        templates: [
          {
            name: "Clock",
            image: "./scenes/49f88a34-92ac-4090-9afd-1c5affb4bfec/image?v=8",
            url: "https://scenes.frameos.net/s/clock",
          },
          { name: "No page", image: "./scenes/x/image" },
          { name: "Bad page", image: "./scenes/x/image", url: "javascript:alert(1)" },
        ],
      },
      listingUrl,
    );
    expect(covers).toEqual({
      clock: {
        image: "https://flash.frameos.net/api/store/scenes/49f88a34-92ac-4090-9afd-1c5affb4bfec/image?v=8",
        url: "https://scenes.frameos.net/s/clock",
      },
    });
    expect(storeCoversFromListing(null, listingUrl)).toEqual({});
    expect(storeCoversFromListing({ templates: "nope" }, listingUrl)).toEqual({});
  });

  it("says how long the scenes take over the cable", () => {
    expect(sceneUploadSeconds(110 * 1024, 4)).toBe(10);
    // Past one upload, every scene goes alone.
    expect(sceneUploadSeconds(1100 * 1024, 20)).toBe(140);
  });
});
