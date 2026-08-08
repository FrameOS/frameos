/*
 * Read-only "is this SD card provably empty?" probe.
 *
 * Background: FatFs in IDF is built with FF_FS_EXFAT 0 (hardcoded in the
 * vendored components/fatfs/src/ffconf.h, no Kconfig), so every volume it
 * cannot parse — a blank card AND an exFAT card full of the user's photos —
 * comes back as FR_NO_FILESYSTEM. Auto-formatting on that signal erased
 * people's photos, which is why it was removed in cb232a46.
 *
 * This module puts the convenience back safely: it reads raw sectors and only
 * says "blank" when it can *prove* the card holds nothing. It never writes.
 *
 * THE ONE RULE: every unhandled branch, every parse that does not add up,
 * every unexpected value and every read error returns FOS_SD_PROBE_REFUSE.
 * A false "blank" destroys irreplaceable data and there is no undo; a false
 * "refuse" costs the user one `sd format` command. The enum is ordered so
 * that REFUSE == 0, i.e. a zero-initialised or forgotten result is a refusal.
 *
 * Everything here is pure C over byte buffers with no IDF dependency, so it
 * can be compiled and tested on the host — see tests/test_fos_sd_probe.c.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define FOS_SD_SECTOR_BYTES 512u

/* How much of the head of a candidate volume we look at. Three sectors would
 * be the minimum (an ext superblock lives at byte 0x438 and an HFS+ volume
 * header at 0x400, i.e. in sector 2, while the first two sectors are zeroed by
 * mkfs — so "sector 0 is all zeroes" alone is NOT proof of emptiness). Eight
 * is one 4 KB SPI transfer and gives more margin. */
#define FOS_SD_HEAD_SECTORS 8u
#define FOS_SD_HEAD_BYTES (FOS_SD_HEAD_SECTORS * FOS_SD_SECTOR_BYTES)

/* Scratch the orchestrator needs: the head/directory buffer plus one spare
 * sector for FAT lookups. Must be at least this big and 4-byte aligned. */
#define FOS_SD_PROBE_SCRATCH_BYTES (FOS_SD_HEAD_BYTES + FOS_SD_SECTOR_BYTES)

/* Walk bounds, so a corrupt or hostile card cannot make us spin. Exceeding any
 * of them is a refusal, not a truncation. */
#define FOS_SD_PROBE_MAX_DIR_CLUSTERS 64u
#define FOS_SD_PROBE_MAX_DIR_SECTORS 256u

typedef enum {
    /* Deliberately 0: the safe default for anything we did not understand. */
    FOS_SD_PROBE_REFUSE = 0,
    /* No filesystem at all: the head of the card is uniformly 0x00 or 0xFF. */
    FOS_SD_PROBE_BLANK_NO_FILESYSTEM = 1,
    /* A structurally sound exFAT volume whose root directory holds nothing but
     * the bitmap / up-case table / volume label. */
    FOS_SD_PROBE_BLANK_EXFAT = 2,
} fos_sd_probe_verdict_t;

/* What sits at the head of a candidate volume. */
typedef enum {
    FOS_SD_HEAD_REFUSE = 0,
    FOS_SD_HEAD_BLANK,
    FOS_SD_HEAD_EXFAT,
    FOS_SD_HEAD_MBR, /* partition table with exactly one plausible entry */
} fos_sd_head_kind_t;

/* Parsed exFAT boot sector, already range-checked by fos_sd_parse_exfat_vbr. */
typedef struct {
    uint64_t volume_length;             /* sectors, incl. the VBR itself */
    uint32_t fat_offset;                /* sectors from the VBR */
    uint32_t fat_length;                /* sectors, one FAT */
    uint32_t cluster_heap_offset;       /* sectors from the VBR */
    uint32_t cluster_count;
    uint32_t root_cluster;
    uint8_t bytes_per_sector_shift;
    uint8_t sectors_per_cluster_shift;
    uint8_t number_of_fats;
} fos_sd_exfat_vbr_t;

/* Outcome of scanning one buffer of 32-byte exFAT directory entries. */
typedef enum {
    FOS_SD_DIR_REFUSE = 0, /* contents found, or something unrecognised */
    FOS_SD_DIR_CONTINUE,   /* only benign metadata in this buffer */
    FOS_SD_DIR_END,        /* EndOfDirectory reached; nothing was in here */
} fos_sd_dir_result_t;

/* Reads `count` 512-byte sectors starting at `lba` into `dst`. Returns false on
 * any error. Implementations MUST NOT write to the card. */
typedef bool (*fos_sd_read_fn)(void *ctx, uint64_t lba, uint32_t count, uint8_t *dst);

/* Classify the head of a candidate volume that starts at `lba`.
 *
 * `buf` must hold at least FOS_SD_HEAD_BYTES bytes read from `lba` onward;
 * anything shorter is refused rather than guessed at (a short buffer cannot
 * rule out an ext/HFS+ superblock further in). On FOS_SD_HEAD_MBR the single
 * partition's start LBA and length are written to the out params.
 * `*out_detail` always receives a stable, log-safe token. */
fos_sd_head_kind_t fos_sd_classify_head(const uint8_t *buf, size_t len,
                                        uint64_t lba, uint64_t card_sectors,
                                        uint64_t *out_part_lba,
                                        uint64_t *out_part_sectors,
                                        const char **out_detail);

/* Parse and fully range-check an exFAT boot sector.
 * `sectors_available` is how many sectors exist from the boot sector onward —
 * the card size for a volume at LBA 0, or the MBR partition length (capped to
 * what is left on the card) for a partitioned one. Every field is checked
 * against it and against the others, so a caller that then walks the volume
 * can only ever compute sector numbers that lie inside it.
 * Returns false — with a token in *why — on anything that does not add up. */
bool fos_sd_parse_exfat_vbr(const uint8_t *sec, size_t len,
                            uint64_t sectors_available,
                            fos_sd_exfat_vbr_t *out, const char **why);

/* Scan a buffer of 32-byte exFAT directory entries. `len` must be a non-zero
 * multiple of 32. */
fos_sd_dir_result_t fos_sd_scan_dir_entries(const uint8_t *buf, size_t len,
                                            const char **out_detail);

/* Pull the next cluster out of a FAT sector. `byte_in_sector` is the offset of
 * the wanted 4-byte entry. Sets *out_end for the end-of-chain marker. Returns
 * false on any value that is not a legal successor. */
bool fos_sd_exfat_next_cluster(const uint8_t *fat_sector, size_t len,
                               uint32_t byte_in_sector, uint32_t cluster_count,
                               uint32_t *out_next, bool *out_end,
                               const char **why);

/* Full probe: sector 0 -> optional MBR -> exFAT VBR -> root directory walk.
 * `scratch` must be at least FOS_SD_PROBE_SCRATCH_BYTES and, on target,
 * DMA-capable. `*out_detail` receives the token that goes into the "probe"
 * field of the assets:sd log line. Read-only from start to finish. */
fos_sd_probe_verdict_t fos_sd_probe_run(fos_sd_read_fn read_fn, void *ctx,
                                        uint64_t card_sectors,
                                        uint8_t *scratch, size_t scratch_len,
                                        const char **out_detail);
