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

/* Where a tile column's bytes are in a packed row: the columns are in wire
 * order, so on a mirrored panel the first one is the right end of the row. */
static void tile_span(int col, bool mirror_x, size_t *offset, size_t *bytes)
{
    int left = col * FOS_IT8951_TILE_WIDTH;
    int right = left + FOS_IT8951_TILE_WIDTH;
    if (right > FOS_IT8951_10IN3_WIDTH) right = FOS_IT8951_10IN3_WIDTH;
    *bytes = (size_t)(right - left) / 2u;
    *offset = (size_t)(mirror_x ? FOS_IT8951_10IN3_WIDTH - right : left) / 2u;
}

/* Row by row over the buffer, a tile row's digests advancing together: a
 * tile's bytes are not contiguous, and PSRAM wants its reads in order. A word
 * at a time: every tile starts on a 4-byte boundary of its row (936 bytes, the
 * tiles 16 apart, the mirrored half tile 8 bytes), so one 32-bit load reads
 * what four byte loads and their shifts did (the same little-endian word, the
 * same digest). -O2: the firmware is built for size, and this loop reads the
 * whole 1.3 MB picture when nothing says where it changed. */
__attribute__((optimize("O2"))) void fos_it8951_tile_hash_area(const uint8_t *packed, bool mirror_x, uint32_t *out,
                                                               int first_row, int end_row, int first_col, int end_col)
{
    size_t row_bytes = FOS_IT8951_10IN3_WIDTH / 2u;
    size_t offsets[FOS_IT8951_TILE_COLS], words[FOS_IT8951_TILE_COLS];
    if (first_row < 0) first_row = 0;
    if (end_row > FOS_IT8951_TILE_ROWS) end_row = FOS_IT8951_TILE_ROWS;
    if (first_col < 0) first_col = 0;
    if (end_col > FOS_IT8951_TILE_COLS) end_col = FOS_IT8951_TILE_COLS;
    for (int col = first_col; col < end_col; col++) {
        size_t bytes;
        tile_span(col, mirror_x, &offsets[col], &bytes);
        words[col] = bytes / 4u;
    }
    for (int tile_row = first_row; tile_row < end_row; tile_row++) {
        uint32_t *hashes = out + (size_t)tile_row * FOS_IT8951_TILE_COLS;
        for (int col = first_col; col < end_col; col++) hashes[col] = 0x811C9DC5u;
        int first = tile_row * FOS_IT8951_TILE_HEIGHT;
        int end = first + FOS_IT8951_TILE_HEIGHT;
        if (end > FOS_IT8951_10IN3_HEIGHT) end = FOS_IT8951_10IN3_HEIGHT;
        for (int y = first; y < end; y++) {
            const uint8_t *row = packed + (size_t)y * row_bytes;
            for (int col = first_col; col < end_col; col++) {
                uint32_t hash = hashes[col];
                const uint32_t *at = (const uint32_t *)__builtin_assume_aligned(row + offsets[col], 4);
                for (size_t i = 0; i < words[col]; i++) {
                    hash = (hash ^ at[i]) * 0x01000193u;
                    hash ^= hash >> 15;
                }
                hashes[col] = hash;
            }
        }
    }
}

void fos_it8951_tile_hashes(const uint8_t *packed, bool mirror_x, uint32_t *out)
{
    fos_it8951_tile_hash_area(packed, mirror_x, out, 0, FOS_IT8951_TILE_ROWS, 0, FOS_IT8951_TILE_COLS);
}

bool fos_it8951_tile_range(const fos_it8951_rect_t *packed_rect, bool mirror_x, int *first_col, int *end_col,
                           int *first_row, int *end_row)
{
    int x = packed_rect->x, y = packed_rect->y, w = packed_rect->w, h = packed_rect->h;
    if (x >= FOS_IT8951_10IN3_WIDTH || y >= FOS_IT8951_10IN3_HEIGHT || w <= 0 || h <= 0) return false;
    if (x + w > FOS_IT8951_10IN3_WIDTH) w = FOS_IT8951_10IN3_WIDTH - x;
    if (y + h > FOS_IT8951_10IN3_HEIGHT) h = FOS_IT8951_10IN3_HEIGHT - y;
    int wire_x = mirror_x ? FOS_IT8951_10IN3_WIDTH - x - w : x;
    *first_col = wire_x / FOS_IT8951_TILE_WIDTH;
    *end_col = (wire_x + w - 1) / FOS_IT8951_TILE_WIDTH + 1;
    *first_row = y / FOS_IT8951_TILE_HEIGHT;
    *end_row = (y + h - 1) / FOS_IT8951_TILE_HEIGHT + 1;
    return true;
}

static bool rects_near(const fos_it8951_rect_t *a, const fos_it8951_rect_t *b)
{
    int gap_x = FOS_IT8951_MERGE_GAP_COLS * FOS_IT8951_TILE_WIDTH;
    int gap_y = FOS_IT8951_MERGE_GAP_ROWS * FOS_IT8951_TILE_HEIGHT;
    return a->x <= b->x + b->w + gap_x && b->x <= a->x + a->w + gap_x && a->y <= b->y + b->h + gap_y &&
           b->y <= a->y + a->h + gap_y;
}

