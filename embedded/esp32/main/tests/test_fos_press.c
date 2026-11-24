/* Host tests for main/fos_press.c: what decides a press shown at once.
 * Built and run by backend/app/tasks/tests/test_esp32_press.py. */
#include "fos_press.h"

#include <stdio.h>
#include <string.h>

static int failures = 0;
#define CHECK(cond, what)                                        \
    do {                                                         \
        if (!(cond)) {                                           \
            printf("FAIL %s:%d %s\n", __FILE__, __LINE__, what); \
            failures++;                                          \
        }                                                        \
    } while (0)

int main(void)
{
    /* A scene's taps, smoothed: the first is taken as it is. */
    CHECK(fos_press_answer_average(0, 800) == 800, "the first answer is the average");
    CHECK(fos_press_answer_average(0, 0) == 1, "an instant first answer still counts as one");
    CHECK(fos_press_answer_average(800, 400) == 750, "a quicker one pulls it down by an eighth of the gap");
    CHECK(fos_press_answer_average(200, 1000) == 300, "one slow tap among quick ones moves it an eighth");

    /* Ink only where the answer takes longer than the ink's own waveform. */
    CHECK(!fos_press_ink_wanted(0), "no answer timed yet: no ink");
    CHECK(!fos_press_ink_wanted(FOS_PRESS_INK_AFTER_MS - 1), "quick answers: no ink, it would only delay them");
    CHECK(fos_press_ink_wanted(FOS_PRESS_INK_AFTER_MS), "slow answers: ink");
    uint32_t avg = 0;
    for (int i = 0; i < 3; i++) avg = fos_press_answer_average(avg, 250);
    avg = fos_press_answer_average(avg, 2000);
    CHECK(!fos_press_ink_wanted(avg), "one slow answer after quick ones inks nothing yet");
    avg = fos_press_answer_average(avg, 2000);
    CHECK(fos_press_ink_wanted(avg), "two in a row: the scene is slow now");

    /* A finger that slid is a drag. */
    CHECK(!fos_press_moved_off(0, 0), "still");
    CHECK(!fos_press_moved_off(FOS_PRESS_SLOP_PX, 0), "at the slop: still a press");
    CHECK(fos_press_moved_off(FOS_PRESS_SLOP_PX + 1, 0), "past it: a drag");
    CHECK(fos_press_moved_off(-9, 9), "diagonally past it: a drag");

    /* The ink: the other extreme, pure black and white. */
    uint8_t row[] = {0xFF, 0x00, 0xF0, 0x0F, 0x87, 0x78, 0x9A};
    fos_press_ink_gray4(row, sizeof(row));
    CHECK(row[0] == 0x00, "white goes black");
    CHECK(row[1] == 0xFF, "black goes white");
    CHECK(row[2] == 0x0F && row[3] == 0xF0, "each nibble its own");
    CHECK(row[4] == 0x0F, "8 is light (black), 7 dark (white)");
    CHECK(row[5] == 0xF0, "the same the other way round");
    CHECK(row[6] == 0x00, "light greys go black");
    for (size_t i = 0; i < sizeof(row); i++) {
        uint8_t hi = row[i] >> 4, lo = row[i] & 0x0F;
        CHECK((hi == 0 || hi == 0xF) && (lo == 0 || lo == 0xF), "every pixel pure black or white: a DU draws it exactly");
    }

    /* By box: a slow button inks, the quick one beside it does not. */
    fos_press_answers_t answers;
    fos_press_answers_clear(&answers);
    const int slow[4] = {260, 20, 460, 140}, quick[4] = {20, 20, 220, 140};
    CHECK(fos_press_answers_get(&answers, slow) == 0, "nothing timed yet");
    fos_press_answers_note(&answers, slow, 1600);
    fos_press_answers_note(&answers, quick, 150);
    CHECK(fos_press_ink_wanted(fos_press_answers_get(&answers, slow)), "the slow button inks");
    CHECK(!fos_press_ink_wanted(fos_press_answers_get(&answers, quick)), "the quick one does not");
    fos_press_answers_note(&answers, quick, 150);
    CHECK(fos_press_answers_get(&answers, quick) == 150, "its own taps only");
    CHECK(fos_press_answers_get(&answers, NULL) == 0, "no box, no answer");
    /* Room for FOS_PRESS_ANSWERS: the one pressed longest ago goes. */
    for (int i = 0; i < FOS_PRESS_ANSWERS; i++) {
        const int other[4] = {i * 10, 300, i * 10 + 5, 320};
        fos_press_answers_note(&answers, other, 700);
        if (i == 0) fos_press_answers_note(&answers, slow, 1600); /* pressed again: kept */
    }
    CHECK(fos_press_answers_get(&answers, quick) == 0, "the least recently pressed went");
    CHECK(fos_press_answers_get(&answers, slow) != 0, "one pressed since stays");
    fos_press_answers_clear(&answers);
    CHECK(fos_press_answers_get(&answers, slow) == 0, "another scene: all forgotten");

    if (failures) {
        printf("%d failure(s)\n", failures);
        return 1;
    }
    printf("ok: press\n");
    return 0;
}
