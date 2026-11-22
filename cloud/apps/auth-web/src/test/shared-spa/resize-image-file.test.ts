import { describe, expect, it } from "vitest";
import {
  isResizableImage,
  planUploadResize,
  uploadResizeFileName,
  uploadResizeOutputFormat,
} from "../../../../../../frontend/src/utils/resizeImageFile";

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
