import type { PanelPaletteKey } from "frameos-wasm";

// The live preview's Device menu: a frame people actually build, its panel's
// size and the inks it shows. Picking one resizes the preview and dithers it
// to that panel (a screen shows full colour), so a scene can be checked on
// the hardware it will meet in a couple of clicks. Sizes are the panel's
// native ones (the board tables in embedded/esp32/README.md and the drivers);
// the preview keeps the orientation it is in, and Rotate turns it.
export type PreviewDevice = {
  key: string;
  label: string;
  group: "E-paper" | "Screens";
  width: number;
  height: number;
  /** The dither palette its panel shows; null for a full-colour screen. */
  panel: PanelPaletteKey | null;
};

export const previewDevices: PreviewDevice[] = [
  { group: "E-paper", height: 480, key: "reterminal-e1001", label: 'Seeed reTerminal E1001, 7.5" black and white', panel: "blackWhite", width: 800 },
  { group: "E-paper", height: 480, key: "reterminal-e1002", label: 'Seeed reTerminal E1002, 7.3" Spectra 6', panel: "spectra6", width: 800 },
  { group: "E-paper", height: 1404, key: "reterminal-e1003", label: 'Seeed reTerminal E1003, 10.3" 16 greys', panel: "sixteenGray", width: 1872 },
  { group: "E-paper", height: 1200, key: "reterminal-e1004", label: 'Seeed reTerminal E1004, 13.3" Spectra 6', panel: "spectra6", width: 1600 },
  { group: "E-paper", height: 480, key: "reterminal-sticky", label: 'Seeed reTerminal Sticky, 3.97" 4 greys', panel: "fourGray", width: 800 },
  { group: "E-paper", height: 480, key: "waveshare-photopainter", label: 'Waveshare PhotoPainter, 7.3" Spectra 6', panel: "spectra6", width: 800 },
  { group: "E-paper", height: 1200, key: "waveshare-13in3e6", label: 'Waveshare 13.3" Spectra 6', panel: "spectra6", width: 1600 },
  { group: "E-paper", height: 480, key: "waveshare-7in5", label: 'Waveshare 7.5" black and white', panel: "blackWhite", width: 800 },
  { group: "E-paper", height: 272, key: "crowpanel-5in79", label: 'Elecrow CrowPanel 5.79" 4 greys', panel: "fourGray", width: 792 },
  { group: "E-paper", height: 448, key: "inky-impression-5in7", label: 'Pimoroni Inky Impression 5.7" 7 colour', panel: "sevenColor", width: 600 },
  { group: "E-paper", height: 480, key: "inky-impression-7in3", label: 'Pimoroni Inky Impression 7.3" Spectra 6', panel: "spectra6", width: 800 },
  { group: "E-paper", height: 1200, key: "inky-impression-13in3", label: 'Pimoroni Inky Impression 13.3" Spectra 6', panel: "spectra6", width: 1600 },
  { group: "E-paper", height: 480, key: "inky-frame-7in3", label: 'Pimoroni Inky Frame 7.3" Spectra 6', panel: "spectra6", width: 800 },
  { group: "Screens", height: 480, key: "sensecap-indicator", label: 'Seeed SenseCAP Indicator, 4" LCD', panel: null, width: 480 },
  { group: "Screens", height: 480, key: "hyperpixel-4", label: "Pimoroni HyperPixel 4.0", panel: null, width: 800 },
  { group: "Screens", height: 480, key: "hyperpixel-2-round", label: "Pimoroni HyperPixel 2.1 Round", panel: null, width: 480 },
  { group: "Screens", height: 480, key: "pi-touch-display", label: 'Raspberry Pi Touch Display, 7"', panel: null, width: 800 },
  { group: "Screens", height: 1280, key: "pi-touch-display-2", label: 'Raspberry Pi Touch Display 2, 7"', panel: null, width: 720 },
  { group: "Screens", height: 1080, key: "screen-1080p", label: "TV or monitor, 1080p", panel: null, width: 1920 },
  { group: "Screens", height: 2160, key: "screen-4k", label: "TV or monitor, 4K", panel: null, width: 3840 },
];

export function previewDeviceFor(key: string | null | undefined): PreviewDevice | null {
  return previewDevices.find((device) => device.key === key) ?? null;
}

/** The device's size turned to the orientation the preview is in now (a
 * square panel has none). */
export function previewDeviceSize(
  device: PreviewDevice,
  current: { width: number; height: number },
): { width: number; height: number } {
  const portrait = current.height > current.width;
  const devicePortrait = device.height > device.width;
  if (device.width === device.height || portrait === devicePortrait) {
    return { height: device.height, width: device.width };
  }
  return { height: device.width, width: device.height };
}

/** Whether the preview is at the device's size, either way round. */
export function previewShowsDevice(
  device: PreviewDevice,
  viewport: { width: number; height: number },
): boolean {
  return (
    (viewport.width === device.width && viewport.height === device.height) ||
    (viewport.width === device.height && viewport.height === device.width)
  );
}
