/* ST7701S 480x480 RGB LCD (the Seeed SenseCAP Indicator's). See lcd_st7701s_rgb.h. */
#include "lcd_st7701s_rgb.h"

#include <stdbool.h>
#include <string.h>

#include "esp_log.h"
#include "sdkconfig.h"
#include "soc/soc_caps.h"

static const char *TAG = "fos_lcd";

/* ---------------------------------------------------------------- boards */

typedef struct {
    const char *preset;
    /* The expander's bus, the expander's pins (the TCA9535's P0..P15, or the
     * HT8574's P0..P7 with the same numbers below 8). */
    int i2c_sda, i2c_scl;
    int exp_lcd_cs, exp_lcd_rst, exp_tp_rst;
    /* Pins held high so the rest of the board runs: the RP2040's reset and
     * the WXM's barometer power on the Indicator (-1 = none). */
    int exp_hold_high[2];
    /* The controller's 3-wire SPI (clock and data are GPIOs). */
    int spi_sck, spi_sda;
    int backlight; /* GPIO, high = on */
    /* The RGB interface. */
    int hsync, vsync, de, pclk;
    int data[16]; /* B0..B4, G0..G5, R0..R4 */
    uint32_t pclk_hz;
    uint32_t hsync_pulse, hsync_back, hsync_front;
    uint32_t vsync_pulse, vsync_back, vsync_front;
    /* Lines per bounce buffer (two of them, internal RAM): how late the
     * refill interrupt may run before a frame breaks. Must divide the
     * height. */
    uint32_t bounce_lines;
} lcd_board_t;

/* Seeed SenseCAP Indicator (sensecap_indicator_board.c in Seeed's BSP): the
 * TCA9535 at 0x20 on SDA39/SCL40 holds LCD_CS (P4), LCD_RESET (P5), TP_RESET
 * (P7), the RP2040's reset (P8) and the barometer's power (P10, WXM only);
 * the controller's SPI clock is GPIO41 and its data GPIO48; the backlight is
 * GPIO45. Data lines B0..B4 = GPIO15..11, G0..G5 = GPIO10..5, R0..R4 =
 * GPIO4..0; HSYNC 16, VSYNC 17, DE 18, PCLK 21 with the GuanXian glass's
 * porches.
 *
 * The pixel clock is the bench's, not Seeed's 18 MHz or ESPHome's 16: those
 * builds run the CPU at 240 MHz, the flash in QIO and the PSRAM at 120 MHz,
 * and the generic FrameOS image runs 160 MHz, DIO flash and 80 MHz PSRAM on
 * one shared bus. Measured with `lcd` while a finger moved on the glass
 * (2026-10-25): 18 and 16 MHz dropped frames by 60-140 ms (the picture
 * jumped); 14, 12 and 10 MHz kept every frame within a millisecond. 12 MHz
 * (42 fps) is the middle of the clean range. */
static const lcd_board_t k_boards[] = {
    {
        .preset = "seeed_sensecap_indicator_d1",
        .i2c_sda = 39, .i2c_scl = 40,
        .exp_lcd_cs = 4, .exp_lcd_rst = 5, .exp_tp_rst = 7,
        .exp_hold_high = {8, 10},
        .spi_sck = 41, .spi_sda = 48,
        .backlight = 45,
        .hsync = 16, .vsync = 17, .de = 18, .pclk = 21,
        .data = {15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0},
        .pclk_hz = 12 * 1000 * 1000,
        .hsync_pulse = 8, .hsync_back = 50, .hsync_front = 10,
        .vsync_pulse = 8, .vsync_back = 20, .vsync_front = 10,
        /* 2 x 19.2 KB: ~0.9 ms of slack at 12 MHz, where ten lines (ESPHome's)
         * still dropped frames during a render's bulk copies. */
        .bounce_lines = 20,
    },
};

static const lcd_board_t *s_board = &k_boards[0];

void fos_lcd_st7701s_select_board(const char *hardware_preset)
{
    s_board = &k_boards[0];
    if (!hardware_preset || !hardware_preset[0]) return;
    for (size_t i = 0; i < sizeof(k_boards) / sizeof(k_boards[0]); i++) {
        if (strcmp(hardware_preset, k_boards[i].preset) == 0) {
            s_board = &k_boards[i];
            return;
        }
    }
}

#if SOC_LCD_RGB_SUPPORTED

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_rgb.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"

