// A standalone ESP32 set up by flash.frameos.net
// (cloud-frontend/src/flasher/standalone.ts, cloud/docs/flasher.md): what the
// console is told, in what order, and which scenes the frame starts with.
import { describe, expect, it } from "vitest";
import {
  CUSTOM_BOARD,
  boardFromQuery,
  pinSpecProblem,
  standaloneBoards,
  standaloneHostname,
  standaloneProblem,
  standaloneProvisioning,
  starterSceneSet,
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
  const templates = [
    { name: "Scene store", description: "", preselected: true, scenes: [{ id: "scene-store", default: true }] },
    { name: "Clock", description: "", preselected: true, scenes: [{ id: "clock" }] },
    { name: "Flip clock", description: "", preselected: false, scenes: [{ id: "flip-clock" }] },
  ];

  it("shows the first picked scene that is not the store", () => {
    const scenes = starterSceneSet(templates, new Set(["Scene store", "Clock"]));
    expect(scenes.map((scene) => scene.id)).toEqual(["scene-store", "clock"]);
    expect(scenes.filter((scene) => scene.default).map((scene) => scene.id)).toEqual(["clock"]);
    // The templates themselves are left as they were.
    expect(templates[0]!.scenes[0]).toEqual({ id: "scene-store", default: true });
  });

  it("shows the store when it is all there is", () => {
    const scenes = starterSceneSet(templates, new Set(["Scene store"]));
    expect(scenes).toEqual([{ id: "scene-store", default: true }]);
  });
});
