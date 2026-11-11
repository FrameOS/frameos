/*
 * FrameOS ESP32-S3 firmware.
 *
 * Boot: NVS config → display select → Wi-Fi (STA, or captive-portal
 * provisioning when unconfigured) → SNTP → HTTP server + render loop
 * (Nim runtime on-device, or thin client fetching backend bitmaps) → OTA.
 * A touch LCD (the SenseCAP Indicator) does not wait for Wi-Fi and has no
 * portal: it joins in the background and is set up on its own screen
 * (the settings panel's Frame tab, fos_frame_settings.c).
 *
 * The serial console (USB) is always available: `help` for commands,
 * `wifi <ssid> [pass]` provisions a frame without the portal.
 */
#include <dirent.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "driver/gpio.h"
#include "esp_app_desc.h"
#include "esp_spiffs.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"

#include "fos_assets.h"
#include "fos_assets_flash.h"
#include "fos_assets_sd.h"
#include "fos_battery.h"
#include "fos_defaults.h"
#include "fos_events.h"
#include "fos_buttons.h"
#include "fos_buzzer.h"
#include "fos_climate.h"
#include "fos_i2c.h"
#include "fos_led.h"
#include "fos_rtc.h"
#include "fos_codec.h"
#include "fos_touch.h"
#include "fos_voice.h"
#include "fos_client.h"
#include "fos_cloud.h"
#include "fos_config.h"
#include "fos_console.h"
#include "fos_frame_settings.h"
#include "fos_framebuffer.h"
#include "fos_http.h"
#include "fos_ota.h"
#include "fos_scenes.h"
#include "fos_scene_state.h"
#include "fos_schedule.h"
#include "fos_settings.h"
#include "fos_status_screen.h"
#include "fos_tz.h"
#include "fos_mem.h"
#include "fos_wifi.h"
#include "frameos_display.h"
#include "lcd_splash.h"
#if CONFIG_IDF_TARGET_ESP32S3
#include "soc/rtc.h"
#endif
#include "frameos_nim.h"
#include "fos_log_ring.h"

static const char *TAG = "frameos";

#define WIFI_CONNECT_TIMEOUT_MS 45000
#define SNTP_TIMEOUT_MS 10000

/* Heartbeat on the XIAO ESP32-S3 user LED (GPIO 21, active low). Slow
 * blink = running, fast blink = provisioning portal. Only the S3 gets a
 * default: on the C3 boards GPIO 21 is display CS (XTEINK X4) or I2C
 * (TRMNL), so "unconnected GPIO" no longer holds; boards without a plain
 * LED disable the task with -1. */
#ifndef FRAMEOS_HEARTBEAT_GPIO
#if CONFIG_IDF_TARGET_ESP32S3
#define FRAMEOS_HEARTBEAT_GPIO 21
#else
#define FRAMEOS_HEARTBEAT_GPIO -1
#endif
#endif
#define HEARTBEAT_GPIO FRAMEOS_HEARTBEAT_GPIO

static volatile uint32_t s_blink_period_ms = 2000;

static void heartbeat_task(void *arg)
{
    gpio_reset_pin(HEARTBEAT_GPIO);
    gpio_set_direction(HEARTBEAT_GPIO, GPIO_MODE_OUTPUT);
    bool on = false;
    while (true) {
        on = !on;
        gpio_set_level(HEARTBEAT_GPIO, on ? 0 : 1);
        vTaskDelay(pdMS_TO_TICKS(s_blink_period_ms / 2));
    }
}

/* The heartbeat's pin is the XIAO's LED; on other boards it may be wired to
 * something that must not blink: the reTerminal E1001/E1002/E1004 switch
 * their battery divider through GPIO21 (a blinking enable line reads as an
 * empty cell, 0 mV on the E1004), the E1003 its IT8951 controller's power
 * (pins.cs2) and the reTerminal Sticky's touch panel interrupts on it. */
static bool heartbeat_pin_free(const fos_config_t *config)
{
    const int taken[] = {
        config->battery_enable_pin, config->led_pin,
        config->pins.rst, config->pins.dc, config->pins.cs, config->pins.cs2,
        config->pins.busy, config->pins.sck, config->pins.mosi, config->pins.pwr,
        config->touch_pins.sda, config->touch_pins.scl, config->touch_pins.irq,
        config->touch_pins.rst, config->touch_pins.en,
    };
    for (size_t i = 0; i < sizeof(taken) / sizeof(taken[0]); i++) {
        if (taken[i] == HEARTBEAT_GPIO) return false;
    }
    return true;
}