#define LCD_I2C_HZ 400000
#define LCD_I2C_TIMEOUT_MS 50
#define EXPANDER_ADDR_TCA9535 0x20
#define EXPANDER_ADDR_HT8574 0x39
/* TCA9535 registers: two bytes each, P0..P7 then P8..P15. */
#define TCA9535_REG_OUTPUT 0x02
#define TCA9535_REG_CONFIG 0x06

static bool s_ready = false;
static i2c_master_bus_handle_t s_bus = NULL;
/* Scan-out timing (fos_lcd_st7701s_stats). Written in the frame-complete
 * interrupt, read by the console. */
static uint32_t s_pclk_hz = 0;
static volatile uint32_t s_frame_us = 0;
static volatile uint32_t s_glitch_us = 0;
static volatile uint32_t s_slack_us = 0;
static volatile uint32_t s_late_refills = 0;
/* Three frame buffers in turn: one scanned (s_front), one handed to the
 * driver for the next frame boundary (s_pending_front; on_frame_complete
 * says when it switched), and one to draw the next picture in. A writer
 * never waits to start; it waits before handing its picture over, and only
 * while the one handed over before is not on the glass yet (settle_front):
 * a render longer than a frame finds it there. With two buffers each render
 * waited, before drawing, for the boundary after the one before — DVD Logo
 * Bounce's 55 ms renders took three 23.6 ms scans each, 13.5 fps. */
#define LCD_FBS 3
static uint8_t *s_fbs[LCD_FBS] = {NULL, NULL, NULL};
static int s_front = 0;
static int s_pending_front = -1; /* handed to the driver, not yet scanned */
static int s_drawing = -1;       /* the buffer a writer has (writable_back) */
static int s_last_drawn = 0;     /* the order buffers are drawn in */
static SemaphoreHandle_t s_frame_done = NULL;
/* One writer at a time: the render task drawing a scene straight into the
 * back buffer (fos_lcd_st7701s_back_buffer) holds it until display(), and a
 * console `display_test` on another task waits for it. */
static SemaphoreHandle_t s_write_lock = NULL;
static void (*s_before_write)(const uint8_t *buf) = NULL;
/* Every write into a buffer but a render drawn in place counts here: a copy,
 * a clear, an overlay the render task draws (fos_lcd_st7701s_mark_written).
 * A render in place reads it to know whether the buffer still holds what it
 * left there two frames ago. */
static volatile uint32_t s_generation[LCD_FBS] = {0, 0, 0};

static int buffer_index(const uint8_t *buf)
{
    for (int i = 0; i < LCD_FBS; i++) {
        if (buf == s_fbs[i]) return i;
    }
    return -1;
}
static volatile int64_t s_last_frame_at_us = 0;
static volatile uint32_t s_frames = 0;
static volatile uint32_t s_glitches = 0;
static volatile uint32_t s_max_deviation_us = 0;
#define LCD_RECENT_GLITCHES 16
static volatile int64_t s_recent_at[LCD_RECENT_GLITCHES];
static volatile uint32_t s_recent_dev[LCD_RECENT_GLITCHES];
static volatile uint32_t s_recent_next = 0;
static i2c_master_dev_handle_t s_expander = NULL;
static bool s_expander_is_8bit = false;
static uint16_t s_exp_output = 0;
static esp_lcd_panel_handle_t s_panel = NULL;

/* ---------------------------------------------------------- the expander */

static esp_err_t expander_write_output(void)
{
    if (s_expander_is_8bit) {
        uint8_t byte = (uint8_t)s_exp_output;
        return i2c_master_transmit(s_expander, &byte, 1, LCD_I2C_TIMEOUT_MS);
    }
    uint8_t frame[3] = {TCA9535_REG_OUTPUT, (uint8_t)s_exp_output, (uint8_t)(s_exp_output >> 8)};
    return i2c_master_transmit(s_expander, frame, sizeof(frame), LCD_I2C_TIMEOUT_MS);
}

static esp_err_t expander_set(int pin, bool level)
{
    if (pin < 0) return ESP_OK;
    if (level) s_exp_output |= (uint16_t)(1u << pin);
    else s_exp_output &= (uint16_t)~(1u << pin);
    esp_err_t err = expander_write_output();
    /* Seeed's driver lets the expander settle after each write. */
    esp_rom_delay_us(10);
    return err;
}

static esp_err_t expander_probe(uint8_t addr, bool eight_bit)
{
    if (s_expander) {
        i2c_master_bus_rm_device(s_expander);
        s_expander = NULL;
    }
    i2c_device_config_t dev_config = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = addr,
        .scl_speed_hz = LCD_I2C_HZ,
    };
    esp_err_t err = i2c_master_bus_add_device(s_bus, &dev_config, &s_expander);
    if (err != ESP_OK) return err;
    err = i2c_master_probe(s_bus, addr, LCD_I2C_TIMEOUT_MS);
    if (err != ESP_OK) return err;
    s_expander_is_8bit = eight_bit;
    return ESP_OK;
}

