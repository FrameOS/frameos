/*
 * Panel-agnostic display API for the FrameOS embedded runtime.
 *
 * Every supported root Waveshare driver is symlinked into the IDF build tree
 * (so it resolves against this component's ESP-IDF DEV_Config) and compiled
 * into one firmware image. The active panel is picked at runtime from the
 * configured panel name — `set panel <key>` on the serial console, the setup
 * portal dropdown, or NVS — with "none" meaning headless.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "lcd_loading.h"
#include "lcd_splash.h"
#include "lcd_qspi_amoled.h"
#include "lcd_st7701s_rgb.h"

typedef enum {
    FOS_PIXEL_1BPP = 1, /* packed 1 bit/pixel, MSB first, white=1 */
    FOS_PIXEL_DUAL_1BPP_RED = 2, /* black plane then red plane, 0=ink */
    FOS_PIXEL_DUAL_1BPP_YELLOW = 3, /* black plane then yellow plane, 0=ink */
    FOS_PIXEL_2BPP_GRAY = 4, /* 4 gray levels, MSB first, 0=black, 3=white */
    FOS_PIXEL_2BPP_BWYR = 5, /* black/white/yellow/red palette indices */
    FOS_PIXEL_4BPP_7COLOR = 6, /* Waveshare 7-color palette indices */
    FOS_PIXEL_4BPP_SPECTRA6 = 7, /* Spectra 6 indices: 0,1,2,3,5,6 */
    FOS_PIXEL_4BPP_GRAY = 8, /* 16 gray levels, MSB first */
    FOS_PIXEL_RGB565 = 9, /* 16-bit colour, 5/6/5, one little-endian word per pixel (an LCD) */
} fos_pixel_format_t;

typedef struct {
    const char *panel;  /* e.g. "EPD_7in5_V2", "none" */
    const char *hardware_preset; /* e.g. "waveshare_esp32_s3_photopainter" */
    int8_t rst, dc, cs, cs2, busy, sck, mosi, pwr;
} fos_display_config_t;

/* Select panel + pins. Does not touch hardware yet. A panel whose controller
 * answers (EPD_10in3, the IT8951) reads `dc` as its MISO pin. */
esp_err_t fos_display_init(const fos_display_config_t *config);
/* Where a panel reads the temperature when its controller picks a waveform
 * by it and has no sensor of its own (the reTerminal E1003's IT8951, from
 * the board's SHT40): true with whole degrees Celsius, false when unknown. */
void fos_display_set_temperature_hook(bool (*read_celsius)(int *celsius));
/* How a board chip the display drives reaches an I2C bus the firmware
 * already runs (fos_i2c_lend_bus: the PhotoPainter's AXP2101 shares
 * SDA47/SCL48 with its clock and codec). The handle is an
 * `i2c_master_bus_handle_t`, NULL when no bus runs on those pins. Set
 * before fos_display_init. */
void fos_display_set_i2c_lender(void *(*lend_bus)(int sda, int scl));
bool fos_display_present(void);  /* false for panel "none" */
/* The panel actually driving the display ("none" when headless). With the
 * whole panel table compiled in, fos_display_panel_name(0) is just the first
 * table entry — never use it to mean "the selected panel". */
const char *fos_display_selected_panel(void);
int fos_display_width(void);
int fos_display_height(void);
fos_pixel_format_t fos_display_format(void);
/* How the selected panel is wired: one of the FOS_PANEL_BUS_* kinds in the
 * generated frameos_panel_table.h (FOS_PANEL_BUS_SPI, 0, when headless). An
 * RGB LCD owns sixteen data lines and the sync pins: nothing else may blink
 * them. */
int fos_display_bus(void);
/* True when the display refreshes on its own (an LCD scanned from a frame
 * buffer): a blit shows at once and costs no e-paper wait. */
bool fos_display_is_lcd(void);
/* Only the circle inside the panel's square shows and takes touches (the
 * Waveshare 1.75" AMOLED): the runtime keeps what it draws by itself inside
 * it (frameos/panel_shape.nim `boardPanelRound`). */
