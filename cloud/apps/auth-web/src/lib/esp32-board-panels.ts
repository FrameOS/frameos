// Which display panels an ESP32 board can be pushed (the `device` setting).
// The rule and its reasons are docs/esp32-board-panels.json; the firmware
// runs the same rule (embedded/esp32/main/fos_board_panels.c) and is the
// final word, the SPA offers by it (frontend/src/utils/esp32BoardPanels.ts),
// and all three run the `panels` cases of docs/cloud-frames-fixtures.json.
// The tables are generated (esp32-board-panels.gen.ts).

import { esp32Boards, esp32Panels } from "./esp32-board-panels.gen";

export type Esp32PanelRefusal =
  | "panel_off"
  | "not_compiled"
  | "builtin_display"
  | "no_wiring"
  | "wrong_bus"
  | "needs_cs2";

export type Esp32Panel = (typeof esp32Panels)[number];

/** What a frame's hardware report says about its board (fos_cloud.c add_hardware_json). */
export type Esp32PanelBoard = { hardwarePreset?: unknown; pins?: unknown };

type Wiring = { bus: "spi" | "i2c" | null; cs2: boolean };

const panelsByName = new Map<string, Esp32Panel>(esp32Panels.map((panel) => [panel.name, panel]));
const panelsByDevice = new Map<string, Esp32Panel>(esp32Panels.map((panel) => [panel.device, panel]));

/** The firmware's panel name for a plane's key: `waveshare.EPD_7in3e`, the bare `EPD_7in3e`, `oled.ssd1306_72x40`. */
export function esp32PanelName(device: string): string {
  const aliased = panelsByDevice.get(device);
  if (aliased) return aliased.name;
  return device.startsWith("waveshare.") ? device.slice("waveshare.".length) : device;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// The bus the reported pins make (fos_board_panels.c wiring_bus), or
// undefined when the frame reported none: older firmware, which cannot be
// pushed a panel anyway, so the device judges.
function wiringOf(board: Esp32PanelBoard): Wiring | undefined {
  if (!isRecord(board.pins)) return undefined;
  const pins = board.pins;
  const pin = (name: string) => (typeof pins[name] === "number" ? (pins[name] as number) : -1);
  const set = (name: string) => pin(name) >= 0;
  let bus: Wiring["bus"] = null;
  if (set("sck") && set("mosi")) {
    if (set("rst") && set("dc") && set("cs") && set("busy")) bus = "spi";
    else if (!set("dc") && !set("cs") && !set("busy")) bus = "i2c";
  }
  return { bus, cs2: set("cs2") };
}

function builtinPanel(hardwarePreset: unknown): string | undefined {
  if (typeof hardwarePreset !== "string" || !Object.prototype.hasOwnProperty.call(esp32Boards, hardwarePreset)) {
    return undefined;
  }
  const board = esp32Boards[hardwarePreset as keyof typeof esp32Boards];
  return board.display === "builtin" ? board.panel : undefined;
}

/**
 * null when a board reporting `board` can drive `device`, otherwise the first
 * reason that applies, in the order the firmware checks them.
 */
export function esp32PanelRefusal(board: Esp32PanelBoard, device: string): Esp32PanelRefusal | null {
  const name = esp32PanelName(device);
  if (name === "none") return "panel_off";
  const panel = panelsByName.get(name);
  if (!panel) return "not_compiled";
  const builtin = builtinPanel(board.hardwarePreset);
  if (builtin !== undefined && builtin !== name) return "builtin_display";
  const wiring = wiringOf(board);
  if (!wiring) return null;
  if (wiring.bus === null) return "no_wiring";
  if (wiring.bus !== panel.bus) return "wrong_bus";
  if ("requiresCs2" in panel && panel.requiresCs2 && !wiring.cs2) return "needs_cs2";
  return null;
}

/** The panels a board reporting `board` can be pushed, in the firmware's table order. */
export function esp32DrivablePanels(board: Esp32PanelBoard): Esp32Panel[] {
  return esp32Panels.filter((panel) => esp32PanelRefusal(board, panel.device) === null);
}
