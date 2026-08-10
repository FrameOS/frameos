/*
 * Host tests for the SD "provably empty" probe. No IDF, no CMake, no mocks —
 * fos_sd_probe.c is deliberately pure C over byte buffers so it can be run and
 * argued about on a laptop.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_sd_probe.c main/tests/test_fos_sd_probe.c -o /tmp/test_fos_sd_probe \
 *      && /tmp/test_fos_sd_probe
 *
 * The bias under test is one-directional: a wrong "blank" erases somebody's
 * photos, a wrong "refuse" costs them one `sd format`. So most cases below
 * assert a refusal, and each asserts the exact reason token that ends up in
 * the "probe" field of the assets:sd log line.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fos_sd_probe.h"

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(cond, ...)                                                       \
    do {                                                                       \
        g_checks++;                                                            \
        if (!(cond)) {                                                         \
            g_failures++;                                                      \
            printf("FAIL %s:%d: ", __func__, __LINE__);                        \
            printf(__VA_ARGS__);                                               \
            printf("\n");                                                      \
        }                                                                      \
    } while (0)

static void expect(const char *name, fos_sd_probe_verdict_t got_verdict,
                   const char *got_detail, fos_sd_probe_verdict_t want_verdict,
                   const char *want_detail)
{
    g_checks++;
    /* fos_sd_probe promises *out_detail is always set, but the compiler cannot
     * prove the callee wrote it — GCC rejects the bare strcmp with -Wnonnull.
     * Substituting a token keeps that a loud test failure (a NULL detail IS a
     * broken contract) instead of a segfault or a suppressed warning. */
    const char *got = got_detail ? got_detail : "(null detail)";
    if (got_verdict != want_verdict || strcmp(got, want_detail) != 0) {
        g_failures++;
        printf("FAIL %-38s got verdict=%d detail=%s, want verdict=%d detail=%s\n",
               name, (int)got_verdict, got, (int)want_verdict, want_detail);
    } else {
        printf("ok   %-38s verdict=%d %s\n", name, (int)got_verdict, got);
    }
}

/* Run a probe and check it, with the call sequenced BEFORE the detail is read.
 *
 * `EXPECT_RUN(name, run(c, &d), d, ...)` looks fine and is not: C does not order
 * function arguments, so `d` may be read before `run` writes it. clang happened
 * to evaluate the call first, so these assertions passed for as long as this
 * file was only ever built by hand on a Mac; under GCC all 32 of them compared
 * against the initial NULL. Assigning to a local first is a sequence point. */
#define EXPECT_RUN(name, call, detail_var, want_verdict, want_detail)          \
    do {                                                                       \
        fos_sd_probe_verdict_t got_verdict_ = (call);                          \
        expect((name), got_verdict_, (detail_var), (want_verdict),             \
               (want_detail));                                                 \
    } while (0)

/* --------------------------------------------------------------------- */
/* A fake card: a flat sector array plus an optional injected read error.  */

typedef struct {
    uint8_t *data;
    uint64_t sectors;
    long fail_lba; /* -1 = reads always succeed */
    int reads;
} fake_card_t;

static bool fake_read(void *ctx, uint64_t lba, uint32_t count, uint8_t *dst)
{
    fake_card_t *c = (fake_card_t *)ctx;
    c->reads++;
    if (c->fail_lba >= 0 && lba == (uint64_t)c->fail_lba) return false;
    if (lba + count > c->sectors) return false;
    memcpy(dst, c->data + lba * FOS_SD_SECTOR_BYTES, (size_t)count * FOS_SD_SECTOR_BYTES);
    return true;
}

static fake_card_t *card_new(uint64_t sectors, uint8_t fill)
{
    fake_card_t *c = calloc(1, sizeof(*c));
    c->data = malloc((size_t)sectors * FOS_SD_SECTOR_BYTES);
    memset(c->data, fill, (size_t)sectors * FOS_SD_SECTOR_BYTES);
    c->sectors = sectors;
    c->fail_lba = -1;
    return c;
}

static void card_free(fake_card_t *c)
{
    free(c->data);
    free(c);
}

static uint8_t *sec_of(fake_card_t *c, uint64_t lba)
{
    return c->data + lba * FOS_SD_SECTOR_BYTES;
}

