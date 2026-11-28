import { describe, expect, it } from "vitest";
import { parseTones } from "frameos-wasm";

// A scene's frameos.tone() in the browser preview (docs/tones.md): the notes
// as the runtime wrote them (tones.nim normalizeTones), "hz:ms,..." with 0 Hz
// a rest, which the page plays with Web Audio (frameos/wasm/src/tones.ts).

describe("a scene's tone in the preview", () => {
  it("reads the runtime's notes, rests included", () => {
    expect(parseTones("2093:120,0:40,2637:120")).toEqual([
      [2093, 120],
      [0, 40],
      [2637, 120],
    ]);
  });

  it("leaves out what is no note", () => {
    expect(parseTones("880:200,loud,:5,440:")).toEqual([[880, 200]]);
    expect(parseTones("")).toEqual([]);
  });
});