static void rect_union(fos_it8951_rect_t *into, const fos_it8951_rect_t *other)
{
    int left = into->x < other->x ? into->x : other->x;
    int top = into->y < other->y ? into->y : other->y;
    int right = into->x + into->w > other->x + other->w ? into->x + into->w : other->x + other->w;
    int bottom = into->y + into->h > other->y + other->h ? into->y + into->h : other->y + other->h;
    into->x = (uint16_t)left;
    into->y = (uint16_t)top;
    into->w = (uint16_t)(right - left);
    into->h = (uint16_t)(bottom - top);
}

static void rects_remove(fos_it8951_rect_t *rects, size_t *count, size_t index)
{
    rects[index] = rects[*count - 1];
    (*count)--;
}

/* Whatever touches or nearly touches is one rectangle: two waveforms over
 * the same pixels would run one over the other. */
static void rects_settle(fos_it8951_rect_t *rects, size_t *count)
{
    bool merged = true;
    while (merged) {
        merged = false;
        for (size_t i = 0; i < *count && !merged; i++) {
            for (size_t j = i + 1; j < *count && !merged; j++) {
                if (!rects_near(&rects[i], &rects[j])) continue;
                rect_union(&rects[i], &rects[j]);
                rects_remove(rects, count, j);
                merged = true;
            }
        }
    }
}

/* Past the limit the two rectangles that cost the least to join become one. */
static void rects_join_cheapest(fos_it8951_rect_t *rects, size_t *count)
{
    size_t best_i = 0, best_j = 1;
    long best_cost = -1;
    for (size_t i = 0; i < *count; i++) {
        for (size_t j = i + 1; j < *count; j++) {
            fos_it8951_rect_t joined = rects[i];
            rect_union(&joined, &rects[j]);
            long cost = (long)joined.w * joined.h - (long)rects[i].w * rects[i].h - (long)rects[j].w * rects[j].h;
            if (best_cost < 0 || cost < best_cost) {
                best_cost = cost;
                best_i = i;
                best_j = j;
            }
        }
    }
    rect_union(&rects[best_i], &rects[best_j]);
    rects_remove(rects, count, best_j);
}

size_t fos_it8951_tile_rects(const uint8_t *dirty, fos_it8951_rect_t *rects, size_t max)
{
    size_t count = 0;
    for (int tile_row = 0; tile_row < FOS_IT8951_TILE_ROWS; tile_row++) {
        const uint8_t *row = dirty + (size_t)tile_row * FOS_IT8951_TILE_COLS;
        for (int col = 0; col < FOS_IT8951_TILE_COLS;) {
            if (!row[col]) {
                col++;
                continue;
            }
            int end = col + 1;
            while (end < FOS_IT8951_TILE_COLS && row[end]) end++;
            int bottom = (tile_row + 1) * FOS_IT8951_TILE_HEIGHT;
            int right = end * FOS_IT8951_TILE_WIDTH;
            fos_it8951_rect_t span = {
                .x = (uint16_t)(col * FOS_IT8951_TILE_WIDTH),
                .y = (uint16_t)(tile_row * FOS_IT8951_TILE_HEIGHT),
                .w = (uint16_t)((right > FOS_IT8951_10IN3_WIDTH ? FOS_IT8951_10IN3_WIDTH : right) - col * FOS_IT8951_TILE_WIDTH),
                .h = (uint16_t)((bottom > FOS_IT8951_10IN3_HEIGHT ? FOS_IT8951_10IN3_HEIGHT : bottom) -
                                tile_row * FOS_IT8951_TILE_HEIGHT),
            };
            bool joined = false;
            for (size_t i = 0; i < count && !joined; i++) {
                if (rects_near(&rects[i], &span)) {
                    rect_union(&rects[i], &span);
                    joined = true;
                }
            }
            if (!joined) {
                if (count == max) rects_join_cheapest(rects, &count);
                rects[count++] = span;
            }
            rects_settle(rects, &count);
            col = end;
        }
    }
    return count;
}

/* rects_join_cheapest, and whatever the joined rectangle now covers goes:
 * it is sent with it. */
static void spans_join_cheapest(fos_it8951_rect_t *rects, size_t *count)
{
    rects_join_cheapest(rects, count);
    for (size_t i = 0; i < *count; i++) {
        for (size_t j = 0; j < *count;) {
            const fos_it8951_rect_t *a = &rects[i], *b = &rects[j];
            if (j != i && a->x <= b->x && a->y <= b->y && a->x + a->w >= b->x + b->w && a->y + a->h >= b->y + b->h) {
                rects_remove(rects, count, j);
                if (i == *count) i = j; /* the last one moved into j */
                continue;
            }
            j++;
        }
    }
}

size_t fos_it8951_tile_spans(const uint8_t *dirty, fos_it8951_rect_t *rects, size_t max)
{
    size_t count = 0;
    for (int tile_row = 0; tile_row < FOS_IT8951_TILE_ROWS; tile_row++) {
        const uint8_t *row = dirty + (size_t)tile_row * FOS_IT8951_TILE_COLS;
        int top = tile_row * FOS_IT8951_TILE_HEIGHT;
        int height = top + FOS_IT8951_TILE_HEIGHT > FOS_IT8951_10IN3_HEIGHT ? FOS_IT8951_10IN3_HEIGHT - top
                                                                             : FOS_IT8951_TILE_HEIGHT;
        for (int col = 0; col < FOS_IT8951_TILE_COLS;) {
            if (!row[col]) {
                col++;
                continue;
            }
            int end = col + 1;
            while (end < FOS_IT8951_TILE_COLS && row[end]) end++;
            int x = col * FOS_IT8951_TILE_WIDTH;
            int right = end * FOS_IT8951_TILE_WIDTH > FOS_IT8951_10IN3_WIDTH ? FOS_IT8951_10IN3_WIDTH : end * FOS_IT8951_TILE_WIDTH;
            bool extended = false;
            /* The same columns as a rectangle ending on the row above go on it. */
            for (size_t i = 0; i < count && !extended; i++) {
                if (rects[i].x == x && rects[i].w == right - x && rects[i].y + rects[i].h == top) {
                    rects[i].h = (uint16_t)(rects[i].h + height);
                    extended = true;
                }
            }
            if (!extended) {
                if (count == max) spans_join_cheapest(rects, &count);
                rects[count++] = (fos_it8951_rect_t){(uint16_t)x, (uint16_t)top, (uint16_t)(right - x), (uint16_t)height};
            }
            col = end;
        }
    }
    return count;
}