static fos_sd_probe_verdict_t run(fake_card_t *c, const char **detail)
{
    uint8_t scratch[FOS_SD_PROBE_SCRATCH_BYTES];
    *detail = "";
    return fos_sd_probe_run(fake_read, c, c->sectors, scratch, sizeof(scratch), detail);
}

/* --------------------------------------------------------------------- */
/* Little-endian writers                                                   */

static void put16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); }
static void put32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}
static void put64(uint8_t *p, uint64_t v) { put32(p, (uint32_t)v); put32(p + 4, (uint32_t)(v >> 32)); }

/* --------------------------------------------------------------------- */
/* Synthetic volumes                                                       */

typedef struct {
    uint64_t volume_length;
    uint32_t fat_offset;
    uint32_t fat_length;
    uint32_t heap_offset;
    uint32_t cluster_count;
    uint32_t root_cluster;
    uint8_t spc_shift;
    uint8_t num_fats;
} exfat_geom_t;

static exfat_geom_t default_geom(uint64_t volume_sectors)
{
    exfat_geom_t g = {0};
    g.volume_length = volume_sectors;
    g.fat_offset = 32;
    g.fat_length = 16; /* 2048 FAT entries, plenty for cluster_count below */
    g.heap_offset = 64;
    g.spc_shift = 3; /* 8 sectors = 4 KiB clusters */
    g.num_fats = 1;
    g.root_cluster = 2;
    g.cluster_count = (uint32_t)((volume_sectors - g.heap_offset) >> g.spc_shift);
    if (g.cluster_count > 1000) g.cluster_count = 1000;
    return g;
}

static void write_exfat_vbr(uint8_t *sec, const exfat_geom_t *g)
{
    memset(sec, 0, FOS_SD_SECTOR_BYTES);
    sec[0] = 0xEB; sec[1] = 0x76; sec[2] = 0x90;
    memcpy(sec + 3, "EXFAT   ", 8);
    /* bytes 11..63 stay zero: MustBeZero */
    put64(sec + 64, 0);                  /* PartitionOffset (informational) */
    put64(sec + 72, g->volume_length);
    put32(sec + 80, g->fat_offset);
    put32(sec + 84, g->fat_length);
    put32(sec + 88, g->heap_offset);
    put32(sec + 92, g->cluster_count);
    put32(sec + 96, g->root_cluster);
    put32(sec + 100, 0x12345678);        /* VolumeSerialNumber */
    put16(sec + 104, 0x0100);            /* FileSystemRevision 1.00 */
    put16(sec + 106, 0x0000);            /* VolumeFlags: clean */
    sec[108] = 9;                        /* BytesPerSectorShift: 512 */
    sec[109] = g->spc_shift;
    sec[110] = g->num_fats;
    sec[111] = 0x80;                     /* DriveSelect */
    sec[112] = 0;                        /* PercentInUse */
    sec[510] = 0x55; sec[511] = 0xAA;
}

/* Lay down a complete, mountable-looking exFAT volume at `base` whose root
 * directory contains only the three benign metadata entries. */
static void build_exfat(fake_card_t *c, uint64_t base, const exfat_geom_t *g)
{
    write_exfat_vbr(sec_of(c, base), g);

    /* FAT: media descriptor, end-of-chain, then end-of-chain for the root. */
    uint8_t *fat = sec_of(c, base + g->fat_offset);
    memset(fat, 0, (size_t)g->fat_length * FOS_SD_SECTOR_BYTES);
    put32(fat + 0, 0xFFFFFFF8u);
    put32(fat + 4, 0xFFFFFFFFu);
    put32(fat + (size_t)g->root_cluster * 4, 0xFFFFFFFFu);

    /* Root directory: allocation bitmap, up-case table, volume label, then
     * the end-of-directory marker. This is what mkfs writes on a fresh card. */
    uint64_t root_lba = base + g->heap_offset + ((uint64_t)(g->root_cluster - 2) << g->spc_shift);
    uint8_t *root = sec_of(c, root_lba);
    memset(root, 0, (size_t)FOS_SD_SECTOR_BYTES << g->spc_shift);
    root[0 * 32] = 0x81;
    root[1 * 32] = 0x82;
    root[2 * 32] = 0x83;
}

static uint64_t root_lba_of(uint64_t base, const exfat_geom_t *g)
{
    return base + g->heap_offset + ((uint64_t)(g->root_cluster - 2) << g->spc_shift);
}

