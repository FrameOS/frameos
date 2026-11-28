// The frame's `dither` setting and the OpenDisplay packer path: the cloud's
// port of backend/app/utils/panel_dither.py (docs/dithering.md).
//
// A palette panel the cloud packs for (a thin client, a frame that renders on
// the server) is dithered with Floyd-Steinberg by default (panel-pack.ts). A
// frame can choose OpenDisplay epaper-dithering instead
// (https://github.com/OpenDisplay/epaper-dithering, MIT): ink matching in
// OKLab, serpentine error diffusion, linear-light exposure and an optional
// Direct Binary Search pass for a viewing distance. The npm package runs the
// same Rust core as the backend's Python wheel, so both planes pack the same
// bytes (docs/dither-fixtures.json, panel-dither.test.ts).
//
// The setting is the plane's own: it never reaches the device.

import { createRequire } from "node:module";

import type { PanelDitherer, PanelPaletteEntry } from "./panel-pack";

export const ditherMethods = ["floydSteinberg", "opendisplay"] as const;
export const ditherAlgorithms = [
  "burkes",
  "floyd_steinberg",
  "atkinson",
  "stucki",
  "sierra",
  "sierra_lite",
  "jarvis_judice_ninke",
  "ordered",
] as const;
export const defaultDitherAlgorithm = "burkes";
export const ditherExposureRange = [0.5, 2.0] as const;
export const ditherViewingDistanceRangeCm = [10, 500] as const;
export const defaultViewingDistanceCm = 30;
/** Pixel density when the panel's size is not known (a 7.3" 800x480 panel). */
export const defaultPanelPpi = 127;
/** Above this many pixels the DBS pass is skipped (about 4 s on a 13.3" panel). */
export const dbsMaxPixels = 2_000_000;
/** An owner's override of the density read from the panel's name. */
export const ditherPpiRange = [50, 600] as const;
/**
 * OpenDisplay's tone and colour steps, as panel_dither.py ADJUSTMENTS:
 * [low, high, default], each a no-op at its default.
 */
export const ditherAdjustments = {
  saturation: [0, 2, 1],
  shadows: [0, 1, 0],
  highlights: [0, 1, 0],
  tone: [0, 1, 0],
  gamut: [0, 1, 0],
} as const;
export type DitherAdjustment = keyof typeof ditherAdjustments;
const adjustmentKeys = Object.keys(ditherAdjustments) as DitherAdjustment[];
/** What a saved preset list may hold (the `ditherPresets` settings group). */
export const maxDitherPresets = 50;
export const maxDitherPresetName = 60;

export type DitherAlgorithm = (typeof ditherAlgorithms)[number];

/** The stored setting as the packer reads it (normalizeDither). */
export type NormalizedDither = {
  algorithm: DitherAlgorithm;
  dbs: boolean;
  exposure: number;
  method: "opendisplay";
  ppi: number | null;
  viewingDistanceCm: number;
} & Record<DitherAdjustment, number>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: unknown, low: number, high: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(high, Math.max(low, value));
}

/**
 * normalize_dither: null for the default (Floyd-Steinberg) or anything
 * unreadable, otherwise every field filled in and clamped. Also what the
 * render fingerprint names.
 */
export function normalizeDither(value: unknown): NormalizedDither | null {
  if (!isRecord(value) || value.method !== "opendisplay") return null;
  const algorithm = (ditherAlgorithms as readonly unknown[]).includes(value.algorithm)
    ? (value.algorithm as DitherAlgorithm)
    : defaultDitherAlgorithm;
  const normalized = {
    method: "opendisplay",
    algorithm,
    dbs: value.dbs === true,
    exposure: clamp(value.exposure, ditherExposureRange[0], ditherExposureRange[1], 1),
    viewingDistanceCm: clamp(
      value.viewingDistanceCm,
      ditherViewingDistanceRangeCm[0],
      ditherViewingDistanceRangeCm[1],
      defaultViewingDistanceCm,
    ),
  } as NormalizedDither;
  for (const key of adjustmentKeys) {
    const [low, high, fallback] = ditherAdjustments[key];
    normalized[key] = clamp(value[key], low, high, fallback);
  }
  normalized.ppi =
    value.ppi === null || value.ppi === undefined
      ? null
      : clamp(value.ppi, ditherPpiRange[0], ditherPpiRange[1], defaultPanelPpi);
  return normalized;
}

