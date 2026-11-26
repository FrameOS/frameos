/* Panels that keep their own picture, behind an SPI controller: the CO5300
 * 466x466 AMOLED of the Waveshare ESP32-S3-Touch-AMOLED-1.75 on QSPI, and the
 * GC9309 240x296 IPS of the Elecrow CrowPanel 2.01" watch on one lane with a
 * D/C line. See lcd_qspi_amoled.h. */
#include "lcd_qspi_amoled.h"

#include <stdbool.h>
#include <string.h>

#include "esp_log.h"
#include "lcd_qspi_box.h"
#include "sdkconfig.h"

#define TAG "fos_qspi"

/* ---------------------------------------------------------------- boards */

/* A controller's setup as bytes: the command, the count of its parameters
 * (with INIT_WAIT: then 120 ms, the time a SLPOUT wants), the parameters. */
#define INIT_WAIT 0x80

typedef struct {
    const char *preset;
    const char *panel; /* the panel table's key for this glass */
    int width, height;
    /* Where the glass starts in the controller's RAM (the CO5300 is a 480
     * column part; this glass is wired from its sixth). */
    int x_gap, y_gap;
    bool round; /* only the circle inside the square is glass */
    int cs, sclk, data[4], rst;
    /* -1: QSPI, the CO5300's framing (an opcode and the command in an
     * address); else one lane, `data[0]`, and this GPIO low for a command. */
    int dc;
    int backlight; /* lit high; -1: the glass lights its own pixels */
    uint32_t spi_hz;
    const uint8_t *init;
    uint16_t init_len;
} qspi_board_t;

/* Waveshare's BSP (esp32_s3_touch_amoled_1_75.c lcd_init_cmds), less the
 * display-on: the glass is lit once it holds the splash, not the controller's
 * power-on noise. 0xFE pages the vendor registers in and out; 0xC4 0x80 is
 * the SPI mode, 0x3A 0x55 RGB565, 0x35 the tearing line on, 0x53 0x20 the
 * brightness control on, 0x51 / 0x63 the normal and high brightness. The
 * column window is the glass's 6..471. */
static const uint8_t k_co5300_init[] = {
    0xFE, 1, 0x20, 0x19, 1, 0x10, 0x1C, 1, 0xA0, 0xFE, 1, 0x00, 0xC4, 1, 0x80, 0x3A, 1, 0x55,
    0x35, 1, 0x00, 0x53, 1, 0x20, 0x51, 1, 0xFF, 0x63, 1, 0xFF,
    0x2A, 4, 0x00, 0x06, 0x01, 0xD7, 0x2B, 4, 0x00, 0x00, 0x01, 0xD1, 0x11, INIT_WAIT,
};

/* Elecrow's GC9309 sequence (their ESP-IDF lesson 3, "copied from the
 * validated Arduino_GFX driver behavior"), less its display-on and RAMWR:
 * 0xFE 0xEF open the vendor registers, 0x36 0x48 mirrors X in BGR order,
 * 0x3A 0x05 RGB565, 0xF0 / 0xF1 the gammas, the window the whole 240x296. */
static const uint8_t k_gc9309_init[] = {
    0xFE, 0, 0xEF, 0, 0x80, 1, 0xC0, 0x81, 1, 0x01, 0x82, 1, 0x07, 0x83, 1, 0x38, 0x88, 1, 0x64,
    0x89, 1, 0x86, 0x8B, 1, 0x3C, 0x8D, 1, 0x51, 0x8E, 1, 0x70, 0x35, 1, 0x00, 0x36, 1, 0x48,
    0x3A, 1, 0x05, 0xBF, 1, 0x1F, 0x7D, 2, 0x45, 0x06, 0xEE, 2, 0x00, 0x06, 0xF4, 1, 0x53,
    0xF6, 2, 0x17, 0x08, 0x70, 2, 0x4F, 0x4F, 0x71, 2, 0x12, 0x20, 0x72, 2, 0x12, 0x20,
    0xB5, 1, 0x50, 0xBA, 1, 0x00, 0xEC, 1, 0x71, 0x7B, 2, 0x00, 0x0D, 0x7C, 2, 0x0D, 0x03,
    0xF5, 3, 0x02, 0x10, 0x12,
    0xF0, 12, 0x0C, 0x11, 0x0B, 0x0A, 0x05, 0x32, 0x44, 0x8E, 0x9A, 0x29, 0x2E, 0x5F,
    0xF1, 12, 0x0B, 0x11, 0x0B, 0x07, 0x07, 0x32, 0x45, 0xBD, 0x8D, 0x21, 0x28, 0xAF,
    0x2A, 4, 0x00, 0x00, 0x00, 0xEF, 0x2B, 4, 0x00, 0x00, 0x01, 0x27,
    0x66, 1, 0x2C, 0x67, 1, 0x18, 0x68, 1, 0x3E, 0xCA, 1, 0x0E, 0xE8, 1, 0xF0, 0xCB, 1, 0x06,
    0xB6, 3, 0x5C, 0x40, 0x40, 0xCC, 1, 0x33, 0xCD, 1, 0x33, 0x11, INIT_WAIT,
    0xE8, 1, 0xA0, 0xE8, 1, 0xF0, 0xFE, 0, 0xEE, 0,
};