static void write_mbr(uint8_t *sec, uint8_t type, uint32_t start, uint32_t count, int slot)
{
    memset(sec, 0, FOS_SD_SECTOR_BYTES);
    sec[0] = 0x33; sec[1] = 0xC0; /* plausible boot code */
    uint8_t *e = sec + 446 + slot * 16;
    e[0] = 0x00;      /* not bootable */
    e[1] = 0x20; e[2] = 0x21; e[3] = 0x00; /* CHS, ignored */
    e[4] = type;
    e[5] = 0xFE; e[6] = 0xFF; e[7] = 0xFF;
    put32(e + 8, start);
    put32(e + 12, count);
    sec[510] = 0x55; sec[511] = 0xAA;
}

/* --------------------------------------------------------------------- */
/* Tests                                                                   */

static void test_blank_zero(void)
{
    fake_card_t *c = card_new(8192, 0x00);
    const char *d = NULL;
    EXPECT_RUN("all-zero card", run(c, &d), d,
           FOS_SD_PROBE_BLANK_NO_FILESYSTEM, "blank_no_filesystem");
    card_free(c);

    /* And the pure classifier on its own, on one head buffer of zeroes. */
    uint8_t head[FOS_SD_HEAD_BYTES];
    memset(head, 0x00, sizeof(head));
    const char *detail = NULL;
    fos_sd_head_kind_t k = fos_sd_classify_head(head, sizeof(head), 0, 8192, NULL, NULL, &detail);
    CHECK(k == FOS_SD_HEAD_BLANK && strcmp(detail, "blank_no_filesystem") == 0,
          "classify_head(all zero) = %d/%s", (int)k, detail);
}

static void test_blank_ff(void)
{
    fake_card_t *c = card_new(8192, 0xFF);
    const char *d = NULL;
    EXPECT_RUN("0xFF-filled card", run(c, &d), d,
           FOS_SD_PROBE_BLANK_NO_FILESYSTEM, "blank_no_filesystem");
    card_free(c);
}

static void test_mixed_fill_refused(void)
{
    /* Half zeroes, half 0xFF: not uniform, no signature, nothing recognisable.
     * Not proof of anything, so it must not count as blank. */
    fake_card_t *c = card_new(8192, 0x00);
    memset(sec_of(c, 1), 0xFF, FOS_SD_SECTOR_BYTES);
    const char *d = NULL;
    EXPECT_RUN("mixed 0x00/0xFF fill", run(c, &d), d,
           FOS_SD_PROBE_REFUSE, "unrecognised_content");
    card_free(c);
}

static void test_exfat_empty_root(void)
{
    fake_card_t *c = card_new(8192, 0x00);
    exfat_geom_t g = default_geom(8192);
    build_exfat(c, 0, &g);
    const char *d = NULL;
    EXPECT_RUN("exFAT, empty root", run(c, &d), d, FOS_SD_PROBE_BLANK_EXFAT, "blank_exfat");
    card_free(c);
}

static void test_exfat_empty_root_in_partition(void)
{
    fake_card_t *c = card_new(16384, 0x00);
    write_mbr(sec_of(c, 0), 0x07 /* exFAT/NTFS type */, 2048, 16384 - 2048, 0);
    exfat_geom_t g = default_geom(16384 - 2048);
    build_exfat(c, 2048, &g);
    const char *d = NULL;
    EXPECT_RUN("MBR + exFAT, empty root", run(c, &d), d, FOS_SD_PROBE_BLANK_EXFAT, "blank_exfat");
    card_free(c);
}

static void test_exfat_with_file(void)
{
    fake_card_t *c = card_new(8192, 0x00);
    exfat_geom_t g = default_geom(8192);
    build_exfat(c, 0, &g);
    /* One 0x85 file entry after the metadata: the card has contents. */
    sec_of(c, root_lba_of(0, &g))[3 * 32] = 0x85;
    const char *d = NULL;
    EXPECT_RUN("exFAT with one 0x85 entry", run(c, &d), d, FOS_SD_PROBE_REFUSE, "exfat_has_files");
    card_free(c);
}

static void test_exfat_with_file_in_partition(void)
{
    /* The realistic disaster case: a 64 GB card straight from a Mac, full of
     * photos. FatFs reports FR_NO_FILESYSTEM for it exactly like a blank card. */
    fake_card_t *c = card_new(16384, 0x00);
    write_mbr(sec_of(c, 0), 0x07, 2048, 16384 - 2048, 0);
    exfat_geom_t g = default_geom(16384 - 2048);
    build_exfat(c, 2048, &g);
    sec_of(c, root_lba_of(2048, &g))[3 * 32] = 0x85;
    const char *d = NULL;
    EXPECT_RUN("MBR + exFAT holding photos", run(c, &d), d, FOS_SD_PROBE_REFUSE, "exfat_has_files");
    card_free(c);
}