static const uint8_t k_bayer[16] = {0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5};

static uint8_t halftone_pixel(uint8_t level, uint8_t threshold)
{
    if (level == 0 || level == 15) return level;
    return (uint8_t)(level + threshold >= 16 ? 15 : 0);
}

void fos_it8951_row_halftone(uint8_t *wire, size_t bytes, int x, int y)
{
    const uint8_t *cells = k_bayer + (size_t)(y & 3) * 4u;
    for (size_t i = 0; i < bytes; i++) {
        int left = x + (int)i * 2;
        uint8_t high = halftone_pixel((uint8_t)(wire[i] >> 4), cells[left & 3]);
        uint8_t low = halftone_pixel((uint8_t)(wire[i] & 15u), cells[(left + 1) & 3]);
        wire[i] = (uint8_t)((high << 4) | low);
    }
}

bool fos_it8951_black_and_white(const uint8_t *wire, size_t bytes)
{
    for (size_t i = 0; i < bytes; i++) {
        uint8_t value = wire[i];
        /* Every nibble all ones or all zeros. */
        if ((uint8_t)(value ^ (value >> 1)) & 0x77u) return false;
    }
    return true;
}

bool fos_it8951_glass_wire_rect(int x, int y, int w, int h, bool mirror_x, fos_it8951_rect_t *out)
{
    const int width = FOS_IT8951_10IN3_WIDTH, height = FOS_IT8951_10IN3_HEIGHT;
    if (x < 0) {
        w += x;
        x = 0;
    }
    if (y < 0) {
        h += y;
        y = 0;
    }
    if (x + w > width) w = width - x;
    if (y + h > height) h = height - y;
    if (w <= 0 || h <= 0) return false;
    int wx = mirror_x ? width - x - w : x;
    int x0 = wx / FOS_IT8951_TILE_WIDTH * FOS_IT8951_TILE_WIDTH;
    int x1 = (wx + w + FOS_IT8951_TILE_WIDTH - 1) / FOS_IT8951_TILE_WIDTH * FOS_IT8951_TILE_WIDTH;
    int y0 = y / FOS_IT8951_TILE_HEIGHT * FOS_IT8951_TILE_HEIGHT;
    int y1 = (y + h + FOS_IT8951_TILE_HEIGHT - 1) / FOS_IT8951_TILE_HEIGHT * FOS_IT8951_TILE_HEIGHT;
    if (x1 > width) x1 = width;
    if (y1 > height) y1 = height;
    out->x = (uint16_t)x0;
    out->y = (uint16_t)y0;
    out->w = (uint16_t)(x1 - x0);
    out->h = (uint16_t)(y1 - y0);
    return true;
}

#ifdef ESP_PLATFORM
#include <stdarg.h>
#include <stdio.h>

#include "esp_heap_caps.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"

#include "DEV_Config.h"

/* The firmware's log ring (components/frameos_nim/fos_log_ring.c), when it is
 * linked: a printf here was a write to the 115200-baud console on the render
 * task, between a tap's upload and the next one, and behind a render's own
 * 2-3 KB of lines it waited 10-45 ms for room in the UART's buffer (a tap on
 * the reTerminal E1003, 2026-11-24). */
void fos_log_ring_puts(const char *line) __attribute__((weak));
/* Both cores over a job's rows (components/frameos_nim/fos_rows.c). */
typedef void (*it8951_rows_fn)(void *ctx, int32_t worker, int32_t first, int32_t last);
void fos_rows_run(it8951_rows_fn fn, void *ctx, int32_t rows, int32_t block) __attribute__((weak));

__attribute__((format(printf, 1, 2))) static void log_line(const char *fmt, ...)
{
    char line[200];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(line, sizeof(line), fmt, ap);
    va_end(ap);
    if (fos_log_ring_puts) {
        fos_log_ring_puts(line);
    } else {
        printf("%s\n", line);
    }
}

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
#define MODE_DU 1   /* black and white, no flash: what a tap is drawn with */
#define MODE_GC16 2 /* sixteen greys, full flash */

#define WIDTH FOS_IT8951_10IN3_WIDTH
#define HEIGHT FOS_IT8951_10IN3_HEIGHT
#define ROW_BYTES ((size_t)WIDTH / 2u)
/* One DMA transfer stays under the bus's 4 KB. */
#define CHUNK_BYTES (ROW_BYTES * 4u)

/* The controller answers a word in microseconds; it boots from its own flash
 * after a reset, which takes longer. A GC16 refresh of the whole panel is a
 * second or two (Zephyr allows 40 s for the worst case). */
