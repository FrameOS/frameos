#include "it8951.h"

#include <stddef.h>
#include <string.h>

/* Pixels go to the controller as one byte each, big-endian (the first byte
 * on the wire is the first pixel), in the order Seeed's own E1003 examples
 * send them (GxEPD2_reTerminal_E1003_Gray16, GxEPD2_ED103TC2_1872x1404):
 * twice the bytes of 4-bit pixels, but no nibble order to get wrong, and the
 * controller keeps the top four bits for its 16-level waveform anyway. The
 * E1003's columns run right to left, so its rows go out mirrored (Seeed's
 * drivers, FastEPD's BB_PANEL_FLAG_MIRROR_X for the ED103TC2, Zephyr's
 * `h-mirror` for this board). */
void fos_it8951_row_8bpp(const uint8_t *packed, int width, bool mirror_x, uint8_t *out)
{
    for (int x = 0; x < width; x++) {
        int source = mirror_x ? width - 1 - x : x;
        uint8_t pair = packed[source >> 1];
        uint8_t level = (source & 1) ? (uint8_t)(pair & 0x0F) : (uint8_t)(pair >> 4);
        out[x] = (uint8_t)(level * 17u);
    }
}

#ifdef ESP_PLATFORM
#include <stdio.h>

#include "esp_heap_caps.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"

#include "DEV_Config.h"

#define CMD_SYS_RUN 0x0001
#define CMD_SLEEP 0x0003
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
#define LOAD_8BPP (3u << 4)

#define MODE_INIT 0 /* the full clear */
#define MODE_GC16 2 /* sixteen greys, full flash */

/* The controller answers a word in microseconds; it boots from its own flash
 * after a reset, which takes longer. A GC16 refresh of the whole panel is a
 * second or two (Zephyr allows 40 s for the worst case). */
#define READY_TIMEOUT_MS 5000
#define REFRESH_TIMEOUT_MS 40000
#define REFRESH_POLL_MS 50
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
/* A step timed out: the rest of the pass is skipped rather than talking to
 * a controller that stopped listening, and init reports the failure. */
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
            s_failed = true;
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

static int apply_temperature(void)
{
    int celsius = DEFAULT_TEMPERATURE_C;
    if (s_read_temperature && !s_read_temperature(&celsius)) celsius = DEFAULT_TEMPERATURE_C;
    if (celsius < 0) celsius = 0;
    if (celsius > 50) celsius = 50;
    const UWORD args[] = {0x0001, (UWORD)celsius};
    command_args(CMD_TEMPERATURE, args, 2);
    return celsius;
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

int fos_it8951_10in3_init(void)
{
    s_failed = false;
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
    if (info[0] != FOS_IT8951_10IN3_WIDTH || info[1] != FOS_IT8951_10IN3_HEIGHT) {
        DEV_Error("IT8951 drives a %ux%u panel, not EPD_10in3's %dx%d%s", info[0], info[1],
                  FOS_IT8951_10IN3_WIDTH, FOS_IT8951_10IN3_HEIGHT,
                  info[0] == 0 || info[0] == 0xFFFF ? " (no answer on MISO: check pins.dc)" : "");
        return 1;
    }
    s_image_addr = (uint32_t)info[2] | ((uint32_t)info[3] << 16);
    write_register(REG_I80CPCR, 1);
    int celsius = s_variant.set_temperature ? apply_temperature() : -1;
    UWORD vcom = apply_vcom(s_variant.vcom_mv);
    if (s_failed) return 1;
    if (!s_reported) {
        char firmware[17], lut[17];
        words_to_text(info + 4, 8, firmware, sizeof(firmware));
        words_to_text(info + 12, 8, lut, sizeof(lut));
        /* printf: WARN-only builds show it on the console too. */
        printf("it8951: %ux%u, image buffer 0x%08lx, firmware %s, LUT %s, VCOM -%u mV%s, temperature %d C\n",
               info[0], info[1], (unsigned long)s_image_addr, firmware, lut, vcom,
               s_variant.mirror_x ? ", mirrored" : "", celsius);
        s_reported = true;
    }
    return 0;
}

/* The whole panel into the controller's image buffer: `packed` rows, or
 * white when NULL. */
static void load_image(const uint8_t *packed)
{
    const int width = FOS_IT8951_10IN3_WIDTH;
    const int height = FOS_IT8951_10IN3_HEIGHT;
    const size_t packed_row = ((size_t)width + 1u) / 2u;
    /* A row at a time from internal RAM: the panel buffer is in PSRAM, which
     * the SPI DMA would otherwise bounce through a fresh copy per transfer. */
    uint8_t *row = heap_caps_malloc((size_t)width, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    if (!row) {
        DEV_Error("IT8951: no %d bytes of DMA memory for a row", width);
        s_failed = true;
        return;
    }
    if (!packed) memset(row, 0xFF, (size_t)width);
    write_register(REG_LISAR + 2, (UWORD)(s_image_addr >> 16));
    write_register(REG_LISAR, (UWORD)(s_image_addr & 0xFFFF));
    const UWORD args[] = {LOAD_BIG_ENDIAN | LOAD_8BPP, 0, 0, (UWORD)width, (UWORD)height};
    command_args(CMD_LOAD_AREA, args, 5);
    if (wait_ready("load")) {
        DEV_Digital_Write(EPD_CS_PIN, 0);
        DEV_SPI_Transfer16(PREAMBLE_WRITE);
        for (int y = 0; y < height; y++) {
            if (!wait_ready("load")) break;
            if (packed) fos_it8951_row_8bpp(packed + (size_t)y * packed_row, width, s_variant.mirror_x, row);
            DEV_SPI_Write_nByte(row, (uint32_t)width);
        }
        DEV_Digital_Write(EPD_CS_PIN, 1);
        write_command(CMD_LOAD_END);
    }
    heap_caps_free(row);
}

/* Start a waveform over the whole panel and wait for it to finish: putting
 * the controller to sleep while it runs cuts the refresh short. */
static void refresh(UWORD mode)
{
    const UWORD args[] = {0, 0, FOS_IT8951_10IN3_WIDTH, FOS_IT8951_10IN3_HEIGHT, mode};
    command_args(CMD_DISPLAY_AREA, args, 5);
    int64_t start = now_ms();
    UWORD running = 1;
    while (read_register(REG_LUTAFSR, &running) && running != 0) {
        if (now_ms() - start > REFRESH_TIMEOUT_MS) {
            DEV_Error("IT8951 refresh still running after %d ms (LUTAFSR 0x%04x)", REFRESH_TIMEOUT_MS, running);
            s_failed = true;
            return;
        }
        DEV_Delay_ms(REFRESH_POLL_MS);
    }
}

void fos_it8951_10in3_clear(void)
{
    load_image(NULL);
    refresh(MODE_INIT);
}

void fos_it8951_10in3_display(uint8_t *buf)
{
    load_image(buf);
    refresh(MODE_GC16);
}

void fos_it8951_10in3_sleep(void)
{
    /* The next pass resets it anyway; asleep it draws next to nothing. */
    write_command(CMD_SLEEP);
}
#endif /* ESP_PLATFORM */
