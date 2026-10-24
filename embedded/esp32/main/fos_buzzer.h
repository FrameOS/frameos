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
 * hold both sound right and nothing drones. Each event a scene can hear
 * (docs/events-contract.json `buttons`) sounds the instant it happens, played
 * by the button task when its timing (fos_button_timing.c, the dispatcher's
 * rules on the same stamps) says so:
 *
 *   down         [tone 14]
 *   up           [0.7 tone 14], every up: a tap's, a double press's, a long press's
 *   doublePress  its second down is [1.5 tone 14] instead of the down click
 *   held         [tone 8, 0.5 tone 20] at every whole longPressMs the key is
 *                down (1 s, 2 s, ...); the scene's `longPress` comes once, with the up
 *   press        nothing of its own: its clicks were the down and the up
 *   refused      down [100 Hz 14], up [70 Hz 14]
 *
 * (notes as [pitch ms], `tone` the configured `buzzer_tone_hz`; the segment
 * lists are what the Buzzer Lab auditions.) A press that wakes the chip
 * clicks down as soon as the chip boots and is a press like any other from
 * then on: its duns, its up, a second tap's higher click.
 *
 * The pin is the live config's `buzzer_pin` (-1 = none) and the pitch its
 * `buzzer_tone_hz`, both read again on every tone: a settings push moves,
 * retunes or silences the buzzer without a reboot.
 *
 * The board's status LED (fos_led.h) follows every note: lit while one
 * sounds, dark for a rest and after the last. A frame with an LED and no
 * buzzer (none, or `buzzer_pin -1`) shows the same clicks, ticks and voice
 * cues in light, which is what a microphone next to a buzzer wants.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Once, early in boot, before anything chirps. */
void fos_buzzer_init(void);
/* A button press registered: a 14 ms click at the press pitch. Returns at
 * once. No-op without a buzzer. */
void fos_buzzer_click_down(void);
/* Its release: the same click at 0.7 of the press pitch. */
void fos_buzzer_click_up(void);
/* The second down of a double press, in place of the down click: the same
 * click at 1.5 of the press pitch, so a double tap is heard as one. */
void fos_buzzer_double_down(void);
/* A key held: at every whole longPressMs it stays down, a short note falling
 * to a longer low one. */
void fos_buzzer_long_press(void);
/* A press the frame could not take (its queue is full): the same two
 * clicks, from a 100 Hz base instead of the press pitch — a dull "no" next
 * to the press's bright "yes". */
void fos_buzzer_reject_down(void);
void fos_buzzer_reject_up(void);
/* Any tone (the console's `beep`). Safe from any task; a tone while one
 * sounds replaces it. */
void fos_buzzer_tone(uint32_t freq_hz, uint32_t duration_ms);

/* The voice chat's four outcomes (docs/voice-chat.md), pitched from the
 * press pitch like the clicks. Listening: four rising notes and a held top,
 * ~305 ms (the recording drops that long, so the microphone does not hear
 * it). Sent: two quick rising notes on the release, then a tick or a low bop
 * every two seconds until the answer. Ok: three rising notes when the answer came. Error: two
 * low notes. */
void fos_buzzer_voice_listening(void);
void fos_buzzer_voice_sent(void);
/* One tick of the wait after the release, every two seconds (fos_voice.c): a tiny
 * high tick while the recording still uploads, a low monotone bop while the
 * plane transcribes and answers. */
void fos_buzzer_voice_tick(bool thinking);
/* The chat did something to the frame (switched a scene, set a field). */
void fos_buzzer_voice_ok(void);
/* The chat only answered: two notes, the up-click's pitches. */
void fos_buzzer_voice_said(void);
/* Nothing was heard: one low note. */
void fos_buzzer_voice_nothing(void);
void fos_buzzer_voice_error(void);

/* One note of a sequence: `freq_hz` 0 is a rest. */
typedef struct {
    uint32_t freq_hz;
    uint32_t duration_ms;
} fos_buzzer_note_t;
#define FOS_BUZZER_NOTES_MAX 8
/* Notes back to back (at most FOS_BUZZER_NOTES_MAX), stepped by the stop
 * timer; returns at once. Like a tone, a sequence replaces whatever sounds. */
void fos_buzzer_play(const fos_buzzer_note_t *notes, size_t count);
