// Weather glyphs as SVG path data in a 64x64 box. Paths are strings, not
// objects: a string costs its own bytes in the JS heap, a parsed object
// ten to twenty times that. `canvas.fillPath` takes them as they are.

export const SUN = "M32 14a18 18 0 1 0 0 36 18 18 0 1 0 0-36zm-2-14h4v9h-4zm0 55h4v9h-4zM0 30h9v4H0zm55 0h9v4h-9zM8.9 6.1l2.8-2.8 6.4 6.4-2.8 2.8zm37 37l2.8-2.8 6.4 6.4-2.8 2.8zM6.1 55.1l6.4-6.4 2.8 2.8-6.4 6.4zm37-37l6.4-6.4 2.8 2.8-6.4 6.4z";
export const CLOUD = "M18 52a12 12 0 0 1-1.5-23.9A16 16 0 0 1 47 24a10 10 0 0 1 1 20H18z";
export const RAIN = CLOUD + " M20 56l-4 8h4l4-8zm12 0l-4 8h4l4-8zm12 0l-4 8h4l4-8z";
export const SNOW = CLOUD + " M22 56h4v8h-4zm10 0h4v8h-4zm10 0h4v8h-4z";
export const FOG = "M8 30h48v4H8zm0 10h48v4H8zm0 10h48v4H8zm6-30h36v4H14z";
export const STORM = CLOUD + " M30 46l-6 10h6l-2 8 8-12h-6l2-6z";

// Open-Meteo WMO weather codes → glyph and a short label.
export function describe(code: number): { path: string; label: string } {
  if (code === 0) return { path: SUN, label: "Clear" };
  if (code <= 2) return { path: CLOUD, label: "Partly cloudy" };
  if (code === 3) return { path: CLOUD, label: "Overcast" };
  if (code <= 48) return { path: FOG, label: "Fog" };
  if (code <= 67) return { path: RAIN, label: "Rain" };
  if (code <= 77) return { path: SNOW, label: "Snow" };
  if (code <= 82) return { path: RAIN, label: "Showers" };
  if (code <= 86) return { path: SNOW, label: "Snow showers" };
  return { path: STORM, label: "Thunderstorm" };
}