/* Waveshare ESP32-S3-Touch-AMOLED-1.75 (Waveshare's ESP-IDF BSP,
 * esp32_s3_touch_amoled_1_75.h): CS GPIO12, SCLK GPIO38, D0..D3 GPIO4..7,
 * reset GPIO39, no backlight (an AMOLED lights its own pixels). The glass is
 * the controller's columns 6..471 (`esp_lcd_panel_set_gap(panel, 6, 0)`).
 * The tearing-effect line (GPIO13) is not used: a push of only what changed
 * is over before the scan reaches most of it, and Waveshare's BSP leaves it
 * off too. 40 MHz is the clock of the CO5300's esp_lcd component.
 *
 * Elecrow CrowPanel 2.01" watch (Elecrow's wiki and lessons): the GC9309 on
 * CS GPIO9, SCLK GPIO7, MOSI GPIO8, D/C GPIO10, reset GPIO6, the backlight
 * on GPIO13; its supply (GPIO40, low) is the board's (fos_board_rails), the
 * tearing line (GPIO21) unused as on the AMOLED. 80 MHz is Elecrow's. */
static const qspi_board_t k_boards[] = {
    {
        .preset = "waveshare_esp32_s3_touch_amoled_1_75",
        .panel = "AMOLED_CO5300_466x466",
        .width = 466, .height = 466,
        .x_gap = 6, .y_gap = 0,
        .round = true,
        .cs = 12, .sclk = 38, .data = {4, 5, 6, 7}, .rst = 39,
        .dc = -1, .backlight = -1,
        .spi_hz = 40 * 1000 * 1000,
        .init = k_co5300_init, .init_len = sizeof(k_co5300_init),
    },
    {
        .preset = "elecrow_crowpanel_watch_2in01",
        .panel = "LCD_GC9309_240x296",
        .width = 240, .height = 296,
        .cs = 9, .sclk = 7, .data = {8, -1, -1, -1}, .rst = 6,
        .dc = 10, .backlight = 13,
        .spi_hz = 80 * 1000 * 1000,
        .init = k_gc9309_init, .init_len = sizeof(k_gc9309_init),
    },
};

static const qspi_board_t *s_board = &k_boards[0];

void fos_lcd_qspi_select_board(const char *hardware_preset, const char *panel)
{
    const qspi_board_t *pick = &k_boards[0];
    bool by_panel = false;
    for (size_t i = 0; i < sizeof(k_boards) / sizeof(k_boards[0]); i++) {
        const qspi_board_t *b = &k_boards[i];
        if (hardware_preset && strcmp(hardware_preset, b->preset) == 0) {
            pick = b;
            break;
        }
        if (!by_panel && panel && strcmp(panel, b->panel) == 0) {
            pick = b;
            by_panel = true;
        }
    }
    s_board = pick;
}

void fos_lcd_qspi_size(int *width, int *height)
{
    if (width) *width = s_board->width;
    if (height) *height = s_board->height;
}

bool fos_lcd_qspi_round(void)
{
    return s_board->round;
}

#if CONFIG_IDF_TARGET_ESP32S3

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#define QSPI_HOST SPI2_HOST
/* The CO5300's QSPI framing (its esp_lcd component, Arduino_GFX): an 8-bit
 * opcode and a 24-bit address that carries the DCS command in its middle
 * byte. 0x02 writes a command and its parameters on one line; 0x32 writes
 * pixels, the opcode and address on one line and the data on four. */
#define OP_WRITE_CMD 0x02
#define OP_WRITE_PIXELS 0x32
#define DCS_SLPIN 0x10
#define DCS_SLPOUT 0x11
#define DCS_DISPOFF 0x28
#define DCS_DISPON 0x29
#define DCS_CASET 0x2A
#define DCS_RASET 0x2B
#define DCS_RAMWR 0x2C
#define DCS_BRIGHTNESS 0x51
/* Two DMA buffers in internal RAM, one filled while the other is sent:
 * 2 x 8 KB, a little over eight full rows each. */
#define QSPI_CHUNK_BYTES (8 * 1024)
#define QSPI_FBS 2

static bool s_ready = false;
static spi_device_handle_t s_dev = NULL;
static uint16_t *s_chunk[2] = {NULL, NULL};
static uint8_t *s_fbs[QSPI_FBS] = {NULL, NULL};
static int s_front = 0;   /* what the glass shows, pixel for pixel */
static int s_drawing = -1; /* handed to a writer (fos_lcd_qspi_back_buffer) */
static volatile uint32_t s_generation[QSPI_FBS] = {0, 0};
static size_t s_fb_bytes = 0;
/* One writer at a time (as on the RGB LCD), and the bus: the render task's
 * presents, the splash and the loading mark's pushes. */
static SemaphoreHandle_t s_write_lock = NULL;
static SemaphoreHandle_t s_bus_lock = NULL;
static void (*s_before_write)(const uint8_t *buf) = NULL;
static volatile bool s_splash_on = false;
static volatile int s_splash_status = FOS_LCD_SPLASH_NO_STATUS;
static volatile int64_t s_splash_status_at_us = 0;
static bool s_on = true;
static uint8_t s_brightness = 0xFF;
static fos_lcd_qspi_stats_t s_stats;
/* A presented picture goes onto the glass on a task of its own (core 0; the
 * render task is on core 1 on an LCD): the compare with the picture before,
 * then the push of what differs. The render task draws the next frame in the
 * other buffer meanwhile. That buffer is the picture before, which only the
 * compare reads: a writer waits for QSPI_OLD_FREE, a present for QSPI_IDLE
 * (the job before is over: one bus, one job). Without the task (it did not
 * start) a present compares and pushes in place, as before. */
