#include "fos_touch.h"

#include <stdio.h>
#include <string.h>

int fos_touch_decode(const uint8_t *report, size_t len, fos_touch_point_t *points, size_t max)
{
    if (!report || len < 1) return -1;
    uint8_t status = report[0];
    if ((status & FOS_TOUCH_STATUS_READY) == 0) return -1;
    int count = status & 0x0F;
    if (count > FOS_TOUCH_POINTS_MAX) return -1;
    if (len < 1 + (size_t)count * FOS_TOUCH_POINT_BYTES) return -1;
    int out = 0;
    for (int i = 0; i < count; i++) {
        const uint8_t *rec = report + 1 + (size_t)i * FOS_TOUCH_POINT_BYTES;
        if ((size_t)out >= max) break;
        /* track id, x low, x high, y low, y high, size low, size high, reserved */
        points[out].id = rec[0] & 0x0F;
        points[out].x = (uint16_t)(rec[1] | (rec[2] << 8));
        points[out].y = (uint16_t)(rec[3] | (rec[4] << 8));
        out++;
    }
    return out;
}

int fos_touch_decode_ft(const uint8_t *report, size_t len, fos_touch_point_t *points, size_t max)
{
    if (!report || len < 1) return -1;
    int count = report[0] & 0x0F;
    if (count > FOS_TOUCH_POINTS_MAX) return -1;
    if (len < 1 + (size_t)count * FOS_TOUCH_FT_POINT_BYTES) return -1;
    int out = 0;
    for (int i = 0; i < count; i++) {
        const uint8_t *rec = report + 1 + (size_t)i * FOS_TOUCH_FT_POINT_BYTES;
        if ((size_t)out >= max) break;
        int event = rec[0] >> 6;
        int id = rec[2] >> 4;
        if (event == FOS_TOUCH_FT_EVENT_UP || event == FOS_TOUCH_FT_EVENT_NONE || id == 0x0F) continue;
        points[out].id = (uint8_t)id;
        points[out].x = (uint16_t)(((rec[0] & 0x0F) << 8) | rec[1]);
        points[out].y = (uint16_t)(((rec[2] & 0x0F) << 8) | rec[3]);
        out++;
    }
    return out;
}

int fos_touch_wire(int value, int max)
{
    if (max <= 1) return 0;
    if (value < 0) value = 0;
    if (value > max - 1) value = max - 1;
    return (int)(((long)value * FOS_TOUCH_WIRE_MAX) / (max - 1));
}

bool fos_touch_axes_swapped(int touch_x_max, int touch_y_max, int panel_width, int panel_height)
{
    if (touch_x_max <= 0 || touch_y_max <= 0 || panel_width <= 0 || panel_height <= 0) return false;
    if (touch_x_max == touch_y_max || panel_width == panel_height) return false;
    return (touch_x_max > touch_y_max) != (panel_width > panel_height);
}

#ifdef ESP_PLATFORM
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_log.h"
#include "esp_sleep.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "soc/soc_caps.h"
#if SOC_PM_SUPPORT_EXT0_WAKEUP
#include "driver/rtc_io.h"
#endif

#include "fos_client.h"
#include "fos_config.h"
#include "fos_events.h"
#include "fos_i2c.h"
#include "fos_events_gen.h"
#include "frameos_display.h"
#include "frameos_nim.h"

static const char *TAG = "fos_touch";

#define TOUCH_I2C_HZ 400000
#define TOUCH_I2C_TIMEOUT_MS 50
/* While a finger is down the controller pulses INT per report (~100 Hz);
 * a poll at this rate catches a release whose pulse was missed. Idle, the
 * task sleeps until the line moves. */
#define TOUCH_POLL_HELD_MS 20
#define TOUCH_POLL_IDLE_MS 2000
/* Without an interrupt line (the SenseCAP Indicator's FT6336U: its INT is on
 * the IO expander, unwired) the task polls: a tap is 80 ms or longer, so
 * every 30 ms catches it. One two-byte read at 400 kHz, ~0.1 ms. */
