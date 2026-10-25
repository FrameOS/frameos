#include "it8951.h"

#include <string.h>

/* A big-endian 4-bit load takes pixels in wire order, the first pixel in the
 * high nibble of the first byte: the packed buffer's own layout, so a row
 * goes out as it is. (Little-endian loads are where the sources disagree on
 * the nibble order; nothing here uses one.) The E1003's columns run right to
 * left, so its rows go out reversed, nibbles and all (Seeed's GxEPD2 and
 * Gray16 examples, FastEPD's BB_PANEL_FLAG_MIRROR_X for the ED103TC2,
 * Zephyr's `h-mirror` for this board). */
void fos_it8951_row_wire(const uint8_t *packed, size_t bytes, bool mirror_x, uint8_t *out)
{
    if (!mirror_x) {
        memcpy(out, packed, bytes);
        return;
    }
    for (size_t i = 0; i < bytes; i++) {
        uint8_t pair = packed[bytes - 1 - i];
        out[i] = (uint8_t)((pair >> 4) | (pair << 4));
    }
}

/* Two 32-bit lanes over the row's 32-bit words (64-bit multiplies are a
 * library call on the S3): FNV-1a and a murmur-style rotate-multiply. A full
 * frame is 330k words, a few milliseconds. */
uint64_t fos_it8951_row_hash(const uint8_t *row, size_t bytes)
{
    uint32_t a = 0x811C9DC5u;
    uint32_t b = 0x9747B28Cu ^ (uint32_t)bytes;
    size_t i = 0;
    for (; i + 4 <= bytes; i += 4) {
        uint32_t word = (uint32_t)row[i] | ((uint32_t)row[i + 1] << 8) | ((uint32_t)row[i + 2] << 16) |
                        ((uint32_t)row[i + 3] << 24);
        a = (a ^ word) * 0x01000193u;
        b += word * 0xCC9E2D51u;
        b = ((b << 15) | (b >> 17)) * 0x1B873593u;
    }
    for (; i < bytes; i++) {
        a = (a ^ row[i]) * 0x01000193u;
        b = (b ^ row[i]) * 0x1B873593u;
    }
    b ^= b >> 16;
    b *= 0x85EBCA6Bu;
    b ^= b >> 13;
    return ((uint64_t)a << 32) | b;
}

#ifdef ESP_PLATFORM
#include <stdio.h>

#include "esp_heap_caps.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"

#include "DEV_Config.h"

#define CMD_SYS_RUN 0x0001
#define CMD_STANDBY 0x0002
#define CMD_REG_READ 0x0010
#define CMD_REG_WRITE 0x0011
#define CMD_LOAD_AREA 0x0021
#define CMD_LOAD_END 0x0022
#define CMD_DISPLAY_AREA 0x0034
#define CMD_VCOM 0x0039
#define CMD_TEMPERATURE 0x0040
#define CMD_DEVICE_INFO 0x0302

/* Every word on the bus follows a preamble saying what it is. */
#define PREAMBLE_COMMAND 0x6000
#define PREAMBLE_WRITE 0x0000
#define PREAMBLE_READ 0x1000

#define REG_I80CPCR 0x0004 /* 1 = packed writes */
#define REG_LISAR 0x0208   /* where the next image load lands, low word; +2 the high word */
#define REG_LUTAFSR 0x1224 /* non-zero while a waveform is still running */

#define LOAD_BIG_ENDIAN (1u << 8)
#define LOAD_4BPP (2u << 4)

#define MODE_INIT 0 /* the full clear */
#define MODE_GC16 2 /* sixteen greys, full flash */

#define WIDTH FOS_IT8951_10IN3_WIDTH
#define HEIGHT FOS_IT8951_10IN3_HEIGHT
#define ROW_BYTES ((size_t)WIDTH / 2u)
/* Rows per SPI transaction: one DMA transfer stays under the bus's 4 KB. */
#define CHUNK_ROWS 4
/* Unchanged rows between two changed ones still go up when there are this
 * few: a separate load costs about as much as two rows on the wire. */
