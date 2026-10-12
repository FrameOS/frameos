/*
 * Board buzzer: a passive piezo on one GPIO (GPIO45 on the Seeed reTerminal
 * E-series), driven by an LEDC PWM channel. It only sounds while the pin
 * toggles at an audible rate, so a chirp is "start the PWM, stop it a few
 * milliseconds later".
 *
 * Its job is feedback for the GPIO buttons. A press on an e-paper frame
 * changes nothing visible for seconds (the E1004's 13.3" panel takes ~30 s
 * to refresh, and a frame in deep sleep has to boot first), so the button
 * task sounds it from the moment it has registered a press until the
 * release (a tap clicks, a hold beeps, a second at most), and a press that
 * wakes the chip chirps as soon as it boots.
 *
 * The pin is the live config's `buzzer_pin` (-1 = none) and the pitch its
 * `buzzer_tone_hz`, both read again on every tone: a settings push moves,
 * retunes or silences the buzzer without a reboot.
 */
#pragma once

#include <stdint.h>

/* Once, early in boot, before anything chirps. */
void fos_buzzer_init(void);
/* A button press registered: sound until fos_buzzer_press_end, or for
 * FOS_BUZZER_PRESS_MAX_MS when the release never comes. Returns at once.
 * No-op without a buzzer. */
#define FOS_BUZZER_PRESS_MAX_MS 1000
void fos_buzzer_press_start(void);
void fos_buzzer_press_end(void);
/* A short fixed chirp: the press that woke the chip, released long before
 * the boot got here. */
void fos_buzzer_chirp(void);
/* A press the frame could not take (its queue is full): a lower buzz, a
 * quarter of the press tone, for 250 ms. */
void fos_buzzer_reject(void);
/* Any tone (the console's `beep`). Safe from any task; a tone while one
 * sounds replaces it. */
void fos_buzzer_tone(uint32_t freq_hz, uint32_t duration_ms);
