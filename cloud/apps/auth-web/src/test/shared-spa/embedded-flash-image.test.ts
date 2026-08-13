// The write plan behind "Update over USB" on an already-enrolled ESP32 frame.
//
// The whole point of the plan is one guarantee: the NVS partition — where the
// board keeps its Wi-Fi credentials AND its cloud enrollment (cloud_url,
// cloud_fid, cloud_token; embedded/esp32/main/fos_cloud.c) — is never written.
// Flashing the merged release image at 0x0 the way the enrollment flasher does
// blanks it with the image's 0xFF padding, which turns a firmware update into
// an un-enrollment: the account keeps an orphaned frame row and the board comes
// back a stranger. These tests pin that the hole is in the right place and that
// anything the planner cannot prove fails loudly instead.
//
// Lives here (auth-web's vitest) because frontend/ has no test runner; same
// cross-package arrangement as the other shared-spa suites.
import { describe, expect, it } from "vitest";
import {
  deviceLayoutMatchesPlan,
  esp32NvsPartition,
  firmwareUpdateWritePlan,
  parseEsp32PartitionTable,
  partitionTableFromMergedImage,
} from "../../../../../../frontend/src/scenes/workspace/embeddedFlashImage";
// Image/table builders shared with embedded-web-flasher.test.tsx.
import {
  PARTITION_ENTRY_SIZE,
  defaultLayout,
  mergedImage,
  partitionTable,
} from "./esp32ImageFixtures";

describe("parseEsp32PartitionTable", () => {
  it("reads entries until the first non-magic one", () => {
    const table = partitionTable(defaultLayout);
    // gen_esp32part.py appends an 0xEBEB md5 entry after the real ones.
    table.set([0xeb, 0xeb], defaultLayout.length * PARTITION_ENTRY_SIZE);

    const parsed = parseEsp32PartitionTable(table);

    expect(parsed.map((partition) => partition.name)).toEqual([
      "nvs",
      "otadata",
      "phy_init",
      "ota_0",
      "ota_1",
    ]);
    expect(esp32NvsPartition(parsed)).toMatchObject({
      offset: 0x9000,
      size: 16 * 1024,
    });
  });

  it("returns nothing for a blank or truncated table", () => {
    expect(parseEsp32PartitionTable(new Uint8Array(0x1000))).toEqual([]);
    expect(partitionTableFromMergedImage(new Uint8Array(64))).toEqual([]);
  });
});

describe("firmwareUpdateWritePlan", () => {
  it("writes everything around the NVS partition and nothing inside it", () => {
    const image = mergedImage();

    const plan = firmwareUpdateWritePlan(image);

    expect(plan.preserved).toMatchObject({ name: "nvs", offset: 0x9000 });
    expect(
      plan.segments.map((segment) => [
        segment.address,
        segment.address + segment.data.byteLength,
      ]),
    ).toEqual([
      [0, 0x9000],
      [0xd000, image.byteLength],
    ]);
    // Bootloader, partition table, otadata and app are all still covered: the
    // only gap is the NVS.
    expect(plan.totalBytes).toBe(image.byteLength - 16 * 1024);
    expect(plan.segments[0]!.data[0]).toBe(0xe9);
    expect(plan.segments[1]!.data[0x10000 - 0xd000]).toBe(0xe9);
  });

  it("resets otadata, so the board boots the slot that was just written", () => {
    // otadata (0xd000) sits after the NVS, inside the second segment. If it
    // were skipped too, a board that had previously OTA'd into ota_1 would keep
    // booting ota_1 and the flash would look like it did nothing.
    const plan = firmwareUpdateWritePlan(mergedImage());
    const tail = plan.segments[1]!;

    expect(tail.address).toBe(0xd000);
    expect(tail.data.subarray(0, 8 * 1024).every((byte) => byte === 0xff)).toBe(
      true,
    );
  });

  it("refuses an image with no readable partition table", () => {
    expect(() => firmwareUpdateWritePlan(new Uint8Array(0x20000))).toThrow(
      /no readable partition table/i,
    );
  });

  it("refuses an image whose table declares no NVS", () => {
    const withoutNvs = defaultLayout.filter(
      (partition) => partition.name !== "nvs",
    );

    expect(() => firmwareUpdateWritePlan(mergedImage(withoutNvs))).toThrow(
      /no NVS partition/i,
    );
  });

  it("refuses a misaligned NVS rather than erasing a neighbouring sector", () => {
    const misaligned = defaultLayout.map((partition) =>
      partition.name === "nvs" ? { ...partition, offset: 0x9100 } : partition,
    );

    expect(() => firmwareUpdateWritePlan(mergedImage(misaligned))).toThrow(
      /sector aligned/i,
    );
  });
});

describe("deviceLayoutMatchesPlan", () => {
  it("accepts a board partitioned exactly like the image", () => {
    const plan = firmwareUpdateWritePlan(mergedImage());

    expect(deviceLayoutMatchesPlan(defaultLayout, plan)).toBe(true);
  });

  it("rejects a board whose NVS sits elsewhere", () => {
    // The 16MB layout puts a 24KB NVS at the same offset but ends it later:
    // the hole this plan leaves would clip it and wipe the enrollment.
    const sixteenMb = defaultLayout.map((partition) =>
      partition.name === "nvs"
        ? { ...partition, size: 24 * 1024 }
        : partition,
    );
    const plan = firmwareUpdateWritePlan(mergedImage());

    expect(deviceLayoutMatchesPlan(sixteenMb, plan)).toBe(false);
    expect(deviceLayoutMatchesPlan([], plan)).toBe(false);
  });
});