/** validate_dither: the reason a stored value is refused, or null when it is fine (null clears it). */
export function ditherProblem(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return "dither must be an object";
  const allowed = new Set(["method", "algorithm", "dbs", "exposure", "viewingDistanceCm", "ppi", ...adjustmentKeys]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) return `unknown dither keys: ${unknown.sort().join(", ")}`;
  if ("method" in value && !(ditherMethods as readonly unknown[]).includes(value.method)) {
    return `dither.method must be one of ${ditherMethods.join(", ")}`;
  }
  if ("algorithm" in value && !(ditherAlgorithms as readonly unknown[]).includes(value.algorithm)) {
    return `dither.algorithm must be one of ${ditherAlgorithms.join(", ")}`;
  }
  if ("dbs" in value && typeof value.dbs !== "boolean") return "dither.dbs must be true or false";
  const ranges: [string, readonly [number, number]][] = [
    ["exposure", ditherExposureRange],
    ["viewingDistanceCm", ditherViewingDistanceRangeCm],
    ["ppi", ditherPpiRange],
    ...adjustmentKeys.map((key): [string, readonly [number, number]] => [key, [ditherAdjustments[key][0], ditherAdjustments[key][1]]]),
  ];
  for (const [key, [low, high]] of ranges) {
    if (key === "ppi" && (value.ppi === null || value.ppi === undefined)) continue;
    if (key in value) {
      const number = value[key];
      if (typeof number !== "number" || !Number.isFinite(number) || number < low || number > high) {
        return `dither.${key} must be a number from ${low} to ${high}`;
      }
    }
  }
  return null;
}

export type DitherPreset = { dither: Record<string, unknown>; id: string; name: string };

/**
 * validate_dither_presets: the `ditherPresets` settings group, checked and
 * tidied (names trimmed), or the reason it is refused.
 */
export function readDitherPresets(
  value: unknown,
): { error: string; presets?: undefined } | { error?: undefined; presets: DitherPreset[] } {
  if (!Array.isArray(value)) return { error: "ditherPresets must be a list" };
  if (value.length > maxDitherPresets) return { error: `at most ${maxDitherPresets} dithering presets` };
  const presets: DitherPreset[] = [];
  const seen = new Set<string>();
  for (const preset of value) {
    if (!isRecord(preset) || Object.keys(preset).some((key) => !["id", "name", "dither"].includes(key))) {
      return { error: "a dithering preset is {id, name, dither}" };
    }
    const { id, name, dither } = preset;
    if (typeof id !== "string" || id.length === 0 || id.length > 64 || seen.has(id)) {
      return { error: "a dithering preset needs a unique id" };
    }
    if (typeof name !== "string" || name.trim().length === 0 || name.trim().length > maxDitherPresetName) {
      return { error: `a dithering preset needs a name of 1 to ${maxDitherPresetName} characters` };
    }
    if (dither === null || dither === undefined) return { error: "a dithering preset needs its dither settings" };
    const problem = ditherProblem(dither);
    if (problem) return { error: problem };
    seen.add(id);
    presets.push({ id, name: name.trim(), dither: { ...(dither as Record<string, unknown>) } });
  }
  return { presets };
}

/** panel_diagonal_inches: the diagonal a panel's name carries (`EPD_7in3e` = 7.3"). */
export function panelDiagonalInches(panel: string | null | undefined): number | null {
  if (!panel) return null;
  const name = panel.split(".").pop() ?? panel;
  const inches = /(\d+)in(\d)/.exec(name);
  if (inches) return Number(`${inches[1]}.${inches[2]}`);
  const impression = /impression_(\d+(?:\.\d+)?)/.exec(name);
  if (impression) return Number(impression[1]);
  return null;
}