#define QSPI_PUSH_CORE 0
#define QSPI_PUSH_PRIORITY 5
/* It uses about 1.1 KB (`lcd`'s "push stack N free"); internal RAM, as a
 * task stack in PSRAM faults while a flash write has the cache off. */
#define QSPI_PUSH_STACK 2048
#define QSPI_IDLE BIT0     /* no job in flight */
#define QSPI_OLD_FREE BIT1 /* the job's compare has read the picture before */
static TaskHandle_t s_push_task = NULL;
static EventGroupHandle_t s_push_state = NULL;
static int s_job_old = -1, s_job_new = -1;

static int buffer_index(const uint8_t *buf)
{
    for (int i = 0; i < QSPI_FBS; i++) {
        if (buf == s_fbs[i]) return i;
    }
    return -1;
}

/* ------------------------------------------------------------- the bus */

/* One lane: bytes with the D/C line at `level` (low: a command), the chip
 * select held after them when `keep` (the bus acquired). */
static esp_err_t dc_write(int level, const uint8_t *data, size_t len, bool keep)
{
    gpio_set_level((gpio_num_t)s_board->dc, level);
    /* Four bytes or fewer ride in the transaction itself: no DMA copy. */
    spi_transaction_t t = {
        .flags = (keep ? SPI_TRANS_CS_KEEP_ACTIVE : 0) | (len <= 4 ? SPI_TRANS_USE_TXDATA : 0),
        .length = len * 8,
        .tx_buffer = len <= 4 ? NULL : data,
    };
    if (len <= 4) memcpy(t.tx_data, data, len);
    return spi_device_polling_transmit(s_dev, &t);
}

static esp_err_t send_cmd(uint8_t cmd, const uint8_t *data, size_t len)
{
    if (s_board->dc >= 0) {
        esp_err_t err = spi_device_acquire_bus(s_dev, portMAX_DELAY);
        if (err != ESP_OK) return err;
        err = dc_write(0, &cmd, 1, len > 0);
        if (err == ESP_OK && len) err = dc_write(1, data, len, false);
        spi_device_release_bus(s_dev);
        return err;
    }
    spi_transaction_t t = {
        .cmd = OP_WRITE_CMD,
        .addr = (uint32_t)cmd << 8,
        .length = len * 8,
        .tx_buffer = len ? data : NULL,
    };
    return spi_device_polling_transmit(s_dev, &t);
}

static esp_err_t send_cmd1(uint8_t cmd, uint8_t value)
{
    return send_cmd(cmd, &value, 1);
}

static esp_err_t set_window(int x0, int y0, int x1, int y1)
{
    x0 += s_board->x_gap;
    x1 += s_board->x_gap;
    y0 += s_board->y_gap;
    y1 += s_board->y_gap;
    uint8_t cols[4] = {(uint8_t)(x0 >> 8), (uint8_t)x0, (uint8_t)(x1 >> 8), (uint8_t)x1};
    uint8_t rows[4] = {(uint8_t)(y0 >> 8), (uint8_t)y0, (uint8_t)(y1 >> 8), (uint8_t)y1};
    esp_err_t err = send_cmd(DCS_CASET, cols, sizeof(cols));
    if (err == ESP_OK) err = send_cmd(DCS_RASET, rows, sizeof(rows));
    return err;
}

/* The box of `frame` onto the glass, with the bus lock held: the window, then
 * RAMWR and the pixels in chunks under one chip select, each chunk swapped
 * into one DMA buffer while the other goes out. */