#define MERGE_GAP_ROWS 2

/* The controller answers a word in microseconds; it boots from its own flash
 * after a reset, which takes longer. A GC16 refresh of the whole panel is a
 * second or two (Zephyr allows 40 s for the worst case). */
#define READY_TIMEOUT_MS 5000
#define REFRESH_TIMEOUT_MS 40000
#define REFRESH_POLL_MS 20
/* Without a reading the E1003 is told what Seeed's own examples tell it. */
#define DEFAULT_TEMPERATURE_C 16

typedef struct {
    uint16_t vcom_mv;
    bool mirror_x;
    bool set_temperature;
} variant_t;

static const variant_t k_variants[] = {
    /* The Waveshare HAT: the VCOM on the Pi driver's default (-1.50 V; the
     * panel's own is printed on its cable), columns left to right, and a
     * controller that reads its own temperature. */
    [FOS_IT8951_VARIANT_WAVESHARE] = {1500, false, false},
    /* Seeed reTerminal E1003: -1.40 V (Seeed's drivers, Zephyr's board
     * file), mirrored, and no sensor on the controller: without a
     * temperature it takes the display command and skips the refresh
     * (Seeed's GxEPD2 driver says as much). */
    [FOS_IT8951_VARIANT_SEEED_E1003] = {1400, true, true},
};

static variant_t s_variant = {1500, false, false};
static bool (*s_read_temperature)(int *celsius) = NULL;
static uint32_t s_image_addr = 0;
static bool s_powered = false;
static bool s_reported = false;
/* Brought up since the controller last lost power or failed: the next pass
 * wakes it from standby instead of resetting it. */
static bool s_ready = false;
/* What the controller's image memory holds, row by row, and which rows the
 * pass in hand changes: in PSRAM, allocated at the first picture. */
typedef struct {
    uint64_t hash[HEIGHT];
    uint8_t dirty[HEIGHT];
} rows_t;
static rows_t *s_rows = NULL;
/* s_rows->hash describes the controller's image memory. */
static bool s_rows_valid = false;
static int s_temperature = -1;
/* A step timed out: the rest of the pass is skipped rather than talking to
 * a controller that stopped listening, and the next one starts over. */
static bool s_failed = false;

void fos_it8951_set_variant(int variant)
{
    if (variant >= 0 && variant < (int)(sizeof(k_variants) / sizeof(k_variants[0]))) {
        s_variant = k_variants[variant];
    }
}

void fos_it8951_set_temperature_source(bool (*read_celsius)(int *celsius))
{
    s_read_temperature = read_celsius;
}

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

/* A failed step forgets everything the controller was known to hold. */
static void fail(void)
{
    s_failed = true;
    s_ready = false;
    s_rows_valid = false;
}

/* HRDY (the busy pin) is high when the controller takes the next word. */
static bool wait_ready(const char *stage)
{
    if (s_failed) return false;
    int64_t start = now_ms();
    int spins = 0;
    while (DEV_Digital_Read(EPD_BUSY_PIN) == 0) {
        if (++spins < 1000) {
            esp_rom_delay_us(1);
            continue;
        }
        if (now_ms() - start > READY_TIMEOUT_MS) {
            DEV_Error("IT8951 busy (HRDY low) for %d ms during %s", READY_TIMEOUT_MS, stage);
            fail();
            return false;
        }
        DEV_Delay_ms(1);
    }
    return true;
}

static void write_word(UWORD preamble, UWORD word, const char *stage)
{
    if (!wait_ready(stage)) return;
    DEV_Digital_Write(EPD_CS_PIN, 0);
    DEV_SPI_Transfer16(preamble);
    if (wait_ready(stage)) DEV_SPI_Transfer16(word);
    DEV_Digital_Write(EPD_CS_PIN, 1);
}

static void write_command(UWORD command)
{
    write_word(PREAMBLE_COMMAND, command, "command");
}

static void write_data(UWORD data)
{
    write_word(PREAMBLE_WRITE, data, "data");
}

