/**
 * ESP32 partition-table parsing and the "keep the NVS" write plan.
 *
 * A released FrameOS ESP32 image (`frameos-<version>-esp32-s3-generic.bin`) is
 * the MERGED image `idf.py merge-bin` writes: one contiguous file from 0x0
 * holding the bootloader, the partition table, a blank otadata and the app,
 * with 0xFF padding in between. Flashing all of it at 0x0 — what the
 * enrollment flasher does — therefore also writes 0xFF over the NVS partition,
 * which is where the board keeps its Wi-Fi credentials AND its cloud
 * enrollment (cloud_url, cloud_fid, cloud_token; fos_cloud.c). That is fine
 * when the board is being enrolled, and destructive when it already belongs to
 * a frame: the device would come back as a stranger and the account would end
 * up with an orphaned frame row.
 *
 * Updating the firmware of an enrolled board therefore writes everything in
 * that image EXCEPT the NVS range, in two chunks around it. The partition
 * table sits inside the image, so the range is read out of the image itself
 * rather than assumed — and the caller cross-checks it against the table
 * actually on the device before writing anything.
 */

export interface Esp32Partition {
  name: string
  type: number
  subtype: number
  offset: number
  size: number
}

export interface FlashSegment {
  address: number
  data: Uint8Array
}

export interface FirmwareUpdateWritePlan {
  /** The NVS partition left untouched by this plan. */
  preserved: Esp32Partition
  segments: FlashSegment[]
  totalBytes: number
}

/** Where `idf.py` always puts the partition table on ESP32 targets. */
export const ESP32_PARTITION_TABLE_OFFSET = 0x8000
export const ESP32_PARTITION_TABLE_SIZE = 0x1000
/** Smallest erasable unit: every written range must be a multiple of this. */
export const ESP32_FLASH_SECTOR_SIZE = 0x1000

// esp_partition_info_t (esp_partition.h): magic, type, subtype, offset, size,
// 16-byte label, flags — 32 bytes per entry. The table ends at the first
// non-magic entry; the generator appends an 0xEBEB md5 entry there.
const PARTITION_ENTRY_MAGIC = 0x50aa
const PARTITION_ENTRY_SIZE = 32
const PARTITION_TYPE_DATA = 0x01
const PARTITION_SUBTYPE_NVS = 0x02

export function parseEsp32PartitionTable(table: Uint8Array): Esp32Partition[] {
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength)
  const partitions: Esp32Partition[] = []
  for (let offset = 0; offset + PARTITION_ENTRY_SIZE <= table.byteLength; offset += PARTITION_ENTRY_SIZE) {
    if (view.getUint16(offset, true) !== PARTITION_ENTRY_MAGIC) {
      break
    }
    const labelBytes = table.subarray(offset + 12, offset + 28)
    const terminator = labelBytes.indexOf(0)
    partitions.push({
      name: new TextDecoder().decode(terminator === -1 ? labelBytes : labelBytes.subarray(0, terminator)),
      type: view.getUint8(offset + 2),
      subtype: view.getUint8(offset + 3),
      offset: view.getUint32(offset + 4, true),
      size: view.getUint32(offset + 8, true),
    })
  }
  return partitions
}

export function esp32NvsPartition(partitions: readonly Esp32Partition[]): Esp32Partition | undefined {
  return partitions.find(
    (partition) => partition.type === PARTITION_TYPE_DATA && partition.subtype === PARTITION_SUBTYPE_NVS
  )
}

/** The partition table carried inside a merged flash image, or []. */
export function partitionTableFromMergedImage(image: Uint8Array): Esp32Partition[] {
  if (image.byteLength < ESP32_PARTITION_TABLE_OFFSET + ESP32_PARTITION_TABLE_SIZE) {
    return []
  }
  return parseEsp32PartitionTable(
    image.subarray(ESP32_PARTITION_TABLE_OFFSET, ESP32_PARTITION_TABLE_OFFSET + ESP32_PARTITION_TABLE_SIZE)
  )
}

/**
 * Split a merged image into the chunks to write around its NVS partition.
 * Throws rather than guessing: a plan that cannot prove where the NVS is would
 * silently un-enroll the board it is supposed to update.
 */
export function firmwareUpdateWritePlan(image: Uint8Array): FirmwareUpdateWritePlan {
  const partitions = partitionTableFromMergedImage(image)
  if (partitions.length === 0) {
    throw new Error(
      'This firmware image has no readable partition table, so its settings partition cannot be spared. ' +
        'Flash it from the "Add frame" panel instead — that enrolls the board from scratch.'
    )
  }
  const nvs = esp32NvsPartition(partitions)
  if (!nvs) {
    throw new Error("This firmware image declares no NVS partition, so the frame's settings cannot be preserved.")
  }
  if (nvs.offset % ESP32_FLASH_SECTOR_SIZE !== 0 || nvs.size % ESP32_FLASH_SECTOR_SIZE !== 0) {
    throw new Error("The firmware image's NVS partition is not flash-sector aligned; refusing to flash around it.")
  }
  if (nvs.offset >= image.byteLength) {
    throw new Error('The firmware image is shorter than its own partition table claims.')
  }

  const segments: FlashSegment[] = []
  const head = image.subarray(0, nvs.offset)
  if (head.byteLength > 0) {
    segments.push({ address: 0, data: head })
  }
  const tailStart = nvs.offset + nvs.size
  if (tailStart < image.byteLength) {
    segments.push({ address: tailStart, data: image.subarray(tailStart) })
  }
  if (segments.length === 0) {
    throw new Error('The firmware image contains nothing to write outside its NVS partition.')
  }

  return {
    preserved: nvs,
    segments,
    totalBytes: segments.reduce((total, segment) => total + segment.data.byteLength, 0),
  }
}

/**
 * Whether the layout on the device matches the one in the image being written.
 * The NVS is only preserved if the two tables agree about where it lives —
 * writing an 8MB-layout image onto a board partitioned for 16MB would move the
 * hole and wipe the credentials it was meant to protect.
 */
export function deviceLayoutMatchesPlan(
  devicePartitions: readonly Esp32Partition[],
  plan: FirmwareUpdateWritePlan
): boolean {
  const deviceNvs = esp32NvsPartition(devicePartitions)
  return Boolean(deviceNvs && deviceNvs.offset === plan.preserved.offset && deviceNvs.size === plan.preserved.size)
}
