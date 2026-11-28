/*
 * A tone as text (docs/tones.md): "hz:ms,hz:ms,...", 0 Hz a rest. What the
 * runtime hands the firmware for frameos.tone() (tones.nim normalizeTones)
 * and what a control plane sends a board it renders for as X-FrameOS-Tone.
 * Read here with the runtime's bounds, whoever wrote it: a pitch held to
 * 100 ... 10000 Hz (the contract's buzzer_tone_hz bounds) or 0, a note to
 * 10 ... 5000 ms, FOS_BUZZER_NOTES_MAX notes and 10 s in all at most, a pair
 * that is no pair left out. Pure: host-tested (tests/test_fos_tone.c).
 */
#pragma once

#include <stddef.h>

#include "fos_buzzer.h"

#define FOS_TONE_HZ_MIN 100
#define FOS_TONE_HZ_MAX 10000
#define FOS_TONE_NOTE_MS_MIN 10
#define FOS_TONE_NOTE_MS_MAX 5000
#define FOS_TONE_TOTAL_MS_MAX 10000
/* A render pull's answer carries the tone of the render it ran
 * (docs/server-rendering.md, docs/tones.md). */
#define FOS_TONE_HEADER "X-FrameOS-Tone"

/* The notes `text` holds, at most `max`, into `out`; how many. 0 for NULL,
 * "", or notes that are all rests. */
size_t fos_tone_parse(const char *text, fos_buzzer_note_t *out, size_t max);