static esp_err_t push_box_locked(const uint8_t *frame, const fos_lcd_qspi_box_t *box)
{
    int w = box->x1 - box->x0 + 1;
    int h = box->y1 - box->y0 + 1;
    size_t row_bytes = (size_t)w * 2u;
    int rows_per_chunk = (int)(QSPI_CHUNK_BYTES / row_bytes);
    if (rows_per_chunk < 1) return ESP_ERR_INVALID_SIZE;
    esp_err_t err = set_window(box->x0, box->y0, box->x1, box->y1);
    if (err != ESP_OK) return err;
    err = spi_device_acquire_bus(s_dev, portMAX_DELAY);
    if (err != ESP_OK) return err;
    /* One lane: RAMWR as a command, the pixels after it as data, one chip
     * select over both. */
    bool one_lane = s_board->dc >= 0;
    if (one_lane) {
        const uint8_t ramwr = DCS_RAMWR;
        err = dc_write(0, &ramwr, 1, true);
        gpio_set_level((gpio_num_t)s_board->dc, 1);
    }
    /* Under the bus lock, so one push at a time uses them. */
    static spi_transaction_ext_t t[2];
    int queued = 0;
    int which = 0;
    for (int row = 0; row < h && err == ESP_OK; row += rows_per_chunk) {
        int rows = h - row < rows_per_chunk ? h - row : rows_per_chunk;
        bool last = row + rows >= h;
        /* The buffer about to be filled went out two chunks ago: wait for it. */
        if (queued == 2) {
            spi_transaction_t *done = NULL;
            err = spi_device_get_trans_result(s_dev, &done, portMAX_DELAY);
            queued--;
            if (err != ESP_OK) break;
        }
        fos_lcd_qspi_copy_swapped((const uint16_t *)frame, s_board->width, box, box->y0 + row, rows, s_chunk[which]);
        spi_transaction_ext_t *x = &t[which];
        memset(x, 0, sizeof(*x));
        x->base.flags = (one_lane ? 0 : SPI_TRANS_MODE_QIO) | (last ? 0 : SPI_TRANS_CS_KEEP_ACTIVE);
        if (one_lane) {
            /* data only */
        } else if (row == 0) {
            x->base.cmd = OP_WRITE_PIXELS;
            x->base.addr = (uint32_t)DCS_RAMWR << 8;
        } else {
            /* The rest of the same write: no opcode, no address. */
            x->base.flags |= SPI_TRANS_VARIABLE_CMD | SPI_TRANS_VARIABLE_ADDR;
            x->command_bits = 0;
            x->address_bits = 0;
        }
        x->base.length = (size_t)rows * row_bytes * 8u;
        x->base.tx_buffer = s_chunk[which];
        err = spi_device_queue_trans(s_dev, &x->base, portMAX_DELAY);
        if (err == ESP_OK) queued++;
        which ^= 1;
    }
    while (queued > 0) {
        spi_transaction_t *done = NULL;
        if (spi_device_get_trans_result(s_dev, &done, portMAX_DELAY) != ESP_OK) break;
        queued--;
    }
    spi_device_release_bus(s_dev);
    s_stats.bytes += (uint64_t)row_bytes * (uint64_t)h;
    return err;
}

static void push_box(const uint8_t *frame, fos_lcd_qspi_box_t box)
{
    fos_lcd_qspi_align_box(&box, s_board->width, s_board->height);
    xSemaphoreTake(s_bus_lock, portMAX_DELAY);
    esp_err_t err = push_box_locked(frame, &box);
    xSemaphoreGive(s_bus_lock);
    if (err != ESP_OK) ESP_LOGW(TAG, "push %d,%d..%d,%d: %s", box.x0, box.y0, box.x1, box.y1, esp_err_to_name(err));
}

static void push_all(const uint8_t *frame)
{
    fos_lcd_qspi_box_t box = {0, 0, s_board->width - 1, s_board->height - 1};
    push_box(frame, box);
}

/* -------------------------------------------------------- the controller */

static esp_err_t controller_init(void)
{
    const qspi_board_t *b = s_board;
    if (b->rst >= 0) {
        gpio_reset_pin((gpio_num_t)b->rst);
        gpio_set_direction((gpio_num_t)b->rst, GPIO_MODE_OUTPUT);
        gpio_set_level((gpio_num_t)b->rst, 1);
        vTaskDelay(pdMS_TO_TICKS(10));
        gpio_set_level((gpio_num_t)b->rst, 0);
        vTaskDelay(pdMS_TO_TICKS(20));
        gpio_set_level((gpio_num_t)b->rst, 1);
        vTaskDelay(pdMS_TO_TICKS(120));
    }
    if (b->dc >= 0) {
        gpio_reset_pin((gpio_num_t)b->dc);
        gpio_set_direction((gpio_num_t)b->dc, GPIO_MODE_OUTPUT);
    }
    for (const uint8_t *p = b->init, *end = b->init + b->init_len; p < end;) {
        uint8_t n = p[1] & (uint8_t)~INIT_WAIT;
        esp_err_t err = send_cmd(p[0], p + 2, n);
        if (err != ESP_OK) return err;
        if (p[1] & INIT_WAIT) vTaskDelay(pdMS_TO_TICKS(120));
        p += 2 + n;
    }
    return ESP_OK;
}

static esp_err_t bus_init(void)
{
    const qspi_board_t *b = s_board;
    bool one_lane = b->dc >= 0;
    spi_bus_config_t bus = {
        .data0_io_num = b->data[0],
        .data1_io_num = b->data[1],
        .data2_io_num = b->data[2],
        .data3_io_num = b->data[3],
        .data4_io_num = -1,
        .data5_io_num = -1,
        .data6_io_num = -1,
        .data7_io_num = -1,
        .sclk_io_num = b->sclk,
        .max_transfer_sz = QSPI_CHUNK_BYTES,
        .flags = SPICOMMON_BUSFLAG_MASTER | (one_lane ? 0 : SPICOMMON_BUSFLAG_QUAD),
    };
    esp_err_t err = spi_bus_initialize(QSPI_HOST, &bus, SPI_DMA_CH_AUTO);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "bus: %s", esp_err_to_name(err));
        return err;
    }
    spi_device_interface_config_t dev = {
        .command_bits = one_lane ? 0 : 8,
        .address_bits = one_lane ? 0 : 24,
        .mode = 0,
        .clock_speed_hz = (int)b->spi_hz,
        .spics_io_num = b->cs,
        .queue_size = 2,
        .flags = SPI_DEVICE_HALFDUPLEX,
    };
    err = spi_bus_add_device(QSPI_HOST, &dev, &s_dev);
    if (err != ESP_OK) ESP_LOGE(TAG, "device: %s", esp_err_to_name(err));
    return err;
}