static esp_err_t expander_init(void)
{
    const lcd_board_t *b = s_board;
    i2c_master_bus_config_t bus_config = {
        .i2c_port = -1,
        .sda_io_num = (gpio_num_t)b->i2c_sda,
        .scl_io_num = (gpio_num_t)b->i2c_scl,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    esp_err_t err = i2c_new_master_bus(&bus_config, &s_bus);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2c bus on sda=%d scl=%d failed: %s", b->i2c_sda, b->i2c_scl, esp_err_to_name(err));
        return err;
    }
    uint8_t addr = EXPANDER_ADDR_TCA9535;
    if (expander_probe(EXPANDER_ADDR_TCA9535, false) != ESP_OK) {
        addr = EXPANDER_ADDR_HT8574;
        if (expander_probe(EXPANDER_ADDR_HT8574, true) != ESP_OK) {
            ESP_LOGE(TAG, "no IO expander at 0x%02x or 0x%02x on sda=%d scl=%d", EXPANDER_ADDR_TCA9535,
                     EXPANDER_ADDR_HT8574, b->i2c_sda, b->i2c_scl);
            return ESP_ERR_NOT_FOUND;
        }
    }
    /* Everything the board needs high (the LCD's CS and reset idle high, the
     * RP2040 out of reset) with the touch controller held in reset, then the
     * pins made outputs, then the touch controller released: Seeed's order.
     * On the TCA9535 only our pins become outputs; the LoRa radio's lines on
     * P0..P3 stay inputs. The HT8574 has no direction register: a 1 is a
     * weak high, a 0 a driven low. */
    uint16_t ours = 0;
    s_exp_output = 0;
    int highs[] = {b->exp_lcd_cs, b->exp_lcd_rst, b->exp_hold_high[0], b->exp_hold_high[1]};
    for (size_t i = 0; i < sizeof(highs) / sizeof(highs[0]); i++) {
        if (highs[i] < 0 || (s_expander_is_8bit && highs[i] >= 8)) continue;
        ours |= (uint16_t)(1u << highs[i]);
        s_exp_output |= (uint16_t)(1u << highs[i]);
    }
    if (b->exp_tp_rst >= 0) ours |= (uint16_t)(1u << b->exp_tp_rst);
    if (s_expander_is_8bit) {
        /* Inputs read as weak highs on a quasi-bidirectional port: keep every
         * pin we do not drive at 1. */
        s_exp_output |= (uint16_t)~ours & 0x00FF;
    }
    err = expander_write_output();
    if (err == ESP_OK && !s_expander_is_8bit) {
        uint16_t config = (uint16_t)~ours; /* 0 = output */
        uint8_t frame[3] = {TCA9535_REG_CONFIG, (uint8_t)config, (uint8_t)(config >> 8)};
        err = i2c_master_transmit(s_expander, frame, sizeof(frame), LCD_I2C_TIMEOUT_MS);
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "IO expander 0x%02x setup failed: %s", addr, esp_err_to_name(err));
        return err;
    }
    vTaskDelay(pdMS_TO_TICKS(5));
    expander_set(b->exp_tp_rst, true);
    ESP_LOGI(TAG, "IO expander %s at 0x%02x", s_expander_is_8bit ? "ht8574" : "tca9535", addr);
    return ESP_OK;
}

/* ------------------------------------------------ the controller's SPI */

/* Seeed's lcd_panel_config.c, bit for bit: a 9-bit frame is the D/C bit then
 * the byte, MSB first, clocked at ~50 kHz; chip-select and reset are the
 * expander's, clock and data two GPIOs. The stray clocks their code leaves
 * around a frame are kept — the controller drops whatever is pending when
 * CS rises, and this is the waveform the glass is known to accept. */
#define SPI_DELAY() esp_rom_delay_us(10)

static void spi_sck(int level) { gpio_set_level((gpio_num_t)s_board->spi_sck, level); }
static void spi_sdo(int level) { gpio_set_level((gpio_num_t)s_board->spi_sda, level); }
static void spi_cs(int level) { expander_set(s_board->exp_lcd_cs, level != 0); }

static void spi_send_9bits(unsigned value)
{
    for (int n = 0; n < 9; n++) {
        spi_sdo((value & 0x0100) ? 1 : 0);
        value <<= 1;
        spi_sck(1);
        SPI_DELAY();
        spi_sck(0);
        SPI_DELAY();
    }
}

