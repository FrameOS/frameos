import { describe, expect, it } from "vitest";
import {
  cachedAssetContentType,
  isServableImageContentType,
  normalizeAssetPath,
  sceneSnapshotAssetPath,
} from "./frame-asset-cache";
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

  it("refuses NUL and other control characters anywhere in the path", () => {
    expect(normalizeAssetPath("photos/cat.jpg\u0000.png")).toBeUndefined();
    expect(normalizeAssetPath("photos/\ncat.jpg")).toBeUndefined();
    expect(normalizeAssetPath("photos/cat\u007f.jpg")).toBeUndefined();
    expect(normalizeAssetPath("photos/\u001b[31mcat.jpg")).toBeUndefined();
    // Non-ASCII text is fine; only the control range is out.
    expect(normalizeAssetPath("photos/kass\u00e4.jpg")).toBe("photos/kass\u00e4.jpg");
  });
});

// The device's own content_type claim is never stored: a frame (or the scene
// code on it) must not be able to choose what the app origin serves. Only a
// sniffed raster type survives; everything else is opaque bytes.
describe("cachedAssetContentType", () => {
  const pad = (head: Buffer) => Buffer.concat([head, Buffer.alloc(16)]);

  it("keeps the raster formats a browser can only treat as images", () => {
    expect(cachedAssetContentType(pad(Buffer.from("\x89PNG\r\n\x1a\n", "latin1")))).toBe("image/png");
    expect(cachedAssetContentType(pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0])))).toBe("image/jpeg");
    expect(cachedAssetContentType(pad(Buffer.from("GIF89a", "latin1")))).toBe("image/gif");
    expect(
      cachedAssetContentType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1")),
    ).toBe("image/webp");
    // The ESP32 answers image_get straight from its framebuffer as BMP.
    expect(cachedAssetContentType(pad(Buffer.from("BM", "latin1")))).toBe("image/bmp");
  });

  it("stores anything else — HTML, SVG, fonts, JSON — as opaque bytes", () => {
    for (const body of [
      "<!doctype html><script>alert(1)</script>",
      '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
      '{"a":1}',
      "OTTO\0\0\0\0\0\0\0\0\0",
      "",
    ]) {
      expect(cachedAssetContentType(Buffer.from(body, "latin1"))).toBe(
        "application/octet-stream",
      );
    }
  });

  it("only serves the sniffed types with a rendering content type", () => {
    expect(isServableImageContentType("image/png")).toBe(true);
    expect(isServableImageContentType("image/bmp")).toBe(true);
    expect(isServableImageContentType("image/svg+xml")).toBe(false);
    expect(isServableImageContentType("text/html")).toBe(false);
    expect(isServableImageContentType("application/octet-stream")).toBe(false);
  });
});
