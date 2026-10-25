#ifndef FOS_BOARD_H
#define FOS_BOARD_H

#include <stdbool.h>

/* What chip and board this firmware is actually running on.
 *
 * The status JSON used to hardcode `"target":"esp32-s3"` and
 * `"module":"Seeed XIAO ESP32-S3 class"`, which was true of the first board
 * FrameOS supported and of nothing since. A C3 thin client reporting itself
 * as an S3 sends anyone reading its log down the wrong path: "S3 with 120 KB
 * free" looks like a broken S3, "C3 with 120 KB free" is a C3 doing exactly
 * what a C3 does. Report the truth instead. */

/* Maps an ESP-IDF CONFIG_IDF_TARGET value ("esp32c3") to the platform
 * spelling FrameOS uses everywhere else ("esp32-c3"). Unknown targets come
 * back verbatim rather than guessed at. Pure string work, no IDF. */
const char *fos_board_target_name(const char *idf_target);

/* The chip this image was built for, in FrameOS platform spelling. */
const char *fos_board_target(void);

/* Human-facing board label: the hardware preset the backend baked into the
 * image (or an NVS override) when there is one, else a chip-derived
 * fallback. Never NULL. */
const char *fos_board_module(const char *hardware_preset);

/* The GPIO of the board's buzzer for a hardware preset key, -1 when the
 * preset names a board without one (or no preset at all). The console's
 * `set hardware` applies it, and it is the stored-config default when NVS
 * has no `buzzer` key: a board provisioned before the key existed gets its
 * buzzer with the update. Keep in step with `buzzerPin` in
 * EMBEDDED_HARDWARE_PRESETS (backend/app/tasks/embedded_firmware.py). */
int fos_board_buzzer_pin(const char *hardware_preset);
/* The pitch that board's buzzer sounds best at, in Hz; 0 when the preset has
 * no buzzer (the caller keeps its default). Same table, same two users. */
int fos_board_buzzer_tone_hz(const char *hardware_preset);

/* The frame's event map a hardware preset ships with (docs/events.md, "Event
 * map"): what the board's buttons do whatever scene shows, as the compact
 * JSON rule list frame.json `eventMap` holds — a reTerminal's LEFT and RIGHT
 * held are the previous and the next scene, and on the E1001/E1002 REFRESH
 * held is the voice chat. "" for a board without one (or
 * no preset at all). The console's `set hardware` applies it, and it is the
 * stored-config default when NVS has no `event_map` key. Keep in step with
 * `eventMap` in EMBEDDED_HARDWARE_PRESETS (backend/app/tasks/embedded_firmware.py)
 * and the SPA's preset table. */
const char *fos_board_event_map(const char *hardware_preset);

/* The board's PDM microphone for a hardware preset key: clock, data and the
 * power-enable GPIO (-1 each when the preset names a board without one, or no
 * preset at all). The Seeed reTerminal E1001/E1002 carry an MSM261 on
 * 42/41/38; the E1004 has none (docs/voice-chat.md). Same role as
 * fos_board_buzzer_pin: the console's `set hardware` applies it and it is the
 * stored-config default when NVS has no `mic_pins`. Returns true when the
 * board has one. */
bool fos_board_mic_pins(const char *hardware_preset, int *clk, int *data, int *pwr);

/* The board's status LED for a hardware preset key: its GPIO and how it is
 * lit (fos_led_type_t: 0 high, 1 low, 2 a WS2812 pixel), -1 / 0 for a board
 * without one. The reTerminal E1001/E1002 have a green LED on GPIO6, the
 * E1004 on GPIO48; the first two lit low, the E1004's lit high (Seeed's
 * schematics, and the E1004 on the bench).
 * Same role as fos_board_buzzer_pin: `set hardware` applies it and it is the
 * stored-config default when NVS has no `led` key. Keep in step with
 * `ledPin` / `ledType` in EMBEDDED_HARDWARE_PRESETS. */
bool fos_board_led(const char *hardware_preset, int *pin, int *type);

/* The board's I2C peripheral buses as the `i2c_buses` spec
 * (`sda=19,scl=20;sda=39,scl=40`), "" for a board without any. The reTerminal
 * E1001/E1002 carry their PCF8563 clock and SHT40 sensor on 19/20 and their
 * SY6974B charger on 39/40; the E1004 has all three on 19/20 (its 39/40 is
 * the J2 header). fos_i2c.c probes what is there. */
const char *fos_board_i2c_buses(const char *hardware_preset);

/* The board's TF socket as the `assets_sd_pins` spec, "" for a board with no
 * usable one. The reTerminal E-series share the panel's SPI bus (SCK7/MOSI9)
 * with MISO on GPIO8, CS on GPIO14, a card-detect contact on GPIO15 and a
 * TPS22916 power switch on GPIO16 — one table for the console's `set
 * hardware` and the stored-config default. Keep in step with
 * EMBEDDED_SD_CARD_ASSETS_PRESET_PINS. */
const char *fos_board_sd_pins(const char *hardware_preset);

#endif /* FOS_BOARD_H */
