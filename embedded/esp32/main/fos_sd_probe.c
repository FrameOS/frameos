#include "fos_sd_probe.h"

#include <string.h>

/* ---------------------------------------------------------------------------
 * Little-endian readers. Every on-disk structure below is little-endian, and
 * every field is widened to 64 bits before arithmetic so no range check can be
 * defeated by an overflow.
 * ------------------------------------------------------------------------ */

static uint16_t rd16(const uint8_t *p)
{
    return (uint16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

static uint32_t rd32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static uint64_t rd64(const uint8_t *p)
{
    return (uint64_t)rd32(p) | ((uint64_t)rd32(p + 4) << 32);
}

static bool all_bytes_are(const uint8_t *p, size_t len, uint8_t value)
{
    for (size_t i = 0; i < len; i++) {
        if (p[i] != value) return false;
    }
    return true;
}

static bool has_boot_signature(const uint8_t *sec)
{
    return sec[510] == 0x55 && sec[511] == 0xAA;
}

/* ---------------------------------------------------------------------------
 * Filesystem fingerprints we refuse on.
 *
 * None of these are needed for correctness — anything unrecognised is refused
 * anyway — but naming the filesystem in the log turns "we did not touch your
 * card" into "we did not touch your card, it is NTFS".
 * ------------------------------------------------------------------------ */

static bool looks_like_fat_vbr(const uint8_t *sec)
{
    /* The named variants first: these are what real formatters write. */
    if (memcmp(sec + 82, "FAT32   ", 8) == 0) return true;
    if (memcmp(sec + 54, "FAT12   ", 8) == 0) return true;
    if (memcmp(sec + 54, "FAT16   ", 8) == 0) return true;
    if (memcmp(sec + 54, "FAT     ", 8) == 0) return true;

    /* Then a structural check, for a FAT volume whose label area is damaged —
     * still a volume with possibly recoverable photos on it, so still a
     * refusal. Requires a real jump instruction AND a BPB that adds up. */
    bool jump = (sec[0] == 0xEB && sec[2] == 0x90) || sec[0] == 0xE9;
    if (!jump) return false;
    uint16_t bytes_per_sector = rd16(sec + 11);
    if (bytes_per_sector != 512 && bytes_per_sector != 1024 &&
        bytes_per_sector != 2048 && bytes_per_sector != 4096) {
        return false;
    }
    uint8_t sectors_per_cluster = sec[13];
    if (sectors_per_cluster == 0 || (sectors_per_cluster & (sectors_per_cluster - 1)) != 0) {
        return false;
    }
    uint16_t reserved = rd16(sec + 14);
    if (reserved == 0) return false;
    uint8_t num_fats = sec[16];
    if (num_fats != 1 && num_fats != 2) return false;
    return true;
}

/* ext2/3/4 superblock magic 0xEF53 sits at byte 0x438 of the volume, i.e. at
 * offset 56 of sector 2. mkfs.ext* zeroes bytes 0..1023, so sector 0 of an ext
 * volume looks blank — this check is what stops us formatting one. */
static bool looks_like_ext(const uint8_t *head, size_t len)
{
    if (len < 3 * FOS_SD_SECTOR_BYTES) return false;
    return rd16(head + 1024 + 56) == 0xEF53;
}

/* HFS+/HFSX volume header lives at byte 0x400 of the volume. */
static bool looks_like_hfs_plus(const uint8_t *head, size_t len)
{
    if (len < 3 * FOS_SD_SECTOR_BYTES) return false;
    const uint8_t *vh = head + 1024;
    /* "H+" (HFS+), "HX" (HFSX), "BD" (classic HFS master directory block). */
    return (vh[0] == 'H' && (vh[1] == '+' || vh[1] == 'X')) ||
           (vh[0] == 'B' && vh[1] == 'D');
}

/* APFS container superblock: object header, then "NXSB" at offset 32. */
static bool looks_like_apfs(const uint8_t *head, size_t len)
{
    if (len < FOS_SD_SECTOR_BYTES) return false;
    return memcmp(head + 32, "NXSB", 4) == 0;
}

/* ---------------------------------------------------------------------------
 * Head classification
 * ------------------------------------------------------------------------ */

fos_sd_head_kind_t fos_sd_classify_head(const uint8_t *buf, size_t len,
                                        uint64_t lba, uint64_t card_sectors,
                                        uint64_t *out_part_lba,
                                        uint64_t *out_part_sectors,
                                        const char **out_detail)
{
    const char *unused_detail = NULL;
    if (!out_detail) out_detail = &unused_detail;
    /* Set the refusal first, so every early return below is already safe. */
    *out_detail = "probe_internal_error";
    if (out_part_lba) *out_part_lba = 0;
    if (out_part_sectors) *out_part_sectors = 0;

    if (!buf || len < FOS_SD_HEAD_BYTES) {
        *out_detail = "short_read";
        return FOS_SD_HEAD_REFUSE;
    }
    len = FOS_SD_HEAD_BYTES;

    /* Named filesystems that hide behind a zeroed first sector — checked
     * before the blank test, because they would otherwise pass it. (The
     * uniform-buffer test below would also catch them, since their superblock
     * bytes are not 0x00/0xFF; this is belt and braces plus a better log.) */
    if (looks_like_ext(buf, len)) {
        *out_detail = "ext_filesystem";
        return FOS_SD_HEAD_REFUSE;
    }
    if (looks_like_hfs_plus(buf, len)) {
        *out_detail = "hfs_plus_filesystem";
        return FOS_SD_HEAD_REFUSE;
    }
    if (looks_like_apfs(buf, len)) {
        *out_detail = "apfs_filesystem";
        return FOS_SD_HEAD_REFUSE;
    }

    /* Provably nothing: the whole head reads as a single fill byte. An erased
     * card reads 0xFF; a zeroed one reads 0x00. Mixed fill is not proof of
     * anything, so it falls through to the refusals below. */
    if (all_bytes_are(buf, len, 0x00) || all_bytes_are(buf, len, 0xFF)) {
        *out_detail = "blank_no_filesystem";
        return FOS_SD_HEAD_BLANK;
    }

    /* Volume boot records identify themselves at offset 3; check those before
     * treating the sector as a partition table, since a VBR also carries the
     * 0x55AA signature an MBR has. */
    if (memcmp(buf + 3, "EXFAT   ", 8) == 0) {
        *out_detail = "exfat_volume";
        return FOS_SD_HEAD_EXFAT;
    }
    if (memcmp(buf + 3, "NTFS    ", 8) == 0) {
        *out_detail = "ntfs_filesystem";
        return FOS_SD_HEAD_REFUSE;
    }
    if (looks_like_fat_vbr(buf)) {
        /* A FAT volume FatFs could mount never reaches the probe at all, so
         * this is a FAT volume too damaged to mount — which may still have
         * recoverable photos on it. Refuse. */
        *out_detail = "fat_filesystem";
        return FOS_SD_HEAD_REFUSE;
    }

    if (!has_boot_signature(buf)) {
        *out_detail = "unrecognised_content";
        return FOS_SD_HEAD_REFUSE;
    }

    /* Master boot record. Accept exactly one non-empty entry: more than one is
     * ambiguous, and a card partitioned that way was set up deliberately by
     * somebody, which is the opposite of "brand new". */
    const uint8_t *table = buf + 446;
    int used = -1;
    for (int i = 0; i < 4; i++) {
        const uint8_t *e = table + i * 16;
        if (all_bytes_are(e, 16, 0x00)) continue;
        if (used >= 0) {
            *out_detail = "mbr_multiple_partitions";
            return FOS_SD_HEAD_REFUSE;
        }
        used = i;
    }
    if (used < 0) {
        *out_detail = "mbr_no_partitions";
        return FOS_SD_HEAD_REFUSE;
    }

    const uint8_t *e = table + used * 16;
    uint8_t boot_flag = e[0];
    uint8_t type = e[4];
    uint64_t start = rd32(e + 8);
    uint64_t count = rd32(e + 12);

    if (boot_flag != 0x00 && boot_flag != 0x80) {
        *out_detail = "mbr_bad_entry";
        return FOS_SD_HEAD_REFUSE;
    }
    if (type == 0x00) {
        /* Non-zero bytes but no type: garbage, not a partition table. */
        *out_detail = "mbr_bad_entry";
        return FOS_SD_HEAD_REFUSE;
    }
    if (type == 0xEE || type == 0xEF) {
        *out_detail = "gpt_partitioned";
        return FOS_SD_HEAD_REFUSE;
    }
    if (type == 0x05 || type == 0x0F || type == 0x85 || type == 0xC5) {
        *out_detail = "mbr_extended_partition";
        return FOS_SD_HEAD_REFUSE;
    }
    if (start == 0 || count == 0) {
        *out_detail = "mbr_bad_entry";
        return FOS_SD_HEAD_REFUSE;
    }
    /* Must fit on the card we are actually holding. card_sectors of 0 means
     * "unknown", which is not something we are willing to format against. */
    if (card_sectors == 0) {
        *out_detail = "card_size_unknown";
        return FOS_SD_HEAD_REFUSE;
    }
    if (lba != 0) {
        /* A partition table found inside a partition. Nothing sane does this. */
        *out_detail = "nested_partition_table";
        return FOS_SD_HEAD_REFUSE;
    }
    if (start >= card_sectors || count > card_sectors - start) {
        *out_detail = "mbr_partition_out_of_range";
        return FOS_SD_HEAD_REFUSE;
    }
    /* Room for the head read we are about to do at the partition start. */
    if (count < FOS_SD_HEAD_SECTORS) {
        *out_detail = "mbr_partition_too_small";
        return FOS_SD_HEAD_REFUSE;
    }

    if (out_part_lba) *out_part_lba = start;
    if (out_part_sectors) *out_part_sectors = count;
    *out_detail = "mbr_single_partition";
    return FOS_SD_HEAD_MBR;
}

/* ---------------------------------------------------------------------------
 * exFAT boot sector
 *
 * Every bound below comes from the exFAT specification's "must be" ranges. We
 * check all of them, in 64-bit arithmetic, and refuse on the first miss — the
 * point is not to be permissive with odd-but-legal volumes, it is to make sure
 * that if we do go on to walk the root directory, every sector number we
 * compute lands inside the volume.
 * ------------------------------------------------------------------------ */

bool fos_sd_parse_exfat_vbr(const uint8_t *sec, size_t len,
                            uint64_t sectors_available,
                            fos_sd_exfat_vbr_t *out, const char **why)
{
    const char *unused = NULL;
    if (!why) why = &unused;
    *why = "exfat_bad_vbr";
    if (!sec || !out || len < FOS_SD_SECTOR_BYTES) {
        *why = "short_read";
        return false;
    }
    memset(out, 0, sizeof(*out));

    /* JumpBoot is mandated to be exactly EB 76 90. */
    if (!(sec[0] == 0xEB && sec[1] == 0x76 && sec[2] == 0x90)) return false;
    if (memcmp(sec + 3, "EXFAT   ", 8) != 0) return false;
    /* MustBeZero: 53 bytes that a FAT BPB would have filled in. This single
     * check is what makes "exFAT" here mean exFAT and not a lookalike. */
    if (!all_bytes_are(sec + 11, 53, 0x00)) return false;
    if (!has_boot_signature(sec)) return false;

    uint16_t volume_flags = rd16(sec + 106);
    if (volume_flags & 0x0002) {
        /* VolumeDirty: the volume was not cleanly unmounted, so its metadata
         * may not reflect what is actually stored. Not something to format. */
        *why = "exfat_volume_dirty";
        return false;
    }

    uint8_t bps_shift = sec[108];
    uint8_t spc_shift = sec[109];
    uint8_t num_fats = sec[110];

    /* We read the card in 512-byte sectors via sdmmc_read_sectors, so a volume
     * with a larger logical sector is one we cannot address correctly. Refuse
     * rather than guess. (SD cards are 512 in practice.) */
    if (bps_shift != 9) {
        *why = "exfat_sector_size";
        return false;
    }
    if (spc_shift > 25 - bps_shift) {
        *why = "exfat_field_out_of_range";
        return false;
    }
    if (num_fats != 1 && num_fats != 2) {
        *why = "exfat_field_out_of_range";
        return false;
    }

    uint64_t volume_length = rd64(sec + 72);
    uint64_t fat_offset = rd32(sec + 80);
    uint64_t fat_length = rd32(sec + 84);
    uint64_t heap_offset = rd32(sec + 88);
    uint64_t cluster_count = rd32(sec + 92);
    uint64_t root_cluster = rd32(sec + 96);
    uint64_t spc = (uint64_t)1u << spc_shift;

    /* Spec minimum is 2^20 bytes worth of sectors. */
    if (volume_length < ((uint64_t)1u << (20 - bps_shift))) {
        *why = "exfat_field_out_of_range";
        return false;
    }
    /* The whole volume must fit in the space that actually exists after the
     * boot sector. This is the check that keeps every sector number derived
     * below on the card. */
    if (sectors_available == 0 || volume_length > sectors_available) {
        *why = "exfat_volume_larger_than_card";
        return false;
    }

    if (fat_offset < 24) {
        *why = "exfat_fat_range";
        return false;
    }
    if (fat_length == 0 || cluster_count == 0) {
        *why = "exfat_field_out_of_range";
        return false;
    }
    /* The FAT must be big enough to hold an entry for every cluster. */
    uint64_t fat_entry_bytes = (cluster_count + 2) * 4u;
    uint64_t fat_min_sectors = (fat_entry_bytes + FOS_SD_SECTOR_BYTES - 1) / FOS_SD_SECTOR_BYTES;
    if (fat_length < fat_min_sectors) {
        *why = "exfat_fat_range";
        return false;
    }
    /* FATs sit between FatOffset and ClusterHeapOffset, without overlapping. */
    if (fat_length > (UINT64_MAX / num_fats)) {
        *why = "exfat_fat_range";
        return false;
    }
    if (heap_offset < fat_offset + fat_length * num_fats) {
        *why = "exfat_fat_range";
        return false;
    }
    /* The cluster heap must fit in the volume. */
    if (heap_offset >= volume_length) {
        *why = "exfat_field_out_of_range";
        return false;
    }
    if (cluster_count > (volume_length - heap_offset) >> spc_shift) {
        *why = "exfat_field_out_of_range";
        return false;
    }
    if (cluster_count > 0xFFFFFFF5u) {
        *why = "exfat_field_out_of_range";
        return false;
    }
    if (root_cluster < 2 || root_cluster > cluster_count + 1) {
        *why = "exfat_root_cluster";
        return false;
    }
    /* Belt and braces: the last sector of the last cluster must be readable. */
    uint64_t heap_end = heap_offset + cluster_count * spc;
    if (heap_end > volume_length) {
        *why = "exfat_field_out_of_range";
        return false;
    }

    out->volume_length = volume_length;
    out->fat_offset = (uint32_t)fat_offset;
    out->fat_length = (uint32_t)fat_length;
    out->cluster_heap_offset = (uint32_t)heap_offset;
    out->cluster_count = (uint32_t)cluster_count;
    out->root_cluster = (uint32_t)root_cluster;
    out->bytes_per_sector_shift = bps_shift;
    out->sectors_per_cluster_shift = spc_shift;
    out->number_of_fats = num_fats;
    *why = "";
    return true;
}

/* ---------------------------------------------------------------------------
 * exFAT root directory
 *
 * Checking the root directory is enough to prove "no files anywhere": every
 * file and every subdirectory tree on an exFAT volume is anchored by a 0x85
 * entry in the root, so if the root holds none, there is nothing on the card.
 * ------------------------------------------------------------------------ */

fos_sd_dir_result_t fos_sd_scan_dir_entries(const uint8_t *buf, size_t len,
                                            const char **out_detail)
{
    const char *unused = NULL;
    if (!out_detail) out_detail = &unused;
    *out_detail = "exfat_dir_unreadable";
    if (!buf || len == 0 || (len % 32u) != 0) return FOS_SD_DIR_REFUSE;

    for (size_t off = 0; off < len; off += 32) {
        uint8_t type = buf[off];
        if (type == 0x00) {
            /* EndOfDirectory: this entry and every one after it are unused. */
            *out_detail = "";
            return FOS_SD_DIR_END;
        }
        if ((type & 0x80) == 0) {
            /* In-use bit clear but the entry is not the end marker: a deleted
             * entry. The card has been written to and then emptied, which is
             * not "brand new" — and the user may still want that data back. */
            *out_detail = "exfat_deleted_entries";
            return FOS_SD_DIR_REFUSE;
        }
        switch (type) {
            case 0x81: /* allocation bitmap */
            case 0x82: /* up-case table */
            case 0x83: /* volume label */
                break; /* benign volume metadata; keep looking */
            case 0x85:
                /* A file or directory. This is the whole point of the probe. */
                *out_detail = "exfat_has_files";
                return FOS_SD_DIR_REFUSE;
            default:
                /* Includes 0xC0/0xC1 stream+name entries (which can only
                 * follow a 0x85 we would already have refused on), vendor
                 * extensions, and anything a future revision adds. */
                *out_detail = "exfat_unknown_entry";
                return FOS_SD_DIR_REFUSE;
        }
    }
    *out_detail = "";
    return FOS_SD_DIR_CONTINUE;
}

bool fos_sd_exfat_next_cluster(const uint8_t *fat_sector, size_t len,
                               uint32_t byte_in_sector, uint32_t cluster_count,
                               uint32_t *out_next, bool *out_end,
                               const char **why)
{
    const char *unused = NULL;
    if (!why) why = &unused;
    *why = "exfat_bad_fat_entry";
    if (out_next) *out_next = 0;
    if (out_end) *out_end = false;
    if (!fat_sector || !out_next || !out_end) return false;
    if (byte_in_sector > len || len - byte_in_sector < 4) {
        *why = "short_read";
        return false;
    }

    uint32_t value = rd32(fat_sector + byte_in_sector);
    if (value == 0xFFFFFFFFu) {
        *out_end = true;
        *why = "";
        return true;
    }
    if (value == 0xFFFFFFF7u) {
        *why = "exfat_bad_cluster";
        return false;
    }
    if (value < 2 || value > cluster_count + 1) {
        /* Includes 0 (free) and 1 (reserved): a chain must not point there. */
        return false;
    }
    *out_next = value;
    *why = "";
    return true;
}

/* ---------------------------------------------------------------------------
 * Orchestration
 * ------------------------------------------------------------------------ */

fos_sd_probe_verdict_t fos_sd_probe_run(fos_sd_read_fn read_fn, void *ctx,
                                        uint64_t card_sectors,
                                        uint8_t *scratch, size_t scratch_len,
                                        const char **out_detail)
{
    const char *unused = NULL;
    if (!out_detail) out_detail = &unused;
    *out_detail = "probe_internal_error";

    if (!read_fn || !scratch || scratch_len < FOS_SD_PROBE_SCRATCH_BYTES) {
        return FOS_SD_PROBE_REFUSE;
    }
    if (card_sectors < FOS_SD_HEAD_SECTORS) {
        *out_detail = "card_size_unknown";
        return FOS_SD_PROBE_REFUSE;
    }

    uint8_t *head = scratch;                       /* FOS_SD_HEAD_BYTES */
    uint8_t *fat_buf = scratch + FOS_SD_HEAD_BYTES; /* one sector */

    if (!read_fn(ctx, 0, FOS_SD_HEAD_SECTORS, head)) {
        *out_detail = "read_error";
        return FOS_SD_PROBE_REFUSE;
    }

    uint64_t vbr_lba = 0;
    uint64_t volume_limit = card_sectors;
    uint64_t part_lba = 0, part_sectors = 0;
    const char *detail = NULL;
    fos_sd_head_kind_t kind = fos_sd_classify_head(head, FOS_SD_HEAD_BYTES, 0, card_sectors,
                                                   &part_lba, &part_sectors, &detail);
    if (kind == FOS_SD_HEAD_BLANK) {
        *out_detail = "blank_no_filesystem";
        return FOS_SD_PROBE_BLANK_NO_FILESYSTEM;
    }
    if (kind == FOS_SD_HEAD_MBR) {
        vbr_lba = part_lba;
        /* volume_limit is the partition length; the volume must also stay on
         * the card, which classify_head already checked when it accepted the
         * entry. Cap anyway so later arithmetic cannot escape the card. */
        volume_limit = part_sectors;
        if (volume_limit > card_sectors - vbr_lba) volume_limit = card_sectors - vbr_lba;
        /* Re-read at the partition and classify again. */
        if (!read_fn(ctx, vbr_lba, FOS_SD_HEAD_SECTORS, head)) {
            *out_detail = "read_error";
            return FOS_SD_PROBE_REFUSE;
        }
        uint64_t nested_lba = 0, nested_sectors = 0;
        kind = fos_sd_classify_head(head, FOS_SD_HEAD_BYTES, vbr_lba, card_sectors,
                                    &nested_lba, &nested_sectors, &detail);
        if (kind == FOS_SD_HEAD_BLANK) {
            /* A partition table pointing at a wiped volume. Deliberately NOT
             * treated as blank: a brand-new card ships formatted (so it shows
             * up as exFAT/FAT, not this), whereas a card whose boot sector was
             * damaged or overwritten looks exactly like this and may still
             * have recoverable photos behind it. */
            *out_detail = "partition_without_filesystem";
            return FOS_SD_PROBE_REFUSE;
        }
        if (kind != FOS_SD_HEAD_EXFAT) {
            *out_detail = detail ? detail : "unrecognised_content";
            return FOS_SD_PROBE_REFUSE;
        }
    } else if (kind != FOS_SD_HEAD_EXFAT) {
        *out_detail = detail ? detail : "unrecognised_content";
        return FOS_SD_PROBE_REFUSE;
    }

    /* --- exFAT: parse the boot sector, then walk the root directory. --- */
    fos_sd_exfat_vbr_t vbr;
    if (!fos_sd_parse_exfat_vbr(head, FOS_SD_SECTOR_BYTES, volume_limit, &vbr, &detail)) {
        *out_detail = detail ? detail : "exfat_bad_vbr";
        return FOS_SD_PROBE_REFUSE;
    }

    uint64_t spc = (uint64_t)1u << vbr.sectors_per_cluster_shift;
    uint32_t cluster = vbr.root_cluster;
    uint32_t visited[FOS_SD_PROBE_MAX_DIR_CLUSTERS];
    size_t visited_count = 0;
    uint32_t sectors_scanned = 0;

    for (;;) {
        if (visited_count >= FOS_SD_PROBE_MAX_DIR_CLUSTERS) {
            *out_detail = "exfat_dir_too_large";
            return FOS_SD_PROBE_REFUSE;
        }
        if (cluster < 2 || cluster > vbr.cluster_count + 1) {
            *out_detail = "exfat_root_cluster";
            return FOS_SD_PROBE_REFUSE;
        }
        for (size_t i = 0; i < visited_count; i++) {
            if (visited[i] == cluster) {
                *out_detail = "exfat_chain_cycle";
                return FOS_SD_PROBE_REFUSE;
            }
        }
        visited[visited_count++] = cluster;

        uint64_t first_sector = vbr_lba + vbr.cluster_heap_offset +
                                (uint64_t)(cluster - 2) * spc;
        for (uint64_t s = 0; s < spc; s++) {
            if (sectors_scanned >= FOS_SD_PROBE_MAX_DIR_SECTORS) {
                *out_detail = "exfat_dir_too_large";
                return FOS_SD_PROBE_REFUSE;
            }
            uint64_t lba = first_sector + s;
            if (lba >= card_sectors) {
                *out_detail = "exfat_field_out_of_range";
                return FOS_SD_PROBE_REFUSE;
            }
            if (!read_fn(ctx, lba, 1, head)) {
                *out_detail = "read_error";
                return FOS_SD_PROBE_REFUSE;
            }
            sectors_scanned++;
            fos_sd_dir_result_t res = fos_sd_scan_dir_entries(head, FOS_SD_SECTOR_BYTES, &detail);
            if (res == FOS_SD_DIR_REFUSE) {
                *out_detail = detail && detail[0] ? detail : "exfat_dir_unreadable";
                return FOS_SD_PROBE_REFUSE;
            }
            if (res == FOS_SD_DIR_END) {
                *out_detail = "blank_exfat";
                return FOS_SD_PROBE_BLANK_EXFAT;
            }
        }

        /* Follow the FAT to the next root-directory cluster. */
        uint64_t fat_byte = (uint64_t)cluster * 4u;
        uint64_t fat_sector_index = fat_byte / FOS_SD_SECTOR_BYTES;
        if (fat_sector_index >= vbr.fat_length) {
            *out_detail = "exfat_fat_range";
            return FOS_SD_PROBE_REFUSE;
        }
        uint64_t fat_lba = vbr_lba + vbr.fat_offset + fat_sector_index;
        if (fat_lba >= card_sectors) {
            *out_detail = "exfat_fat_range";
            return FOS_SD_PROBE_REFUSE;
        }
        if (!read_fn(ctx, fat_lba, 1, fat_buf)) {
            *out_detail = "read_error";
            return FOS_SD_PROBE_REFUSE;
        }
        uint32_t next = 0;
        bool end = false;
        if (!fos_sd_exfat_next_cluster(fat_buf, FOS_SD_SECTOR_BYTES,
                                       (uint32_t)(fat_byte % FOS_SD_SECTOR_BYTES),
                                       vbr.cluster_count, &next, &end, &detail)) {
            *out_detail = detail && detail[0] ? detail : "exfat_bad_fat_entry";
            return FOS_SD_PROBE_REFUSE;
        }
        if (end) {
            /* Whole root directory scanned, nothing but benign metadata. */
            *out_detail = "blank_exfat";
            return FOS_SD_PROBE_BLANK_EXFAT;
        }
        cluster = next;
    }
}