static void test_exfat_deleted_entry(void)
{
    fake_card_t *c = card_new(8192, 0x00);
    exfat_geom_t g = default_geom(8192);
    build_exfat(c, 0, &g);
    sec_of(c, root_lba_of(0, &g))[3 * 32] = 0x05; /* in-use bit clear = deleted */
    const char *d = NULL;
    EXPECT_RUN("exFAT with a deleted entry", run(c, &d), d,
           FOS_SD_PROBE_REFUSE, "exfat_deleted_entries");
    card_free(c);
}

static void test_exfat_unknown_entry(void)
{
    fake_card_t *c = card_new(8192, 0x00);
    exfat_geom_t g = default_geom(8192);
    build_exfat(c, 0, &g);
    sec_of(c, root_lba_of(0, &g))[3 * 32] = 0xA0; /* in use, unrecognised */
    const char *d = NULL;
    EXPECT_RUN("exFAT with unknown in-use entry", run(c, &d), d,
           FOS_SD_PROBE_REFUSE, "exfat_unknown_entry");
    card_free(c);
}

static void test_exfat_dirty_volume(void)
{
    fake_card_t *c = card_new(8192, 0x00);
    exfat_geom_t g = default_geom(8192);
    build_exfat(c, 0, &g);
    put16(sec_of(c, 0) + 106, 0x0002); /* VolumeDirty */
    const char *d = NULL;
    EXPECT_RUN("exFAT flagged dirty", run(c, &d), d, FOS_SD_PROBE_REFUSE, "exfat_volume_dirty");
    card_free(c);
}

static void test_exfat_heap_beyond_card(void)
{
    fake_card_t *c = card_new(8192, 0x00);
    exfat_geom_t g = default_geom(8192);
    build_exfat(c, 0, &g);
    put32(sec_of(c, 0) + 88, 100000); /* ClusterHeapOffset past the volume */
    const char *d = NULL;
    EXPECT_RUN("exFAT heap offset past card", run(c, &d), d,
           FOS_SD_PROBE_REFUSE, "exfat_field_out_of_range");
    card_free(c);
}

static void test_exfat_volume_longer_than_card(void)
{
    fake_card_t *c = card_new(8192, 0x00);
    exfat_geom_t g = default_geom(8192);
    build_exfat(c, 0, &g);
    put64(sec_of(c, 0) + 72, 1ULL << 40); /* VolumeLength = 512 GiB */
    const char *d = NULL;
    EXPECT_RUN("exFAT volume longer than card", run(c, &d), d,
           FOS_SD_PROBE_REFUSE, "exfat_volume_larger_than_card");
    card_free(c);
}

static void test_exfat_short_fat(void)
{
    fake_card_t *c = card_new(8192, 0x00);
    exfat_geom_t g = default_geom(8192);
    build_exfat(c, 0, &g);
    put32(sec_of(c, 0) + 84, 1); /* FatLength too small for cluster_count */
    const char *d = NULL;
    EXPECT_RUN("exFAT FAT too short", run(c, &d), d, FOS_SD_PROBE_REFUSE, "exfat_fat_range");
    card_free(c);
}

static void test_exfat_bad_root_cluster(void)
{
    fake_card_t *c = card_new(8192, 0x00);
    exfat_geom_t g = default_geom(8192);
    build_exfat(c, 0, &g);
    put32(sec_of(c, 0) + 96, 0); /* root cluster 0 is not addressable */
    const char *d = NULL;
    EXPECT_RUN("exFAT root cluster 0", run(c, &d), d, FOS_SD_PROBE_REFUSE, "exfat_root_cluster");
    card_free(c);
}

static void test_exfat_4k_sectors(void)
{
    fake_card_t *c = card_new(8192, 0x00);
    exfat_geom_t g = default_geom(8192);
    build_exfat(c, 0, &g);
    sec_of(c, 0)[108] = 12; /* 4096-byte logical sectors: we cannot address it */
    const char *d = NULL;
    EXPECT_RUN("exFAT with 4K logical sectors", run(c, &d), d,
           FOS_SD_PROBE_REFUSE, "exfat_sector_size");
    card_free(c);
}