static void spi_write_command(uint8_t command)
{
    spi_cs(0);
    SPI_DELAY();
    spi_sck(0);
    SPI_DELAY();
    spi_send_9bits(0x0000); /* the high byte of a 16-bit address: a NOP */
    spi_sck(1);
    SPI_DELAY();
    spi_sck(0);
    spi_cs(1);
    SPI_DELAY();
    spi_cs(0);
    SPI_DELAY();
    spi_send_9bits(command);
    spi_cs(1);
    SPI_DELAY();
}

static void spi_write_data(uint8_t data)
{
    spi_cs(0);
    SPI_DELAY();
    spi_sck(0);
    SPI_DELAY();
    spi_send_9bits(0x0100u | data);
    spi_sck(1);
    SPI_DELAY();
    spi_sck(0);
    SPI_DELAY();
    spi_cs(1);
    SPI_DELAY();
}

/* The ST7701S bring-up Seeed ships for the Indicator's GuanXian glass
 * (lcd_panel_st7701s_init): command bytes are marked by a 0x100 bit, a
 * 0x200 entry is a delay of that many milliseconds. */
#define C(x) (0x100u | (x))
#define D(ms) (0x200u | (ms))
static const uint16_t k_st7701s_init[] = {
    C(0xFF), 0x77, 0x01, 0x00, 0x00, 0x10,
    C(0xC0), 0x3B, 0x00,
    C(0xC1), 0x0D, 0x02,
    C(0xC2), 0x31, 0x05,
    C(0xC7), 0x04,
    C(0xCD), 0x08,
    C(0xB0), 0x00, 0x11, 0x18, 0x0E, 0x11, 0x06, 0x07, 0x08, 0x07, 0x22, 0x04, 0x12, 0x0F, 0xAA, 0x31, 0x18,
    C(0xB1), 0x00, 0x11, 0x19, 0x0E, 0x12, 0x07, 0x08, 0x08, 0x08, 0x22, 0x04, 0x11, 0x11, 0xA9, 0x32, 0x18,
    C(0xFF), 0x77, 0x01, 0x00, 0x00, 0x11,
    C(0xB0), 0x60,
    C(0xB1), 0x32,
    C(0xB2), 0x07,
    C(0xB3), 0x80,
    C(0xB5), 0x49,
    C(0xB7), 0x85,
    C(0xB8), 0x21,
    C(0xC1), 0x78,
    C(0xC2), 0x78,
    D(20),
    C(0xE0), 0x00, 0x1B, 0x02,
    C(0xE1), 0x08, 0xA0, 0x00, 0x00, 0x07, 0xA0, 0x00, 0x00, 0x00, 0x44, 0x44,
    C(0xE2), 0x11, 0x11, 0x44, 0x44, 0xED, 0xA0, 0x00, 0x00, 0xEC, 0xA0, 0x00, 0x00,
    C(0xE3), 0x00, 0x00, 0x11, 0x11,
    C(0xE4), 0x44, 0x44,
    C(0xE5), 0x0A, 0xE9, 0xD8, 0xA0, 0x0C, 0xEB, 0xD8, 0xA0, 0x0E, 0xED, 0xD8, 0xA0, 0x10, 0xEF, 0xD8, 0xA0,
    C(0xE6), 0x00, 0x00, 0x11, 0x11,
    C(0xE7), 0x44, 0x44,
    C(0xE8), 0x09, 0xE8, 0xD8, 0xA0, 0x0B, 0xEA, 0xD8, 0xA0, 0x0D, 0xEC, 0xD8, 0xA0, 0x0F, 0xEE, 0xD8, 0xA0,
    C(0xEB), 0x02, 0x00, 0xE4, 0xE4, 0x88, 0x00, 0x40,
    C(0xEC), 0x3C, 0x00,
    C(0xED), 0xAB, 0x89, 0x76, 0x54, 0x02, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x20, 0x45, 0x67, 0x98, 0xBA,
    C(0x36), 0x10,
    C(0xFF), 0x77, 0x01, 0x00, 0x00, 0x13,
    C(0xE5), 0xE4,
    C(0xFF), 0x77, 0x01, 0x00, 0x00, 0x00,
    C(0x3A), 0x60, /* RGB666 on the controller side; the bus carries 16 bits */
    C(0x21),       /* display inversion on */
    C(0x11),       /* sleep out */
    D(120),
    C(0x29),       /* display on */
    D(120),
};
#undef C
#undef D