bool fos_display_round(void);
/* The panel's power, for turnOn / turnOff / toggleScreen: an LCD's
 * backlight, an AMOLED's display on/off. ESP_ERR_NOT_SUPPORTED where there is nothing to switch (e-paper
 * holds its image unpowered). */
esp_err_t fos_display_power(bool on);
/* The panel's step before a deep sleep, after the last refresh: on the
 * PhotoPainter, release the panel's lines and switch its supply (the
 * AXP2101's ALDO4) off; an AMOLED's controller off and asleep. ESP_ERR_NOT_SUPPORTED on boards whose panel supply
 * the firmware does not own. */
esp_err_t fos_display_prepare_deep_sleep(void);
/* What the boot is waiting for, on an LCD's boot splash (lcd_splash.h): a
 * line under the FrameOS mark once the wait has lasted a second. Nothing on
 * any other panel, and nothing once a picture is up. */
void fos_display_boot_status(fos_lcd_splash_status_t status);
/* An LCD's own buffer for the next picture, `*len` bytes in the panel's
 * format (fos_display_buffer_size): the renderer draws there in place and
 * fos_display_blit(that buffer) shows it without a copy. The panel stays
 * this task's until then, or until fos_display_release_render_target() hands
 * it back unshown. NULL (and `*len` 0) for every panel that is not an LCD,
 * which renders into a canvas of its own and packs. */
uint8_t *fos_display_render_target(size_t *len, uint32_t *generation);
void fos_display_release_render_target(void);
/* `*generation` above counts the writes into the buffer other than a render
 * drawn in place; report an overlay drawn over such a render here, so the
 * next render into the buffer knows it holds more than the scene drew. */
void fos_display_mark_written(const uint8_t *buf);
/* The same count for any of an LCD's buffers (a render about to draw a
 * buffer whole copies in the newest one that still holds its frame,
 * frameos/utils/svg_frames.nim); -1 for any other pointer or panel. */
int64_t fos_display_buffer_generation(const uint8_t *buf);
/* Called with a panel buffer just before it is written to: a snapshot that
 * points at the last picture shown lets go of it (fos_client.c). */
void fos_display_set_before_write_hook(void (*hook)(const uint8_t *buf));
/* The loading mark (lcd_loading.h, docs/realtime-rendering.md "A switch that
 * takes a while"): on an LCD, three pulsing dots over the picture shown
 * while a scene switch loads, once it has taken FOS_LCD_LOADING_DELAY_MS,
 * drawn by the runtime (frameos/loading_mark.nim). `begin` on the render
 * task as a switch starts, with when it was asked for (a FreeRTOS tick) and
 * the frame's rotation; the next picture shown ends it, and `end` does for a
 * switch that shows none. The one panel that shows it
 * is the RGB LCD, whose driver does nothing before its init, so these go
 * straight there: every other panel leaves them alone. */
static inline void fos_display_updating_begin(void)
{
    /* A QSPI AMOLED keeps its picture through flash writes: no screen. */
    fos_lcd_st7701s_updating_begin();
}
static inline void fos_display_updating_end(bool picture_follows)
{
    fos_lcd_st7701s_updating_end(picture_follows);
}
static inline void fos_display_loading_begin(uint32_t since_tick, int rotation)
{
    /* Each driver does nothing before its init: one of the two is up. */
    fos_lcd_st7701s_loading_begin(since_tick, rotation);
    fos_lcd_qspi_loading_begin(since_tick, rotation);
}
static inline void fos_display_loading_end(void)
{
    fos_lcd_st7701s_loading_end();
    fos_lcd_qspi_loading_end();
}
/* A press lit at once (lcd_press.h, docs/realtime-rendering.md "A press
 * shows at once"): on an RGB LCD the touch task shades the element a finger
 * lands on in the buffer on the glass, before the press is even reported;
 * the next picture presented puts it away, and so does `release` (the lift)
 * after `linger_ms` with no picture, and `end` now. Nothing on any other
 * panel. */