static void test_exfat_must_be_zero_dirty(void)
{
    fake_card_t *c = card_new(8192, 0x00);
    exfat_geom_t g = default_geom(8192);
    build_exfat(c, 0, &g);
    sec_of(c, 0)[20] = 0x01; /* MustBeZero region carries a FAT BPB byte */
    const char *d = NULL;
    EXPECT_RUN("exFAT MustBeZero violated", run(c, &d), d, FOS_SD_PROBE_REFUSE, "exfat_bad_vbr");
    card_free(c);
}

static void test_exfat_chain_cycle(void)
{
    fake_card_t *c = card_new(8192, 0x00);
    exfat_geom_t g = default_geom(8192);
    build_exfat(c, 0, &g);
    /* Fill the root cluster with benign entries so the scan never terminates
     * on an end-of-directory marker, then point the chain back at itself. */
    uint8_t *root = sec_of(c, root_lba_of(0, &g));
    for (size_t i = 0; i < ((size_t)FOS_SD_SECTOR_BYTES << g.spc_shift); i += 32) root[i] = 0x83;
    put32(sec_of(c, g.fat_offset) + 2 * 4, 2); /* cluster 2 -> cluster 2 */
    const char *d = NULL;
    EXPECT_RUN("exFAT root chain cycles", run(c, &d), d, FOS_SD_PROBE_REFUSE, "exfat_chain_cycle");
    card_free(c);
}

static void test_exfat_free_cluster_in_chain(void)
{
    fake_card_t *c = card_new(8192, 0x00);
    exfat_geom_t g = default_geom(8192);
    build_exfat(c, 0, &g);
    uint8_t *root = sec_of(c, root_lba_of(0, &g));
    for (size_t i = 0; i < ((size_t)FOS_SD_SECTOR_BYTES << g.spc_shift); i += 32) root[i] = 0x83;
    put32(sec_of(c, g.fat_offset) + 2 * 4, 0); /* free cluster mid-chain */
    const char *d = NULL;
    EXPECT_RUN("exFAT chain into a free cluster", run(c, &d), d,
           FOS_SD_PROBE_REFUSE, "exfat_bad_fat_entry");
    card_free(c);
}

static void test_fat32(void)
{
    fake_card_t *c = card_new(8192, 0x00);
    uint8_t *s = sec_of(c, 0);
    s[0] = 0xEB; s[1] = 0x58; s[2] = 0x90;
    memcpy(s + 3, "MSDOS5.0", 8);
    put16(s + 11, 512); s[13] = 8; put16(s + 14, 32); s[16] = 2;
    memcpy(s + 82, "FAT32   ", 8);
    s[510] = 0x55; s[511] = 0xAA;
    const char *d = NULL;
    EXPECT_RUN("FAT32 volume", run(c, &d), d, FOS_SD_PROBE_REFUSE, "fat_filesystem");
    card_free(c);
}

static void test_fat16_damaged_label(void)
{
    /* No recognisable FAT label, but a valid jump + BPB: still a FAT volume
     * with possibly recoverable photos on it. */
    fake_card_t *c = card_new(8192, 0x00);
    uint8_t *s = sec_of(c, 0);
    s[0] = 0xEB; s[1] = 0x3C; s[2] = 0x90;
    memcpy(s + 3, "GARBAGE!", 8);
    put16(s + 11, 512); s[13] = 4; put16(s + 14, 1); s[16] = 2;
    s[510] = 0x55; s[511] = 0xAA;
    const char *d = NULL;
    EXPECT_RUN("FAT with damaged label", run(c, &d), d, FOS_SD_PROBE_REFUSE, "fat_filesystem");
    card_free(c);
}

static void test_ntfs(void)
{
    fake_card_t *c = card_new(8192, 0x00);
    uint8_t *s = sec_of(c, 0);
    s[0] = 0xEB; s[1] = 0x52; s[2] = 0x90;
    memcpy(s + 3, "NTFS    ", 8);
    s[510] = 0x55; s[511] = 0xAA;
    const char *d = NULL;
    EXPECT_RUN("NTFS volume", run(c, &d), d, FOS_SD_PROBE_REFUSE, "ntfs_filesystem");
    card_free(c);
}