static void controller_init(void)
{
    const lcd_board_t *b = s_board;
    gpio_config_t io_conf = {
        .pin_bit_mask = (1ULL << b->spi_sck) | (1ULL << b->spi_sda),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&io_conf);
    spi_cs(1);
    spi_sck(1);
    spi_sdo(1);
    for (size_t i = 0; i < sizeof(k_st7701s_init) / sizeof(k_st7701s_init[0]); i++) {
        uint16_t entry = k_st7701s_init[i];
        if (entry & 0x200u) vTaskDelay(pdMS_TO_TICKS(entry & 0xFF));
        else if (entry & 0x100u) spi_write_command((uint8_t)entry);
        else spi_write_data((uint8_t)entry);
    }
    spi_cs(1);
    spi_sck(1);
    spi_sdo(1);
}

/* ------------------------------------------------- the RGB peripheral */

static uint32_t h_total(const lcd_board_t *b)
{
    return FOS_LCD_ST7701S_WIDTH + b->hsync_pulse + b->hsync_back + b->hsync_front;
}

static uint32_t v_total(const lcd_board_t *b)
{
    return FOS_LCD_ST7701S_HEIGHT + b->vsync_pulse + b->vsync_back + b->vsync_front;
}

static void timing_for_pclk(uint32_t hz)
{
    const lcd_board_t *b = s_board;
    s_pclk_hz = hz;
    s_frame_us = (uint32_t)(((uint64_t)h_total(b) * v_total(b) * 1000000ull) / hz);
    /* A quarter frame: the interrupt's own latency moves a frame's end by
     * up to a millisecond (measured on the bench at every clock), a starved
     * or restarted frame by tens of milliseconds. */
    s_glitch_us = s_frame_us / 4u;
    /* One bounce buffer's worth of lines: how late a refill may start before
     * the DMA scans stale lines (a band of the picture in the wrong place
     * for one frame, the frame's timing intact). */
    s_slack_us = (uint32_t)(((uint64_t)h_total(b) * b->bounce_lines * 1000000ull) / hz);
    s_last_frame_at_us = 0;
}

/* The last bounce buffer of a frame was filled: time it against the last. */
static bool on_frame_complete(esp_lcd_panel_handle_t panel, const esp_lcd_rgb_panel_event_data_t *edata,
                              void *user_ctx)
{
    (void)panel;
    (void)edata;
    (void)user_ctx;
    int64_t now = esp_timer_get_time();
    int64_t last = s_last_frame_at_us;
    if (last) {
        int64_t deviation = (now - last) - (int64_t)s_frame_us;
        if (deviation < 0) deviation = -deviation;
        if (deviation > (int64_t)s_max_deviation_us) s_max_deviation_us = (uint32_t)deviation;
        if (deviation > (int64_t)s_slack_us && deviation <= (int64_t)s_glitch_us) s_late_refills++;
        if (deviation > (int64_t)s_glitch_us) s_glitches++;
        if (deviation > (int64_t)s_slack_us) {
            uint32_t slot = s_recent_next % LCD_RECENT_GLITCHES;
            s_recent_at[slot] = now;
            s_recent_dev[slot] = (uint32_t)deviation;
            s_recent_next++;
        }
    }
    s_last_frame_at_us = now;
    s_frames++;
    BaseType_t woke = pdFALSE;
    if (s_frame_done) xSemaphoreGiveFromISR(s_frame_done, &woke);
    return woke == pdTRUE;
}

