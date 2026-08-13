// Builders for fake ESP32 merged flash images and partition tables, shared by
// the embedded-flash-image and embedded-web-flasher suites.
import {
  ESP32_PARTITION_TABLE_OFFSET,
  type Esp32Partition,
} from "../../../../../../frontend/src/scenes/workspace/embeddedFlashImage";

export const PARTITION_ENTRY_SIZE = 32;

/** One esp_partition_info_t, as gen_esp32part.py writes it. */
export function partitionEntry(partition: Esp32Partition): Uint8Array {
  const entry = new Uint8Array(PARTITION_ENTRY_SIZE);
  const view = new DataView(entry.buffer);
  view.setUint16(0, 0x50aa, true);
  view.setUint8(2, partition.type);
  view.setUint8(3, partition.subtype);
  view.setUint32(4, partition.offset, true);
  view.setUint32(8, partition.size, true);
  entry.set(new TextEncoder().encode(partition.name).subarray(0, 16), 12);
  return entry;
}

// The 8MB OTA layout every cloud-flashed board runs (embedded/esp32/partitions.csv).
export const defaultLayout: Esp32Partition[] = [
  { name: "nvs", type: 1, subtype: 2, offset: 0x9000, size: 16 * 1024 },
  { name: "otadata", type: 1, subtype: 0, offset: 0xd000, size: 8 * 1024 },
  { name: "phy_init", type: 1, subtype: 1, offset: 0xf000, size: 4 * 1024 },
  { name: "ota_0", type: 0, subtype: 0x10, offset: 0x10000, size: 3520 * 1024 },
  { name: "ota_1", type: 0, subtype: 0x11, offset: 0x380000, size: 3520 * 1024 },
];

export function partitionTable(partitions: Esp32Partition[]): Uint8Array {
  const table = new Uint8Array(0x1000);
  partitions.forEach((partition, index) => {
    table.set(partitionEntry(partition), index * PARTITION_ENTRY_SIZE);
  });
  return table;
}

/** A stand-in for `idf.py merge-bin` output: table at 0x8000, app at 0x10000. */
export function mergedImage(
  partitions: Esp32Partition[] = defaultLayout,
  appBytes = 0x2000,
): Uint8Array {
  const image = new Uint8Array(0x10000 + appBytes).fill(0xff);
  image[0] = 0xe9; // bootloader image magic
  image.set(partitionTable(partitions), ESP32_PARTITION_TABLE_OFFSET);
  image.fill(0xab, 0x10000);
  image[0x10000] = 0xe9; // app image magic
  return image;
}
