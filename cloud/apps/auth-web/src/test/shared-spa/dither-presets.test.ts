import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BUILTIN_DITHER_PRESETS,
  changedSettingsCount,
  compactDither,
  matchingPresetId,
  normalizeFrameDither,
} from "../../../../../../frontend/src/utils/ditherPresets";
import { normalizeDither } from "../../lib/panel-dither";

// The Dithering section's presets and fine tuning
// (frontend/src/utils/ditherPresets.ts, docs/dithering.md).

const corpus = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../../../docs/dither-fixtures.json", import.meta.url)), "utf8"),
) as { cases: { dither: Record<string, unknown> }[] };

describe("dithering presets in the settings screen", () => {
  it("normalizes like both planes' packers", () => {
    for (const { dither } of corpus.cases) {
      expect(normalizeFrameDither(dither as never)).toEqual(dither);
    }
    for (const value of [null, { method: "floydSteinberg" }, { method: "opendisplay", saturation: 9, ppi: 10, tone: -2 }]) {
      expect(normalizeFrameDither(value as never)).toEqual(normalizeDither(value));
    }
  });

  it("offers only valid built-in presets, each matched back to itself", () => {
    for (const preset of BUILTIN_DITHER_PRESETS) {
      expect(matchingPresetId(preset.dither, [])).toBe(preset.id);
    }
    expect(matchingPresetId(undefined, [])).toBe("builtin:floydSteinberg");
    expect(matchingPresetId({ method: "opendisplay", exposure: 1 }, [])).toBe("builtin:opendisplay");
  });

  it("recognises the owner's presets by what they dither, and custom settings as none", () => {
    const own = [{ id: "p1", name: "Mine", dither: { method: "opendisplay" as const, saturation: 1.2 } }];
    expect(matchingPresetId({ method: "opendisplay", saturation: 1.2, ppi: null }, own)).toBe("p1");
    expect(matchingPresetId({ method: "opendisplay", saturation: 1.25 }, own)).toBeNull();
  });

  it("saves only what differs from plain OpenDisplay, and counts it", () => {
    const tuned = { method: "opendisplay" as const, exposure: 1.3, dbs: true, viewingDistanceCm: 30, gamut: 0, ppi: null };
    expect(compactDither(tuned)).toEqual({ method: "opendisplay", exposure: 1.3, dbs: true });
    expect(changedSettingsCount(tuned)).toBe(2);
    expect(changedSettingsCount({ method: "opendisplay", viewingDistanceCm: 80 })).toBe(0);
    expect(changedSettingsCount({ method: "opendisplay", dbs: true, viewingDistanceCm: 80 })).toBe(2);
    expect(compactDither(null)).toBeNull();
  });
});