/* The backlight of a glass that has one (the GC9309's): lit high. */
static void backlight(bool on)
{
    if (s_board->backlight < 0) return;
    gpio_set_direction((gpio_num_t)s_board->backlight, GPIO_MODE_OUTPUT);
    gpio_set_level((gpio_num_t)s_board->backlight, on);
}

/* --------------------------------------------------------- the buffers */

static void hold_writer(void)
{
    /* A picture is coming: the splash's next frame is its last. */
    s_splash_on = false;
    if (xSemaphoreGetMutexHolder(s_write_lock) == xTaskGetCurrentTaskHandle()) return;
    xSemaphoreTake(s_write_lock, portMAX_DELAY);
}

static void release_writer(void)
{
    if (xSemaphoreGetMutexHolder(s_write_lock) == xTaskGetCurrentTaskHandle()) xSemaphoreGive(s_write_lock);
}

static void wait_bits(EventBits_t bits)
{
    if (!s_push_task) return;
    if ((xEventGroupGetBits(s_push_state) & bits) == bits) return;
    int64_t start = esp_timer_get_time();
    xEventGroupWaitBits(s_push_state, bits, pdFALSE, pdTRUE, portMAX_DELAY);
    s_stats.waits++;
    s_stats.waited_us += (uint64_t)(esp_timer_get_time() - start);
}

static uint8_t *writable_back(void)
{
    /* The picture before, which the job in flight may still be comparing. */
    wait_bits(QSPI_OLD_FREE);
    if (s_drawing < 0) s_drawing = (s_front + 1) % QSPI_FBS;
    uint8_t *back = s_fbs[s_drawing];
    if (s_before_write) s_before_write(back);
    return back;
}

/* The picture in buffer `now` onto the glass, which shows buffer `old`: what
 * differs, timed. `compared` runs between the compare and the push. */
static void show_changes(int old, int now, void (*compared)(void))
{
    int64_t start = esp_timer_get_time();
    fos_lcd_qspi_box_t box;
    bool changed = fos_lcd_qspi_changed_box((const uint16_t *)s_fbs[old], (const uint16_t *)s_fbs[now],
                                            s_board->width, s_board->height, &box);
    int64_t pushed = esp_timer_get_time();
    s_stats.compare_us += (uint64_t)(pushed - start);
    if (compared) compared();
    if (!changed) return;
    push_box(s_fbs[now], box);
    uint32_t took = (uint32_t)(esp_timer_get_time() - pushed);
    fos_lcd_qspi_align_box(&box, s_board->width, s_board->height);
    s_stats.pushes++;
    s_stats.last_box[0] = (uint32_t)box.x0;
    s_stats.last_box[1] = (uint32_t)box.y0;
    s_stats.last_box[2] = (uint32_t)(box.x1 - box.x0 + 1);
    s_stats.last_box[3] = (uint32_t)(box.y1 - box.y0 + 1);
    s_stats.last_us = took;
    s_stats.push_us += took;
    if (took > s_stats.max_us) s_stats.max_us = took;
}

static void old_picture_free(void)
{
    xEventGroupSetBits(s_push_state, QSPI_OLD_FREE);
}

static void push_task(void *arg)
{
    (void)arg;
    while (true) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        show_changes(s_job_old, s_job_new, old_picture_free);
        xEventGroupSetBits(s_push_state, QSPI_IDLE | QSPI_OLD_FREE);
    }
}

/* Until the picture presented last is in the controller's RAM. */
static void wait_for_push(void)
{
    if (s_push_task) xEventGroupWaitBits(s_push_state, QSPI_IDLE, pdFALSE, pdTRUE, portMAX_DELAY);
}

/* The drawn buffer onto the glass, which shows it from then on (for the
 * loading mark, the splash and the next writer at once; the job sends it). */
static void present_back(void)
{
    int back = s_drawing;
    /* A picture after a switch began is that switch's: the loading mark
     * goes (and the glass gets back what was under it) first. */
    fos_lcd_qspi_loading_end();
    s_stats.presents++;
    if (s_push_task) {
        wait_bits(QSPI_IDLE);
        xEventGroupClearBits(s_push_state, QSPI_IDLE | QSPI_OLD_FREE);
        s_job_old = s_front;
        s_job_new = back;
        xTaskNotifyGive(s_push_task);
    } else {
        show_changes(s_front, back, NULL);
    }
    s_front = back;
    s_drawing = -1;
}

/* ---------------------------------------------------------- the splash */

/* As on the RGB LCD (lcd_st7701s_rgb.c splash_task): the squares walk their
 * colors until the first writer. Here a frame of it is the picture on the
 * glass copied into the other buffer, the squares drawn there and presented:
 * only the squares go over the bus. */