/* The panel temperature for a controller that has no sensor of its own (the
 * reTerminal E1003's IT8951), from the board's SHT40. */
static bool panel_temperature(int *celsius)
{
    int centi = 0;
    if (fos_climate_read(&centi, NULL) != ESP_OK) return false;
    *celsius = (centi + (centi >= 0 ? 50 : -50)) / 100;
    return true;
}

/* fos_display_set_i2c_lender: a board chip the display drives (the
 * PhotoPainter's AXP2101) joins the bus fos_i2c.c already runs on its pins. */
static void *lend_i2c_bus(int sda, int scl)
{
    return fos_i2c_lend_bus(sda, scl);
}

static void action_ota_now(void)
{
    ESP_LOGW(TAG, "manual OTA requested");
    esp_err_t err = fos_ota_request_check();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "manual OTA request failed: %s", esp_err_to_name(err));
    }
}

static void action_render_now(void)
{
    fos_client_render_fresh();
}

/* How long a scene's changed state may wait in RAM before it is written to
 * the state partition (fos_scene_state.h: a write that erases stalls the
 * flash cache, and an RGB panel scanned from PSRAM glitches). An RGB LCD
 * waits ten minutes: a Ken Burns slideshow changes its photo counter every
 * photo, and written every minute it erased a block, a disturbed scan, every
 * several minutes on the SenseCAP Indicator (2026-10-26). Such a frame runs
 * on mains power, and a restart or a deep sleep still writes first. */
#define SCENE_STATE_WRITE_DELAY_MS (60 * 1000)
#define SCENE_STATE_LCD_WRITE_DELAY_MS (10 * 60 * 1000)

static SemaphoreHandle_t s_scene_state_mutex = NULL;
static SemaphoreHandle_t s_scene_state_flush_mutex = NULL;

static uint32_t scene_state_now_ms(void)
{
    return (uint32_t)(esp_timer_get_time() / 1000);
}

static void scene_state_lock(void)
{
    xSemaphoreTake(s_scene_state_mutex, portMAX_DELAY);
}

static void scene_state_unlock(void)
{
    xSemaphoreGive(s_scene_state_mutex);
}

static void scene_state_flush_lock(void)
{
    xSemaphoreTake(s_scene_state_flush_mutex, portMAX_DELAY);
}

static void scene_state_flush_unlock(void)
{
    xSemaphoreGive(s_scene_state_flush_mutex);
}

/* Writes the scene state that has waited its delay, on a task of its own: a
 * SPIFFS write is 0.7 s on the reTerminal E1003 and 3 s on the Sticky
 * (2026-11-10), and on the render task, which also drains the touch queue,
 * it held a tap that long. Not while someone taps: a write still stalls a
 * scene load waiting on the same partition. */
static void scene_state_writer_task(void *arg)
{
    (void)arg;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        if (!fos_client_input_held()) fos_scene_state_flush(fos_scene_state_crowded());
    }
}

static void log_ring_flush_on_restart(void)
{
    /* esp_restart: the lines explaining why go out before the reset. A
     * panic never gets here; those are lost with the ring. */
    fos_log_ring_flush(500);
}

static void scene_state_flush_on_restart(void)
{
    fos_scene_state_flush(true);
}

static void scene_state_write_behind(void)
{
    s_scene_state_mutex = xSemaphoreCreateMutex();
    s_scene_state_flush_mutex = xSemaphoreCreateMutex();
    if (s_scene_state_mutex == NULL || s_scene_state_flush_mutex == NULL) return; /* writes through, as before */
    const fos_scene_state_write_behind_t behind = {
        .delay_ms = fos_display_is_lcd() ? SCENE_STATE_LCD_WRITE_DELAY_MS : SCENE_STATE_WRITE_DELAY_MS,
        .now_ms = scene_state_now_ms,
        .lock = scene_state_lock,
        .unlock = scene_state_unlock,
        .flush_lock = scene_state_flush_lock,
        .flush_unlock = scene_state_flush_unlock,
    };
    fos_scene_state_set_write_behind(&behind);
    xTaskCreatePinnedToCore(scene_state_writer_task, "state_wr", 4096, NULL, tskIDLE_PRIORITY + 1, NULL, 0);
    esp_register_shutdown_handler(scene_state_flush_on_restart);
}