static inline void fos_display_press_begin(int x0, int y0, int x1, int y1)
{
    fos_lcd_st7701s_press_begin(x0, y0, x1, y1);
}
static inline void fos_display_press_release(int linger_ms)
{
    fos_lcd_st7701s_press_release(linger_ms);
}
static inline void fos_display_press_end(void)
{
    fos_lcd_st7701s_press_end();
}
/* The runtime's loading mark (frameos/loading_mark.nim), for whichever LCD
 * driver runs. */
void fos_display_set_loading_mark(fos_loading_mark_fn mark);
/* The selected panel's own I2C bus when it runs one on exactly these pins
 * (the SenseCAP Indicator's LCD shares SDA39/SCL40 with its touch
 * controller): the handle (an `i2c_master_bus_handle_t`) for another device
 * to join, or ESP_ERR_NOT_FOUND. */
esp_err_t fos_display_shared_i2c_bus(int sda, int scl, void **bus);
size_t fos_display_buffer_size(void);
size_t fos_display_panel_count(void); /* all panels compiled into this firmware */
/* True for "none" (headless) and for every panel compiled into this
 * firmware: the check the console and the setup page apply before storing a
 * panel key. */
bool fos_display_panel_known(const char *name);
const char *fos_display_panel_name(size_t index);
int fos_display_panel_width(size_t index);
int fos_display_panel_height(size_t index);
fos_pixel_format_t fos_display_panel_format(size_t index);
/* Bits per pixel of the scene canvas the Nim renderer composites into
 * (frameos/src/embedded/embedded_runtime.nim, `renderCanvas`), decided by
 * the panel first and the module's PSRAM after:
 *
 * - 4 (pixie's sixteen-grey surface, the panel buffer's own layout) for a
 *   4-bit grey panel, always. Every store is dithered through the ordered
 *   matrix the pack used, so a gradient stays smooth and the pack is a copy.
 *   The 1872x1404 reTerminal E1003 is why: 1.3 MB, where luma was 2.5 and
 *   565 was 5.0, and a scene like Word clock wants that room.
 * - 8 (its 8-bit luma surface) for a four-grey or black-and-white panel,
 *   always: their error diffusion wants the 256 levels. Grey costs it
 *   nothing — blending is per channel, so the luma of a composite is the
 *   composite of the lumas — and every pass over the canvas (a fill, a
 *   blend, the dither) moves a quarter of the bytes RGBX would.
 * - 16 (its RGB 5/6/5 surface) for an RGB565 LCD, always: the canvas
 *   is then the panel's own frame buffer (fos_display_render_target), drawn
 *   in place, with nothing to pack or copy.
 * - 16 for a colour e-paper panel too, whatever the PSRAM. Up to 2026.11.13
 *   a colour panel got RGBX wherever a full canvas took at most half the
 *   module's PSRAM (the 800x480 boards: 1.5 MB of 8 MB) and 565 only where it
 *   did not (1200x1600 Spectra 6 on 8 MB, the reTerminal E1004, 3.7 MB). The
 *   5/6-bit rounding of every stored pixel would turn a smooth gradient into
 *   plateaus the diffusion prints as bands, which is why 565 canvases store
 *   with a per-pixel dither (pixie `ditherStores`); the E1004's pictures
 *   showed that dither is enough, so every colour panel draws in 565 (the
 *   owner, 2026-11-21): half the canvas (0.77 MB on an 800x480 board), the
 *   picture packed in the canvas's own bytes where it is unturned and the
 *   two apart would take more than half the PSRAM (main.c
 *   canvas_holds_panel_picture: the E1004 on 8 MB; elsewhere a panel buffer
 *   of its own, so the next render need not wait out a refresh), and pixie's
 *   565 fast paths.
 *
 * The same rule lives, in bytes (0.5 for 4 bits), in
 * `embedded_render_canvas_bytes_per_pixel`
 * in backend embedded_firmware.py, `esp32_canvas_bytes_per_pixel` in
 * app/utils/device_limits.py, `esp32CanvasBytesPerPixel` in the SPA's
 * utils/deviceLimits.ts and the wasm preview's devices.ts, and
 * `sceneCanvasFormat` in embedded_runtime.nim; keep them in step
 * (docs/device-limits-fixtures.json pins the TS copy and the Python one).
 * Where the 4-bit canvas is the panel buffer itself (main.c
 * canvas_is_panel_picture: unturned sixteen greys) both device-limits ports
 * charge no second buffer (`esp32CanvasIsPanelBuffer`), and so where a colour
 * panel's picture is packed in the first bytes of its 565 canvas (main.c
 * canvas_holds_panel_picture: unturned, no partial waveform, and the canvas
 * plus a panel buffer over half the module's PSRAM). */