/** panel_ppi: the panel's pixel density from its name, else defaultPanelPpi. */
export function panelPpi(panel: string | null | undefined, width: number, height: number): number {
  const diagonal = panelDiagonalInches(panel);
  if (!diagonal || width <= 0 || height <= 0) return defaultPanelPpi;
  return Math.hypot(width, height) / diagonal;
}

/** The OpenDisplay module's surface this file uses. */
type OpenDisplayModule = {
  Palette: { fromSrgb(colors: { name?: string; nominal?: string; rgb: { b: number; g: number; r: number } }[], measured?: boolean): unknown };
  ditherImage(
    image: { data: Uint8ClampedArray; height: number; width: number },
    palette: unknown,
    options?: Record<string, unknown>,
  ): { indices: Uint8Array };
};

/**
 * A PanelDitherer running OpenDisplay with `dither` at `ppi`. Self-contained
 * on purpose (no import, nothing from outside it): the render worker gets its
 * text (`openDisplayDithererSource`) and builds it beside panel-pack.ts's
 * packer, with the module the worker loads itself. Returns null (so the
 * packer falls back to Floyd-Steinberg) for an ink it cannot name or when
 * the call fails.
 */
export function createOpenDisplayDitherer(
  od: OpenDisplayModule,
  dither: NormalizedDither,
  ppi: number,
  dbsMaxPixels: number,
): PanelDitherer {
  const nominal: Record<string, string> = {
    black: "#000000",
    white: "#ffffff",
    yellow: "#ffff00",
    red: "#ff0000",
    blue: "#0000ff",
    green: "#00ff00",
    orange: "#ff8000",
  };
  return (rgba: Uint8Array, width: number, height: number, entries: readonly PanelPaletteEntry[]) => {
    if (entries.some((entry) => !entry.ink || !(entry.ink in nominal))) return null;
    try {
      const palette = od.Palette.fromSrgb(
        entries.map((entry) => ({
          rgb: { r: entry.color[0], g: entry.color[1], b: entry.color[2] },
          name: entry.ink as string,
          // Every ink was checked against `nominal` above.
          nominal: nominal[entry.ink as string] as string,
        })),
        true,
      );
      const useDbs = dither.dbs && width * height <= dbsMaxPixels;
      const density = dither.ppi || ppi;
      const result = od.ditherImage(
        { width, height, data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength) },
        palette,
        {
          mode: dither.algorithm,
          exposure: dither.exposure,
          saturation: dither.saturation,
          shadows: dither.shadows,
          highlights: dither.highlights,
          tone: dither.tone,
          gamut: dither.gamut,
          dbs: useDbs ? { viewingDistanceCm: dither.viewingDistanceCm, ppi: density } : false,
        },
      );
      return result.indices;
    } catch {
      return null;
    }
  };
}

/** `createOpenDisplayDitherer`'s text: what the render worker builds its ditherer from. */
export const openDisplayDithererSource: string = String(createOpenDisplayDitherer);

let resolvedModulePath: string | null | undefined;

/** Where the worker `require`s the package from; null when it is not installed. */
export function openDisplayModulePath(): string | null {
  if (resolvedModulePath === undefined) {
    try {
      resolvedModulePath = createRequire(import.meta.url).resolve("@opendisplay/epaper-dithering");
    } catch {
      resolvedModulePath = null;
    }
  }
  return resolvedModulePath;
}

/** The ditherer on this thread (tests, the main thread's fallback); null without the package. */
export function openDisplayDitherer(dither: NormalizedDither | null, ppi: number): PanelDitherer | null {
  if (!dither) return null;
  const path = openDisplayModulePath();
  if (!path) return null;
  try {
    const od = createRequire(import.meta.url)(path) as OpenDisplayModule;
    return createOpenDisplayDitherer(od, dither, ppi, dbsMaxPixels);
  } catch {
    return null;
  }
}
