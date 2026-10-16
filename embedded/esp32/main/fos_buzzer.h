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
 * hold both sound right and nothing drones. Each kind of press the scene can
 * hear (docs/events-contract.json `buttons`) has its own sound, played by
 * the button task the moment its timing (fos_button_timing.c, the
 * dispatcher's rules on the same stamps) says it happened:
 *
 *   press        down: [tone 14]                 up: [0.7 tone 14]
 *   doublePress  down: [1.5 tone 10, rest 6, 2 tone 10]   (in place of the
 *                press's down click; its up click is the press's)
 *   longPress    at longPressMs held: [tone 8, 0.5 tone 20]
 *   repeat       every whole repeatMs held: [tone 7]
 *   refused      down: [100 Hz 14]               up: [70 Hz 14]
 *
 * (notes as [pitch ms], `tone` the configured `buzzer_tone_hz`; the segment
 * lists are what the Buzzer Lab auditions.) A press that wakes the chip is
 * the same press: its down click sounds as soon as the chip boots, the ticks
 * and the release click follow the finger.
 *
 * The pin is the live config's `buzzer_pin` (-1 = none) and the pitch its
 * `buzzer_tone_hz`, both read again on every tone: a settings push moves,
 * retunes or silences the buzzer without a reboot.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

/* Once, early in boot, before anything chirps. */
void fos_buzzer_init(void);
/* A button press registered: a 14 ms click at the press pitch. Returns at
 * once. No-op without a buzzer. */
void fos_buzzer_click_down(void);
/* Its release: the same click at 0.7 of the press pitch. */
void fos_buzzer_click_up(void);
/* The second press of a double press, in place of its down click: two
 * quick rising notes. */
void fos_buzzer_double_down(void);
/* The hold reached the long press: a short note falling to a longer low one. */
void fos_buzzer_long_press(void);
/* A `repeat` (every whole second of the key held down): a shorter click at
 * the press pitch. */
void fos_buzzer_tick(void);
/* A press the frame could not take (its queue is full): the same two
 * clicks, from a 100 Hz base instead of the press pitch — a dull "no" next
 * to the press's bright "yes". */
void fos_buzzer_reject_down(void);
void fos_buzzer_reject_up(void);
/* Any tone (the console's `beep`). Safe from any task; a tone while one
 * sounds replaces it. */
void fos_buzzer_tone(uint32_t freq_hz, uint32_t duration_ms);

/* One note of a sequence: `freq_hz` 0 is a rest. */
typedef struct {
    uint32_t freq_hz;
    uint32_t duration_ms;
} fos_buzzer_note_t;
#define FOS_BUZZER_NOTES_MAX 4
/* Notes back to back (at most FOS_BUZZER_NOTES_MAX), stepped by the stop
 * timer; returns at once. Like a tone, a sequence replaces whatever sounds. */
void fos_buzzer_play(const fos_buzzer_note_t *notes, size_t count);
