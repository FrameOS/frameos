#include "fos_press.h"

#include <string.h>

uint32_t fos_press_answer_average(uint32_t previous_ms, uint32_t sample_ms)
{
    if (previous_ms == 0) return sample_ms > 0 ? sample_ms : 1;
    /* Seven parts the past, one the newest: a slow tap among quick ones does
     * not ink the next. */
    uint32_t average = (uint32_t)(((uint64_t)previous_ms * 7u + sample_ms) / 8u);
    return average > 0 ? average : 1;
}

bool fos_press_ink_wanted(uint32_t average_ms)
{
    return average_ms >= FOS_PRESS_INK_AFTER_MS;
}

bool fos_press_moved_off(int dx, int dy)
{
    return dx * dx + dy * dy > FOS_PRESS_SLOP_PX * FOS_PRESS_SLOP_PX;
}

void fos_press_ink_gray4(uint8_t *bytes, size_t len)
{
    for (size_t i = 0; i < len; i++) {
        uint8_t hi = bytes[i] >> 4, lo = bytes[i] & 0x0F;
        hi = hi >= 8 ? 0x0 : 0xF;
        lo = lo >= 8 ? 0x0 : 0xF;
        bytes[i] = (uint8_t)(hi << 4 | lo);
    }
}

static int find_box(const fos_press_answers_t *answers, const int box[4])
{
    for (int i = 0; i < FOS_PRESS_ANSWERS; i++) {
        const fos_press_answer_t *e = &answers->entries[i];
        if (e->ms != 0 && memcmp(e->box, box, sizeof(e->box)) == 0) return i;
    }
    return -1;
}

uint32_t fos_press_answers_get(const fos_press_answers_t *answers, const int box[4])
{
    int i = box ? find_box(answers, box) : -1;
    return i >= 0 ? answers->entries[i].ms : 0;
}

void fos_press_answers_note(fos_press_answers_t *answers, const int box[4], uint32_t ms)
{
    if (!box) return;
    int i = find_box(answers, box);
    if (i < 0) {
        /* A free entry, else the one pressed longest ago. */
        i = 0;
        for (int j = 0; j < FOS_PRESS_ANSWERS; j++) {
            if (answers->entries[j].ms == 0) {
                i = j;
                break;
            }
            if (answers->entries[j].used < answers->entries[i].used) i = j;
        }
        memcpy(answers->entries[i].box, box, sizeof(answers->entries[i].box));
        answers->entries[i].ms = 0;
    }
    fos_press_answer_t *e = &answers->entries[i];
    e->ms = fos_press_answer_average(e->ms, ms);
    e->used = ++answers->clock;
}

void fos_press_answers_clear(fos_press_answers_t *answers)
{
    memset(answers, 0, sizeof(*answers));
}