static esp_err_t rgb_init(void)
{
    const lcd_board_t *b = s_board;
    esp_lcd_rgb_panel_config_t config = {
        .clk_src = LCD_CLK_SRC_DEFAULT,
        .timings = {
            .pclk_hz = b->pclk_hz,
            .h_res = FOS_LCD_ST7701S_WIDTH,
            .v_res = FOS_LCD_ST7701S_HEIGHT,
            .hsync_pulse_width = b->hsync_pulse,
            .hsync_back_porch = b->hsync_back,
            .hsync_front_porch = b->hsync_front,
            .vsync_pulse_width = b->vsync_pulse,
            .vsync_back_porch = b->vsync_back,
            .vsync_front_porch = b->vsync_front,
            .flags.pclk_active_neg = 0,
        },
        .data_width = 16,
        .bits_per_pixel = 16,
        /* Three frame buffers (s_fbs): a new picture never lands in the one
         * being scanned (a single buffer showed the new picture's top over
         * the old one's bottom for a frame or two: a flicker every time the
         * clock changed), and the next one is drawn while the last waits for
         * its frame boundary. 460 KB of PSRAM each, counted in
         * fos_display_render_psram_bytes. */
        .num_fbs = LCD_FBS,
        /* The frame buffers live in PSRAM; the DMA scans two bounce
         * buffers in internal RAM that an interrupt refills from them.
         * Scanning PSRAM directly under-ran on this board's 80 MHz octal
         * PSRAM whenever the renderer or Wi-Fi had the bus (Seeed runs its
         * PSRAM at 120 MHz): every frame restarted late and the picture
         * crept down the glass (2026-10-25). The fill interrupt is not
         * IRAM-safe on purpose — the driver notes a copy from a PSRAM frame
         * buffer crashes while a flash write has the cache off — so a flash
         * write (an NVS save) costs a disturbed frame, after which the
         * driver restarts the DMA at the next vertical blank. Not
         * CONFIG_LCD_RGB_RESTART_IN_VSYNC: its restart at every blank kept
         * a stale refill count and left the picture one bounce buffer
         * ahead (sdkconfig.defaults). */
        .bounce_buffer_size_px = FOS_LCD_ST7701S_WIDTH * b->bounce_lines,
        .dma_burst_size = 64,
        .hsync_gpio_num = b->hsync,
        .vsync_gpio_num = b->vsync,
        .de_gpio_num = b->de,
        .pclk_gpio_num = b->pclk,
        .disp_gpio_num = -1,
        .flags.fb_in_psram = 1,
    };
    for (int i = 0; i < 16; i++) config.data_gpio_nums[i] = b->data[i];
    esp_err_t err = esp_lcd_new_rgb_panel(&config, &s_panel);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "RGB panel failed: %s", esp_err_to_name(err));
        return err;
    }
    timing_for_pclk(b->pclk_hz);
    err = esp_lcd_rgb_panel_get_frame_buffer(s_panel, LCD_FBS, (void **)&s_fbs[0], (void **)&s_fbs[1],
                                             (void **)&s_fbs[2]);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "RGB panel frame buffers: %s", esp_err_to_name(err));
        return err;
    }
    s_frame_done = xSemaphoreCreateBinary();
    if (!s_frame_done) return ESP_ERR_NO_MEM;
    s_write_lock = xSemaphoreCreateMutex();
    if (!s_write_lock) return ESP_ERR_NO_MEM;
    esp_lcd_rgb_panel_event_callbacks_t callbacks = {0};
    callbacks.on_frame_buf_complete = on_frame_complete;
    esp_lcd_rgb_panel_register_event_callbacks(s_panel, &callbacks, NULL);
    err = esp_lcd_panel_reset(s_panel);
    if (err == ESP_OK) err = esp_lcd_panel_init(s_panel);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "RGB panel init failed: %s", esp_err_to_name(err));
        return err;
    }
    return ESP_OK;
}

static void backlight_set(bool on)
{
    if (s_board->backlight < 0) return;
    gpio_reset_pin((gpio_num_t)s_board->backlight);
    gpio_set_direction((gpio_num_t)s_board->backlight, GPIO_MODE_OUTPUT);
    gpio_set_level((gpio_num_t)s_board->backlight, on ? 1 : 0);
}

#define LCD_FB_BYTES ((size_t)FOS_LCD_ST7701S_WIDTH * FOS_LCD_ST7701S_HEIGHT * 2u)

/* The buffer last presented is being scanned: wait for the frame boundary
 * that switched to it (a few frames at most; on a timeout the switch still
 * happens, a frame later), after which the one scanned before is free. */
static void settle_front(void)
{
    if (s_pending_front < 0) return;
    uint32_t wait_ms = (s_frame_us * 4u) / 1000u + 10u;
    xSemaphoreTake(s_frame_done, pdMS_TO_TICKS(wait_ms));
    s_front = s_pending_front;
    s_pending_front = -1;
}

/* The writer's lock, taken once by the task that draws (it may already hold
 * it from fos_lcd_st7701s_back_buffer). */
static void hold_writer(void)
{
    if (xSemaphoreGetMutexHolder(s_write_lock) == xTaskGetCurrentTaskHandle()) return;
    xSemaphoreTake(s_write_lock, portMAX_DELAY);
}

static void release_writer(void)
{
    if (xSemaphoreGetMutexHolder(s_write_lock) == xTaskGetCurrentTaskHandle()) {
        xSemaphoreGive(s_write_lock);
    }
}

/* The buffer about to be drawn in, neither scanned nor handed over, and the
 * next in turn so that each holds the picture from three frames back; whoever
 * pointed at it as a picture (fos_client.c's snapshot) lets go first. */
