/*
 * Board buzzer: a passive piezo on one GPIO (GPIO45 on the Seeed reTerminal
 * E-series), driven by an LEDC PWM channel. It only sounds while the pin
 * toggles at an audible rate, so a chirp is "start the PWM, stop it a few
 * milliseconds later".
 *
 * Its job is feedback for the GPIO buttons. A press on an e-paper frame
 * changes nothing visible for seconds (the E1004's 13.3" panel takes ~30 s
 * to refresh, and a frame in deep sleep has to boot first), so the button
 * task clicks the moment it has registered a press and clicks again, lower,
 * on the release: a mechanical key's two clicks, so a tap and a one-second
 * hold both sound right and nothing drones. While the key stays down a
 * shorter tick sounds at every whole second, counting the hold, the same
 * seconds the dispatcher reports as `heldSeconds`. A press that wakes the
 * chip is the same press: its down click sounds as soon as the chip boots,
 * the ticks and the release click follow the finger.
 *
 * The pin is the live config's `buzzer_pin` (-1 = none) and the pitch its
 * `buzzer_tone_hz`, both read again on every tone: a settings push moves,
 * retunes or silences the buzzer without a reboot.
 */
#pragma once

#include <stdint.h>

/* Once, early in boot, before anything chirps. */
void fos_buzzer_init(void);
/* A button press registered: a 14 ms click at the press pitch. Returns at
 * once. No-op without a buzzer. */
void fos_buzzer_click_down(void);
/* Its release: the same click at 0.7 of the press pitch. */
void fos_buzzer_click_up(void);
/* A whole second of the key held down: a shorter click at the press pitch. */
void fos_buzzer_tick(void);
/* A press the frame could not take (its queue is full): the same two
 * clicks, from a 100 Hz base instead of the press pitch — a dull "no" next
 * to the press's bright "yes". */
void fos_buzzer_reject_down(void);
void fos_buzzer_reject_up(void);
/* Any tone (the console's `beep`). Safe from any task; a tone while one
 * sounds replaces it. */
void fos_buzzer_tone(uint32_t freq_hz, uint32_t duration_ms);