/* The CPU at 240 MHz. On the S3 both clocks divide the same 480 MHz PLL,
 * so the PSRAM and flash clocks do not move; the switch is the one ESP-IDF's
 * power management makes, core voltage first. */
static void cpu_240(const char *why)
{
#if CONFIG_IDF_TARGET_ESP32S3
    rtc_cpu_freq_config_t cpu;
    if (rtc_clk_cpu_freq_mhz_to_config(240, &cpu)) {
        rtc_clk_cpu_freq_set_config(&cpu);
        printf("cpu: 240 MHz (%s)\n", why);
    }
#else
    (void)why;
#endif
}

/* The generic image boots at 160 MHz. `cpu_mode` (the frame's "Processor
 * speed") decides whether this board goes to 240: auto does for a screen
 * someone watches, an RGB LCD or a touch panel, and leaves an e-paper frame
 * at 160. There a render is a few seconds of work and the refresh a long
 * wait (about 20 s on a reTerminal E1002), and the chip idles through the
 * wait at whatever clock it runs (README "Processor speed"). */
static void cpu_for_mode(const fos_config_t *config, bool touch)
{
    bool lcd = fos_display_is_lcd();
    if (fos_config_cpu_mhz(config->cpu_mode, lcd, touch) != 240) return;
    cpu_240(config->cpu_mode == FOS_CPU_PERFORMANCE ? "performance" : lcd ? "RGB LCD" : "touch");
}

static void log_bootup_event(bool online);

/* A sixteen-grey panel's packed picture is the 4-bit canvas byte for byte
 * when nothing turns it (dither.nim packGray4Canvas): the buffer reserved for
 * the panel serves as the canvas too, and the 1.31 MB a reTerminal E1003
 * held twice of its 8 MB goes back to the renders (2026-11-10). A turned
 * frame packs with a turn, so it keeps a canvas of its own; changing the
 * rotation restarts the firmware. */
static bool canvas_is_panel_picture(const fos_config_t *config)
{
    return fos_display_format() == FOS_PIXEL_4BPP_GRAY && fos_display_canvas_bits_per_pixel() == 4 &&
           config->rotate == 0 && fos_display_canvas_bytes() == fos_display_buffer_size() &&
           fos_framebuffer_reserved_bytes() == fos_display_buffer_size();
}

/* The stored Wi-Fi came back while the provisioning portal was serving.
 * fos_wifi has already dropped the open AP; bring the rest up the way the
 * online boot path does, and replace the portal status screen. */
/* What a boot that waited for Wi-Fi did before its first render, for one
 * that got it later. Not marking the image valid here: that happens after
 * the first successful render (fos_client.c) — "reached Wi-Fi" said nothing
 * about whether the Nim runtime or the scene survive. */
static void online_steps(uint32_t sntp_timeout_ms)
{
    fos_wifi_sync_time(sntp_timeout_ms);
    frameos_nim_set_log_upload_enabled(true);
    log_bootup_event(true);
    fos_ota_start_periodic_task(24);
    fos_client_render_now();
}

static void on_portal_exit(void)
{
    ESP_LOGI(TAG, "Wi-Fi recovered; leaving the provisioning portal");
    s_blink_period_ms = 2000;
    fos_http_stop();
    fos_http_start(false);
    online_steps(SNTP_TIMEOUT_MS);
}

/* A touch LCD's boot went on without Wi-Fi (app_main, touch_setup): the
 * steps an online boot takes before its first render, run the first time the
 * station gets an address. Later addresses (a lost link back) need none. */
static bool s_online_steps_done = false;

static void on_wifi_online(void)
{
    if (__atomic_exchange_n(&s_online_steps_done, true, __ATOMIC_SEQ_CST)) return;
    ESP_LOGI(TAG, "Wi-Fi up after boot (%s)", fos_wifi_ip());
    if (fos_ota_boot_request_pending()) fos_ota_request_check();
    /* An LCD renders without the clock and again when it comes. */
    fos_wifi_set_late_time_hook(action_render_now);
    online_steps(0);
}