static void test_ext4(void)
{
    /* mkfs.ext4 zeroes bytes 0..1023, so sector 0 looks blank. The superblock
     * magic at 0x438 is the only thing between this card and a wipe. */
    fake_card_t *c = card_new(8192, 0x00);
    put16(c->data + 0x438, 0xEF53);
    const char *d = NULL;
    EXPECT_RUN("ext4 with zeroed sector 0", run(c, &d), d, FOS_SD_PROBE_REFUSE, "ext_filesystem");
    card_free(c);
}

static void test_hfs_plus(void)
{
    fake_card_t *c = card_new(8192, 0x00);
    c->data[1024] = 'H'; c->data[1025] = '+';
    const char *d = NULL;
    EXPECT_RUN("HFS+ volume header", run(c, &d), d, FOS_SD_PROBE_REFUSE, "hfs_plus_filesystem");
    card_free(c);
}

static void test_apfs(void)
{
    fake_card_t *c = card_new(8192, 0x00);
    memcpy(c->data + 32, "NXSB", 4);
    const char *d = NULL;
    EXPECT_RUN("APFS container superblock", run(c, &d), d, FOS_SD_PROBE_REFUSE, "apfs_filesystem");
    card_free(c);
}

static void test_gpt(void)
{
    fake_card_t *c = card_new(8192, 0x00);
    write_mbr(sec_of(c, 0), 0xEE, 1, 8191, 0);
    const char *d = NULL;
    EXPECT_RUN("GPT protective MBR", run(c, &d), d, FOS_SD_PROBE_REFUSE, "gpt_partitioned");
    card_free(c);
}

static void test_two_partitions(void)
{
    fake_card_t *c = card_new(16384, 0x00);
    write_mbr(sec_of(c, 0), 0x07, 2048, 4096, 0);
    uint8_t *e = sec_of(c, 0) + 446 + 16;
    e[4] = 0x83;
    put32(e + 8, 8192);
    put32(e + 12, 4096);
    const char *d = NULL;
    EXPECT_RUN("two partitions", run(c, &d), d, FOS_SD_PROBE_REFUSE, "mbr_multiple_partitions");
    card_free(c);
}

static void test_mbr_no_partitions(void)
{
    fake_card_t *c = card_new(8192, 0x00);
    memset(sec_of(c, 0), 0, FOS_SD_SECTOR_BYTES);
    sec_of(c, 0)[0] = 0x33; sec_of(c, 0)[1] = 0xC0;
    sec_of(c, 0)[510] = 0x55; sec_of(c, 0)[511] = 0xAA;
    const char *d = NULL;
    EXPECT_RUN("MBR with no partition entries", run(c, &d), d,
           FOS_SD_PROBE_REFUSE, "mbr_no_partitions");
    card_free(c);
}

static void test_partition_out_of_range(void)
{
    fake_card_t *c = card_new(8192, 0x00);
    write_mbr(sec_of(c, 0), 0x07, 2048, 1000000, 0);
    const char *d = NULL;
    EXPECT_RUN("partition larger than the card", run(c, &d), d,
           FOS_SD_PROBE_REFUSE, "mbr_partition_out_of_range");
    card_free(c);
}

static void test_partition_without_filesystem(void)
{
    /* Partition table pointing at a wiped volume. Deliberately refused: a card
     * whose boot sector was damaged looks exactly like this and its data may
     * still be recoverable, while a brand-new card never does. */
    fake_card_t *c = card_new(16384, 0x00);
    write_mbr(sec_of(c, 0), 0x07, 2048, 16384 - 2048, 0);
    const char *d = NULL;
    EXPECT_RUN("partitioned but unformatted", run(c, &d), d,
           FOS_SD_PROBE_REFUSE, "partition_without_filesystem");
    card_free(c);
}

static void test_garbage(void)
{
    fake_card_t *c = card_new(8192, 0x00);
    uint8_t *s = sec_of(c, 0);
    for (size_t i = 0; i < FOS_SD_SECTOR_BYTES; i++) s[i] = (uint8_t)(i * 7 + 13);
    s[510] = 0x00; s[511] = 0x00; /* no boot signature */
    const char *d = NULL;
    EXPECT_RUN("garbage sector 0", run(c, &d), d, FOS_SD_PROBE_REFUSE, "unrecognised_content");
    card_free(c);
}

