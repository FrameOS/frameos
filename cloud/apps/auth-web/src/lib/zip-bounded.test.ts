import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { unzipBounded, ZipBoundsError } from "./zip-bounded";

function zip(files: Record<string, Uint8Array>, level: 0 | 6 = 6) {
  return zipSync(files, { level });
}

// Overwrite the central directory's declared uncompressed size of the
// first entry — the number unzipSync sizes its output buffer by.
function understateDeclaredSize(data: Uint8Array, declared: number) {
  const patched = data.slice();
  let end = patched.length - 22;
  while (
    !(patched[end] === 0x50 && patched[end + 1] === 0x4b && patched[end + 2] === 0x05 && patched[end + 3] === 0x06)
  ) {
    end -= 1;
  }
  const directory =
    patched[end + 16]! | (patched[end + 17]! << 8) | (patched[end + 18]! << 16) | (patched[end + 19]! << 24);
  patched[directory + 24] = declared & 0xff;
  patched[directory + 25] = (declared >>> 8) & 0xff;
  patched[directory + 26] = (declared >>> 16) & 0xff;
  patched[directory + 27] = (declared >>> 24) & 0xff;
  return patched;
}

describe("unzipBounded", () => {
  it("returns the selected entries and skips the rest", () => {
    const data = zip({
      "Scene/image.jpg": new Uint8Array([0xff, 0xd8, 0xff]),
      "Scene/scenes.json": strToU8("[1,2,3]"),
      "Scene/template.json": strToU8('{"name":"x"}'),
    });
    const files = unzipBounded(data, (name) => name.endsWith(".json"));
    expect(Object.keys(files).sort()).toEqual(["Scene/scenes.json", "Scene/template.json"]);
    expect(Buffer.from(files["Scene/scenes.json"]!).toString()).toBe("[1,2,3]");
    expect(files).toEqual(
      Object.fromEntries(
        Object.entries(unzipSync(data, { filter: (file) => file.name.endsWith(".json") })),
      ),
    );
  });

  it("reads stored (uncompressed) entries too", () => {
    const data = zip({ "a.txt": strToU8("hello") }, 0);
    expect(Buffer.from(unzipBounded(data, () => true)["a.txt"]!).toString()).toBe("hello");
  });

  it("stops on the declared sizes before inflating anything", () => {
    const data = zip({ "big.bin": new Uint8Array(1024) });
    expect(() => unzipBounded(data, () => true, { maxUncompressedBytes: 512 })).toThrow(
      ZipBoundsError,
    );
    expect(() => unzipBounded(data, () => false, { maxUncompressedBytes: 512 })).toThrow(
      ZipBoundsError,
    );
  });

  it("stops on the bytes actually inflated when the header understates them", () => {
    // 4 MB of zeros deflates to a few KB; the header then claims 100 bytes,
    // which passes every declared-size check.
    const data = understateDeclaredSize(zip({ "bomb.bin": new Uint8Array(4 * 1024 * 1024) }), 100);
    expect(unzipSync(data)["bomb.bin"]!.length).toBe(100); // what the header says
    expect(() => unzipBounded(data, () => true, { maxUncompressedBytes: 1024 * 1024 })).toThrow(
      ZipBoundsError,
    );
    // Under a ceiling that fits it, the real content comes out in full.
    expect(unzipBounded(data, () => true)["bomb.bin"]!.length).toBe(4 * 1024 * 1024);
  });

  it("counts entries against the cap", () => {
    const files: Record<string, Uint8Array> = {};
    for (let index = 0; index < 5; index += 1) {
      files[`f${index}`] = strToU8("x");
    }
    expect(() => unzipBounded(zip(files), () => false, { maxEntries: 4 })).toThrow(ZipBoundsError);
    expect(Object.keys(unzipBounded(zip(files), () => true, { maxEntries: 5 }))).toHaveLength(5);
  });

  it("refuses bytes that are not a zip", () => {
    expect(() => unzipBounded(strToU8("not a zip at all, definitely not"), () => true)).toThrow(
      /invalid_zip/,
    );
  });
});
