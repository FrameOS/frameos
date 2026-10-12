/*
 * Board buzzer: a passive piezo on one GPIO (GPIO45 on the Seeed reTerminal
 * E-series), driven by an LEDC PWM channel. It only sounds while the pin
 * toggles at an audible rate, so a chirp is "start the PWM, stop it a few
 * milliseconds later".
 *
 * Its job is feedback for the GPIO buttons. A press on an e-paper frame
 * changes nothing visible for seconds (the E1004's 13.3" panel takes ~30 s
 * to refresh, and a frame in deep sleep has to boot first), so the button
 * task chirps the moment it has registered a press, and a press that wakes
 * the chip chirps as soon as it boots.
 *
 * The pin is the live config's `buzzer_pin` (-1 = none), read again on
 * every chirp: a settings push moves or silences the buzzer without a
 * reboot.
 */
#pragma once

#include <stdint.h>

/* Once, early in boot, before anything chirps. */
void fos_buzzer_init(void);
/* A button press registered. Returns at once; a timer ends the tone. Safe
 * from any task; a chirp while one sounds restarts it. No-op without a
 * buzzer. */
void fos_buzzer_chirp(void);
/* Any tone (the console's `beep`), same rules as the chirp. */
void fos_buzzer_tone(uint32_t freq_hz, uint32_t duration_ms);
