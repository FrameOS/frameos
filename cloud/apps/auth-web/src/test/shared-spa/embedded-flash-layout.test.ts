import { describe, expect, it } from "vitest";
import {
  detectFlashSize,
  layoutMatchedPlatform,
  releaseChipMismatch,
} from "../../../../../../frontend/src/scenes/workspace/embeddedFlashImage";

// The self-hosted release flasher picks its image from the flash size esptool
// reads off the chip, not from the frame record (a 4 MB C3 on a frame left at
// the 8 MB default got the esp32-c3-8mb image and boot-looped, 2026-09-05).
const assets = [
  { name: "a", platform: "esp32-s3-generic", size: 1 },
  { name: "b", platform: "esp32-s3-16mb", size: 1 },
  { name: "c", platform: "esp32-c3-generic", size: 1 },
  { name: "d", platform: "esp32-c3-8mb", size: 1 },
];

describe("layoutMatchedPlatform", () => {
  it("maps the detected size to the published layout, generic for the generic size", () => {
    expect(layoutMatchedPlatform("esp32-c3-generic", "4MB", assets)).toBe("esp32-c3-generic");
    expect(layoutMatchedPlatform("esp32-c3-generic", "8MB", assets)).toBe("esp32-c3-8mb");
    expect(layoutMatchedPlatform("esp32-s3-generic", "8MB", assets)).toBe("esp32-s3-generic");
    expect(layoutMatchedPlatform("esp32-s3-generic", "16MB", assets)).toBe("esp32-s3-16mb");
  });

  it("falls back to the generic image for an unknown size or a release without the match", () => {
    expect(layoutMatchedPlatform("esp32-s3-generic", null, assets)).toBe("esp32-s3-generic");
    expect(layoutMatchedPlatform("esp32-s3-generic", "2MB", assets)).toBe("esp32-s3-generic");
    expect(layoutMatchedPlatform("esp32-s3-generic", "32MB", assets)).toBe("esp32-s3-generic");
    expect(layoutMatchedPlatform("esp32-c3-generic", "16MB", assets)).toBe("esp32-c3-generic");
  });
});

describe("detectFlashSize", () => {
  const sizes = { 0x16: "4MB", 0x17: "8MB", 0x18: "16MB" };

  it("reads the size byte out of the flash id", async () => {
    expect(await detectFlashSize({ readFlashId: async () => 0x1640ef, DETECTED_FLASH_SIZES: sizes })).toBe("4MB");
    expect(await detectFlashSize({ readFlashId: async () => 0x1740ef, DETECTED_FLASH_SIZES: sizes })).toBe("8MB");
  });

  it("answers null for a blank id, an unknown byte, a throwing read, or a loader without the API", async () => {
    expect(await detectFlashSize({ readFlashId: async () => 0xffffff, DETECTED_FLASH_SIZES: sizes })).toBeNull();
    expect(await detectFlashSize({ readFlashId: async () => 0x2040ef, DETECTED_FLASH_SIZES: sizes })).toBeNull();
    expect(
      await detectFlashSize({
        readFlashId: async () => {
          throw new Error("stub gone");
        },
        DETECTED_FLASH_SIZES: sizes,
      })
    ).toBeNull();
    expect(await detectFlashSize({})).toBeNull();
  });
});

describe("releaseChipMismatch", () => {
  // The image used to follow the configured hardware alone: a C3 or a classic
  // ESP32 got the S3 image written over it and boot-looped in the ROM.
  it("lets the matching chip through, and a chip esptool could not name", () => {
    expect(releaseChipMismatch("ESP32-S3", "esp32-s3-generic")).toBeNull();
    expect(releaseChipMismatch("ESP32-S3", "esp32-s3-32mb")).toBeNull();
    expect(releaseChipMismatch("ESP32-C3", "esp32-c3-generic")).toBeNull();
    expect(releaseChipMismatch(undefined, "esp32-s3-generic")).toBeNull();
    expect(releaseChipMismatch("", "esp32-s3-generic")).toBeNull();
  });

  it("refuses the other supported chip's image and names the fix", () => {
    expect(releaseChipMismatch("ESP32-C3", "esp32-s3-generic")).toMatch(/ESP32-C3.*built for the ESP32-S3/);
    expect(releaseChipMismatch("ESP32-S3", "esp32-c3-8mb")).toMatch(/ESP32-S3.*built for the ESP32-C3/);
  });

  it("refuses chips FrameOS publishes no firmware for", () => {
    expect(releaseChipMismatch("ESP32", "esp32-s3-generic")).toMatch(/ESP32-S3 and ESP32-C3 only/);
    expect(releaseChipMismatch("ESP32-S2", "esp32-s3-generic")).toMatch(/ESP32-S3 and ESP32-C3 only/);
  });
});
