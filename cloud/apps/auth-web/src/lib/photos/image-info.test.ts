import { describe, expect, it } from "vitest";
import { detectImageContentType } from "../store";
import { exifOrientation, imageDimensions } from "./image-info";

function u16be(value: number) {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u16le(value: number) {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u24le(value: number) {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
}

function u32le(value: number) {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}

function ascii(text: string) {
  return [...Buffer.from(text, "latin1")];
}

function exifSegment(orientation: number, byteOrder: "II" | "MM") {
  const u16 = byteOrder === "II" ? u16le : u16be;
  const u32 = (value: number) =>
    byteOrder === "II" ? u32le(value) : [...u32le(value)].reverse();
  const tiff = [
    ...ascii(byteOrder),
    ...u16(42),
    ...u32(8),
    // One IFD entry: Orientation (0x0112), SHORT (3), count 1, value.
    ...u16(1),
    ...u16(0x0112),
    ...u16(3),
    ...u32(1),
    ...u16(orientation),
    0,
    0,
    ...u32(0),
  ];
  const payload = [...ascii("Exif\0\0"), ...tiff];
  return [0xff, 0xe1, ...u16be(payload.length + 2), ...payload];
}

function jpeg(width: number, height: number, extra: number[] = []) {
  const app0 = [0xff, 0xe0, ...u16be(16), ...ascii("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, 0xc2, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Buffer.from([0xff, 0xd8, ...app0, ...extra, 0xff, 0xff, ...sof.slice(1), 0xff, 0xda]);
}

describe("imageDimensions", () => {
  it("reads a JPEG start-of-frame, skipping other segments and fill bytes", () => {
    const bytes = jpeg(4032, 3024);
    expect(detectImageContentType(bytes)).toBe("image/jpeg");
    expect(imageDimensions(bytes, "image/jpeg")).toEqual({ height: 3024, width: 4032 });
  });

  it("swaps a JPEG's sides when EXIF turns it a quarter, like a browser", () => {
    expect(imageDimensions(jpeg(4032, 3024, exifSegment(6, "MM")), "image/jpeg")).toEqual({
      height: 4032,
      width: 3024,
    });
    expect(imageDimensions(jpeg(4032, 3024, exifSegment(8, "II")), "image/jpeg")).toEqual({
      height: 4032,
      width: 3024,
    });
    // Upside down keeps the sides.
    expect(imageDimensions(jpeg(4032, 3024, exifSegment(3, "II")), "image/jpeg")).toEqual({
      height: 3024,
      width: 4032,
    });
  });

  it("reads the EXIF orientation in both byte orders", () => {
    expect(exifOrientation(Buffer.from(exifSegment(6, "II").slice(4)))).toBe(6);
    expect(exifOrientation(Buffer.from(exifSegment(5, "MM").slice(4)))).toBe(5);
    expect(exifOrientation(Buffer.from(ascii("Exif\0\0junk")))).toBeUndefined();
  });

  it("gives up on a JPEG with no frame header before the scan", () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0]);
    expect(imageDimensions(bytes, "image/jpeg")).toBeUndefined();
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg")).toBeUndefined();
  });

  it("reads PNG IHDR", () => {
    const bytes = Buffer.from([
      0x89,
      ...ascii("PNG\r\n\x1a\n"),
      0,
      0,
      0,
      13,
      ...ascii("IHDR"),
      0,
      0,
      0x07,
      0x80,
      0,
      0,
      0x04,
      0x38,
      8,
      6,
      0,
      0,
      0,
    ]);
    expect(detectImageContentType(bytes)).toBe("image/png");
    expect(imageDimensions(bytes, "image/png")).toEqual({ height: 1080, width: 1920 });
  });

  it("reads the GIF logical screen", () => {
    const bytes = Buffer.from([...ascii("GIF89a"), ...u16le(640), ...u16le(480), 0, 0, 0]);
    expect(detectImageContentType(bytes)).toBe("image/gif");
    expect(imageDimensions(bytes, "image/gif")).toEqual({ height: 480, width: 640 });
  });

  function riff(chunk: string, data: number[]) {
    const body = [...ascii("WEBP"), ...ascii(chunk), ...u32le(data.length), ...data];
    return Buffer.from([...ascii("RIFF"), ...u32le(body.length), ...body, 0, 0, 0, 0]);
  }

  it("reads WebP VP8X (extended)", () => {
    const bytes = riff("VP8X", [0x10, 0, 0, 0, ...u24le(5999), ...u24le(3999)]);
    expect(detectImageContentType(bytes)).toBe("image/webp");
    expect(imageDimensions(bytes, "image/webp")).toEqual({ height: 4000, width: 6000 });
  });

  it("reads WebP VP8L (lossless)", () => {
    const bits = (800 - 1) | ((600 - 1) << 14);
    const bytes = riff("VP8L", [0x2f, ...u32le(bits)]);
    expect(imageDimensions(bytes, "image/webp")).toEqual({ height: 600, width: 800 });
  });

  it("reads WebP VP8 (lossy), masking the scale bits", () => {
    const bytes = riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(1024 | 0xc000), ...u16le(768)]);
    expect(imageDimensions(bytes, "image/webp")).toEqual({ height: 768, width: 1024 });
  });

  it("answers undefined for anything it can not read", () => {
    expect(imageDimensions(Buffer.from("not an image"), "image/png")).toBeUndefined();
    expect(imageDimensions(Buffer.from("not an image"), "image/bmp")).toBeUndefined();
    expect(imageDimensions(Buffer.alloc(0), "image/webp")).toBeUndefined();
  });
});