static void command_args(UWORD command, const UWORD *args, size_t count)
{
    write_command(command);
    for (size_t i = 0; i < count; i++) write_data(args[i]);
}

/* The words the last command answers with, after the dummy word every read
 * starts with. */
static bool read_words(UWORD *out, size_t count)
{
    if (!wait_ready("read")) return false;
    DEV_Digital_Write(EPD_CS_PIN, 0);
    DEV_SPI_Transfer16(PREAMBLE_READ);
    bool ok = wait_ready("read");
    if (ok) DEV_SPI_Transfer16(0);
    for (size_t i = 0; ok && i < count; i++) {
        ok = wait_ready("read");
        if (ok) out[i] = DEV_SPI_Transfer16(0);
    }
    DEV_Digital_Write(EPD_CS_PIN, 1);
    return ok;
}

static bool read_register(UWORD reg, UWORD *value)
{
    write_command(CMD_REG_READ);
    write_data(reg);
    return read_words(value, 1);
}

static void write_register(UWORD reg, UWORD value)
{
    const UWORD args[] = {reg, value};
    command_args(CMD_REG_WRITE, args, 2);
}

static UWORD read_vcom(void)
{
    UWORD vcom = 0;
    write_command(CMD_VCOM);
    write_data(0);
    read_words(&vcom, 1);
    return vcom;
}

/* Firmwares differ on how VCOM is set: 1 (Waveshare's examples, FastEPD) or
 * 2 (Seeed's drivers, Zephyr). Only a value the controller does not already
 * hold is written, and the read-back says which one took. */
static UWORD apply_vcom(UWORD want)
{
    UWORD have = read_vcom();
    static const UWORD setters[] = {1, 2};
    for (size_t i = 0; i < sizeof(setters) / sizeof(setters[0]) && have != want && !s_failed; i++) {
        const UWORD args[] = {setters[i], want};
        command_args(CMD_VCOM, args, 2);
        have = read_vcom();
    }
    if (have != want && !s_failed) DEV_Error("IT8951 kept VCOM -%u mV, wanted -%u mV", have, want);
    return have;
}

static void apply_temperature(void)
{
    int celsius = DEFAULT_TEMPERATURE_C;
    if (s_read_temperature && !s_read_temperature(&celsius)) celsius = DEFAULT_TEMPERATURE_C;
    if (celsius < 0) celsius = 0;
    if (celsius > 50) celsius = 50;
    const UWORD args[] = {0x0001, (UWORD)celsius};
    command_args(CMD_TEMPERATURE, args, 2);
    s_temperature = celsius;
}

/* The controller's firmware and LUT names: eight words of ASCII each, low
 * byte first. */
static void words_to_text(const UWORD *words, size_t count, char *out, size_t out_len)
{
    size_t n = 0;
    for (size_t i = 0; i < count && n + 1 < out_len; i++) {
        char pair[2] = {(char)(words[i] & 0xFF), (char)(words[i] >> 8)};
        for (size_t j = 0; j < 2 && n + 1 < out_len; j++) {
            if (pair[j] == '\0') {
                out[n] = '\0';
                return;
            }
            out[n++] = (pair[j] >= 0x20 && pair[j] < 0x7f) ? pair[j] : '?';
        }
    }
    out[n] = '\0';
}

/* Power, reset and identify the controller: the first pass of a boot, and
 * any pass after one that failed. */
