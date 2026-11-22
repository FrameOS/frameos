import { describe, expect, it } from "vitest";
import {
  isResizableImage,
  planUploadResize,
  uploadResizeFileName,
  uploadResizeOutputFormat,
} from "../../../../../../frontend/src/utils/resizeImageFile";
import {
  crc32,
  exifWithUprightOrientation,
  readExif,
  writeExif,
} from "../../../../../../frontend/src/utils/imageExif";

// "Resize and upload" on Photos and a frame's Files: the size is a longer and
// a shorter edge, turned to suit each photo, and a photo that needs no change
// goes up untouched (planUploadResize returns null).

const box = { longEdge: 800, shortEdge: 480, upscale: false };

describe("planUploadResize", () => {
  it("fits a landscape photo within the box", () => {
    expect(planUploadResize(4000, 3000, { ...box, fit: "inside" })).toEqual({
      canvasWidth: 640,
      canvasHeight: 480,
      x: 0,
      y: 0,
      width: 640,
      height: 480,
    });
  });

  it("turns the box for a portrait photo", () => {
    expect(planUploadResize(3000, 4000, { ...box, fit: "inside" })).toMatchObject({
      canvasWidth: 480,
      canvasHeight: 640,
    });
    expect(planUploadResize(3000, 4000, { ...box, fit: "cover" })).toMatchObject({
      canvasWidth: 480,
      canvasHeight: 800,
    });
  });

  it("limits the longer edge alone when there is no shorter one", () => {
    expect(planUploadResize(4000, 1000, { longEdge: 1000, shortEdge: null, upscale: false, fit: "inside" })).toMatchObject({
      canvasWidth: 1000,
      canvasHeight: 250,
    });
    expect(planUploadResize(4000, 1000, { longEdge: 1000, shortEdge: null, upscale: false, fit: "cover" })).toBeNull();
  });

  it("crops to fill the box, centered", () => {
    const plan = planUploadResize(4000, 2000, { ...box, fit: "cover" })!;
    expect(plan.canvasWidth).toBe(800);
    expect(plan.canvasHeight).toBe(480);
    expect(plan.height).toBe(480);
    expect(plan.width).toBe(960);
    expect(plan.x).toBe(-80);
    expect(plan.y).toBe(0);
  });

  it("pads to the whole box", () => {
    const plan = planUploadResize(4000, 4000, { ...box, fit: "contain" })!;
    expect(plan).toEqual({ canvasWidth: 800, canvasHeight: 480, x: 160, y: 0, width: 480, height: 480 });
  });

  it("stretches to the box", () => {
    expect(planUploadResize(1000, 1000, { ...box, fit: "fill" })).toEqual({
      canvasWidth: 800,
      canvasHeight: 480,
      x: 0,
      y: 0,
      width: 800,
      height: 480,
    });
  });

  it("leaves a photo that already fits alone, unless asked to enlarge it", () => {
    expect(planUploadResize(640, 400, { ...box, fit: "inside" })).toBeNull();
    expect(planUploadResize(640, 400, { ...box, fit: "cover" })).toBeNull();
    expect(planUploadResize(640, 400, { ...box, fit: "fill" })).toBeNull();
    expect(planUploadResize(640, 400, { ...box, upscale: true, fit: "inside" })).toMatchObject({
      canvasWidth: 768,
      canvasHeight: 480,
    });
  });

  it("crops a photo only as far as it reaches when not enlarging", () => {
    // Wider than the box but not as tall: cropped to 800 wide, its 400 rows kept.
    expect(planUploadResize(1000, 400, { ...box, fit: "cover" })).toMatchObject({
      canvasWidth: 800,
      canvasHeight: 400,
      width: 1000,
      height: 400,
      x: -100,
    });
  });
});