static void test_read_error(void)
{
    fake_card_t *c = card_new(8192, 0x00);
    exfat_geom_t g = default_geom(8192);
    build_exfat(c, 0, &g);
    c->fail_lba = (long)root_lba_of(0, &g); /* root directory unreadable */
    const char *d = NULL;
    EXPECT_RUN("read error walking the root", run(c, &d), d, FOS_SD_PROBE_REFUSE, "read_error");
    card_free(c);

    fake_card_t *c2 = card_new(8192, 0x00);
    c2->fail_lba = 0; /* even sector 0 unreadable */
    const char *d2 = NULL;
    EXPECT_RUN("read error on sector 0", run(c2, &d2), d2, FOS_SD_PROBE_REFUSE, "read_error");
    card_free(c2);
}

static void test_truncated_buffers(void)
{
    uint8_t head[FOS_SD_HEAD_BYTES];
    memset(head, 0, sizeof(head));
    const char *detail = NULL;

    /* A single sector is not enough to rule out an ext/HFS+ superblock. */
    fos_sd_head_kind_t k = fos_sd_classify_head(head, FOS_SD_SECTOR_BYTES, 0, 8192, NULL, NULL, &detail);
    CHECK(k == FOS_SD_HEAD_REFUSE && strcmp(detail, "short_read") == 0,
          "classify_head(512 bytes) = %d/%s", (int)k, detail);

    exfat_geom_t g = default_geom(8192);
    write_exfat_vbr(head, &g);
    fos_sd_exfat_vbr_t vbr;
    const char *why = NULL;
    CHECK(!fos_sd_parse_exfat_vbr(head, 100, 8192, &vbr, &why) && strcmp(why, "short_read") == 0,
          "parse_exfat_vbr(truncated) why=%s", why);
    CHECK(fos_sd_parse_exfat_vbr(head, FOS_SD_SECTOR_BYTES, 8192, &vbr, &why),
          "parse_exfat_vbr(good) rejected: %s", why);
    CHECK(vbr.root_cluster == 2 && vbr.cluster_count == g.cluster_count &&
          vbr.sectors_per_cluster_shift == 3,
          "parsed geometry mismatch");

    /* A directory buffer whose length is not a whole number of entries. */
    uint8_t dir[64] = {0x81, 0};
    fos_sd_dir_result_t dres = fos_sd_scan_dir_entries(dir, 33, &detail);
    CHECK(dres == FOS_SD_DIR_REFUSE, "scan_dir_entries(len 33) = %d", (int)dres);
    dres = fos_sd_scan_dir_entries(dir, 0, &detail);
    CHECK(dres == FOS_SD_DIR_REFUSE, "scan_dir_entries(len 0) = %d", (int)dres);

    /* Scratch smaller than the documented minimum must never format. */
    fake_card_t *c = card_new(8192, 0x00);
    uint8_t small[64];
    detail = "";
    fos_sd_probe_verdict_t v = fos_sd_probe_run(fake_read, c, c->sectors, small, sizeof(small), &detail);
    CHECK(v == FOS_SD_PROBE_REFUSE, "probe_run(small scratch) = %d", (int)v);
    /* Unknown card size must never format either. */
    detail = "";
    uint8_t scratch[FOS_SD_PROBE_SCRATCH_BYTES];
    v = fos_sd_probe_run(fake_read, c, 0, scratch, sizeof(scratch), &detail);
    CHECK(v == FOS_SD_PROBE_REFUSE && strcmp(detail, "card_size_unknown") == 0,
          "probe_run(card_sectors 0) = %d/%s", (int)v, detail);
    card_free(c);
}

