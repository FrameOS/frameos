import { describe, expect, it } from "vitest";
import { normalizeAssetPath, sceneSnapshotAssetPath } from "./frame-asset-cache";
import { hiddenWritePath, sanitizedUploadFilename } from "./frame-asset-write";

// These mirror device-side Nim code byte for byte — sceneImageFilename in
// frameos/src/frameos/scenes.nim and sanitizeAssetComponent in
// admin_api_assets_routes.nim. A drift here means thumbnails silently 404
// (wrong snapshot path) or upload responses name a file that does not exist.

describe("sceneSnapshotAssetPath", () => {
  it("builds the runner's snapshot path for a plain runtime id", () => {
    // md5("abc") — the device hashes the PUBLIC id (uploaded/ prefix stripped).
    expect(sceneSnapshotAssetPath("abc")).toBe(
      ".frameos/scene_images/abc-900150983cd24fb0d6963f7d28e17f72.png",
    );
  });

  it("strips the uploaded/ prefix like sceneImagePublicId does", () => {
    expect(sceneSnapshotAssetPath("uploaded/abc")).toBe(
      sceneSnapshotAssetPath("abc"),
    );
  });

  it("replaces unsafe characters, strips edge punctuation, caps at 64", () => {
    const path = sceneSnapshotAssetPath("../../etc");
    // '/' becomes '_', then leading '.'/'_' are stripped: a single flat
    // filename component, never a traversal.
    expect(path.startsWith(".frameos/scene_images/etc-")).toBe(true);
    expect(path.split("/").length).toBe(3);

    const long = "x".repeat(100);
    const longPath = sceneSnapshotAssetPath(long);
    const filename = longPath.split("/").pop()!;
    expect(filename.startsWith("x".repeat(64) + "-")).toBe(true);
    expect(filename).not.toContain("x".repeat(65));
  });

  it("falls back to 'scene' when nothing survives sanitizing", () => {
    expect(sceneSnapshotAssetPath("///").split("/").pop()!.startsWith("scene-")).toBe(
      true,
    );
  });
});

describe("sanitizedUploadFilename", () => {
  it("mirrors the device's component sanitizer", () => {
    expect(sanitizedUploadFilename("My Photo (1).jpg")).toBe("My_Photo__1_.jpg");
    expect(sanitizedUploadFilename("nested/dir/cat.png")).toBe("cat.png");
    expect(sanitizedUploadFilename("...")).toBe("uploaded_file");
    expect(sanitizedUploadFilename("")).toBe("uploaded_file");
    // '-' survives edge stripping (the device only strips '_' and '.').
    expect(sanitizedUploadFilename("-dash.bin")).toBe("-dash.bin");
  });
});

describe("hiddenWritePath", () => {
  it("refuses any dot-component, allows plain paths", () => {
    expect(hiddenWritePath(".frameos/scene_images/x.png")).toBe(true);
    expect(hiddenWritePath("photos/.thumbs/x.jpg")).toBe(true);
    expect(hiddenWritePath("photos/cat.jpg")).toBe(false);
    expect(hiddenWritePath("dot.folder/file")).toBe(false);
  });
});

describe("normalizeAssetPath", () => {
  it("strips ./ and leading slashes, refuses traversal and empties", () => {
    expect(normalizeAssetPath("./photos/cat.jpg")).toBe("photos/cat.jpg");
    expect(normalizeAssetPath("/photos/cat.jpg")).toBe("photos/cat.jpg");
    expect(normalizeAssetPath("photos/../secret")).toBeUndefined();
    expect(normalizeAssetPath("  ")).toBeUndefined();
  });
});