static void splash_task(void *arg)
{
    (void)arg;
    int64_t start_us = esp_timer_get_time();
    int shown = FOS_LCD_SPLASH_NO_STATUS;
    while (s_splash_on) {
        vTaskDelay(pdMS_TO_TICKS(FOS_LCD_SPLASH_FRAME_MS));
        if (xSemaphoreTake(s_write_lock, 0) != pdTRUE) continue;
        if (s_splash_on) {
            int64_t now_us = esp_timer_get_time();
            wait_bits(QSPI_OLD_FREE);
            int back = (s_front + 1) % QSPI_FBS;
            memcpy(s_fbs[back], s_fbs[s_front], s_fb_bytes);
            uint16_t *fb = (uint16_t *)s_fbs[back];
            fos_lcd_splash_draw(fb, s_board->width, s_board->height, (uint32_t)((now_us - start_us) / 1000), true);
            int wanted = s_splash_status;
            if (wanted != shown &&
                (shown != FOS_LCD_SPLASH_NO_STATUS ||
                 now_us - s_splash_status_at_us >= (int64_t)FOS_LCD_SPLASH_STATUS_DELAY_MS * 1000)) {
                fos_lcd_splash_draw_status(fb, s_board->width, s_board->height, (fos_lcd_splash_status_t)wanted);
                shown = wanted;
            }
            s_generation[back]++;
            s_drawing = back;
            present_back();
        }
        xSemaphoreGive(s_write_lock);
    }
    vTaskDelete(NULL);
}

void fos_lcd_qspi_splash_status(fos_lcd_splash_status_t status)
{
    s_splash_status_at_us = esp_timer_get_time();
    s_splash_status = (int)status;
}

/* ---------------------------------------------------- the loading mark */

/* lcd_st7701s_rgb.c's mark, drawn by a task on core 0 into the buffer the
 * glass shows, and the rectangle it touched pushed after each step. */
#define QSPI_MARK_CORE 0
#define QSPI_MARK_PRIORITY 2
#define QSPI_MARK_SAVED_WORDS 2048u

static SemaphoreHandle_t s_mark_lock = NULL;
static TaskHandle_t s_mark_task = NULL;
static fos_lcd_loading_t s_mark;
static int s_mark_index = -1;
static uint32_t s_mark_generation = 0;

/* As count_mark_move on the RGB LCD: a buffer holding the mark counts a write,
 * and gets it back once the mark is put away. */
static void count_mark_move(const uint16_t *before)
{
    if (s_mark.drawn_in == before) return;
    if (s_mark_index >= 0 && s_generation[s_mark_index] == s_mark_generation) s_generation[s_mark_index]--;
    s_mark_index = s_mark.drawn_in ? buffer_index((const uint8_t *)s_mark.drawn_in) : -1;
    if (s_mark_index >= 0) s_mark_generation = ++s_generation[s_mark_index];
}

/* After a step of the mark, with its lock held: the glass gets the rectangle
 * whenever the buffer it shows was written (the mark drawn, or put back). */
static void push_mark(const uint16_t *before, fos_lcd_loading_rect_t old)
{
    const uint16_t *front = (const uint16_t *)s_fbs[s_front];
    if (before != front && s_mark.drawn_in != front) return;
    fos_lcd_loading_rect_t r = s_mark.rect;
    if (before == front && memcmp(&old, &r, sizeof(r)) != 0 && old.w > 0) {
        /* Moved (another rotation): both, as one box. */
        int x0 = old.x < r.x || r.w <= 0 ? old.x : r.x;
        int y0 = old.y < r.y || r.w <= 0 ? old.y : r.y;
        int x1 = r.w <= 0 || old.x + old.w > r.x + r.w ? old.x + old.w : r.x + r.w;
        int y1 = r.w <= 0 || old.y + old.h > r.y + r.h ? old.y + old.h : r.y + r.h;
        r = (fos_lcd_loading_rect_t){x0, y0, x1 - x0, y1 - y0};
    }
    if (r.w <= 0 || r.h <= 0) return;
    fos_lcd_qspi_box_t box = {r.x, r.y, r.x + r.w - 1, r.y + r.h - 1};
    push_box(s_fbs[s_front], box);
}

static void mark_task(void *arg)
{
    (void)arg;
    while (true) {
        xSemaphoreTake(s_mark_lock, portMAX_DELAY);
        uint16_t *before = s_mark.drawn_in;
        fos_lcd_loading_rect_t old = s_mark.rect;
        uint32_t now_ms = xTaskGetTickCount() * portTICK_PERIOD_MS;
        int32_t wait_ms = fos_lcd_loading_step(&s_mark, (uint16_t *)s_fbs[s_front], now_ms);
        count_mark_move(before);
        push_mark(before, old);
        xSemaphoreGive(s_mark_lock);
        ulTaskNotifyTake(pdTRUE, wait_ms < 0 ? portMAX_DELAY
                                             : (TickType_t)(wait_ms + portTICK_PERIOD_MS - 1) / portTICK_PERIOD_MS);
    }
}

void fos_lcd_qspi_set_loading_mark(fos_loading_mark_fn mark)
{
    s_mark.draw = mark;
}