static void log_bootup_event(bool online)
{
    fos_config_t *config = fos_config();
    const esp_app_desc_t *app = esp_app_get_description();
    int width = fos_display_present() ? fos_display_width() : 800;
    int height = fos_display_present() ? fos_display_height() : 480;
    int pixel_format = fos_display_present() ? (int)fos_display_format() : 1;
    char log_line[360];
    snprintf(log_line, sizeof(log_line),
             "{\"event\":\"bootup\",\"source\":\"esp32\",\"width\":%d,\"height\":%d,"
             "\"pixelFormat\":%d,\"mode\":\"embedded\",\"renderMode\":\"%s\","
             "\"version\":\"%s\",\"panel\":\"%s\",\"ip\":\"%s\",\"wifi\":\"%s\"}",
             width, height, pixel_format,
             config->render_mode == FOS_RENDER_LOCAL ? "local" : "remote",
             app->version, config->panel, fos_wifi_ip(), online ? "connected" : "offline");
    frameos_nim_log_hook(log_line);
    frameos_nim_flush_logs();
}

/* Boot-time memory attribution, the C-side companion to the Nim -d:memProbe.
 * Off by default; build with -DFRAMEOS_BOOTMEM=1 to find out which init step
 * is holding the PSRAM a render needs. This is how the 1.57 MB default-font
 * parse was found: every other step on this list costs a couple of KB. */
#if defined(FRAMEOS_BOOTMEM) && FRAMEOS_BOOTMEM
#define BOOTMEM(stage) ESP_LOGW(TAG, "BOOTMEM %-24s psram_free=%u largest=%u internal=%u", \
    stage, (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM), \
    (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM), \
    (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL))
#else
#define BOOTMEM(stage) ((void)0)
#endif

