#ifndef FOS_BOARD_H
#define FOS_BOARD_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

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
 * held are the previous and the next scene, and on the E1001/E1002/E1003
 * REFRESH held is the voice chat. "" for a board without one (or
 * no preset at all). The console's `set hardware` applies it, and it is the
 * stored-config default when NVS has no `event_map` key. Keep in step with
 * `eventMap` in EMBEDDED_HARDWARE_PRESETS (backend/app/tasks/embedded_firmware.py)
 * and the SPA's preset table. */
void fos_board_event_map(const char *hardware_preset, char *out, size_t out_len);

/* The board's PDM microphone for a hardware preset key: clock, data and the
 * power-enable GPIO (-1 each when the preset names a board without one, or no
 * preset at all). The Seeed reTerminal E1001/E1002/E1003 carry an MSM261 on
 * 42/41/38; the E1004 has none (docs/voice-chat.md). Same role as
 * fos_board_buzzer_pin: the console's `set hardware` applies it and it is the
 * stored-config default when NVS has no `mic_pins`. Returns true when the
 * board has one. */
bool fos_board_mic_pins(const char *hardware_preset, int *clk, int *data, int *pwr);

/* The GPIO that lets the board's charger charge while it is driven low, -1
 * for a board whose charger needs no pin (the E-series' SY6974B charges by
 * its own defaults) or has none. The reTerminal Sticky's BQ25616: GPIO39.
 * Nothing provisions it and no setting overrides it: fos_charger_enable
 * drives it at boot. */
int fos_board_charge_enable_pin(const char *hardware_preset);

/* The GPIOs of a board's power latch, for a board that stays on battery only
 * while a flip-flop holds its supply: `hold` is the latch's D, `lock` its
 * clock, and a rising `lock` with `hold` high latches the board on
 * (fos_charger_latch_power). The reTerminal Sticky's PWR_HOLD GPIO45 and
 * PWR_LOCK GPIO46; -1 / -1 and false on every other board. */
bool fos_board_power_latch_pins(const char *hardware_preset, int *hold, int *lock);

/* The board's status LED for a hardware preset key: its GPIO and how it is
 * lit (fos_led_type_t: 0 high, 1 low, 2 a WS2812 pixel), -1 / 0 for a board
 * without one. The reTerminal E1001/E1002 have a green LED on GPIO6, the
 * E1003 on GPIO16, the E1004 on GPIO48; the first three lit low, the
 * E1004's lit high (Seeed's schematics, and the E1004 on the bench).
 * Same role as fos_board_buzzer_pin: `set hardware` applies it and it is the
 * stored-config default when NVS has no `led` key. Keep in step with
 * `ledPin` / `ledType` in EMBEDDED_HARDWARE_PRESETS. */
bool fos_board_led(const char *hardware_preset, int *pin, int *type);

/* Keys on the board's I2C IO expander rather than a GPIO (fos_buttons.c
 * adds them to the configured keys): the expander pin, high while pressed,
 * and the label the event map matches. The Waveshare
 * ESP32-S3-Touch-AMOLED-1.75's PWR key is its TCA9554's P4 (SYS_OUT, the
 * AXP2101's power key conditioned; Waveshare's hardware reference). Fills
 * at most `max`, returns how many. */
typedef struct {
    int pin;
    const char *label;
} fos_board_key_t;
size_t fos_board_expander_keys(const char *hardware_preset, fos_board_key_t *out, size_t max);
/* GPIOs the board drives at boot, before anything it powers is probed: its
 * peripherals' supplies (fos_charger_latch_power drives them). NULL for a
 * board without; else a list ended by pin -1. The Elecrow CrowPanel 2.01"
 * watch's GPIO47 high and GPIO40 low. */
typedef struct {
    int pin;
    int level;
} fos_board_rail_t;
const fos_board_rail_t *fos_board_rails(const char *hardware_preset);
/* One-byte commands sent to I2C devices when the board's first bus comes up
 * (fos_i2c.c), as address / byte pairs: how many, NULL / 0 for a board
 * without. The Elecrow CrowPanel Advance 7.0"'s STC8 coprocessor at 0x30:
 * 0x19 (the touch panel out of reset), 0x10 (the backlight on). */