static void test_dir_scanner_units(void)
{
    const char *detail = NULL;
    uint8_t buf[128];

    memset(buf, 0, sizeof(buf));
    CHECK(fos_sd_scan_dir_entries(buf, sizeof(buf), &detail) == FOS_SD_DIR_END,
          "empty directory buffer should end the scan");

    memset(buf, 0, sizeof(buf));
    buf[0] = 0x81; buf[32] = 0x82; buf[64] = 0x83; buf[96] = 0x83;
    CHECK(fos_sd_scan_dir_entries(buf, sizeof(buf), &detail) == FOS_SD_DIR_CONTINUE,
          "all-metadata buffer should continue");

    memset(buf, 0, sizeof(buf));
    buf[0] = 0x81; buf[32] = 0x85;
    CHECK(fos_sd_scan_dir_entries(buf, sizeof(buf), &detail) == FOS_SD_DIR_REFUSE &&
          strcmp(detail, "exfat_has_files") == 0, "0x85 must refuse, got %s", detail);

    memset(buf, 0, sizeof(buf));
    buf[0] = 0xC0; /* stream extension with no preceding 0x85 */
    CHECK(fos_sd_scan_dir_entries(buf, sizeof(buf), &detail) == FOS_SD_DIR_REFUSE &&
          strcmp(detail, "exfat_unknown_entry") == 0, "0xC0 must refuse, got %s", detail);

    /* Every one of the 256 possible entry types must land somewhere explicit,
     * and only 0x00/0x81/0x82/0x83 may ever let the scan continue. */
    for (int t = 0; t < 256; t++) {
        memset(buf, 0, sizeof(buf));
        buf[0] = (uint8_t)t;
        buf[32] = 0x85; /* would refuse if the scan carried on past entry 0 */
        fos_sd_dir_result_t r = fos_sd_scan_dir_entries(buf, sizeof(buf), &detail);
        bool benign = (t == 0x81 || t == 0x82 || t == 0x83);
        bool end = (t == 0x00);
        if (end) {
            CHECK(r == FOS_SD_DIR_END, "type 0x%02x should end", t);
        } else if (benign) {
            CHECK(r == FOS_SD_DIR_REFUSE && strcmp(detail, "exfat_has_files") == 0,
                  "type 0x%02x should keep scanning and then hit the file", t);
        } else {
            CHECK(r == FOS_SD_DIR_REFUSE, "type 0x%02x should refuse", t);
        }
    }
}

static void test_next_cluster_units(void)
{
    uint8_t fat[FOS_SD_SECTOR_BYTES];
    memset(fat, 0, sizeof(fat));
    uint32_t next = 0;
    bool end = false;
    const char *why = NULL;

    put32(fat + 8, 0xFFFFFFFFu);
    CHECK(fos_sd_exfat_next_cluster(fat, sizeof(fat), 8, 100, &next, &end, &why) && end,
          "0xFFFFFFFF should be end-of-chain");

    put32(fat + 8, 0xFFFFFFF7u);
    CHECK(!fos_sd_exfat_next_cluster(fat, sizeof(fat), 8, 100, &next, &end, &why) &&
          strcmp(why, "exfat_bad_cluster") == 0, "bad-cluster marker should refuse");

    put32(fat + 8, 101); /* cluster_count 100 => max valid cluster is 101 */
    CHECK(fos_sd_exfat_next_cluster(fat, sizeof(fat), 8, 100, &next, &end, &why) &&
          !end && next == 101, "cluster_count+1 is the last legal cluster");

    put32(fat + 8, 102);
    CHECK(!fos_sd_exfat_next_cluster(fat, sizeof(fat), 8, 100, &next, &end, &why),
          "cluster past the heap should refuse");

    put32(fat + 8, 1);
    CHECK(!fos_sd_exfat_next_cluster(fat, sizeof(fat), 8, 100, &next, &end, &why),
          "reserved cluster 1 should refuse");

    CHECK(!fos_sd_exfat_next_cluster(fat, sizeof(fat), FOS_SD_SECTOR_BYTES - 2, 100, &next, &end, &why),
          "entry running off the end of the sector should refuse");
}

int main(void)
{
    test_blank_zero();
    test_blank_ff();
    test_mixed_fill_refused();
    test_exfat_empty_root();
    test_exfat_empty_root_in_partition();
    test_exfat_with_file();
    test_exfat_with_file_in_partition();
    test_exfat_deleted_entry();
    test_exfat_unknown_entry();
    test_exfat_dirty_volume();
    test_exfat_heap_beyond_card();
    test_exfat_volume_longer_than_card();
    test_exfat_short_fat();
    test_exfat_bad_root_cluster();
    test_exfat_4k_sectors();
    test_exfat_must_be_zero_dirty();
    test_exfat_chain_cycle();
    test_exfat_free_cluster_in_chain();
    test_fat32();
    test_fat16_damaged_label();
    test_ntfs();
    test_ext4();
    test_hfs_plus();
    test_apfs();
    test_gpt();
    test_two_partitions();
    test_mbr_no_partitions();
    test_partition_out_of_range();
    test_partition_without_filesystem();
    test_garbage();
    test_read_error();
    test_truncated_buffers();
    test_dir_scanner_units();
    test_next_cluster_units();

    printf("\n%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
