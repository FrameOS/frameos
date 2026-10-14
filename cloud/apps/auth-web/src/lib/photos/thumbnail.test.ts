import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { makePhotoThumbnail } from "./thumbnail";

// Left half transparent, right half red.
function halfTransparent(width: number, height: number) {
  return sharp({ create: { background: { alpha: 0, b: 0, g: 0, r: 0 }, channels: 4, height, width } })
    .composite([
      {
        input: { create: { background: "#ff0000", channels: 4, height, width: width / 2 } },
        left: width / 2,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
}

async function pixel(jpeg: Buffer, x: number, y: number) {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return [...data.subarray(at, at + 3)];
}

function near(actual: number[], expected: number[]) {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => Math.abs(value - (expected[index] ?? NaN)) <= 8)
  );
}

describe("makePhotoThumbnail", () => {
  it("fits a photo in 512 px and puts transparency on white", async () => {
    const thumb = await makePhotoThumbnail(await halfTransparent(1200, 800));
    expect(thumb).not.toBeNull();
    const meta = await sharp(thumb!).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 512, 341]);
    expect(near(await pixel(thumb!, 20, 170), [255, 255, 255])).toBe(true);
    expect(near(await pixel(thumb!, 490, 170), [255, 0, 0])).toBe(true);
  });

  it("turns a photo by its EXIF orientation, the way browsers show it", async () => {
    // Stored 600x400, shown a quarter turn clockwise: 400x600.
    const turned = await sharp({ create: { background: "#3366cc", channels: 3, height: 400, width: 600 } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(turned).metadata()).orientation).toBe(6);
    const meta = await sharp((await makePhotoThumbnail(turned))!).metadata();
    expect([meta.width, meta.height, meta.orientation]).toEqual([341, 512, undefined]);
  });

  it("never enlarges a small photo", async () => {
    const small = await sharp({ create: { background: "#00ff00", channels: 3, height: 50, width: 100 } })
      .webp()
      .toBuffer();
    const meta = await sharp((await makePhotoThumbnail(small))!).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 100, 50]);
  });

  it("reads GIFs", async () => {
    const gif = await sharp({ create: { background: "#0000ff", channels: 3, height: 600, width: 1024 } })
      .gif()
      .toBuffer();
    const meta = await sharp((await makePhotoThumbnail(gif))!).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 512, 300]);
  });

  it("answers null for bytes it cannot read", async () => {
    expect(await makePhotoThumbnail(Buffer.from("not an image"))).toBeNull();
    const headerOnly = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
      Buffer.from("IHDR", "latin1"),
      Buffer.from([0, 0, 15, 160, 0, 0, 11, 184, 8, 6, 0, 0, 0]),
    ]);
    expect(await makePhotoThumbnail(headerOnly)).toBeNull();
  });
});