/* The grey panel formats: 1-bit black and white, 2- and 4-bit grey. */
bool fos_pixel_format_is_grey(fos_pixel_format_t format);
size_t fos_render_canvas_bits_per_pixel(int width, int height, size_t psram_total_bytes,
                                        fos_pixel_format_t format);
/* The above for the selected panel and this module's PSRAM. */
size_t fos_display_canvas_bits_per_pixel(void);
/* Bytes of the scene canvas for the selected panel (0 when headless). */
size_t fos_display_canvas_bytes(void);
/* PSRAM the on-device renderer needs for this panel: the scene canvas
 * pixie composites into, the selected packed panel output, plus headroom for
 * the Nim heap and QuickJS interpreter. 0 when headless. Used to refuse panels
 * that won't fit the module's PSRAM (they'd OOM mid-render). */
size_t fos_display_render_psram_bytes(void);
/* An SD card on the panel's SPI bus (same SCK/MOSI; the Seeed reTerminal
 * E-series): bring the bus up with the card's MISO and hand back the host the
 * card's sdspi device joins. The panel then holds the bus for each refresh.
 * ESP_ERR_INVALID_STATE when the panel is an I2C one or the bus is already up
 * without that MISO (a restart fixes the second). */
esp_err_t fos_display_spi_bus_share(int miso_pin, int *host);
/* Full update: init panel, push buffer, refresh, put panel to deep sleep. On
 * an SPI panel with no partial waveform the buffer is copied and a task of the
 * display's own runs all that, so the caller does not wait out the refresh
 * (tens of seconds on a color panel); a picture asked for meanwhile waits as
 * the next. Anything else blocks for the refresh. */
esp_err_t fos_display_blit(const uint8_t *buf, size_t len);
/* A picture handed to the display's own task is still on its way. */
bool fos_display_refreshing(void);
/* A colour panel's picture packed in the scene canvas (main.c
 * canvas_holds_panel_picture): the display's task refreshes from `buf` as it
 * is, without the copy (up to two pictures, 1.92 MB on a 1200x1600 panel).
 * Nothing may write `buf` while fos_display_holds(buf): the render waits for
 * the glass first (fos_display_wait_for), another borrower of the panel
 * buffer gets memory of its own (fos_framebuffer.c). Once, at boot. */
void fos_display_lend(const uint8_t *buf);
bool fos_display_holds(const uint8_t *buf);
/* Until the display's task is done with `buf`; at once when it does not
 * hold it. */
void fos_display_wait_for(const uint8_t *buf);
/* The panel has a partial waveform (fos_partial_refresh.h). */
bool fos_display_supports_partial(void);
/* Its controller keeps the picture and finds what changed itself (the
 * IT8951's tile digests): an unchanged picture costs no refresh without the
 * firmware's hash of it (fos_client.c display state). */
bool fos_display_keeps_picture(void);
/* fos_display_blit, or a partial update of the pixels that changed where
 * fos_partial_refresh_wanted says so. `same_scene`: the picture on the glass
 * came from the scene this one does. `input_recent`: someone is tapping, so a
 * full refresh that only clears ghosts waits. `partial` (may be NULL): which
 * it was. */
esp_err_t fos_display_update(const uint8_t *buf, size_t len, bool same_scene, bool input_recent,
                             bool *partial);
