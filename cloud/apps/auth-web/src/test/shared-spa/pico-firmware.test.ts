// A Raspberry Pi Pico W / Pico 2 W frame (the Pimoroni Inky Frame family) in
// the self-hosted deploy drawer: which release file it is offered, and which
// of the ESP32 USB card's affordances it must never see. A Pico's flash is
// written by dragging a .uf2 onto its BOOTSEL drive — no browser can do that —
// so every esptool path is off and the download plus `usb_api bootsel` take
// their place (frontend/src/scenes/workspace/picoFirmware.ts).
import { describe, expect, it } from "vitest";
import {
  bootselDriveName,
  firmwareDownloadFileName,
  firmwareSizeLabel,
  isPicoPlatform,
  isUf2Release,
  pickUf2Asset,
  picoBoardLabel,
  usbBoardFamilyMismatch,
  usbCardAffordances,
} from "../../../../../../frontend/src/scenes/workspace/picoFirmware";

// GET /api/frames/firmware on the self-hosted backend, 2026-09.
const listing = [
  { name: "frameos-v2026.9.20-esp32-s3-generic.bin", platform: "esp32-s3-generic", size: 3_400_000, format: "bin" },
  { name: "frameos-v2026.9.20-pico-w.uf2", platform: "pico-w", size: 1_480_704, format: "uf2" },
  { name: "frameos-v2026.9.20-pico-2w.uf2", platform: "pico-2w", size: 1_512_448, format: "uf2" },
  { name: "frameos-v2026.9.20-raspberry-pi-64-buildroot.img.gz", platform: "raspberry-pi-64", size: 90_000_000, format: "img.gz" },
];

describe("picking the .uf2 out of the release listing", () => {
  it("finds the asset for the frame's release platform", () => {
    expect(pickUf2Asset(listing, "pico-2w")?.name).toBe("frameos-v2026.9.20-pico-2w.uf2");
    expect(pickUf2Asset(listing, "pico-w")?.name).toBe("frameos-v2026.9.20-pico-w.uf2");
  });

  it("answers null when the release predates the pico build", () => {
    const older = listing.filter((asset) => !asset.platform.startsWith("pico"));
    expect(pickUf2Asset(older, "pico-2w")).toBeNull();
    expect(pickUf2Asset([], "pico-2w")).toBeNull();
    expect(pickUf2Asset(undefined, "pico-2w")).toBeNull();
    expect(pickUf2Asset(listing, "")).toBeNull();
    expect(pickUf2Asset(listing, null)).toBeNull();
  });

  it("tolerates a listing with no `format` field by reading the file name", () => {
    // FrameOS Cloud's listing, and a backend that predates the field.
    const bare = listing.map(({ name, platform, size }) => ({ name, platform, size }));
    expect(pickUf2Asset(bare, "pico-2w")?.name).toBe("frameos-v2026.9.20-pico-2w.uf2");
    // A platform match alone is not enough: never offer a non-uf2 as one.
    expect(pickUf2Asset([{ name: "frameos-pico-2w.bin", platform: "pico-2w", size: 1 }], "pico-2w")).toBeNull();
  });

  it("never picks an asset whose format says it is something else", () => {
    expect(pickUf2Asset([{ name: "x.uf2", platform: "pico-2w", size: 1, format: "bin" }], "pico-2w")).toBeNull();
    expect(pickUf2Asset(listing, "esp32-s3-generic")).toBeNull();
  });
});

describe("recognising a UF2 frame", () => {
  it("trusts the provisioning plan's releaseFormat", () => {
    expect(isUf2Release("uf2", "pico-2w")).toBe(true);
    expect(isUf2Release("bin", "esp32-s3")).toBe(false);
    // The plan wins over a platform name that merely looks like a pico.
    expect(isUf2Release("bin", "pico-2w")).toBe(false);
  });

  it("falls back to the platform while there is no plan, or no such field", () => {
    expect(isUf2Release(undefined, "pico-w")).toBe(true);
    expect(isUf2Release(null, "pico-2w")).toBe(true);
    expect(isUf2Release(undefined, "esp32-c3")).toBe(false);
    expect(isUf2Release(null, "virtual")).toBe(false);
    expect(isUf2Release(undefined, undefined)).toBe(false);
  });

  it("prefix-matches the platform", () => {
    expect(isPicoPlatform("pico-w")).toBe(true);
    expect(isPicoPlatform("Pico-2W")).toBe(true);
    expect(isPicoPlatform("esp32-s3")).toBe(false);
    expect(isPicoPlatform("")).toBe(false);
    expect(isPicoPlatform(undefined)).toBe(false);
  });
});