static uint8_t *writable_back(void)
{
    if (s_drawing < 0) {
        for (int step = 1; step <= LCD_FBS; step++) {
            int i = (s_last_drawn + step) % LCD_FBS;
            if (i != s_front && i != s_pending_front) {
                s_drawing = i;
                break;
            }
        }
    }
    uint8_t *back = s_fbs[s_drawing];
    if (s_before_write) s_before_write(back);
    return back;
}

/* Hand the drawn buffer to the driver once the one handed over before is on
 * the glass (the driver switches to the newest it was given, so handing two
 * over within one frame would skip the first): the refill starts reading it
 * at the next frame boundary, and it is the front buffer from then on. */
static void present_back(void)
{
    settle_front();
    int back = s_drawing;
    esp_lcd_panel_draw_bitmap(s_panel, 0, 0, FOS_LCD_ST7701S_WIDTH, FOS_LCD_ST7701S_HEIGHT, s_fbs[back]);
    /* A frame that ended before the call above may have given already:
     * clear it, so the wait in settle_front is for one that ends after it. */
    xSemaphoreTake(s_frame_done, 0);
    s_pending_front = back;
    s_last_drawn = back;
    s_drawing = -1;
}

static void fill_buffer(uint8_t *fb, uint16_t color)
{
    uint16_t *pixels = (uint16_t *)fb;
    for (size_t i = 0; i < LCD_FB_BYTES / 2u; i++) pixels[i] = color;
}

/* The refill interrupt is allocated on the core that creates the panel, and
 * it belongs on core 1 with the render task (fos_client.c pins it there for
 * an LCD): the render's bulk PSRAM copies (the pack, the blit, the
 * snapshot) then pause while the refill runs instead of racing it from the
 * other core, and core 0 keeps Wi-Fi. Measured on the bench: with the
 * interrupt on core 0 a render dropped frames at 12 MHz. */
#define LCD_ISR_CORE 1

static esp_err_t s_rgb_result;

static void rgb_init_task(void *arg)
{
    s_rgb_result = rgb_init();
    xTaskNotifyGive((TaskHandle_t)arg);
    vTaskDelete(NULL);
}

static esp_err_t rgb_init_on_isr_core(void)
{
#if CONFIG_FREERTOS_NUMBER_OF_CORES > 1
    if (xPortGetCoreID() != LCD_ISR_CORE) {
        s_rgb_result = ESP_FAIL;
        if (xTaskCreatePinnedToCore(rgb_init_task, "fos_lcd_init", 4096, xTaskGetCurrentTaskHandle(), 10, NULL,
                                    LCD_ISR_CORE) != pdPASS) {
            return ESP_ERR_NO_MEM;
        }
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        return s_rgb_result;
    }
#endif
    return rgb_init();
}

int fos_lcd_st7701s_init(void)
{
    if (s_ready) return 0;
    if (expander_init() != ESP_OK) return 1;
    controller_init();
    if (rgb_init_on_isr_core() != ESP_OK) return 1;
    /* White until the first render: a dark panel reads as a dead frame. */
    for (int i = 0; i < LCD_FBS; i++) fill_buffer(s_fbs[i], 0xFFFF);
    backlight_set(true);
    s_ready = true;
    ESP_LOGI(TAG, "ST7701S %dx%d up: RGB565 scan-out from PSRAM, pclk %lu Hz", FOS_LCD_ST7701S_WIDTH,
             FOS_LCD_ST7701S_HEIGHT, (unsigned long)s_board->pclk_hz);
    return 0;
}

void fos_lcd_st7701s_display(uint8_t *buf)
{
    if (!s_ready || !buf) return;
    hold_writer();
    /* Into the buffer nobody scans, then switched in whole at a frame
     * boundary: the picture changes from one frame to the next. A picture
     * drawn straight into that buffer (fos_lcd_st7701s_back_buffer) is
     * already there. */
    uint8_t *back = s_drawing >= 0 && buf == s_fbs[s_drawing] ? buf : NULL;
    if (!back) {
        back = writable_back();
        if (buf != back) {
            memcpy(back, buf, LCD_FB_BYTES);
            s_generation[buffer_index(back)]++;
        }
    }
    present_back();
    release_writer();
}

void fos_lcd_st7701s_clear(void)
{
    if (!s_ready) return;
    hold_writer();
    uint8_t *back = writable_back();
    fill_buffer(back, 0xFFFF);
    s_generation[buffer_index(back)]++;
    present_back();
    release_writer();
}

uint8_t *fos_lcd_st7701s_back_buffer(uint32_t *generation)
{
    if (!s_ready) return NULL;
    hold_writer();
    uint8_t *back = writable_back();
    if (generation) *generation = s_generation[buffer_index(back)];
    return back;
}