static int bring_up(void)
{
    s_ready = false;
    s_rows_valid = false;
    /* DEV_Module_Init switched the panel's and the controller's power on
     * (pins.pwr, pins.cs2) just before the first pass: let it settle. */
    if (!s_powered) {
        DEV_Delay_ms(100);
        s_powered = true;
    }
    DEV_Digital_Write(EPD_RST_PIN, 0);
    DEV_Delay_ms(10);
    DEV_Digital_Write(EPD_RST_PIN, 1);
    DEV_Delay_ms(50);
    if (!wait_ready("reset")) return 1;
    write_command(CMD_SYS_RUN);

    UWORD info[20] = {0};
    write_command(CMD_DEVICE_INFO);
    if (!read_words(info, 20)) return 1;
    if (info[0] != WIDTH || info[1] != HEIGHT) {
        DEV_Error("IT8951 drives a %ux%u panel, not EPD_10in3's %dx%d%s", info[0], info[1], WIDTH, HEIGHT,
                  info[0] == 0 || info[0] == 0xFFFF ? " (no answer on MISO: check pins.dc)" : "");
        fail();
        return 1;
    }
    s_image_addr = (uint32_t)info[2] | ((uint32_t)info[3] << 16);
    write_register(REG_I80CPCR, 1);
    if (s_variant.set_temperature) apply_temperature();
    UWORD vcom = apply_vcom(s_variant.vcom_mv);
    if (s_failed) return 1;
    if (!s_reported) {
        char firmware[17], lut[17];
        words_to_text(info + 4, 8, firmware, sizeof(firmware));
        words_to_text(info + 12, 8, lut, sizeof(lut));
        /* printf: WARN-only builds show it on the console too. */
        printf("it8951: %ux%u, image buffer 0x%08lx, firmware %s, LUT %s, VCOM -%u mV%s\n", info[0], info[1],
               (unsigned long)s_image_addr, firmware, lut, vcom, s_variant.mirror_x ? ", mirrored" : "");
        s_reported = true;
    }
    s_ready = true;
    return 0;
}

int fos_it8951_10in3_init(void)
{
    s_failed = false;
    if (s_ready) {
        /* Standby kept the controller's state and its picture: wake it. */
        write_command(CMD_SYS_RUN);
        if (s_variant.set_temperature) apply_temperature();
        if (!s_failed) return 0;
        s_failed = false;
    }
    return bring_up();
}

/* Rows [first, first + count) of `packed` (all white when NULL) into the
 * controller's image buffer, CHUNK_ROWS to a transfer from internal RAM:
 * the panel buffer is in PSRAM, which the SPI DMA would otherwise bounce
 * through a fresh copy per transfer. */
static void load_rows(const uint8_t *packed, int first, int count, uint8_t *chunk)
{
    write_register(REG_LISAR + 2, (UWORD)(s_image_addr >> 16));
    write_register(REG_LISAR, (UWORD)(s_image_addr & 0xFFFF));
    const UWORD args[] = {LOAD_BIG_ENDIAN | LOAD_4BPP, 0, (UWORD)first, WIDTH, (UWORD)count};
    command_args(CMD_LOAD_AREA, args, 5);
    if (!wait_ready("load")) return;
    DEV_Digital_Write(EPD_CS_PIN, 0);
    DEV_SPI_Transfer16(PREAMBLE_WRITE);
    for (int y = first; y < first + count; y += CHUNK_ROWS) {
        int rows = first + count - y < CHUNK_ROWS ? first + count - y : CHUNK_ROWS;
        if (!wait_ready("load")) break;
        if (packed) {
            for (int r = 0; r < rows; r++) {
                fos_it8951_row_wire(packed + (size_t)(y + r) * ROW_BYTES, ROW_BYTES, s_variant.mirror_x,
                                    chunk + (size_t)r * ROW_BYTES);
            }
        }
        DEV_SPI_Write_nByte(chunk, (uint32_t)((size_t)rows * ROW_BYTES));
    }
    DEV_Digital_Write(EPD_CS_PIN, 1);
    write_command(CMD_LOAD_END);
}

/* Run a waveform over rows [first, first + count) and wait for it to
 * finish: putting the controller in standby while it runs cuts the refresh
 * short. */
static void refresh(UWORD mode, int first, int count)
{
    const UWORD args[] = {0, (UWORD)first, WIDTH, (UWORD)count, mode};
    command_args(CMD_DISPLAY_AREA, args, 5);
    int64_t start = now_ms();
    UWORD running = 1;
    while (read_register(REG_LUTAFSR, &running) && running != 0) {
        if (now_ms() - start > REFRESH_TIMEOUT_MS) {
            DEV_Error("IT8951 refresh still running after %d ms (LUTAFSR 0x%04x)", REFRESH_TIMEOUT_MS, running);
            fail();
            return;
        }
        DEV_Delay_ms(REFRESH_POLL_MS);
    }
}

