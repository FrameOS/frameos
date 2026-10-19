// Which panels an ESP32 board can be pushed (the `device` setting): the
// `panels` cases of docs/cloud-frames-fixtures.json against the cloud's rule
// (lib/esp32-board-panels.ts, what the settings route refuses with) and the
// SPA's (frontend/src/utils/esp32BoardPanels.ts, what the Settings panel
// offers). The firmware runs the same cases (test_fos_board_panels.c).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { esp32PanelRefusal as cloudRefusal } from "../../lib/esp32-board-panels";
import { esp32Panels as cloudPanels } from "../../lib/esp32-board-panels.gen";
import { frameSettingsRefusal } from "../../lib/frames";
import {
  esp32DrivablePanels,
  esp32PanelName,
  esp32PanelRefusal as spaRefusal,
} from "../../../../../../frontend/src/utils/esp32BoardPanels";
import { esp32Panels as spaPanels } from "../../../../../../frontend/src/utils/esp32BoardPanels.gen";
import { esp32CloudFrameSettingKeysForVersion } from "../../../../../../frontend/src/utils/cloudFrameSettings";
import { paletteDeviceOf } from "../../../../../../frontend/src/utils/assetColors/devicePalette";

interface PanelCase {
  name: string;
  board: { hardwarePreset?: string; pins: Record<string, number> };
  device: string;
  expect: string;
}

const fixtures = JSON.parse(
  readFileSync(new URL("../../../../../../docs/cloud-frames-fixtures.json", import.meta.url), "utf8"),
) as { panels: { compiled: Record<string, { bus: string; requiresCs2?: boolean }>; cases: PanelCase[] } };

const e1002Pins = { rst: 12, dc: 11, cs: 10, cs2: -1, busy: 13, sck: 7, mosi: 9, pwr: -1 };
const xiaoPins = { rst: 38, dc: 10, cs: 44, cs2: -1, busy: 4, sck: 7, mosi: 9, pwr: -1 };

describe("ESP32 board panels", () => {
  for (const testCase of fixtures.panels.cases) {
    it(`cloud and SPA agree: ${testCase.name}`, () => {
      expect(cloudRefusal(testCase.board, testCase.device) ?? "ok").toBe(testCase.expect);
      expect(spaRefusal(testCase.board, testCase.device) ?? "ok").toBe(testCase.expect);
    });
  }

  it("generates one table for both packages, with the fixture's panels in it", () => {
    expect(cloudPanels).toEqual(spaPanels);
    for (const [name, facts] of Object.entries(fixtures.panels.compiled)) {
      const panel = spaPanels.find((candidate) => candidate.name === name);
      expect(panel, name).toBeDefined();
      expect(panel?.bus, name).toBe(facts.bus);
      expect("requiresCs2" in panel! && panel.requiresCs2, name).toBe(Boolean(facts.requiresCs2));
    }
  });

  it("leaves the wiring to the device when the frame reported no pins", () => {
    // Firmware before the `device` floor reports no pins and cannot be
    // pushed a panel anyway; a built-in display still narrows the list.
    expect(spaRefusal({ hardwarePreset: "trmnl_og_diy_kit" }, "waveshare.EPD_13in3e")).toBeNull();
    expect(spaRefusal({ hardwarePreset: "seeed_reterminal_e1002" }, "waveshare.EPD_7in5_V2")).toBe("builtin_display");
    expect(cloudRefusal({}, "waveshare.EPD_10in3")).toBe("not_compiled");
  });

  it("offers a built-in display's board its own panel only, a driver board what its pins drive", () => {
    expect(
      esp32DrivablePanels({ hardwarePreset: "seeed_reterminal_e1002", pins: e1002Pins }).map((p) => p.device),
    ).toEqual(["waveshare.EPD_7in3e"]);
    const socket = esp32DrivablePanels({ hardwarePreset: "trmnl_og_diy_kit", pins: xiaoPins }).map((p) => p.device);
    expect(socket).toContain("waveshare.EPD_7in5_V2");
    expect(socket).toContain("waveshare.EPD_4in26");
    expect(socket).not.toContain("waveshare.EPD_13in3e");
    expect(socket).not.toContain("oled.ssd1306_72x40");
  });

  it("names the reported panel in the planes' spelling", () => {
    const esp32 = (device: string) => ({ device: "", hardware: { platform: "esp32-s3", device } });
    expect(paletteDeviceOf(esp32("EPD_7in3e"))).toBe("waveshare.EPD_7in3e");
    expect(paletteDeviceOf(esp32("OLED_SSD1306_72x40"))).toBe("oled.ssd1306_72x40");
    expect(esp32PanelName("oled.ssd1306_72x40")).toBe("OLED_SSD1306_72x40");
    expect(esp32PanelName("waveshare.EPD_7in3e")).toBe("EPD_7in3e");
  });

  it("sends `device` to an ESP32 from 2026.10.18 on, and the route refuses an undrivable panel", () => {
    expect(esp32CloudFrameSettingKeysForVersion("2026.10.17")).not.toContain("device");
    expect(esp32CloudFrameSettingKeysForVersion("2026.10.18")).toContain("device");
    const e1002 = (frameosVersion: string) => ({
      frameosVersion,
      hardware: { platform: "esp32-s3", hardwarePreset: "seeed_reterminal_e1002", pins: e1002Pins },
    });
    expect(frameSettingsRefusal(e1002("2026.10.17"), { device: "waveshare.EPD_7in3e" })).toEqual({
      error: "settings_need_newer_firmware",
      minFrameosVersion: "2026.10.18",
    });
    expect(frameSettingsRefusal(e1002("2026.10.18"), { device: "waveshare.EPD_7in3e" })).toBeNull();
    expect(frameSettingsRefusal(e1002("2026.10.18"), { device: "waveshare.EPD_7in5_V2" })).toEqual({
      error: "panel_not_drivable",
      reason: "builtin_display",
    });
    expect(frameSettingsRefusal(e1002("2026.10.18"), { device: "none" })).toEqual({
      error: "panel_not_drivable",
      reason: "panel_off",
    });
    // A Linux frame's driver key is not judged by the ESP32 board table.
    expect(
      frameSettingsRefusal({ frameosVersion: "2026.10.18", hardware: { platform: "pi" } }, { device: "framebuffer" }),
    ).toBeNull();
  });
});