void fos_lcd_st7701s_mark_written(const uint8_t *buf)
{
    int index = buffer_index(buf);
    if (index >= 0) s_generation[index]++;
}

void fos_lcd_st7701s_release_back_buffer(void)
{
    if (!s_ready) return;
    release_writer();
}

void fos_lcd_st7701s_set_before_write_hook(void (*hook)(const uint8_t *buf))
{
    s_before_write = hook;
}

void fos_lcd_st7701s_sleep(void)
{
    /* Keep showing the frame. */
}

esp_err_t fos_lcd_st7701s_i2c_bus(int sda, int scl, void **bus)
{
    if (bus) *bus = NULL;
    if (!s_bus || sda != s_board->i2c_sda || scl != s_board->i2c_scl) return ESP_ERR_NOT_FOUND;
    if (bus) *bus = s_bus;
    return ESP_OK;
}

esp_err_t fos_lcd_st7701s_backlight(bool on)
{
    if (!s_ready) return ESP_ERR_INVALID_STATE;
    backlight_set(on);
    return ESP_OK;
}

bool fos_lcd_st7701s_stats(fos_lcd_st7701s_stats_t *out, bool reset)
{
    if (!s_ready) return false;
    if (out) {
        out->pclk_hz = s_pclk_hz;
        out->frame_us = s_frame_us;
        out->frames = s_frames;
        out->glitches = s_glitches;
        out->max_deviation_us = s_max_deviation_us;
        out->late_refills = s_late_refills;
        out->slack_us = s_slack_us;
        out->now_us = esp_timer_get_time();
        uint32_t next = s_recent_next;
        uint32_t count = next < LCD_RECENT_GLITCHES ? next : LCD_RECENT_GLITCHES;
        out->recent_count = (uint8_t)count;
        for (uint32_t i = 0; i < count; i++) {
            uint32_t slot = (next - count + i) % LCD_RECENT_GLITCHES;
            out->recent[i].at_us = s_recent_at[slot];
            out->recent[i].deviation_us = s_recent_dev[slot];
        }
    }
    if (reset) {
        s_frames = 0;
        s_glitches = 0;
        s_max_deviation_us = 0;
        s_late_refills = 0;
        s_last_frame_at_us = 0;
        s_recent_next = 0;
    }
    return true;
}

esp_err_t fos_lcd_st7701s_set_pclk(uint32_t hz)
{
    if (!s_ready) return ESP_ERR_INVALID_STATE;
    if (hz < 4000000u || hz > 30000000u) return ESP_ERR_INVALID_ARG;
    esp_err_t err = esp_lcd_rgb_panel_set_pclk(s_panel, hz);
    if (err == ESP_OK) {
        timing_for_pclk(hz);
        s_frames = 0;
        s_glitches = 0;
        s_late_refills = 0;
        s_max_deviation_us = 0;
    }
    return err;
}

#else /* !SOC_LCD_RGB_SUPPORTED: the chip has no RGB LCD peripheral (ESP32-C3) */

int fos_lcd_st7701s_init(void)
{
    ESP_LOGE(TAG, "this chip has no RGB LCD peripheral");
    return 1;
}
void fos_lcd_st7701s_display(uint8_t *buf) { (void)buf; }
void fos_lcd_st7701s_clear(void) {}
uint8_t *fos_lcd_st7701s_back_buffer(uint32_t *generation)
{
    if (generation) *generation = 0;
    return NULL;
}
void fos_lcd_st7701s_mark_written(const uint8_t *buf) { (void)buf; }
void fos_lcd_st7701s_release_back_buffer(void) {}
void fos_lcd_st7701s_set_before_write_hook(void (*hook)(const uint8_t *buf)) { (void)hook; }
void fos_lcd_st7701s_sleep(void) {}
esp_err_t fos_lcd_st7701s_i2c_bus(int sda, int scl, void **bus)
{
    (void)sda;
    (void)scl;
    if (bus) *bus = NULL;
    return ESP_ERR_NOT_SUPPORTED;
}
esp_err_t fos_lcd_st7701s_backlight(bool on)
{
    (void)on;
    return ESP_ERR_NOT_SUPPORTED;
}
bool fos_lcd_st7701s_stats(fos_lcd_st7701s_stats_t *out, bool reset)
{
    (void)out;
    (void)reset;
    return false;
}
esp_err_t fos_lcd_st7701s_set_pclk(uint32_t hz)
{
    (void)hz;
    return ESP_ERR_NOT_SUPPORTED;
}

#endif