#define READY_TIMEOUT_MS 5000
/* HRDY is spun on this long before a wait sleeps: a tick is 10 ms here
 * (CONFIG_FREERTOS_HZ 100), and the controller answers a word, or takes the
 * next area after a load, in well under that. */
#define READY_SPIN_US 5000
#define REFRESH_TIMEOUT_MS 40000
#define REFRESH_POLL_MS 20
/* How long a waveform runs (docs/realtime-rendering.md, measured on an E1003):
 * a wait for one reads LUTAFSR every tick until REFRESH_WAKE_EARLY_US before
 * it is due, then every REFRESH_SPIN_US until REFRESH_SPIN_MAX_US past it,
 * and every REFRESH_POLL_MS after that (a cold panel's waveform is longer).
 * Polled every 20 ms, the next picture went up 10 ms late on average. */
#define DU_US (470 * 1000LL)
#define GC16_US (580 * 1000LL)
#define INIT_US (2000 * 1000LL)
#define REFRESH_WAKE_EARLY_US (30 * 1000LL)
#define REFRESH_SPIN_US 500
#define REFRESH_SPIN_MAX_US (80 * 1000LL)
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
/* What the controller's image memory holds, tile by tile, and which tiles
 * the pass in hand changes: in PSRAM, allocated at the first picture. */
typedef struct {
    uint32_t hash[FOS_IT8951_TILES];
    uint32_t next[FOS_IT8951_TILES];
    uint8_t dirty[FOS_IT8951_TILES];
    /* Sent as a halftone while someone tapped: the greys are still owed. */
    uint8_t owed[FOS_IT8951_TILES];
    /* Changed outside the box the render gave (fos_it8951_10in3_hint), or
     * something not in any picture on the glass there (glass_rect): sent
     * with the next picture, whatever its box and the digests say. */
    uint8_t stale[FOS_IT8951_TILES];
} tiles_t;
static tiles_t *s_tiles = NULL;
/* s_tiles->hash describes the controller's image memory. */
static bool s_rows_valid = false;
/* The dirty map is for the picture about to go up. */
static bool s_damage_ready = false;
static long s_damage_bytes = 0;
/* A finger is waiting (fos_display_update): one DU, greys as a halftone. */
static bool s_interactive = false;
static bool s_owed_any = false;
static int s_temperature = -1;
/* In standby: the next pass wakes it first. */
static bool s_standby = true;
/* A waveform was started and nobody waited for it yet. The render task does
 * not sit out the 0.5-0.9 s the controller takes: it handles taps and draws
 * the next frame meanwhile, and waits here only before the next upload (the
 * waveform reads the image buffer it would overwrite), a clean, or standby
 * (which cuts a running refresh short). */
static bool s_waveform_pending = false;
/* A step timed out: the rest of the pass is skipped rather than talking to
 * a controller that stopped listening, and the next one starts over. */
static bool s_failed = false;
/* When the waveform started last ends, about (s_du_us, GC16_US). */
static int64_t s_waveform_due_us = 0;
static int64_t s_waveform_started_us = 0;
static UWORD s_waveform_mode = MODE_DU;
/* How long a DU runs on this glass, learned from the waits for one: the
 * controller holds HRDY until its waveform has run, so a wait that began
 * before then ends with it. DU_US until then. 340-365 ms on an E1003 at
 * 21 C (2026-11-26), where the 470 ms first measured would have a render
 * timed to the glass start 120 ms late (fos_display_glass_free_at). */
static int64_t s_du_us = DU_US;
/* The box the next `changed` hashes, in packed pixels (fos_it8951_10in3_hint). */
static bool s_hint_armed = false;
static fos_it8951_rect_t s_hint;
/* The dirty map came from the box: the whole picture is hashed once the
 * waveform is under way (verify_after_hint). */
static bool s_verify_owed = false;
static bool s_stale_any = false;
/* How long the last hash took, for the upload's log line. */
static int64_t s_hash_us = 0;
/* When the temperature was last given: a controller that stays up (USB
 * power, fos_display_keep_controller_awake) is told again every
 * TEMPERATURE_FRESH_US. */
static int64_t s_temperature_us = 0;
#define TEMPERATURE_FRESH_US (300 * 1000000LL)

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
    if (DEV_Digital_Read(EPD_BUSY_PIN) != 0) return true;
    int64_t spin_until = esp_timer_get_time() + READY_SPIN_US;
    while (DEV_Digital_Read(EPD_BUSY_PIN) == 0 && esp_timer_get_time() < spin_until) esp_rom_delay_us(2);
    int64_t start = now_ms();
    while (DEV_Digital_Read(EPD_BUSY_PIN) == 0) {
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
    if (ok) DEV_SPI_Read16(FOS_IT8951_SPI_READ_HZ);
    for (size_t i = 0; ok && i < count; i++) {
        ok = wait_ready("read");
        if (ok) out[i] = DEV_SPI_Read16(FOS_IT8951_SPI_READ_HZ);
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
    /* A read that fails (the bus is shared with the touch panel) keeps the
     * last reading: the waveform is chosen by this. */
    int celsius = s_temperature >= 0 ? s_temperature : DEFAULT_TEMPERATURE_C;
    int reading = celsius;
    if (s_read_temperature && s_read_temperature(&reading)) celsius = reading;
    if (celsius < 0) celsius = 0;
    if (celsius > 50) celsius = 50;
    const UWORD args[] = {0x0001, (UWORD)celsius};
    command_args(CMD_TEMPERATURE, args, 2);
    s_temperature = celsius;
    s_temperature_us = esp_timer_get_time();
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
        /* Not ESP_LOGI: WARN-only builds show it on the console too. */
        log_line("it8951: %ux%u, image buffer 0x%08lx, firmware %s, LUT %s, VCOM -%u mV%s", info[0], info[1],
                 (unsigned long)s_image_addr, firmware, lut, vcom, s_variant.mirror_x ? ", mirrored" : "");
        s_reported = true;
    }
    s_ready = true;
    return 0;
}