size_t fos_board_i2c_writes(const char *hardware_preset, const uint8_t **pairs);
/* A backlight switched by a one-byte command on the board's first bus: the
 * device's address and the bytes for on and off. The CrowPanel Advance 7.0"'s
 * STC8 at 0x30: 0x10 on, 0x05 off. False (and zeros) for every other board. */
bool fos_board_i2c_backlight(const char *hardware_preset, uint8_t *addr, uint8_t *on, uint8_t *off);
/* A rotary encoder's two phases (fos_buttons.c turns its steps into NEXT
 * and PREV presses): the CrowPanel 2.01" watch's crown, A GPIO20 and B
 * GPIO19. False and -1 / -1 on every other board. */
bool fos_board_encoder_pins(const char *hardware_preset, int *a, int *b);

/* The board's I2C peripheral buses as the `i2c_buses` spec
 * (`sda=19,scl=20;sda=39,scl=40`), "" for a board without any. The reTerminal
 * E1001/E1002 carry their PCF8563 clock and SHT40 sensor on 19/20 and their
 * SY6974B charger on 39/40; the E1003 and E1004 have all three on 19/20
 * (the E1004's 39/40 is the J2 header). fos_i2c.c probes what is there. */
const char *fos_board_i2c_buses(const char *hardware_preset);

/* Which real-time clock answers at I2C 0x51 on the board: "pcf85063" on the
 * Waveshare PhotoPainter, "pcf8563" for every other preset and for no preset
 * at all (the reTerminal E-series and Sticky, a custom `i2c_buses` board).
 * The two share the address but not the register map (fos_rtc.c), and
 * nothing either chip answers tells them apart without writing to it. */
const char *fos_board_rtc_chip(const char *hardware_preset);

/* The board's TF socket as the `assets_sd_pins` spec, "" for a board with no
 * usable one. The reTerminal E-series share the panel's SPI bus (SCK7/MOSI9)
 * with MISO on GPIO8, CS on GPIO14, a card-detect contact on GPIO15 and a
 * TPS22916 power switch on GPIO16 (GPIO39 on the E1003) — one table for the
 * console's `set hardware` and the stored-config default. Keep in step with
 * EMBEDDED_SD_CARD_ASSETS_PRESET_PINS. */
const char *fos_board_sd_pins(const char *hardware_preset);

/* The board's capacitive touch panel as the `touch_pins` spec
 * (`sda=3,scl=2,int=21,rst=41,en=42`), "" for a board without one. The Seeed
 * reTerminal Sticky carries a Goodix GT911 on its own I2C bus, the E1003 one
 * on the clock's (fos_touch.c).
 * Keep in step with `touchPins` in EMBEDDED_HARDWARE_PRESETS. */
const char *fos_board_touch_pins(const char *hardware_preset);

/* Which of the board's touch axes run against its panel's, after any swap
 * (fos_touch_axes_swapped): the glass as mounted, not wiring, so not part
 * of the `touch_pins` spec a frame stores. 0 for most boards. */
#define FOS_BOARD_TOUCH_MIRROR_X 1
#define FOS_BOARD_TOUCH_MIRROR_Y 2
int fos_board_touch_mirror(const char *hardware_preset);

/* The board's I2S audio codec as the `codec_pins` spec
 * (`mclk=14,bclk=15,ws=16,din=18,dout=17,pa=7`), "" for a board without one.
 * The Waveshare PhotoPainter and 13.3E6 carry an ES8311 (the speaker) and an
 * ES7210 (the microphones) on one I2S bus, the chips on an `i2c_buses` bus
 * (fos_codec.c). Keep in step with `codecPins` in EMBEDDED_HARDWARE_PRESETS. */
const char *fos_board_codec_pins(const char *hardware_preset);

#endif /* FOS_BOARD_H */
