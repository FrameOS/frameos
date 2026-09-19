// The Pimoroni Inky Frame's wiring has five keys the ESP32 pin form does not
// edit: BUSY and the front buttons sit behind a shift register (sr_clock,
// sr_latch, sr_data, busy_bit) and hold_vsys keeps the Pico powered on
// battery. The backend stores them in device_config.pins; the settings form
// used to normalise every pin map down to its own eight keys, so opening a
// Pico frame's settings and changing anything near the pins stripped them.
//
// The form does not own those keys, so it must never be what deletes them.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ESP32_XIAO_PIN_LAYOUT,
  PIMORONI_INKY_FRAME_PIN_LAYOUT,
  esp32ExtraPins,
  esp32HardwarePresetConfig,
  esp32PinLayoutForPreset,
  esp32PinLayoutPresetValue,
  esp32RecommendedPinLayout,
  normalizeEsp32PinLayout,
} from "../../../../../../frontend/src/scenes/frame/panels/FrameSettings/esp32Hardware";

const inkyExtras = { sr_clock: 8, sr_latch: 9, sr_data: 10, busy_bit: 7, hold_vsys: 2 };
const storedInkyPins = { rst: 27, dc: 28, cs: 17, cs2: -1, busy: -1, sck: 18, mosi: 19, pwr: -1, ...inkyExtras };

describe("the Inky Frame layout", () => {
  it("mirrors EMBEDDED_INKY_FRAME_PINS in the backend, extras included", () => {
    const source = readFileSync(
      resolve(__dirname, "../../../../../..", "backend/app/tasks/embedded_firmware.py"),
      "utf8",
    );
    const table = source.match(/EMBEDDED_INKY_FRAME_PINS = \{([\s\S]*?)\n\}/)?.[1];
    expect(table, "EMBEDDED_INKY_FRAME_PINS not found").toBeTruthy();
    const backendPins = Object.fromEntries(
      [...(table ?? "").matchAll(/"([a-z0-9_]+)":\s*(-?\d+)/g)].map((match) => [match[1], Number(match[2])]),
    );
    expect(PIMORONI_INKY_FRAME_PIN_LAYOUT).toEqual(backendPins);
    expect(PIMORONI_INKY_FRAME_PIN_LAYOUT).toEqual(storedInkyPins);
  });

  it("reaches device_config.pins whole through every preset path", () => {
    // Choosing the hardware preset, the recommended layout, and the pin-layout
    // dropdown are all spreads of the same table.
    for (const preset of [
      "pimoroni_inky_frame_4",
      "pimoroni_inky_frame_5_7",
      "pimoroni_inky_frame_7_3",
      "pimoroni_inky_frame_7_3_pico2",
      "pimoroni_inky_frame_7_3_spectra",
    ] as const) {
      expect(esp32HardwarePresetConfig(preset)?.pins).toEqual(storedInkyPins);
      expect(esp32RecommendedPinLayout("waveshare.EPD_7in3e", preset)).toEqual(storedInkyPins);
    }
    expect(esp32PinLayoutForPreset("pimoroni-inky-frame")).toEqual(storedInkyPins);
  });
});

describe("a round trip through the pin form", () => {
  it("keeps the shift-register keys the frame already has", () => {
    const normalized = normalizeEsp32PinLayout(storedInkyPins, "waveshare.EPD_7in3e", "pimoroni_inky_frame_7_3_spectra");
    expect(normalized).toEqual(storedInkyPins);
    // Still recognised as the Inky layout by its eight SPI keys.
    expect(esp32PinLayoutPresetValue(normalized)).toBe("pimoroni-inky-frame");
  });

  it("keeps them when one of the eight pins is edited on a custom board", () => {
    // What the form does on a pin edit: normalise, then spread the new value in.
    const pins = normalizeEsp32PinLayout({ ...storedInkyPins, sr_clock: 11 }, "waveshare.EPD_7in3e", "custom");
    const edited = { ...pins, rst: 26 };
    expect(edited).toEqual({ ...storedInkyPins, sr_clock: 11, rst: 26 });
  });

  it("never invents them for an ESP32 board", () => {
    const normalized = normalizeEsp32PinLayout({ rst: 5, dc: 4 }, "waveshare.EPD_7in5_V2", "custom");
    expect(normalized).toEqual({ ...ESP32_XIAO_PIN_LAYOUT });
    expect(esp32ExtraPins(normalized)).toEqual({});
  });

  it("restores what an earlier save stripped, while the frame is on an Inky preset", () => {
    const stripped = { rst: 27, dc: 28, cs: 17, cs2: -1, busy: -1, sck: 18, mosi: 19, pwr: -1 };
    expect(normalizeEsp32PinLayout(stripped, "waveshare.EPD_7in3e", "pimoroni_inky_frame_7_3_spectra")).toEqual(
      storedInkyPins,
    );
    // Off the preset there is nothing to restore from, and nothing is guessed.
    expect(normalizeEsp32PinLayout(stripped, "waveshare.EPD_7in3e", "custom")).toEqual(stripped);
  });

  it("carries any unknown key, not just today's five", () => {
    const withFuture = { ...storedInkyPins, led_activity: 6 } as typeof storedInkyPins;
    expect(esp32ExtraPins(withFuture)).toEqual({ ...inkyExtras, led_activity: 6 });
    expect(normalizeEsp32PinLayout(withFuture, "waveshare.EPD_7in3e", "custom")).toMatchObject({ led_activity: 6 });
    // `sclk` is the old spelling of `sck`, folded into it — not an extra.
    expect(esp32ExtraPins({ sclk: 18 })).toEqual({});
  });
});
