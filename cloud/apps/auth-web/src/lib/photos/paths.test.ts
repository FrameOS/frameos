import { describe, expect, it } from "vitest";
import {
  comparePhotoNames,
  comparePhotoPaths,
  isPlayablePhotoName,
  isReservedPhotoName,
  isSameOrBelow,
  isValidPhotoSegment,
  joinPhotoPath,
  parsePhotoPath,
  parsePhotoPathList,
  photoBasename,
  photoNameWithSuffix,
  photoParent,
  photoPathPrefixes,
  photoPathWithinLimits,
} from "./paths";

// docs/photos.md "Paths": the rules both control planes enforce.
describe("parsePhotoPath", () => {
  it("accepts plain relative paths and keeps them as they are", () => {
    expect(parsePhotoPath("Summer 2026/beach.jpg", { allowRoot: false })).toBe(
      "Summer 2026/beach.jpg",
    );
    expect(parsePhotoPath("Ålbum/über ☀️.jpg", { allowRoot: false })).toBe("Ålbum/über ☀️.jpg");
    // Case sensitive: nothing is folded.
    expect(parsePhotoPath("A/b", { allowRoot: false })).toBe("A/b");
  });

  it("allows the root only where asked", () => {
    expect(parsePhotoPath("", { allowRoot: true })).toBe("");
    expect(parsePhotoPath("", { allowRoot: false })).toBeUndefined();
  });

  it("refuses leading, trailing and doubled slashes", () => {
    for (const path of ["/a", "a/", "a//b", "/"]) {
      expect(parsePhotoPath(path, { allowRoot: true }), path).toBeUndefined();
    }
  });

  it("refuses dot segments, hidden names, separators and control characters", () => {
    for (const path of [
      ".",
      "..",
      "a/../b",
      "a/./b",
      ".DS_Store",
      "album/.hidden.jpg",
      "a\\b",
      "a\u0000b",
      "tab\there",
      "new\nline",
      "del\u007f",
    ]) {
      expect(parsePhotoPath(path, { allowRoot: true }), JSON.stringify(path)).toBeUndefined();
    }
  });

  it("keeps names ending in .frameos.json for color profiles, in any case", () => {
    for (const name of ["a.jpg.frameos.json", "x.frameos.json", "A.JPG.FrameOS.JSON", "Album.frameos.json"]) {
      expect(isReservedPhotoName(name), name).toBe(true);
      expect(isValidPhotoSegment(name), name).toBe(false);
      expect(parsePhotoPath(name, { allowRoot: false }), name).toBeUndefined();
      expect(parsePhotoPath(`Album/${name}`, { allowRoot: false }), name).toBeUndefined();
      expect(parsePhotoPath(`${name}/a.jpg`, { allowRoot: false }), name).toBeUndefined();
    }
    for (const name of ["frameos.json", "a.frameos.json.jpg", "a.frameos", "a.json", "a frameos.json"]) {
      expect(isReservedPhotoName(name), name).toBe(false);
      expect(isValidPhotoSegment(name), name).toBe(true);
    }
  });

  it("refuses non-strings and lone surrogates", () => {
    expect(parsePhotoPath(undefined, { allowRoot: true })).toBeUndefined();
    expect(parsePhotoPath(42, { allowRoot: true })).toBeUndefined();
    expect(parsePhotoPath("bad\ud800name", { allowRoot: true })).toBeUndefined();
  });

  it("caps a segment at 255 bytes of UTF-8, not characters", () => {
    expect(isValidPhotoSegment("a".repeat(255))).toBe(true);
    expect(isValidPhotoSegment("a".repeat(256))).toBe(false);
    // "é" is two bytes.
    expect(isValidPhotoSegment("é".repeat(127))).toBe(true);
    expect(isValidPhotoSegment("é".repeat(128))).toBe(false);
  });

  it("caps a path at 1024 bytes and 32 segments", () => {
    const deep = Array.from({ length: 32 }, () => "a").join("/");
    expect(parsePhotoPath(deep, { allowRoot: false })).toBe(deep);
    expect(parsePhotoPath(`${deep}/a`, { allowRoot: false })).toBeUndefined();
    const long = ["b".repeat(255), "b".repeat(255), "b".repeat(255), "b".repeat(254), "b"].join("/");
    expect(Buffer.byteLength(long)).toBe(1024);
    expect(parsePhotoPath(long, { allowRoot: false })).toBe(long);
    expect(photoPathWithinLimits(long)).toBe(true);
    expect(parsePhotoPath(`${long}b`, { allowRoot: false })).toBeUndefined();
    expect(photoPathWithinLimits(`${long}b`)).toBe(false);
    expect(photoPathWithinLimits("")).toBe(true);
  });
});

