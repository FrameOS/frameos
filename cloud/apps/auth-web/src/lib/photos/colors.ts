// A photo's color profile (docs/photos.md "Colors", POST /api/photos/colors):
// the object a frame asset's `.frameos.json` sidecar holds under "colors".
// The cloud stores it as sent: the keys are the editor's business, and the
// runtime clamps every value and ignores keys it does not know. All that is
// checked here is the shape and the size.

// "At most 64 KB as JSON": the same cap the backend puts on a sidecar.
export const maxPhotoColorsBytes = 64 * 1024;

export type PhotoColors = Record<string, unknown>;

export type ParsedPhotoColors =
  | { colors: PhotoColors | null; error?: undefined; status?: undefined }
  | { colors?: undefined; error: "invalid_colors" | "colors_too_large"; status: 400 | 413 };

/**
 * The profile to store, from a request body's `colors`: `null` (and an empty
 * object) removes it, any other JSON object is kept as it is. Anything else
 * is a 400; an object over 64 KB as JSON is a 413.
 */
export function parsePhotoColors(value: unknown): ParsedPhotoColors {
  if (value === null) {
    return { colors: null };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    // `undefined` (no key at all) lands here too: removing takes an explicit null.
    return { error: "invalid_colors", status: 400 };
  }
  const colors = value as PhotoColors;
  if (Object.keys(colors).length === 0) {
    return { colors: null };
  }
  if (Buffer.byteLength(JSON.stringify(colors), "utf8") > maxPhotoColorsBytes) {
    return { error: "colors_too_large", status: 413 };
  }
  return { colors };
}
