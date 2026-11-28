/*
 * Host tests for a tone as text (fos_tone.c, docs/tones.md): the notes of
 * frameos.tone() as the runtime writes them, and X-FrameOS-Tone as a plane
 * sends them, read with the runtime's bounds.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_tone.c main/tests/test_fos_tone.c \
 *      -o /tmp/test_fos_tone && /tmp/test_fos_tone
 *
 * (backend/app/tasks/tests/test_esp32_tone.py does exactly that in CI.)
 */
#include <stdio.h>

#include "fos_tone.h"

static int checks = 0;
static int failures = 0;

#define CHECK_INT(actual, expected)                                                       \
    do {                                                                                  \
        checks++;                                                                         \
        long a = (long)(actual), e = (long)(expected);                                    \
        if (a != e) {                                                                     \
            failures++;                                                                   \
            printf("FAIL %s:%d: %s = %ld, expected %ld\n", __FILE__, __LINE__, #actual, a, e); \
        }                                                                                 \
    } while (0)

static fos_buzzer_note_t notes[FOS_BUZZER_NOTES_MAX];

static void test_the_runtime_s_notes_are_read_as_written(void)
{
    /* tones.nim's ChimeNotes, the chime frameos.tone() plays. */
    const char *chime = "2093:120,0:40,2637:120,0:40,3136:240,0:420,2093:120,0:40,2637:120,0:40,3136:240";
    CHECK_INT(fos_tone_parse(chime, notes, FOS_BUZZER_NOTES_MAX), 11);
    CHECK_INT(notes[0].freq_hz, 2093);
    CHECK_INT(notes[0].duration_ms, 120);
    CHECK_INT(notes[1].freq_hz, 0);
    CHECK_INT(notes[1].duration_ms, 40);
    CHECK_INT(notes[10].freq_hz, 3136);
    CHECK_INT(notes[10].duration_ms, 240);
    CHECK_INT(fos_tone_parse("880:200", notes, FOS_BUZZER_NOTES_MAX), 1);
    CHECK_INT(notes[0].freq_hz, 880);
    CHECK_INT(notes[0].duration_ms, 200);
}

static void test_nothing_to_play_is_no_notes(void)
{
    CHECK_INT(fos_tone_parse(NULL, notes, FOS_BUZZER_NOTES_MAX), 0);
    CHECK_INT(fos_tone_parse("", notes, FOS_BUZZER_NOTES_MAX), 0);
    CHECK_INT(fos_tone_parse("0:500,0:200", notes, FOS_BUZZER_NOTES_MAX), 0); /* rests alone */
    CHECK_INT(fos_tone_parse("loud", notes, FOS_BUZZER_NOTES_MAX), 0);
    CHECK_INT(fos_tone_parse(":200", notes, FOS_BUZZER_NOTES_MAX), 0);
    CHECK_INT(fos_tone_parse("440:", notes, FOS_BUZZER_NOTES_MAX), 0);
}

static void test_pitches_and_lengths_are_held_to_the_bounds(void)
{
    CHECK_INT(fos_tone_parse("20:1,99999:9999", notes, FOS_BUZZER_NOTES_MAX), 2);
    CHECK_INT(notes[0].freq_hz, FOS_TONE_HZ_MIN);
    CHECK_INT(notes[0].duration_ms, FOS_TONE_NOTE_MS_MIN);
    CHECK_INT(notes[1].freq_hz, FOS_TONE_HZ_MAX);
    CHECK_INT(notes[1].duration_ms, FOS_TONE_NOTE_MS_MAX);
    /* A fraction rounds; spaces are no harm; a number too long is the most. */
    CHECK_INT(fos_tone_parse(" 440.6 : 99.5 ,1234567890123:50", notes, FOS_BUZZER_NOTES_MAX), 2);
    CHECK_INT(notes[0].freq_hz, 441);
    CHECK_INT(notes[0].duration_ms, 100);
    CHECK_INT(notes[1].freq_hz, FOS_TONE_HZ_MAX);
}

static void test_a_pair_that_is_none_is_left_out(void)
{
    CHECK_INT(fos_tone_parse("440:100,x:5,-3:100,500:abc,660:100", notes, FOS_BUZZER_NOTES_MAX), 2);
    CHECK_INT(notes[0].freq_hz, 440);
    CHECK_INT(notes[1].freq_hz, 660);
    CHECK_INT(fos_tone_parse("440:100:7,660:100", notes, FOS_BUZZER_NOTES_MAX), 1);
    CHECK_INT(notes[0].freq_hz, 660);
}

static void test_so_many_notes_and_so_long_at_most(void)
{
    char text[512] = "";
    int used = 0;
    for (int i = 0; i < 20; i++) used += snprintf(text + used, sizeof(text) - (size_t)used, "%s%d:100", i ? "," : "", 1000 + i);
    CHECK_INT(fos_tone_parse(text, notes, FOS_BUZZER_NOTES_MAX), FOS_BUZZER_NOTES_MAX);
    CHECK_INT(notes[FOS_BUZZER_NOTES_MAX - 1].freq_hz, 1000 + FOS_BUZZER_NOTES_MAX - 1);
    /* Fewer room than notes: `max` holds. */
    CHECK_INT(fos_tone_parse(text, notes, 3), 3);
    /* Ten seconds in all: the third note is cut to what is left, no fourth. */
    CHECK_INT(fos_tone_parse("440:4000,550:4000,660:4000,770:4000", notes, FOS_BUZZER_NOTES_MAX), 3);
    CHECK_INT(notes[2].duration_ms, 2000);
}

int main(void)
{
    test_the_runtime_s_notes_are_read_as_written();
    test_nothing_to_play_is_no_notes();
    test_pitches_and_lengths_are_held_to_the_bounds();
    test_a_pair_that_is_none_is_left_out();
    test_so_many_notes_and_so_long_at_most();
    printf("%d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