/* The temperature the waveform is chosen by, when the last one is old. */
static void temperature_due(void)
{
    if (!s_variant.set_temperature) return;
    if (esp_timer_get_time() - s_temperature_us < TEMPERATURE_FRESH_US) return;
    apply_temperature();
}

int fos_it8951_10in3_init(void)
{
    s_failed = false;
    if (s_ready && !s_standby) {
        /* Up already (never put in standby): the temperature when it is old,
         * nothing more. A full refresh sent SYS_RUN and read the SHT40 each
         * time. */
        temperature_due();
        if (!s_failed) return 0;
        s_failed = false;
    }
    if (s_ready) {
        /* Standby kept the controller's state and its picture: wake it. */
        int64_t start = esp_timer_get_time();
        write_command(CMD_SYS_RUN);
        if (s_variant.set_temperature) apply_temperature();
        if (!s_failed) {
            s_standby = false;
            log_line("it8951: out of standby in %lld ms", (long long)((esp_timer_get_time() - start) / 1000));
            return 0;
        }
        s_failed = false;
    }
    int64_t start = esp_timer_get_time();
    int err = bring_up();
    s_standby = err != 0;
    log_line("it8951: brought up in %lld ms%s", (long long)((esp_timer_get_time() - start) / 1000), err ? " (failed)" : "");
    return err;
}


/* A rectangle of `packed` (all white when NULL) into the controller's image
 * buffer, a few rows to a transfer from internal RAM: the panel buffer is in
 * PSRAM, which the SPI DMA would otherwise bounce through a fresh copy per
 * transfer. The rectangle is in wire coordinates. *black_and_white stays true
 * while every pixel sent was pure black or white. */
static void load_rect(const uint8_t *packed, const fos_it8951_rect_t *rect, uint8_t *chunk, bool halftone,
                      bool *black_and_white)
{
    size_t row_bytes = rect->w / 2u;
    size_t rows_per_chunk = CHUNK_BYTES / row_bytes;
    size_t packed_x = (size_t)(s_variant.mirror_x ? WIDTH - rect->x - rect->w : rect->x) / 2u;
    write_register(REG_LISAR + 2, (UWORD)(s_image_addr >> 16));
    write_register(REG_LISAR, (UWORD)(s_image_addr & 0xFFFF));
    const UWORD args[] = {LOAD_BIG_ENDIAN | LOAD_4BPP, rect->x, rect->y, rect->w, rect->h};
    command_args(CMD_LOAD_AREA, args, 5);
    if (!wait_ready("load")) return;
    DEV_Digital_Write(EPD_CS_PIN, 0);
    DEV_SPI_Transfer16(PREAMBLE_WRITE);
    for (int y = rect->y; y < rect->y + rect->h; y += (int)rows_per_chunk) {
        int rows = rect->y + rect->h - y < (int)rows_per_chunk ? rect->y + rect->h - y : (int)rows_per_chunk;
        if (!wait_ready("load")) break;
        if (packed) {
            for (int r = 0; r < rows; r++) {
                fos_it8951_row_wire(packed + (size_t)(y + r) * ROW_BYTES + packed_x, row_bytes, s_variant.mirror_x,
                                    chunk + (size_t)r * row_bytes);
            }
            if (black_and_white) {
                bool plain = fos_it8951_black_and_white(chunk, (size_t)rows * row_bytes);
                if (!plain) *black_and_white = false;
                if (!plain && halftone) {
                    for (int r = 0; r < rows; r++) {
                        fos_it8951_row_halftone(chunk + (size_t)r * row_bytes, row_bytes, rect->x, y + r);
                    }
                }
            }
        }
        DEV_SPI_Write_nByte(chunk, (uint32_t)((size_t)rows * row_bytes));
    }
    DEV_Digital_Write(EPD_CS_PIN, 1);
    write_command(CMD_LOAD_END);
}

static void start_waveform(UWORD mode, const fos_it8951_rect_t *rect)
{
    const UWORD args[] = {rect->x, rect->y, rect->w, rect->h, mode};
    command_args(CMD_DISPLAY_AREA, args, 5);
    /* The controller took the area when the last word went: one before it
     * ran first (HRDY held the words back). */
    s_waveform_started_us = esp_timer_get_time();
    s_waveform_mode = mode;
    s_waveform_due_us = s_waveform_started_us + (mode == MODE_DU ? s_du_us : mode == MODE_GC16 ? GC16_US : INIT_US);
}

/* The waveforms running finish first: putting the controller in standby
 * while one runs cuts the refresh short. LUTAFSR is read every tick until
 * shortly before the last one is due, then every half millisecond for a
 * while (the next picture goes up at once), and every REFRESH_POLL_MS after
 * that (a cold panel's waveform is longer). */