describe("the USB card's flashing affordances", () => {
  it("turns every esptool path off for a Pico and offers BOOTSEL instead", () => {
    expect(usbCardAffordances(true)).toEqual({
      browserFlash: false,
      firmwareUpdateOverUsb: false,
      eraseAndReflash: false,
      manualEsptoolCommand: false,
      rebootIntoBootsel: true,
    });
  });

  it("leaves an ESP32 exactly as it was", () => {
    expect(usbCardAffordances(false)).toEqual({
      browserFlash: true,
      firmwareUpdateOverUsb: true,
      eraseAndReflash: true,
      manualEsptoolCommand: true,
      rebootIntoBootsel: false,
    });
  });
});

describe("what the person is told to look for", () => {
  it("names the bootloader drive by chip", () => {
    expect(bootselDriveName("pico-2w")).toBe("RP2350");
    expect(bootselDriveName("pico-w")).toBe("RPI-RP2");
    expect(picoBoardLabel("pico-2w")).toBe("Pico 2 W");
    expect(picoBoardLabel("pico-w")).toBe("Pico W");
  });

  it("formats the asset size", () => {
    expect(firmwareSizeLabel(1_512_448)).toBe("1.4 MB");
    expect(firmwareSizeLabel(612 * 1024)).toBe("612 KB");
    expect(firmwareSizeLabel(0)).toBe("");
  });
});

describe("naming the downloaded file", () => {
  const headers = (values: Record<string, string>) => new Headers(values);

  it("prefers the backend's own image name header", () => {
    expect(
      firmwareDownloadFileName(
        headers({
          "x-frameos-image-name": "frameos-v2026.9.20-pico-2w.uf2",
          "content-disposition": 'attachment; filename="other.uf2"',
        }),
        "fallback.uf2",
      ),
    ).toBe("frameos-v2026.9.20-pico-2w.uf2");
  });

  it("reads the content-disposition attachment name, quoted or bare", () => {
    expect(
      firmwareDownloadFileName(headers({ "content-disposition": 'attachment; filename="frameos-v1-pico-w.uf2"' }), "f"),
    ).toBe("frameos-v1-pico-w.uf2");
    expect(
      firmwareDownloadFileName(headers({ "content-disposition": "attachment; filename=frameos-v1-pico-w.uf2" }), "f"),
    ).toBe("frameos-v1-pico-w.uf2");
  });

  it("falls back to the listing's asset name when a proxy stripped both", () => {
    expect(firmwareDownloadFileName(headers({}), "frameos-v1-pico-2w.uf2")).toBe("frameos-v1-pico-2w.uf2");
    expect(firmwareDownloadFileName(headers({}), "")).toBe("frameos.uf2");
  });

  it("never lets a path through", () => {
    expect(firmwareDownloadFileName(headers({ "x-frameos-image-name": "../../etc/frameos.uf2" }), "f")).toBe(
      "frameos.uf2",
    );
  });
});

describe("a board of the wrong family on the cable", () => {
  it("flags a Pico answering in an ESP32 frame's drawer, and the reverse", () => {
    expect(usbBoardFamilyMismatch("esp32-s3", "pico-2w")).toContain("pico-2w");
    expect(usbBoardFamilyMismatch("pico-2w", "esp32s3")).toContain("esp32s3");
  });

  it("stays quiet when they agree or the board does not say", () => {
    expect(usbBoardFamilyMismatch("pico-2w", "pico-2w")).toBeNull();
    // Same family is enough: the release image, not the drawer, fits the chip.
    expect(usbBoardFamilyMismatch("pico-w", "pico-2w")).toBeNull();
    expect(usbBoardFamilyMismatch("esp32-s3", "esp32s3")).toBeNull();
    expect(usbBoardFamilyMismatch("pico-2w", undefined)).toBeNull();
    expect(usbBoardFamilyMismatch("pico-2w", "")).toBeNull();
    expect(usbBoardFamilyMismatch("", "pico-2w")).toBeNull();
  });
});