static uint8_t *chunk_buffer(void)
{
    uint8_t *chunk = heap_caps_malloc(ROW_BYTES * CHUNK_ROWS, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    if (!chunk) {
        DEV_Error("IT8951: no %u bytes of DMA memory for the transfer", (unsigned)(ROW_BYTES * CHUNK_ROWS));
        fail();
    }
    return chunk;
}

void fos_it8951_10in3_clear(void)
{
    uint8_t *chunk = chunk_buffer();
    if (!chunk) return;
    memset(chunk, 0xFF, ROW_BYTES * CHUNK_ROWS);
    load_rows(NULL, 0, HEIGHT, chunk);
    heap_caps_free(chunk);
    refresh(MODE_INIT, 0, HEIGHT);
    /* The next picture goes up whole. */
    s_rows_valid = false;
}

void fos_it8951_10in3_display(uint8_t *buf)
{
    int64_t start = now_ms();
    if (!s_rows) s_rows = heap_caps_malloc(sizeof(*s_rows), MALLOC_CAP_SPIRAM);
    uint8_t *chunk = chunk_buffer();
    if (!chunk) return;
    int first_dirty = 0, last_dirty = HEIGHT - 1, uploaded = 0;
    if (!s_rows) {
        /* No memory for the digests: every picture goes up whole. */
        load_rows(buf, 0, HEIGHT, chunk);
        uploaded = HEIGHT;
    } else {
        /* Which rows differ from what the controller holds: all of them
         * when it holds nothing known (a boot, a failure, a clear). The
         * digests are written now; a pass that fails marks them stale. */
        first_dirty = -1;
        last_dirty = -1;
        for (int y = 0; y < HEIGHT; y++) {
            uint64_t hash = fos_it8951_row_hash(buf + (size_t)y * ROW_BYTES, ROW_BYTES);
            s_rows->dirty[y] = !s_rows_valid || s_rows->hash[y] != hash;
            s_rows->hash[y] = hash;
            if (!s_rows->dirty[y]) continue;
            if (first_dirty < 0) first_dirty = y;
            last_dirty = y;
        }
        if (first_dirty < 0) {
            heap_caps_free(chunk);
            printf("it8951: no row changed, refresh skipped\n");
            return;
        }
        for (int y = first_dirty; y <= last_dirty && !s_failed;) {
            if (!s_rows->dirty[y]) {
                y++;
                continue;
            }
            /* A run of changed rows, carried over short gaps of unchanged ones. */
            int end = y + 1;
            for (int gap = 0; end <= last_dirty; end++) {
                gap = s_rows->dirty[end] ? 0 : gap + 1;
                if (gap > MERGE_GAP_ROWS) break;
            }
            while (!s_rows->dirty[end - 1]) end--;
            load_rows(buf, y, end - y, chunk);
            uploaded += end - y;
            y = end;
        }
    }
    heap_caps_free(chunk);
    int64_t loaded = now_ms();
    refresh(MODE_GC16, first_dirty, last_dirty - first_dirty + 1);
    if (s_failed) return;
    s_rows_valid = s_rows != NULL;
    printf("it8951: %d of %d rows up in %lld ms, GC16 over rows %d-%d in %lld ms", uploaded, HEIGHT,
           (long long)(loaded - start), first_dirty, last_dirty, (long long)(now_ms() - loaded));
    if (s_variant.set_temperature) printf(" at %d C", s_temperature);
    printf("\n");
}

void fos_it8951_10in3_sleep(void)
{
    /* Standby, not sleep: the controller keeps its picture, which is what
     * lets the next pass send only the rows that changed. The refresh has
     * already finished (refresh() waited for it). */
    write_command(CMD_STANDBY);
}
#endif /* ESP_PLATFORM */