void fos_lcd_qspi_loading_begin(uint32_t since_tick, int rotation)
{
    if (!s_ready || s_splash_on || !s_mark.draw) return;
    if (!s_mark_task) {
        if (!s_mark.saved) {
            s_mark.saved = heap_caps_malloc(QSPI_MARK_SAVED_WORDS * sizeof(uint16_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        }
        if (!s_mark_lock) s_mark_lock = xSemaphoreCreateMutex();
        if (!s_mark.saved || !s_mark_lock ||
            xTaskCreatePinnedToCore(mark_task, "fos_mark", 3072, NULL, QSPI_MARK_PRIORITY, &s_mark_task,
                                    QSPI_MARK_CORE) != pdPASS) {
            s_mark_task = NULL;
            return;
        }
        s_mark.saved_words = QSPI_MARK_SAVED_WORDS;
        s_mark.width = s_board->width;
        s_mark.height = s_board->height;
    }
    xSemaphoreTake(s_mark_lock, portMAX_DELAY);
    uint16_t *before = s_mark.drawn_in;
    fos_lcd_loading_rect_t old = s_mark.rect;
    bool begun = fos_lcd_loading_begin(&s_mark, rotation, since_tick * portTICK_PERIOD_MS);
    count_mark_move(before);
    push_mark(before, old);
    xSemaphoreGive(s_mark_lock);
    if (begun) xTaskNotifyGive(s_mark_task);
}

void fos_lcd_qspi_loading_end(void)
{
    if (!s_mark_lock || (!s_mark.active && !s_mark.drawn_in)) return;
    xSemaphoreTake(s_mark_lock, portMAX_DELAY);
    uint16_t *before = s_mark.drawn_in;
    fos_lcd_loading_rect_t old = s_mark.rect;
    fos_lcd_loading_end(&s_mark);
    count_mark_move(before);
    push_mark(before, old);
    xSemaphoreGive(s_mark_lock);
}

/* -------------------------------------------------------- the panel API */

int fos_lcd_qspi_init(void)
{
    if (s_ready) return 0;
    const qspi_board_t *b = s_board;
    s_fb_bytes = (size_t)b->width * (size_t)b->height * 2u;
    for (int i = 0; i < QSPI_FBS; i++) {
        s_fbs[i] = heap_caps_aligned_alloc(64, s_fb_bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (!s_fbs[i]) {
            ESP_LOGE(TAG, "no PSRAM for a %u byte frame buffer", (unsigned)s_fb_bytes);
            return 1;
        }
    }
    for (int i = 0; i < 2; i++) {
        s_chunk[i] = heap_caps_malloc(QSPI_CHUNK_BYTES, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
        if (!s_chunk[i]) {
            ESP_LOGE(TAG, "no internal DMA RAM for the push buffers");
            return 1;
        }
    }
    s_write_lock = xSemaphoreCreateMutex();
    s_bus_lock = xSemaphoreCreateMutex();
    s_push_state = xEventGroupCreate();
    if (!s_write_lock || !s_bus_lock || !s_push_state) return 1;
    xEventGroupSetBits(s_push_state, QSPI_IDLE | QSPI_OLD_FREE);
    if (bus_init() != ESP_OK) return 1;
    if (controller_init() != ESP_OK) {
        ESP_LOGE(TAG, "%s: the controller did not take its setup", b->preset);
        return 1;
    }
    /* Black with the FrameOS mark until the first picture, in both buffers,
     * onto the glass before it is lit. */
    for (int i = 0; i < QSPI_FBS; i++) {
        memset(s_fbs[i], 0, s_fb_bytes);
        fos_lcd_splash_draw((uint16_t *)s_fbs[i], b->width, b->height, 0, false);
    }
    s_front = 0;
    push_all(s_fbs[0]);
    send_cmd(DCS_DISPON, NULL, 0);
    backlight(true);
    if (xTaskCreatePinnedToCore(push_task, "fos_qspi_push", QSPI_PUSH_STACK, NULL, QSPI_PUSH_PRIORITY, &s_push_task,
                                QSPI_PUSH_CORE) != pdPASS) {
        s_push_task = NULL;
        ESP_LOGW(TAG, "no push task: each present pushes in place");
    }
    s_on = true;
    s_stats.spi_hz = b->spi_hz;
    s_ready = true;
    s_splash_on = true;
    if (xTaskCreate(splash_task, "fos_splash", 2560, NULL, 1, NULL) != pdPASS) s_splash_on = false;
    ESP_LOGI(TAG, "%s %dx%d up: RGB565 on %d lane(s) at %lu Hz", b->preset, b->width, b->height,
             b->dc >= 0 ? 1 : 4, (unsigned long)b->spi_hz);
    return 0;
}

void fos_lcd_qspi_display(uint8_t *buf)
{
    if (!s_ready || !buf) return;
    hold_writer();
    uint8_t *back = s_drawing >= 0 && buf == s_fbs[s_drawing] ? buf : NULL;
    if (!back) {
        back = writable_back();
        if (buf != back) {
            memcpy(back, buf, s_fb_bytes);
            s_generation[buffer_index(back)]++;
        }
    }
    present_back();
    release_writer();
}

void fos_lcd_qspi_clear(void)
{
    if (!s_ready) return;
    hold_writer();
    uint8_t *back = writable_back();
    memset(back, 0xFF, s_fb_bytes);
    s_generation[buffer_index(back)]++;
    present_back();
    release_writer();
}

void fos_lcd_qspi_sleep(void)
{
    /* Keep showing the frame. */
}

uint8_t *fos_lcd_qspi_back_buffer(uint32_t *generation)
{
    if (!s_ready) return NULL;
    hold_writer();
    uint8_t *back = writable_back();
    if (generation) *generation = s_generation[buffer_index(back)];
    return back;
}

void fos_lcd_qspi_release_back_buffer(void)
{
    if (!s_ready) return;
    s_drawing = -1;
    release_writer();
}

void fos_lcd_qspi_mark_written(const uint8_t *buf)
{
    int index = buffer_index(buf);
    if (index >= 0) s_generation[index]++;
}

int64_t fos_lcd_qspi_buffer_generation(const uint8_t *buf)
{
    int index = buffer_index(buf);
    return index < 0 ? -1 : (int64_t)s_generation[index];
}

void fos_lcd_qspi_set_before_write_hook(void (*hook)(const uint8_t *buf))
{
    s_before_write = hook;
}

esp_err_t fos_lcd_qspi_power(bool on)
{
    if (!s_ready) return ESP_ERR_INVALID_STATE;
    /* DISPOFF alone left this glass lit (the bench, 2026-11-23): its
     * brightness goes to 0 with it, and comes back with DISPON. */
    xSemaphoreTake(s_bus_lock, portMAX_DELAY);
    esp_err_t err = s_board->backlight >= 0 ? ESP_OK : send_cmd1(DCS_BRIGHTNESS, on ? s_brightness : 0);
    if (err == ESP_OK) err = send_cmd(on ? DCS_DISPON : DCS_DISPOFF, NULL, 0);
    xSemaphoreGive(s_bus_lock);
    backlight(on && err == ESP_OK);
    if (err == ESP_OK) s_on = on;
    return err;
}

esp_err_t fos_lcd_qspi_brightness(uint8_t level)
{
    if (!s_ready) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(s_bus_lock, portMAX_DELAY);
    esp_err_t err = s_on ? send_cmd1(DCS_BRIGHTNESS, level) : ESP_OK;
    xSemaphoreGive(s_bus_lock);
    if (err == ESP_OK) s_brightness = level;
    return err;
}

esp_err_t fos_lcd_qspi_prepare_deep_sleep(void)
{
    if (!s_ready) return ESP_ERR_NOT_SUPPORTED;
    /* The last picture into the controller's RAM before it sleeps. */
    wait_for_push();
    backlight(false);
    xSemaphoreTake(s_bus_lock, portMAX_DELAY);
    esp_err_t err = send_cmd(DCS_DISPOFF, NULL, 0);
    if (err == ESP_OK) err = send_cmd(DCS_SLPIN, NULL, 0);
    xSemaphoreGive(s_bus_lock);
    if (err == ESP_OK) vTaskDelay(pdMS_TO_TICKS(120));
    return err;
}

bool fos_lcd_qspi_stats(fos_lcd_qspi_stats_t *out, bool reset)
{
    if (!s_ready) return false;
    if (out) {
        *out = s_stats;
        out->on = s_on;
        out->brightness = s_brightness;
        out->push_stack_free = s_push_task ? (uint32_t)uxTaskGetStackHighWaterMark(s_push_task) : 0;
    }
    if (reset) {
        uint32_t hz = s_stats.spi_hz;
        memset(&s_stats, 0, sizeof(s_stats));
        s_stats.spi_hz = hz;
    }
    return true;
}

#else /* a chip without the QSPI wiring this panel needs (the C3 image) */

int fos_lcd_qspi_init(void)
{
    ESP_LOGE(TAG, "this image does not drive QSPI panels");
    return 1;
}
void fos_lcd_qspi_display(uint8_t *buf) { (void)buf; }
void fos_lcd_qspi_clear(void) {}
void fos_lcd_qspi_sleep(void) {}
uint8_t *fos_lcd_qspi_back_buffer(uint32_t *generation)
{
    if (generation) *generation = 0;
    return NULL;
}
void fos_lcd_qspi_release_back_buffer(void) {}
void fos_lcd_qspi_mark_written(const uint8_t *buf) { (void)buf; }
int64_t fos_lcd_qspi_buffer_generation(const uint8_t *buf)
{
    (void)buf;
    return -1;
}
void fos_lcd_qspi_set_before_write_hook(void (*hook)(const uint8_t *buf)) { (void)hook; }
esp_err_t fos_lcd_qspi_power(bool on)
{
    (void)on;
    return ESP_ERR_NOT_SUPPORTED;
}
esp_err_t fos_lcd_qspi_brightness(uint8_t level)
{
    (void)level;
    return ESP_ERR_NOT_SUPPORTED;
}
esp_err_t fos_lcd_qspi_prepare_deep_sleep(void) { return ESP_ERR_NOT_SUPPORTED; }
void fos_lcd_qspi_splash_status(fos_lcd_splash_status_t status) { (void)status; }
void fos_lcd_qspi_set_loading_mark(fos_loading_mark_fn mark) { (void)mark; }
void fos_lcd_qspi_loading_begin(uint32_t since_tick, int rotation)
{
    (void)since_tick;
    (void)rotation;
}
void fos_lcd_qspi_loading_end(void) {}
bool fos_lcd_qspi_stats(fos_lcd_qspi_stats_t *out, bool reset)
{
    (void)out;
    (void)reset;
    return false;
}

#endif