void app_main(void)
{
    const esp_app_desc_t *app = esp_app_get_description();
    const esp_partition_t *running = esp_ota_get_running_partition();
    ESP_LOGI(TAG, "FrameOS %s (idf %s) booting from %s",
             app->version, app->idf_ver, running ? running->label : "?");

    BOOTMEM("start");
    ESP_ERROR_CHECK(fos_config_init());
    fos_config_t *config = fos_config();

    /* Before the wake check below: a button wake clicks the buzzer, and the
     * status LED that follows it (fos_led.c) lights with it. */
    fos_led_init();
    fos_buzzer_init();
    /* Before the buttons: a voice key held at the first look starts a
     * voice session (docs/voice-chat.md). */
    fos_voice_init();
    /* Before anything else reads the wake status: was this a button press? */
    fos_buttons_wake_boot();
    /* Buttons this early so the press that woke the chip is followed while
     * the finger is still down: the hold's second ticks and the release
     * click sound in time, Wi-Fi and the scene load notwithstanding. A
     * button wake also replays its press into the queue here, and the
     * render loop's first pass (fos_client_resume, below) dispatches it. */
    if (fos_buttons_start() != ESP_OK) {
        ESP_LOGW(TAG, "GPIO buttons unavailable");
    }

    /* The I2C peripherals (fos_i2c.c): the charger the power decision asks
     * about USB, the clock that knows the time before Wi-Fi (not after a deep
     * sleep: the chip kept it), the climate sensor. A few milliseconds. */
    fos_i2c_init();
    if (esp_reset_reason() != ESP_RST_DEEPSLEEP) fos_rtc_load_time();
    /* The audio codec of the Waveshare boards (fos_codec.c), once the chips
     * have answered on the bus: the speaker the buzzer's notes play on and
     * the microphone the voice chat listens with. */
    fos_codec_init();

    fos_battery_init(config->battery_pin, config->battery_divider, config->battery_enable_pin);
    if (fos_battery_present()) {
        int battery_mv = 0, battery_pct = -1;
        fos_battery_read(&battery_mv, &battery_pct);
        ESP_LOGI(TAG, "battery: %d mV (%d%%)", battery_mv, battery_pct);
    }

    fos_display_config_t display_config = {
        .panel = config->panel,
        .hardware_preset = config->hardware_preset,
        .rst = config->pins.rst, .dc = config->pins.dc,
        .cs = config->pins.cs, .cs2 = config->pins.cs2,
        .busy = config->pins.busy, .sck = config->pins.sck,
        .mosi = config->pins.mosi, .pwr = config->pins.pwr,
    };
    BOOTMEM("after-config");
    /* An LCD's boot mark is drawn the way up the frame's pictures are. */
    fos_lcd_splash_set_rotation(config->rotate);
    fos_display_set_i2c_lender(lend_i2c_bus);
    if (fos_display_init(&display_config) != ESP_OK) {
        ESP_LOGW(TAG, "display init failed, continuing headless");
    }
    fos_display_set_temperature_hook(panel_temperature);

    /* An RGB LCD board renders at 240 MHz unless its cpu_mode says battery:
     * an LCD is lit and mains-powered anyway, and its renders are watched
     * (the SenseCAP Indicator's took ~3.8 s at 160, 2026-10-25). A touch
     * board goes to 240 too, below, once its controller answers. */
    if (fos_display_is_lcd() || config->cpu_mode == FOS_CPU_PERFORMANCE) cpu_for_mode(config, false);

    /* Not where the pin is wired to something else (heartbeat_pin_free), nor
     * on an RGB LCD, whose pixel clock is GPIO21 (the SenseCAP Indicator):
     * the panel is known only once the display is selected. */
    if (HEARTBEAT_GPIO >= 0 && heartbeat_pin_free(config) && !fos_display_is_lcd()) {
        xTaskCreate(heartbeat_task, "heartbeat", 2048, NULL, 2, NULL);
    }

    /* Claim the panel buffer here — the panel size is known and Wi-Fi, lwIP,
     * httpd and SPIFFS have not yet carved up the internal heap. On a
     * PSRAM-less C3 this is the difference between a frame that renders and
     * one that reports "out of memory for 96000 byte framebuffer" with 120 KB
     * free but no block that size. No-op on PSRAM boards. */
    if (fos_display_present()) {
        fos_framebuffer_reserve(fos_display_buffer_size());
        /* The Nim renderer packs into the same reservation (fos_framebuffer.h).
         * The hooks take/return the buffer through the acquire/release pair
         * that fos_client.c already uses to hand it back after the blit. */
        frameos_nim_set_render_buffer_hooks((void *(*)(size_t))fos_framebuffer_acquire_render,
                                            (void (*)(void *))fos_framebuffer_release);
        /* An RGB LCD's refill interrupt shares core 1 with the render task;
         * a realloc copying under the heap's spinlock held it off for 1-2 ms
         * mid-render (a band of stale lines, bench 2026-10-25). */
        if (fos_display_is_lcd()) frameos_nim_set_realloc_outside_lock(true);
    }

    /* fos_assets_sd_mount emits its own structured "assets:sd" line into the
     * log ring (and replays it to the backend/cloud once upload is enabled,
     * below) — a mount failure must never be a serial-only event, or "why are
     * my assets empty?" has no remote answer. */
    BOOTMEM("after-display");
    FOS_MEM_LOG_MILESTONE(TAG, "after-display");
    /* The touch panel (fos_touch.c), after the display: the panel's size
     * decides which way the controller's axes run. Absent on most boards. */
    if (fos_touch_start() == ESP_ERR_NOT_FOUND && config->touch_pins.sda >= 0) {
        ESP_LOGW(TAG, "touch panel configured but not found");
    }
    /* Someone touching the glass is waiting for every frame: a touch e-paper
     * board renders at 240 MHz as an LCD does. A third off each render's
     * CPU time on the reTerminal E1003 and the Sticky, whose renders took
     * 1.5 to 5 s at 160 (2026-11-10); a battery pays for it only while awake,
     * and a render that ends sooner sleeps sooner. */
    if (fos_touch_present() && !fos_display_is_lcd() && config->cpu_mode == FOS_CPU_AUTO) cpu_for_mode(config, true);
    if (fos_assets_sd_mount(config) != ESP_OK) {
        ESP_LOGW(TAG, "SD assets unavailable, continuing without %s: %s",
                 config->assets_path[0] ? config->assets_path : "/srv/assets",
                 fos_assets_sd_last_error());
    } else {
        fos_assets_cleanup_stale_uploads();
    }

    /* Memory guardrail (M4): refuse to render a panel on-device that can't fit
     * the module's PSRAM — it would OOM mid-render. Fall back to thin-client
     * (the backend renders the bitmap) so the frame still works. */
    bool local_render_ok = true;
    if (fos_display_present()) {
        size_t need = fos_display_render_psram_bytes();
        size_t have = heap_caps_get_total_size(MALLOC_CAP_SPIRAM);
        if (have == 0) {
            /* PSRAM-less module (every supported ESP32-C3 board): thin-client
             * is the design, not a degradation — keep the log calm. */
            if (config->render_mode != FOS_RENDER_REMOTE) {
                ESP_LOGI(TAG, "no PSRAM on this module; running as a thin client "
                         "(the backend or cloud renders)");
                config->render_mode = FOS_RENDER_REMOTE;
            }
            local_render_ok = false;
        } else if (need > have) {
            ESP_LOGE(TAG, "panel %s needs ~%u KB PSRAM to render on-device but the module has "
                     "~%u KB; switching to thin-client mode", config->panel,
                     (unsigned)(need / 1024), (unsigned)(have / 1024));
            config->render_mode = FOS_RENDER_REMOTE;
            local_render_ok = false;
        }
    }

    /* The renderer's scene canvas, claimed now for the same reason the thin-
     * client framebuffer was above: it is the one multi-MB contiguous PSRAM
     * run the device needs, and before Wi-Fi/TLS there is always one. */
    if (local_render_ok && frameos_nim_available() && fos_display_present()) {
        if (canvas_is_panel_picture(config)) {
            frameos_nim_share_canvas(fos_framebuffer_reserved_buffer(), fos_framebuffer_reserved_bytes());
        } else {
            frameos_nim_reserve_canvas(fos_display_canvas_bytes());
        }
    }

    BOOTMEM("after-sd");
    ESP_ERROR_CHECK(fos_wifi_init());
    fos_http_set_actions(action_render_now, action_ota_now);
    /* Scene state across deep sleep: the runtime reads a scene's last public
     * state when it builds the scene and writes it when it changes, behind
     * (fos_scene_state.h): the render task flushes it, and so does a
     * restart from any task. */
    scene_state_write_behind();
    frameos_nim_set_scene_state_hooks(fos_scene_state_load, fos_scene_state_save);

    /* A touch LCD is set up on its own screen, so it neither waits for
     * Wi-Fi nor opens a hotspot: the settings panel (a swipe down from the
     * top) has the network, and the frame joins it in the background. */
    bool touch_setup = fos_touch_present() && fos_display_is_lcd();
    fos_frame_settings_init();
    bool online = false;
    if (touch_setup) {
        if (fos_config_wifi_ready()) {
            esp_err_t err = fos_wifi_start_background();
            if (err != ESP_OK) ESP_LOGW(TAG, "Wi-Fi failed to start: %s", esp_err_to_name(err));
        } else {
            ESP_LOGI(TAG, "no Wi-Fi configured; set it up from the screen (swipe down from the top)");
        }
    } else if (fos_config_wifi_ready()) {
        fos_display_boot_status(FOS_LCD_SPLASH_WIFI);
        online = fos_wifi_connect(WIFI_CONNECT_TIMEOUT_MS) == ESP_OK;
        if (!online) {
            ESP_LOGW(TAG, "Wi-Fi unreachable; starting provisioning portal");
        }
    } else {
        ESP_LOGI(TAG, "no Wi-Fi configured; starting provisioning portal");
    }

    if (online) {
        if (fos_display_is_lcd()) {
            /* An LCD shows its first picture without the clock and renders
             * again when the pool answers: a frame is cheap there, and the
             * boot waited for SNTP longer than for Wi-Fi (up to the whole
             * timeout, 10 s, on a pool that answered late). A panel that
             * refreshes for seconds still waits, so it refreshes once. */
            fos_wifi_set_late_time_hook(action_render_now);
            fos_wifi_sync_time(0);
        } else {
            fos_wifi_sync_time(SNTP_TIMEOUT_MS);
        }
        /* A pending-verify image stays pending until its first render
         * completes (fos_client.c: fos_ota_mark_boot_valid there), so a
         * release that boots, joins Wi-Fi and then dies in Nim or scene init
         * rolls back instead of boot-looping with a valid mark. */
        if (fos_ota_boot_request_pending()) {
            fos_display_boot_status(FOS_LCD_SPLASH_UPDATE);
            esp_err_t ota_err = fos_ota_run_boot_request();
            if (ota_err != ESP_OK) {
                ESP_LOGW(TAG, "boot OTA request failed: %s", esp_err_to_name(ota_err));
            }
        }
    }

    /* Reserve the large render stack before Nim/QuickJS, SPIFFS and httpd
     * consume internal RAM, but after early-boot OTA had a chance to run with
     * the leanest possible task set. The task waits until fos_client_resume()
     * below, so starting it here only claims the stack. */
    /* Before any render: decides whether the previous boot was a memory
     * rescue and whether rendering should stay paused this time. */
    /* The portal draws its own screen; a frame online is on its way to the
     * first render. */
    fos_display_boot_status(online || touch_setup ? FOS_LCD_SPLASH_STARTING : FOS_LCD_SPLASH_NO_STATUS);
    BOOTMEM("after-wifi");
    FOS_MEM_LOG_MILESTONE(TAG, "after-wifi");
    fos_client_render_recovery_boot();
    fos_client_start();

    BOOTMEM("after-client-start");
    FOS_MEM_LOG_MILESTONE(TAG, "after-client-start");
    if (frameos_nim_available() && local_render_ok) {
        int width = fos_display_present() ? fos_display_width() : 800;
        int height = fos_display_present() ? fos_display_height() : 480;
        char frame_name[64];
        snprintf(frame_name, sizeof(frame_name), "frame %lu", (unsigned long)config->frame_id);
        if (frameos_nim_init(width, height, frame_name, config->max_http_response_bytes,
                             config->backend_url, config->api_key,
                             config->server_send_logs, config->rotate)) {
            ESP_LOGI(TAG, "nim runtime up: %s", frameos_nim_info());
        } else {
            ESP_LOGE(TAG, "nim runtime failed to initialize");
        }
    } else if (frameos_nim_available()) {
        ESP_LOGW(TAG, "nim runtime compiled in but not started (panel too large for PSRAM)");
    } else {
        ESP_LOGI(TAG, "nim runtime not compiled in (thin-client only)");
    }

    /* Interpreted scenes: mount /state and queue any cached scenes.json;
     * the render task applies it and keeps it synced with the backend. */
    BOOTMEM("after-nim-init");

    if (fos_scenes_init() != ESP_OK) {
        ESP_LOGW(TAG, "scene storage unavailable, continuing without");
    } else if (!config->assets_sd.enabled &&
               fos_assets_flash_mount(config->assets_path[0] ? config->assets_path : "/srv/assets") == ESP_OK) {
        /* No SD card wired (the SenseCAP Indicator's slot is the RP2040's):
         * the assets directory lives on the state partition. A board with a
         * slot and no card keeps waiting for one. */
        fos_assets_cleanup_stale_uploads();
    }
    /* The other half of what the Nim dispatcher hands back to the firmware:
     * fos_scenes_init installed the scene-select hook, this installs the
     * device-command one. Before any producer (HTTP, cloud, console) exists. */
    fos_events_init();
    BOOTMEM("after-scenes-init");
    /* Needs the Nim runtime (chrono) and /state (the stored slice): from
     * here localtime(), QuickJS Date and the schedule run in the frame's
     * zone. Thin clients stay in UTC. */
    fos_tz_boot();
    fos_schedule_init();

    /* Oversized HTTP bodies (multi-MB gallery images) spill to storage
     * instead of failing on PSRAM pressure (cloud/docs/esp32-large-image-
     * spill.md). Prefer the SD card — a dot-directory stays invisible to the
     * asset API — over the /state SPIFFS partition. Sweep leftovers from a
     * crash before registering. */
    {
        const char *spill_dir = NULL;
        char sd_spill[160];
        /* Extra per-body cap on top of the frame's max_http_response_bytes.
         * SD card: none — the setting alone decides, so a 20 MB gallery JPEG
         * needs nothing but a higher limit. /state (SPIFFS) also holds the
         * scene store: leave headroom for it, and never more than 8 MB. */
        size_t spill_cap = 0;
        if (fos_assets_sd_mounted()) {
            snprintf(sd_spill, sizeof(sd_spill), "%s/.cache",
                     config->assets_path[0] ? config->assets_path : "/srv/assets");
            mkdir(sd_spill, 0775);
            spill_dir = sd_spill;
        } else if (fos_scenes_state_mounted()) {
            size_t state_total = 0, state_used = 0;
            spill_cap = 8 * 1024 * 1024;
            if (esp_spiffs_info("state", &state_total, &state_used) == ESP_OK && state_total > state_used) {
                size_t free_bytes = state_total - state_used;
                size_t margin = 512 * 1024; /* scene updates must still fit */
                size_t usable = free_bytes > margin ? free_bytes - margin : 0;
                if (usable < spill_cap) spill_cap = usable;
            }
            if (spill_cap >= 256 * 1024) {
                spill_dir = "/state";
            } else {
                ESP_LOGW(TAG, "http spill disabled: /state has too little free space");
            }
        }
        if (spill_dir != NULL) {
            DIR *dir = opendir(spill_dir);
            if (dir != NULL) {
                struct dirent *entry;
                while ((entry = readdir(dir)) != NULL) {
                    if (strncmp(entry->d_name, "http-spill-", 11) != 0) continue;
                    char stale[448];
                    snprintf(stale, sizeof(stale), "%s/%s", spill_dir, entry->d_name);
                    unlink(stale);
                    ESP_LOGW(TAG, "removed stale spill file %s", stale);
                }
                closedir(dir);
            }
            fos_nim_http_set_spill_dir(spill_dir, spill_cap);
            fos_nim_http_set_spill_force_bytes(config->http_spill_force_bytes);
            ESP_LOGI(TAG, "http spill dir: %s (cap %u bytes%s)%s", spill_dir,
                     (unsigned)spill_cap, spill_cap ? "" : " = setting only",
                     config->http_spill_force_bytes ? " (forced)" : "");
        }
    }

    BOOTMEM("after-spill");
    fos_console_start();
    /* Log lines leave the logging task here on: a printf on the render task
     * was a third of an isolated tap on an LCD board (fos_log_ring.h). */
    fos_log_ring_start();
    esp_register_shutdown_handler(log_ring_flush_on_restart);

    /* Cloud-managed frames (docs/cloud-frames.md): idles until cloud_url and
     * a claim token are provisioned (USB `set`, flasher) and Wi-Fi is up,
     * then enrolls and, when enrolled, runs the management WebSocket. */
    BOOTMEM("after-console");
    if (fos_cloud_start() != ESP_OK) {
        ESP_LOGW(TAG, "cloud client unavailable");
    }
    /* The service settings the last pull left in NVS, so the first pass —
     * on a deep-sleep frame the only one — renders with its API keys. After
     * fos_cloud_start: the enrolled state it gates on is loaded there. */
    fos_settings_boot_apply_cache();

    if (touch_setup) {
        /* The station may already have its address: then the online steps
         * ran (or run) from fos_wifi's task, and the rest is the same either
         * way. The HTTP server answers once there is a network to answer on. */
        if (config->assets_sd.enabled) fos_assets_sd_log_status();
        if (fos_rtc_present()) fos_rtc_log_status();
        frameos_nim_set_log_upload_enabled(false);
        fos_http_start(false);
        if (!fos_config_wifi_ready()) fos_ota_mark_boot_valid();
        /* Now that the runtime is up (its init resets the log upload): an
         * address from here on runs the online steps, and one that came
         * during the boot runs them now. */
        fos_wifi_set_online_cb(on_wifi_online);
        if (fos_wifi_state() == FOS_WIFI_CONNECTED) on_wifi_online();
    } else if (online) {
        frameos_nim_set_log_upload_enabled(true);
        if (config->assets_sd.enabled) fos_assets_sd_log_status();
        if (fos_rtc_present()) fos_rtc_log_status();
        log_bootup_event(true);
        fos_http_start(false);
        fos_ota_start_periodic_task(24);
        BOOTMEM("after-http+ota");
        FOS_MEM_LOG_MILESTONE(TAG, "after-http+ota");
    } else {
        frameos_nim_set_log_upload_enabled(false);
        if (!fos_config_wifi_ready()) {
            /* Fresh device: nothing to roll back to that would do better. */
            fos_ota_mark_boot_valid();
        }
        /* If Wi-Fi creds exist but fail after an OTA, we deliberately do NOT
         * mark valid: a reset rolls back to the previous image. (An offline
         * frame that still renders its scenes marks itself valid on that
         * render, the same as an online one.) */
        s_blink_period_ms = 400;
        fos_wifi_start_portal();
        fos_http_start(true);
        fos_status_screen_show_portal(fos_wifi_ap_ssid(), fos_wifi_ap_psk(), fos_wifi_ip());
        /* Registered after the portal httpd is up, so a station that comes
         * back right away still ends with httpd in status mode (a recovery
         * before this line is replayed by the call). */
        fos_wifi_set_portal_exit_cb(on_portal_exit);
    }

    /* Render loop runs in both cases: local mode works fully offline. The
     * button task started at the top of boot; its queue waits for this. */
    fos_client_resume();

    ESP_LOGI(TAG, "boot complete: wifi=%s ip=%s portal=%s",
             online ? "connected" : "offline", fos_wifi_ip(),
             fos_wifi_state() == FOS_WIFI_PORTAL ? fos_wifi_ap_ssid() : "no");
}