static void wait_waveforms(void)
{
    int64_t start = now_ms();
    UWORD running = 1;
    while (read_register(REG_LUTAFSR, &running) && running != 0) {
        if (now_ms() - start > REFRESH_TIMEOUT_MS) {
            DEV_Error("IT8951 refresh still running after %d ms (LUTAFSR 0x%04x)", REFRESH_TIMEOUT_MS, running);
            fail();
            return;
        }
        int64_t to_due = s_waveform_due_us - esp_timer_get_time();
        if (to_due > REFRESH_WAKE_EARLY_US) {
            DEV_Delay_ms(1); /* a tick */
        } else if (-to_due < REFRESH_SPIN_MAX_US) {
            esp_rom_delay_us(REFRESH_SPIN_US);
        } else {
            DEV_Delay_ms(REFRESH_POLL_MS);
        }
    }
}

static void finish_waveforms(void)
{
    if (!s_waveform_pending) return;
    s_waveform_pending = false;
    int64_t start = now_ms();
    int64_t start_us = esp_timer_get_time();
    wait_waveforms();
    int64_t end_us = esp_timer_get_time();
    int64_t waited = now_ms() - start;
    /* Arrived while a DU ran: it ended now, and that is how long one takes
     * here (smoothed; HRDY is spun on, so within a fraction of a ms). */
    int64_t ran_us = end_us - s_waveform_started_us;
    if (s_waveform_mode == MODE_DU && end_us - start_us > 2000 && !s_failed && ran_us > 100000 && ran_us < 2000000) {
        s_du_us = (s_du_us * 3 + ran_us) / 4;
    }
    if (waited > 20) {
        log_line("it8951: waited %lld ms for the last waveform (it ran %lld ms)", (long long)waited,
                 (long long)((esp_timer_get_time() - s_waveform_started_us) / 1000));
    }
}