describe("parsePhotoPathList", () => {
  it("takes a non-empty list of valid non-root paths", () => {
    expect(parsePhotoPathList(["a", "b/c"])).toEqual(["a", "b/c"]);
    expect(parsePhotoPathList([])).toBeUndefined();
    expect(parsePhotoPathList(["a", ""])).toBeUndefined();
    expect(parsePhotoPathList(["a", "../b"])).toBeUndefined();
    expect(parsePhotoPathList("a")).toBeUndefined();
  });
});

describe("path helpers", () => {
  it("splits and joins", () => {
    expect(photoParent("a/b/c.jpg")).toBe("a/b");
    expect(photoParent("c.jpg")).toBe("");
    expect(photoBasename("a/b/c.jpg")).toBe("c.jpg");
    expect(joinPhotoPath("", "x")).toBe("x");
    expect(joinPhotoPath("a/b", "x")).toBe("a/b/x");
    expect(photoPathPrefixes("a/b/c")).toEqual(["a", "a/b", "a/b/c"]);
    expect(photoPathPrefixes("")).toEqual([]);
  });

  it("knows what is below what, without prefix accidents", () => {
    expect(isSameOrBelow("a/b", "a")).toBe(true);
    expect(isSameOrBelow("a", "a")).toBe(true);
    expect(isSameOrBelow("ab", "a")).toBe(false);
    expect(isSameOrBelow("anything", "")).toBe(true);
  });

  it("suffixes duplicates before the extension", () => {
    expect(photoNameWithSuffix("beach.jpg", 2)).toBe("beach (2).jpg");
    expect(photoNameWithSuffix("Summer 2026", 3)).toBe("Summer 2026 (3)");
    expect(photoNameWithSuffix("archive.tar.gz", 2)).toBe("archive.tar (2).gz");
  });

  it("keeps a suffixed name within 255 bytes", () => {
    const name = `${"é".repeat(125)}.jpg`;
    const suffixed = photoNameWithSuffix(name, 12);
    expect(Buffer.byteLength(suffixed)).toBeLessThanOrEqual(255);
    expect(suffixed.endsWith(" (12).jpg")).toBe(true);
    expect(isValidPhotoSegment(suffixed)).toBe(true);
  });

  it("knows which names a frame can play", () => {
    for (const name of ["a.jpg", "a.JPEG", "a.png", "a.gif", "a.bmp", "a.webp", "a.qoi", "a.ppm"]) {
      expect(isPlayablePhotoName(name), name).toBe(true);
    }
    for (const name of ["a.heic", "a.txt", "jpg", "a.jpg.zip"]) {
      expect(isPlayablePhotoName(name), name).toBe(false);
    }
  });
});

describe("natural, case-insensitive order", () => {
  it("compares numbers by value and ignores case", () => {
    const names = ["img 10.jpg", "IMG 2.jpg", "img 1.jpg", "Beach.jpg", "apple.jpg", "img 02.jpg"];
    expect([...names].sort(comparePhotoNames)).toEqual([
      "apple.jpg",
      "Beach.jpg",
      "img 1.jpg",
      "IMG 2.jpg",
      "img 02.jpg",
      "img 10.jpg",
    ]);
  });

  it("is a total order: names that differ only in case keep a fixed order", () => {
    expect(comparePhotoNames("a.jpg", "A.jpg")).not.toBe(0);
    expect(Math.sign(comparePhotoNames("a.jpg", "A.jpg"))).toBe(
      -Math.sign(comparePhotoNames("A.jpg", "a.jpg")),
    );
    expect(comparePhotoNames("same", "same")).toBe(0);
  });

  it("handles numbers longer than a double", () => {
    expect(comparePhotoNames("x99999999999999999999", "x100000000000000000000")).toBeLessThan(0);
  });

  it("orders paths one segment at a time, a folder before its contents", () => {
    const paths = ["b/1.jpg", "a 10/x.jpg", "a 2/x.jpg", "a 2", "a 2/sub/y.jpg"];
    expect([...paths].sort(comparePhotoPaths)).toEqual([
      "a 2",
      "a 2/sub/y.jpg",
      "a 2/x.jpg",
      "a 10/x.jpg",
      "b/1.jpg",
    ]);
  });
});