describe("output format and name", () => {
  it("keeps what a browser can write and makes JPEG of the rest", () => {
    expect(uploadResizeOutputFormat("image/png", "keep")).toBe("png");
    expect(uploadResizeOutputFormat("image/webp", "keep")).toBe("webp");
    expect(uploadResizeOutputFormat("image/heic", "keep")).toBe("jpeg");
    expect(uploadResizeOutputFormat("image/png", "jpeg")).toBe("jpeg");
  });

  it("gives the file the extension of what it became", () => {
    expect(uploadResizeFileName("cat.JPG", "jpeg")).toBe("cat.JPG");
    expect(uploadResizeFileName("cat.jpeg", "jpeg")).toBe("cat.jpeg");
    expect(uploadResizeFileName("cat.heic", "jpeg")).toBe("cat.jpg");
    expect(uploadResizeFileName("cat.png", "webp")).toBe("cat.webp");
    expect(uploadResizeFileName("cat", "png")).toBe("cat.png");
  });

  it("resizes pictures, not vectors or other files", () => {
    expect(isResizableImage(new File([], "a.jpg", { type: "image/jpeg" }))).toBe(true);
    expect(isResizableImage(new File([], "a.svg", { type: "image/svg+xml" }))).toBe(false);
    expect(isResizableImage(new File([], "a.ttf", { type: "font/ttf" }))).toBe(false);
  });
});

// "Keep metadata, location included": the EXIF block read from the original
// and written into the copy the canvas encoded, its Orientation made 1.
describe("EXIF carried into the copy", () => {
  // A little-endian TIFF with one IFD0 entry: Orientation (SHORT) = 6.
  const tiff = new Uint8Array([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00,
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
  const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));
  const jfif = [0xff, 0xe0, 0x00, 0x10, ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const jpeg = (...segments: number[][]) =>
    new Uint8Array([0xff, 0xd8, ...segments.flat(), 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
  const app1 = (block: Uint8Array) => {
    const length = 2 + 6 + block.length;
    return [0xff, 0xe1, length >> 8, length & 0xff, ...ascii("Exif"), 0, 0, ...block];
  };

  it("reads a JPEG's block", () => {
    expect(readExif(jpeg(jfif, app1(tiff)))).toEqual(tiff);
    expect(readExif(jpeg(jfif))).toBeNull();
  });

  it("writes it into a JPEG after the JFIF segment", () => {
    const written = writeExif(jpeg(jfif), tiff, 10, 10);
    expect(Array.from(written.slice(2, 2 + jfif.length))).toEqual(jfif);
    expect(written[2 + jfif.length + 1]).toBe(0xe1);
    expect(readExif(written)).toEqual(tiff);
  });

  it("sets the orientation upright, leaving the original as it was", () => {
    const upright = exifWithUprightOrientation(tiff);
    expect(upright[18]).toBe(1);
    expect(tiff[18]).toBe(6);
  });

  it("writes and reads a PNG's eXIf chunk", () => {
    expect(crc32(new Uint8Array(ascii("IEND")))).toBe(0xae426082);
    const ihdr = [0, 0, 0, 13, ...ascii("IHDR"), 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89];
    const iend = [0, 0, 0, 0, ...ascii("IEND"), 0xae, 0x42, 0x60, 0x82];
    const png = new Uint8Array([0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, ...iend]);
    const written = writeExif(png, tiff, 1, 1);
    expect(String.fromCharCode(...written.slice(8 + 25 + 4, 8 + 25 + 8))).toBe("eXIf");
    expect(readExif(written)).toEqual(tiff);
  });

  it("gives a simple WebP the extended header and an EXIF chunk", () => {
    const vp8 = [...ascii("VP8 "), 4, 0, 0, 0, 1, 2, 3, 4];
    const body = [...ascii("WEBP"), ...vp8];
    const webp = new Uint8Array([...ascii("RIFF"), body.length, 0, 0, 0, ...body]);
    const written = writeExif(webp, tiff, 640, 480);
    const view = new DataView(written.buffer);
    expect(String.fromCharCode(...written.slice(12, 16))).toBe("VP8X");
    expect((written[20] ?? 0) & 0x08).toBe(0x08);
    expect(view.getUint16(24, true) | ((written[26] ?? 0) << 16)).toBe(639);
    expect(view.getUint16(27, true) | ((written[29] ?? 0) << 16)).toBe(479);
    expect(view.getUint32(4, true)).toBe(written.length - 8);
    expect(readExif(written)).toEqual(tiff);
  });
});