static uint8_t *chunk_buffer(void)
{
    uint8_t *chunk = heap_caps_malloc(CHUNK_BYTES, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    if (!chunk) {
        DEV_Error("IT8951: no %u bytes of DMA memory for the transfer", (unsigned)CHUNK_BYTES);
        fail();
    }
    return chunk;
}

static const fos_it8951_rect_t k_whole = {0, 0, WIDTH, HEIGHT};

static void forget_owed(void)
{
    if (s_tiles && s_owed_any) memset(s_tiles->owed, 0, sizeof(s_tiles->owed));
    s_owed_any = false;
}

/* The tiles under `rect` owe a GC16 (`owed`: its greys went up as a halftone)
 * or no longer do (pure black and white, which DU draws exactly). A ball that
 * crossed the panel left owed tiles behind it, all white again, and their
 * settle flashed a trail. */
static void set_owed(const fos_it8951_rect_t *rect, bool owed)
{
    for (int row = rect->y / FOS_IT8951_TILE_HEIGHT; row <= (rect->y + rect->h - 1) / FOS_IT8951_TILE_HEIGHT; row++) {
        for (int col = rect->x / FOS_IT8951_TILE_WIDTH; col <= (rect->x + rect->w - 1) / FOS_IT8951_TILE_WIDTH; col++) {
            s_tiles->owed[(size_t)row * FOS_IT8951_TILE_COLS + (size_t)col] = owed ? 1 : 0;
        }
    }
    if (owed) {
        s_owed_any = true;
    } else if (s_owed_any) {
        s_owed_any = memchr(s_tiles->owed, 1, sizeof(s_tiles->owed)) != NULL;
    }
}

void fos_it8951_10in3_clear(void)
{
    finish_waveforms();
    uint8_t *chunk = chunk_buffer();
    if (!chunk) return;
    memset(chunk, 0xFF, CHUNK_BYTES);
    load_rect(NULL, &k_whole, chunk, false, NULL);
    heap_caps_free(chunk);
    start_waveform(MODE_INIT, &k_whole);
    wait_waveforms();
    /* The next picture goes up whole. */
    s_rows_valid = false;
    s_damage_ready = false;
}

typedef struct {
    const uint8_t *buf;
    uint32_t *out;
    bool mirror_x;
} hash_job_t;

/* A band of tile rows: fos_rows_run's job, run on both cores. Plain values
 * and pointers only (fos_rows.c). */
static void hash_rows(void *ctx, int32_t worker, int32_t first, int32_t last)
{
    (void)worker;
    const hash_job_t *job = ctx;
    fos_it8951_tile_hash_area(job->buf, job->mirror_x, job->out, first, last, 0, FOS_IT8951_TILE_COLS);
}

/* Every tile's digest, on both cores where the firmware has the helper: 1.3 MB
 * of PSRAM read in about half the time. Not for the first picture after a
 * boot or a wake, which a task other than the render task may send (the wake
 * mark): the helper takes the priority of whoever first hands it a job. */
static void hash_whole(const uint8_t *buf, uint32_t *out)
{
    hash_job_t job = {buf, out, s_variant.mirror_x};
    if (fos_rows_run && s_rows_valid) {
        fos_rows_run(hash_rows, &job, FOS_IT8951_TILE_ROWS, 8);
    } else {
        hash_rows(&job, 0, 0, FOS_IT8951_TILE_ROWS);
    }
}

/* Digests of `buf` against what the controller holds. False without memory
 * for them: every picture then goes up whole. With a box from the render
 * (fos_it8951_10in3_hint) only its tiles are read; the rest is checked once
 * the waveform runs (verify_after_hint). */
static bool compute_damage(const uint8_t *buf)
{
    if (!s_tiles) {
        s_tiles = heap_caps_calloc(1, sizeof(*s_tiles), MALLOC_CAP_SPIRAM);
    }
    bool hinted = s_hint_armed && s_rows_valid && s_tiles;
    s_hint_armed = false;
    if (!s_tiles) return false;
    int64_t start = esp_timer_get_time();
    if (hinted) {
        memset(s_tiles->dirty, 0, sizeof(s_tiles->dirty));
        int first_col, end_col, first_row, end_row;
        if (fos_it8951_tile_range(&s_hint, s_variant.mirror_x, &first_col, &end_col, &first_row, &end_row)) {
            fos_it8951_tile_hash_area(buf, s_variant.mirror_x, s_tiles->next, first_row, end_row, first_col, end_col);
            for (int row = first_row; row < end_row; row++) {
                for (int col = first_col; col < end_col; col++) {
                    size_t i = (size_t)row * FOS_IT8951_TILE_COLS + (size_t)col;
                    if (s_tiles->next[i] == s_tiles->hash[i]) continue;
                    s_tiles->dirty[i] = 1;
                    s_tiles->hash[i] = s_tiles->next[i];
                }
            }
        }
        s_verify_owed = true;
    } else {
        hash_whole(buf, s_tiles->next);
        for (size_t i = 0; i < FOS_IT8951_TILES; i++) {
            s_tiles->dirty[i] = !s_rows_valid || s_tiles->hash[i] != s_tiles->next[i];
        }
        memcpy(s_tiles->hash, s_tiles->next, sizeof(s_tiles->hash));
        s_verify_owed = false;
    }
    s_hash_us = esp_timer_get_time() - start;
    /* Owed greys go out once nobody is tapping (fos_display_settle_due);
     * tiles the last check found changed outside a box go out now. */
    bool owed = s_owed_any && !s_interactive;
    s_damage_bytes = 0;
    for (size_t i = 0; i < FOS_IT8951_TILES; i++) {
        if ((owed && s_tiles->owed[i]) || s_tiles->stale[i]) s_tiles->dirty[i] = 1;
        if (s_tiles->dirty[i]) s_damage_bytes += FOS_IT8951_TILE_WIDTH / 2 * FOS_IT8951_TILE_HEIGHT;
    }
    if (s_stale_any) {
        memset(s_tiles->stale, 0, sizeof(s_tiles->stale));
        s_stale_any = false;
    }
    s_damage_ready = true;
    return true;
}

/* After a picture whose dirty map came from the render's box: the whole
 * picture hashed, now that the waveform runs and the next upload has to wait
 * for it anyway. A tile that changed outside the box goes up with the next
 * picture (`stale`, fos_display_followup_due when none comes), and the line
 * says the box was wrong: something wrote the canvas that the render did not
 * count (frameos_nim_render_damage). */
static void verify_after_hint(const uint8_t *buf)
{
    if (!s_verify_owed || !s_tiles) return;
    s_verify_owed = false;
    int64_t start = esp_timer_get_time();
    hash_whole(buf, s_tiles->next);
    int missed = 0;
    for (size_t i = 0; i < FOS_IT8951_TILES; i++) {
        if (s_tiles->next[i] == s_tiles->hash[i]) continue;
        s_tiles->hash[i] = s_tiles->next[i];
        s_tiles->stale[i] = 1;
        missed++;
    }
    if (missed) {
        s_stale_any = true;
        log_line("it8951: %d tile(s) changed outside the render's box, sent next (checked in %lld ms)", missed,
                 (long long)((esp_timer_get_time() - start) / 1000));
    }
}

void fos_it8951_10in3_hint(const fos_it8951_rect_t *packed_box)
{
    s_hint_armed = packed_box != NULL;
    if (packed_box) s_hint = *packed_box;
}

bool fos_it8951_10in3_stale(void)
{
    return s_stale_any;
}

long fos_it8951_10in3_changed(const uint8_t *buf)
{
    if (!compute_damage(buf) || !s_rows_valid) return -1;
    return s_damage_bytes;
}

/* The rectangles the digests found, or the whole panel without digests. */
static size_t damaged_rects(const uint8_t *buf, fos_it8951_rect_t *rects)
{
    if (!s_damage_ready) compute_damage(buf);
    if (!s_damage_ready) {
        rects[0] = k_whole;
        return 1;
    }
    s_damage_ready = false;
    if (s_interactive) {
        /* One waveform covers them all, so only what goes on the wire counts:
         * the changed tiles as they are, not the box around a moved crosshair. */
        return fos_it8951_tile_spans(s_tiles->dirty, rects, FOS_IT8951_MAX_RECTS_INTERACTIVE);
    }
    return fos_it8951_tile_rects(s_tiles->dirty, rects, s_interactive ? FOS_IT8951_MAX_RECTS_INTERACTIVE : FOS_IT8951_MAX_RECTS);
}

void fos_it8951_10in3_display(uint8_t *buf)
{
    int64_t start = now_ms();
    fos_it8951_rect_t rects[FOS_IT8951_MAX_RECTS_INTERACTIVE];
    size_t count = damaged_rects(buf, rects);
    if (count == 0) {
        log_line("it8951: nothing changed, refresh skipped");
        verify_after_hint(buf);
        return;
    }
    finish_waveforms();
    temperature_due();
    uint8_t *chunk = chunk_buffer();
    if (!chunk) return;
    for (size_t i = 0; i < count && !s_failed; i++) load_rect(buf, &rects[i], chunk, false, NULL);
    heap_caps_free(chunk);
    int64_t loaded = now_ms();
    /* The whole panel, whatever went up: this is the path a new scene and
     * the periodic ghost clearing take. */
    start_waveform(MODE_GC16, &k_whole);
    if (s_failed) return;
    s_waveform_pending = true;
    s_rows_valid = s_tiles != NULL;
    forget_owed();
    log_line("it8951: %u rect(s) up in %lld ms (hash %lld ms), GC16 started at %d C", (unsigned)count,
             (long long)(loaded - start), (long long)(s_hash_us / 1000), s_temperature);
    verify_after_hint(buf);
}

void fos_it8951_10in3_partial_init(void)
{
    fos_it8951_10in3_init();
}

void fos_it8951_10in3_partial_show(uint8_t *buf, uint8_t *previous)
{
    (void)previous;
    /* The rest after ten idle seconds left it in standby. */
    if (s_standby && fos_it8951_10in3_init() != 0) return;
    if (s_failed) return;
    int64_t start = now_ms();
    fos_it8951_rect_t rects[FOS_IT8951_MAX_RECTS_INTERACTIVE];
    size_t count = damaged_rects(buf, rects);
    if (count == 0) {
        verify_after_hint(buf);
        return;
    }
    finish_waveforms();
    temperature_due();
    uint8_t *chunk = chunk_buffer();
    if (!chunk) return;
    bool plain[FOS_IT8951_MAX_RECTS_INTERACTIVE];
    for (size_t i = 0; i < count && !s_failed; i++) {
        plain[i] = true;
        load_rect(buf, &rects[i], chunk, s_interactive, &plain[i]);
    }
    heap_caps_free(chunk);
    int64_t loaded = now_ms();
    int grey = 0;
    for (size_t i = 0; i < count; i++) {
        if (!plain[i]) grey++;
    }
    if (s_interactive && s_tiles) {
        /* One waveform for all of it: DU moves only the pixels that change, so
         * the rectangle costs nothing where they did not, and the rest of the
         * picture does not flash. Each GC16 would be 0.6 s, one after another. */
        fos_it8951_rect_t all = rects[0];
        for (size_t i = 1; i < count; i++) rect_union(&all, &rects[i]);
        start_waveform(MODE_DU, &all);
        for (size_t i = 0; i < count; i++) set_owed(&rects[i], !plain[i]);
    } else {
        for (size_t i = 0; i < count && !s_failed; i++) {
            /* The controller takes the next area when it can: HRDY holds the
             * words back, so this is no slower than waiting here. */
            start_waveform(plain[i] ? MODE_DU : MODE_GC16, &rects[i]);
        }
        forget_owed();
    }
    if (s_failed) return;
    s_waveform_pending = true;
    log_line("it8951: partial%s, %u rect(s) (%d grey) up in %lld ms (hash %lld ms), waveform started, %ux%u@%u,%u first",
             s_interactive ? " fast" : "", (unsigned)count, grey, (long long)(loaded - start),
             (long long)(s_hash_us / 1000), rects[0].w, rects[0].h, rects[0].x, rects[0].y);
    verify_after_hint(buf);
}

void fos_it8951_10in3_set_interactive(bool interactive)
{
    s_interactive = interactive;
}

bool fos_it8951_10in3_owed(void)
{
    return s_owed_any || s_stale_any;
}

bool fos_it8951_10in3_glass_rect(const uint8_t *buf, int x, int y, int w, int h)
{
    if (s_standby && fos_it8951_10in3_init() != 0) return false;
    /* Nothing to put back without the digests of what the controller holds. */
    if (s_failed || !s_tiles || !s_rows_valid || !buf) return false;
    fos_it8951_rect_t rect;
    if (!fos_it8951_glass_wire_rect(x, y, w, h, s_variant.mirror_x, &rect)) return false;
    finish_waveforms();
    uint8_t *chunk = chunk_buffer();
    if (!chunk) return false;
    load_rect(buf, &rect, chunk, false, NULL);
    heap_caps_free(chunk);
    if (s_failed) return false;
    start_waveform(MODE_DU, &rect);
    if (s_failed) return false;
    s_waveform_pending = true;
    for (int row = rect.y / FOS_IT8951_TILE_HEIGHT; row <= (rect.y + rect.h - 1) / FOS_IT8951_TILE_HEIGHT; row++) {
        for (int col = rect.x / FOS_IT8951_TILE_WIDTH; col <= (rect.x + rect.w - 1) / FOS_IT8951_TILE_WIDTH; col++) {
            s_tiles->stale[(size_t)row * FOS_IT8951_TILE_COLS + (size_t)col] = 1;
        }
    }
    s_stale_any = true;
    return true;
}

void fos_it8951_10in3_wait(void)
{
    finish_waveforms();
}

int64_t fos_it8951_10in3_free_at(void)
{
    return s_waveform_pending && !s_failed ? s_waveform_due_us : 0;
}

void fos_it8951_10in3_rest(void)
{
    finish_waveforms();
    write_command(CMD_STANDBY);
    s_standby = true;
}

void fos_it8951_10in3_clean(void)
{
    if (s_failed || !s_rows_valid) return;
    finish_waveforms();
    start_waveform(MODE_GC16, &k_whole);
    if (!s_failed) s_waveform_pending = true;
    log_line("it8951: clean, GC16 started");
}

void fos_it8951_10in3_sleep(void)
{
    /* Standby, not sleep: the controller keeps its picture, which is what
     * lets the next pass send only what changed. A refresh still running
     * finishes first. */
    finish_waveforms();
    write_command(CMD_STANDBY);
    s_standby = true;
}
#endif /* ESP_PLATFORM */