#define TOUCH_POLL_NO_IRQ_MS 30
/* Edges a render can sit on. A move coalesces into the newest move of the
 * same finger, so this is mostly downs and ups: 64 is plenty. */
#define TOUCH_QUEUE_LEN 64

typedef enum { TOUCH_DOWN = 0, TOUCH_MOVE = 1, TOUCH_UP = 2 } touch_kind_t;

typedef struct {
    uint8_t kind;
    uint8_t id;
    uint16_t x; /* wire units */
    uint16_t y;
} touch_event_t;

typedef enum { CTRL_GT911 = 0, CTRL_FT6X36 = 1 } controller_t;
static const char *const k_controller_names[] = {"gt911", "ft6x36"};

static bool s_present = false;
static i2c_master_bus_handle_t s_bus = NULL;
/* False when the bus is somebody else's: fos_i2c.c's (the E1003's GT911
 * shares the clock's bus) or the display's (fos_display_shared_i2c_bus: the
 * Indicator's LCD expander shares it). The touch panel then adds its device
 * but never deletes the bus. */
static bool s_bus_owned = false;
static bool s_polled = false; /* no interrupt line: the task polls */
static controller_t s_controller = CTRL_GT911;
static i2c_master_dev_handle_t s_dev = NULL;
static uint8_t s_addr = 0;
static int s_x_max = 0, s_y_max = 0;
static bool s_swap = false;
static SemaphoreHandle_t s_irq = NULL;
static portMUX_TYPE s_queue_lock = portMUX_INITIALIZER_UNLOCKED;
static touch_event_t s_queue[TOUCH_QUEUE_LEN];
static uint8_t s_head = 0, s_count = 0;
static uint32_t s_dropped = 0;
/* What is down, by track id, and where it last was (wire units). */
static uint8_t s_down_mask = 0;
static uint16_t s_last_x[FOS_TOUCH_POINTS_MAX], s_last_y[FOS_TOUCH_POINTS_MAX];
static int s_last_raw_x = -1, s_last_raw_y = -1;
static bool s_woke = false;

/* ------------------------------------------------------------- the queue */

static void enqueue(touch_kind_t kind, uint8_t id, uint16_t x, uint16_t y)
{
    portENTER_CRITICAL(&s_queue_lock);
    if (kind == TOUCH_MOVE && s_count > 0) {
        touch_event_t *tail = &s_queue[(s_head + s_count - 1) % TOUCH_QUEUE_LEN];
        if (tail->kind == TOUCH_MOVE && tail->id == id) {
            tail->x = x;
            tail->y = y;
            portEXIT_CRITICAL(&s_queue_lock);
            return;
        }
    }
    if (s_count == TOUCH_QUEUE_LEN) {
        s_dropped++;
        portEXIT_CRITICAL(&s_queue_lock);
        return;
    }
    touch_event_t *slot = &s_queue[(s_head + s_count) % TOUCH_QUEUE_LEN];
    slot->kind = (uint8_t)kind;
    slot->id = id;
    slot->x = x;
    slot->y = y;
    s_count++;
    portEXIT_CRITICAL(&s_queue_lock);
    fos_client_wake_for_events();
}

static bool dequeue(touch_event_t *out)
{
    portENTER_CRITICAL(&s_queue_lock);
    if (s_count == 0) {
        portEXIT_CRITICAL(&s_queue_lock);
        return false;
    }
    *out = s_queue[s_head];
    s_head = (uint8_t)((s_head + 1) % TOUCH_QUEUE_LEN);
    s_count--;
    portEXIT_CRITICAL(&s_queue_lock);
    return true;
}

bool fos_touch_pending(void)
{
    return s_count > 0;
}

