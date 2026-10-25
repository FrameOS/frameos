/*
 * The board's status LED: one GPIO lit high or low (the Seeed reTerminal
 * E-series' green LED, GPIO6 on the E1001/E1002 and GPIO48 on the E1004, lit
 * low), or one WS2812-class addressable pixel fed from the pin.
 *
 * It follows the buzzer (fos_buzzer.c): lit for every note that sounds,
 * dark for a rest and after the last one. So a press shows its two clicks,
 * a hold its ticks, the voice chat its sparkle, its wait and its answer —
 * with the buzzer, or instead of it on a board that has none or whose owner
 * silenced it (`buzzer_pin -1`). A microphone and an LED are a complete set
 * of cues for talking to a frame: the LED never ends up in the recording.
 * While the microphone is open (fos_voice.c) the LED is HELD lit — the
 * notes' rests do not darken it — so a glance says "it is listening".
 *
 * The pin and the type are the live config's `led_pin` / `led_type`, read
 * on every change of state, so a settings push moves or removes the LED
 * without a reboot. A pin another peripheral owns is refused (once, in the
 * log) and left alone.
 */
#pragma once

#include <stdbool.h>

/* Once, early in boot. Nothing lights until the first fos_led_set(true). */
void fos_led_init(void);
/* Light or darken the LED for a note. Safe from any task; a no-op without
 * one. While a hold is on (below) the LED stays lit whatever this says. */
void fos_led_set(bool on);
/* Hold the LED lit (the voice chat's recording) or let it go back to the
 * notes. Idempotent; safe from any task. */
void fos_led_hold(bool held);
/* True when the live config names an LED on a pin this firmware may drive. */
bool fos_led_present(void);