/* Where the render that drew the scene's canvas wrote it, in its own pixels
 * (frameos_nim_render_damage), for the next fos_display_update of that canvas:
 * on a controller that keeps the picture (the IT8951) only those tiles are
 * hashed before the upload, the rest after the waveform has started (it8951.c
 * verify_after_hint). Boxes of renders whose picture did not go up add up.
 * `w` < 0: it could have written anywhere (the whole picture is hashed); w or
 * h 0: nowhere. Only the render task calls it, right before its update; any
 * other way onto the glass (a blit, a quick update) or a picture changed after
 * its update (fos_display_hint_forget: an overlay drawn and taken off the
 * canvas) makes the next update hash it all. */
void fos_display_hint_damage(int x, int y, int w, int h);
void fos_display_hint_forget(void);
/* Tiles changed outside a render's box are still to go up, and no picture is
 * coming: the render task hands the canvas to fos_display_update again. */
bool fos_display_followup_due(void);
/* A controller that keeps the picture (the IT8951) brought up on a task of its
 * own at boot, while Wi-Fi joins and the scene loads, instead of after the
 * first render (~1.9 s on a reTerminal E1003): every way onto the glass waits
 * for it first. Nothing on a panel that keeps no picture. */
void fos_display_warm_up(void);
/* A controller that keeps the picture is not put in standby when the panel
 * idles (FOS_PANEL_AWAKE_US, the ghost clean) while this is set: on a
 * reTerminal E1003 the first waveform after a standby ran 898 ms where one
 * runs 580 (its SYS_RUN answered in 22 ms: the cost is the panel supply's).
 * The render task sets it while the board is on USB power; a deep sleep
 * parks it all the same (fos_display_park). */
void fos_display_keep_controller_awake(bool keep);
/* A notice just before a restart (fos_restart.h) or as a board boots: an LCD
 * draws it at once, an e-paper with a partial waveform takes it in the fast
 * one and is put to sleep after it (no restart under a waveform), anything
 * else not at all (ESP_ERR_NOT_SUPPORTED): a full refresh is seconds the
 * restart would wait out. Never waits for a refresh already running.
 * `previous`: what the glass shows, NULL for the copy the driver keeps (none
 * before the first full refresh). Where it is not known (a boot), a buffer
 * equal to `buf` but for the pixels to draw drives those pixels alone: the
 * rest of the old picture stays. Not on a controller that keeps the picture. */
esp_err_t fos_display_quick_update(const uint8_t *buf, const uint8_t *previous, size_t len);
/* Put a panel left awake after a partial update into deep sleep: before the
 * chip's own, or (the _if_idle one, from the render task's wait) once nothing
 * has been drawn for a while, clearing any ghosts it was left with first. */
/* Something on the glass at once, in black and white, without any picture
 * changing (docs/realtime-rendering.md "A press shows at once"): the panel
 * rectangle x, y, w, h of `buf` (a whole packed picture: the one showing,
 * with the ink or the tile drawn into it for the call) goes up with one fast
 * waveform, grown to the controller's tiles, and the next update puts the
 * picture's own pixels back there (or the follow-up once the render task is
 * idle, fos_display_followup_due).
 * Only a panel whose controller keeps the picture (the IT8951): false
 * elsewhere, and when it holds no picture it knows. Render task. */
bool fos_display_glass_supported(void);
esp_err_t fos_display_glass_rect(const uint8_t *buf, int x, int y, int w, int h);
/* The panel's running waveform, waited out: before a caller draws into the
 * picture it hands fos_display_glass_rect, so it holds it changed no longer
 * than the upload. */
void fos_display_glass_wait(void);
/* Parts of the picture were drawn roughly while someone tapped and nobody has
 * for a while: pack the canvas and hand it to fos_display_update, not as input. */
bool fos_display_settle_due(int64_t now_us);
void fos_display_park(void);
void fos_display_park_if_idle(int64_t now_us);
/* A block of PSRAM kept for good, NULL when there is none to give. */
void *fos_display_alloc_psram(size_t len);
/* Clear to white and sleep the panel. */
esp_err_t fos_display_clear(void);