bool fos_touch_process_events(void)
{
    touch_event_t event;
    bool any = false;
    static const char *const names[] = {FOS_EVENT_POINTER_DOWN, FOS_EVENT_POINTER_MOVE, FOS_EVENT_POINTER_UP};
    while (dequeue(&event)) {
        char payload[160];
        /* The wire position, the finger (pointer ids from 1: 0 is the one
         * mouse cursor), `touch`, and for a down or an up the primary
         * button and what is held after it (docs/events.md "Pointer"). */
        if (event.kind == TOUCH_MOVE) {
            snprintf(payload, sizeof(payload),
                     "{\"x\":%u,\"y\":%u,\"pointerId\":%u,\"pointerType\":\"touch\",\"buttons\":1}",
                     event.x, event.y, event.id + 1);
        } else {
            snprintf(payload, sizeof(payload),
                     "{\"x\":%u,\"y\":%u,\"pointerId\":%u,\"pointerType\":\"touch\",\"button\":0,\"buttons\":%d}",
                     event.x, event.y, event.id + 1, event.kind == TOUCH_DOWN ? 1 : 0);
        }
        /* `driver`: the glass talking. This is the render task, so the
         * runtime lock is free; fos_events.c asks for the render when a
         * gesture changed state. */
        fos_events_dispatch(FOS_ORIGIN_DRIVER, names[event.kind], payload);
        any = true;
    }
    return any;
}

/* --------------------------------------------------------- the controller */

static esp_err_t reg_read(uint16_t reg, uint8_t *buf, size_t len)
{
    uint8_t addr[2] = {(uint8_t)(reg >> 8), (uint8_t)reg};
    return i2c_master_transmit_receive(s_dev, addr, sizeof(addr), buf, len, TOUCH_I2C_TIMEOUT_MS);
}

static esp_err_t reg_write_byte(uint16_t reg, uint8_t value)
{
    uint8_t frame[3] = {(uint8_t)(reg >> 8), (uint8_t)reg, value};
    return i2c_master_transmit(s_dev, frame, sizeof(frame), TOUCH_I2C_TIMEOUT_MS);
}

/* The FocalTech controllers take one-byte register addresses. */
static esp_err_t ft_read(uint8_t reg, uint8_t *buf, size_t len)
{
    return i2c_master_transmit_receive(s_dev, &reg, 1, buf, len, TOUCH_I2C_TIMEOUT_MS);
}

static void IRAM_ATTR on_irq(void *arg)
{
    (void)arg;
    BaseType_t woke = pdFALSE;
    xSemaphoreGiveFromISR(s_irq, &woke);
    if (woke) portYIELD_FROM_ISR();
}

/* The GT911's address is chosen by the level of INT while RST rises: low
 * for 0x5d (0xBA/0xBB), high for 0x14 (0x28/0x29). Drive it low, then let
 * it go: the controller owns the line from here. */
static void reset_controller(const fos_touch_pins_t *pins)
{
    if (pins->en >= 0) {
        gpio_set_direction((gpio_num_t)pins->en, GPIO_MODE_OUTPUT);
        gpio_set_level((gpio_num_t)pins->en, 1);
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    if (pins->irq >= 0) {
        gpio_set_direction((gpio_num_t)pins->irq, GPIO_MODE_OUTPUT);
        gpio_set_level((gpio_num_t)pins->irq, 0);
    }
    if (pins->rst >= 0) {
        gpio_set_direction((gpio_num_t)pins->rst, GPIO_MODE_OUTPUT);
        gpio_set_level((gpio_num_t)pins->rst, 0);
        vTaskDelay(pdMS_TO_TICKS(10));
        gpio_set_level((gpio_num_t)pins->rst, 1);
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    if (pins->irq >= 0) {
        gpio_set_direction((gpio_num_t)pins->irq, GPIO_MODE_INPUT);
        gpio_set_pull_mode((gpio_num_t)pins->irq, GPIO_FLOATING);
    }
    vTaskDelay(pdMS_TO_TICKS(60));
}

static bool attach(uint8_t addr)
{
    if (s_dev) {
        i2c_master_bus_rm_device(s_dev);
        s_dev = NULL;
    }
    i2c_device_config_t dev_config = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = addr,
        .scl_speed_hz = TOUCH_I2C_HZ,
    };
    return i2c_master_bus_add_device(s_bus, &dev_config, &s_dev) == ESP_OK;
}

static bool probe_gt911(uint8_t addr)
{
    if (!attach(addr)) return false;
    uint8_t id[4] = {0};
    if (reg_read(FOS_TOUCH_REG_PRODUCT_ID, id, sizeof(id)) != ESP_OK) return false;
    /* "911" from a GT911; a GT9xx cousin still speaks the same report. */
    return id[0] == '9';
}

static bool probe_ft(uint8_t addr)
{
    if (!attach(addr)) return false;
    /* Any FocalTech answers its touch-count register; an empty address does not. */
    uint8_t count = 0;
    return ft_read(FOS_TOUCH_FT_REG_TOUCHES, &count, 1) == ESP_OK;
}

/* One report from whichever controller is there: the fingers down. */
static int read_points(fos_touch_point_t *points)
{
    if (s_controller == CTRL_FT6X36) {
        uint8_t report[FOS_TOUCH_FT_REPORT_BYTES];
        if (ft_read(FOS_TOUCH_FT_REG_TOUCHES, report, sizeof(report)) != ESP_OK) return -1;
        return fos_touch_decode_ft(report, sizeof(report), points, FOS_TOUCH_POINTS_MAX);
    }
    uint8_t report[FOS_TOUCH_REPORT_BYTES];
    if (reg_read(FOS_TOUCH_REG_STATUS, report, sizeof(report)) != ESP_OK) return -1;
    int count = fos_touch_decode(report, sizeof(report), points, FOS_TOUCH_POINTS_MAX);
    if (count >= 0) reg_write_byte(FOS_TOUCH_REG_STATUS, 0);
    return count;
}

static void touch_task(void *arg)
{
    (void)arg;
    fos_touch_point_t points[FOS_TOUCH_POINTS_MAX];
    while (true) {
        uint32_t wait_ms = s_down_mask ? TOUCH_POLL_HELD_MS : s_polled ? TOUCH_POLL_NO_IRQ_MS : TOUCH_POLL_IDLE_MS;
        xSemaphoreTake(s_irq, pdMS_TO_TICKS(wait_ms));
        int count = read_points(points);
        if (count < 0) continue; /* nothing new, or a failed read */
        uint8_t seen = 0;
        for (int i = 0; i < count; i++) {
            fos_touch_point_t *p = &points[i];
            if (p->id >= FOS_TOUCH_POINTS_MAX) continue;
            int rx = s_swap ? p->y : p->x;
            int ry = s_swap ? p->x : p->y;
            int x_max = s_swap ? s_y_max : s_x_max;
            int y_max = s_swap ? s_x_max : s_y_max;
            uint16_t wx = (uint16_t)fos_touch_wire(rx, x_max);
            uint16_t wy = (uint16_t)fos_touch_wire(ry, y_max);
            s_last_raw_x = p->x;
            s_last_raw_y = p->y;
            seen |= (uint8_t)(1u << p->id);
            if ((s_down_mask & (1u << p->id)) == 0) {
                enqueue(TOUCH_DOWN, p->id, wx, wy);
            } else if (wx != s_last_x[p->id] || wy != s_last_y[p->id]) {
                enqueue(TOUCH_MOVE, p->id, wx, wy);
            }
            s_last_x[p->id] = wx;
            s_last_y[p->id] = wy;
        }
        uint8_t lifted = s_down_mask & (uint8_t)~seen;
        for (int id = 0; id < FOS_TOUCH_POINTS_MAX; id++) {
            if (lifted & (1u << id)) enqueue(TOUCH_UP, (uint8_t)id, s_last_x[id], s_last_y[id]);
        }
        s_down_mask = seen;
    }
}

static void log_line(const char *line)
{
    frameos_nim_log_hook(line);
}

static void drop_bus(void)
{
    if (s_dev) i2c_master_bus_rm_device(s_dev);
    if (s_bus && s_bus_owned) i2c_del_master_bus(s_bus);
    s_dev = NULL;
    s_bus = NULL;
    s_bus_owned = false;
}

esp_err_t fos_touch_start(void)
{
    const fos_config_t *config = fos_config();
    const fos_touch_pins_t *pins = &config->touch_pins;
    if (pins->sda < 0 || pins->scl < 0) return ESP_ERR_NOT_FOUND;
    /* The display may already run a bus on these pins (the Indicator's LCD
     * expander, with the FT6336U next to it): join it instead of opening the
     * same two GPIOs twice. Its pins are then the display's business. */
    void *shared = NULL;
    bool share = fos_display_shared_i2c_bus(pins->sda, pins->scl, &shared) == ESP_OK && shared;
    const int candidates[] = {share ? -1 : pins->sda, share ? -1 : pins->scl, pins->irq, pins->rst, pins->en};
    for (size_t i = 0; i < sizeof(candidates) / sizeof(candidates[0]); i++) {
        const char *why = candidates[i] >= 0 ? fos_config_gpio_pin_reserved(candidates[i]) : NULL;
        if (why) {
            ESP_LOGW(TAG, "touch GPIO %d refused: %s", candidates[i], why);
            return ESP_ERR_INVALID_ARG;
        }
    }
    reset_controller(pins);
    /* A controller on a bus fos_i2c.c already runs (the reTerminal E1003's,
     * on the clock's 19/20) joins it too: a second bus on the same pins would
     * take them from the first. */
    s_bus = share ? (i2c_master_bus_handle_t)shared : fos_i2c_lend_bus(pins->sda, pins->scl);
    s_bus_owned = false;
    if (!s_bus) {
        i2c_master_bus_config_t bus_config = {
            .i2c_port = -1,
            .sda_io_num = (gpio_num_t)pins->sda,
            .scl_io_num = (gpio_num_t)pins->scl,
            .clk_source = I2C_CLK_SRC_DEFAULT,
            .glitch_ignore_cnt = 7,
            .flags = {.enable_internal_pullup = true},
        };
        esp_err_t err = i2c_new_master_bus(&bus_config, &s_bus);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "touch bus sda%d/scl%d: %s", pins->sda, pins->scl, esp_err_to_name(err));
            s_bus = NULL;
            return err;
        }
        s_bus_owned = true;
    }
    s_polled = pins->irq < 0;
    /* Who answers: the Goodix addresses first (its id register says so),
     * then the FocalTech ones. */
    static const uint8_t gt_addresses[] = {0x5d, 0x14};
    static const uint8_t ft_addresses[] = {0x48, 0x38};
    for (size_t i = 0; i < sizeof(gt_addresses) && s_addr == 0; i++) {
        if (i2c_master_probe(s_bus, gt_addresses[i], TOUCH_I2C_TIMEOUT_MS) == ESP_OK && probe_gt911(gt_addresses[i])) {
            s_addr = gt_addresses[i];
            s_controller = CTRL_GT911;
        }
    }
    for (size_t i = 0; i < sizeof(ft_addresses) && s_addr == 0; i++) {
        if (i2c_master_probe(s_bus, ft_addresses[i], TOUCH_I2C_TIMEOUT_MS) == ESP_OK && probe_ft(ft_addresses[i])) {
            s_addr = ft_addresses[i];
            s_controller = CTRL_FT6X36;
        }
    }
    if (s_addr == 0) {
        log_line("{\"event\":\"touch:error\",\"source\":\"esp32\",\"error\":\"no controller answered at 0x5d, 0x14, 0x48 or 0x38\"}");
        drop_bus();
        return ESP_ERR_NOT_FOUND;
    }
    uint8_t range[4] = {0};
    if (s_controller == CTRL_GT911 && reg_read(FOS_TOUCH_REG_X_MAX, range, sizeof(range)) == ESP_OK) {
        s_x_max = range[0] | (range[1] << 8);
        s_y_max = range[2] | (range[3] << 8);
    }
    /* A controller with no configured range reports in the panel's. */
    if (s_x_max <= 1 || s_y_max <= 1 || s_x_max > 4096 || s_y_max > 4096) {
        s_x_max = fos_display_width();
        s_y_max = fos_display_height();
    }
    s_swap = fos_touch_axes_swapped(s_x_max, s_y_max, fos_display_width(), fos_display_height());
    s_irq = xSemaphoreCreateBinary();
    if (!s_irq) return ESP_ERR_NO_MEM;
    if (!s_polled) {
        /* Any edge: the controller's trigger polarity is its configuration's,
         * and a poll follows either way. */
        gpio_install_isr_service(0); /* ESP_ERR_INVALID_STATE when already installed: fine */
        gpio_set_intr_type((gpio_num_t)pins->irq, GPIO_INTR_ANYEDGE);
        gpio_isr_handler_add((gpio_num_t)pins->irq, on_irq, NULL);
        gpio_intr_enable((gpio_num_t)pins->irq);
    }
    if (xTaskCreate(touch_task, "fos_touch", 3072, NULL, 4, NULL) != pdPASS) return ESP_ERR_NO_MEM;
    s_present = true;
    char line[224];
    snprintf(line, sizeof(line),
             "{\"event\":\"touch:ready\",\"source\":\"esp32\",\"controller\":\"%s\",\"address\":\"0x%02x\","
             "\"xMax\":%d,\"yMax\":%d,\"swapped\":%s,\"polled\":%s,\"sharedBus\":%s,\"wake\":%s}",
             k_controller_names[s_controller], s_addr, s_x_max, s_y_max, s_swap ? "true" : "false",
             s_polled ? "true" : "false", share ? "true" : "false",
             fos_touch_wake_pin() >= 0 ? "true" : "false");
    log_line(line);
    return ESP_OK;
}

bool fos_touch_present(void)
{
    return s_present;
}

int fos_touch_wake_pin(void)
{
#if SOC_PM_SUPPORT_EXT0_WAKEUP
    const fos_config_t *config = fos_config();
    if (!s_present) return -1;
    int pin = config->touch_pins.irq;
    return pin >= 0 && rtc_gpio_is_valid_gpio((gpio_num_t)pin) ? pin : -1;
#else
    return -1;
#endif
}

esp_err_t fos_touch_arm_wake(void)
{
    int pin = fos_touch_wake_pin();
    if (pin < 0) return ESP_OK;
#if SOC_PM_SUPPORT_EXT0_WAKEUP
    const fos_touch_pins_t *pins = &fos_config()->touch_pins;
    /* The controller stays powered and out of reset through the sleep, so
     * it can raise its line: the digital pads hold their level. */
    if (pins->en >= 0) gpio_hold_en((gpio_num_t)pins->en);
    if (pins->rst >= 0) gpio_hold_en((gpio_num_t)pins->rst);
    gpio_deep_sleep_hold_en();
    /* Wake on the line LEAVING its idle level, whichever that is for this
     * controller's trigger setting: read it now, arm the other. */
    int idle = gpio_get_level((gpio_num_t)pin);
    esp_err_t err = esp_sleep_enable_ext0_wakeup((gpio_num_t)pin, idle ? 0 : 1);
    if (err != ESP_OK) ESP_LOGW(TAG, "arming touch wake on GPIO %d failed: %s", pin, esp_err_to_name(err));
    return err;
#else
    return ESP_OK;
#endif
}

bool fos_touch_woke_chip(void)
{
#if SOC_PM_SUPPORT_EXT0_WAKEUP
    if (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_EXT0) s_woke = true;
#endif
    return s_woke;
}

void fos_touch_print_status(void)
{
    const fos_touch_pins_t *pins = &fos_config()->touch_pins;
    if (pins->sda < 0 || pins->scl < 0) {
        printf("touch:       none (set touch_pins sda=3,scl=2,int=21,rst=41,en=42)\n");
        return;
    }
    if (!s_present) {
        printf("touch:       sda GPIO %d, scl GPIO %d, int GPIO %d: no controller answered\n",
               (int)pins->sda, (int)pins->scl, (int)pins->irq);
        return;
    }
    printf("touch:       %s at 0x%02x, %dx%d%s, int GPIO %d%s, fingers down 0x%02x, last raw %d,%d, dropped %lu\n",
           k_controller_names[s_controller], s_addr, s_x_max, s_y_max, s_swap ? " (axes swapped)" : "",
           (int)pins->irq, s_polled ? " (polled)" : "", (unsigned)s_down_mask,
           s_last_raw_x, s_last_raw_y, (unsigned long)s_dropped);
}
#endif /* ESP_PLATFORM */
