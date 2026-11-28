#include "fos_tone.h"

#include <stdbool.h>
#include <stdint.h>

/* A whole number at *p (a fraction after it rounds it), spaces around it
 * skipped; moves *p past it. False when there is no digit. */
static bool read_number(const char **p, uint32_t *value)
{
    const char *s = *p;
    while (*s == ' ') s++;
    uint32_t v = 0;
    int digits = 0;
    while (*s >= '0' && *s <= '9') {
        if (digits < 9) v = v * 10 + (uint32_t)(*s - '0');
        digits++;
        s++;
    }
    if (digits == 0) return false;
    if (digits > 9) v = 999999999u;
    if (*s == '.') {
        s++;
        if (*s >= '5' && *s <= '9' && v < 999999999u) v++;
        while (*s >= '0' && *s <= '9') s++;
    }
    while (*s == ' ') s++;
    *p = s;
    *value = v;
    return true;
}

size_t fos_tone_parse(const char *text, fos_buzzer_note_t *out, size_t max)
{
    if (!text || !out) return 0;
    size_t count = 0;
    uint32_t total = 0;
    bool sounds = false;
    const char *p = text;
    while (*p && count < max && total < FOS_TONE_TOTAL_MS_MAX) {
        uint32_t hz = 0, ms = 0;
        const char *start = p;
        bool ok = read_number(&p, &hz) && *p == ':';
        if (ok) {
            p++;
            ok = read_number(&p, &ms) && (*p == ',' || *p == '\0');
        }
        if (!ok) {
            /* No pair: on to the next comma. */
            p = start;
            while (*p && *p != ',') p++;
        } else {
            if (hz != 0) {
                if (hz < FOS_TONE_HZ_MIN) hz = FOS_TONE_HZ_MIN;
                if (hz > FOS_TONE_HZ_MAX) hz = FOS_TONE_HZ_MAX;
                sounds = true;
            }
            if (ms < FOS_TONE_NOTE_MS_MIN) ms = FOS_TONE_NOTE_MS_MIN;
            if (ms > FOS_TONE_NOTE_MS_MAX) ms = FOS_TONE_NOTE_MS_MAX;
            if (ms > FOS_TONE_TOTAL_MS_MAX - total) ms = FOS_TONE_TOTAL_MS_MAX - total;
            out[count].freq_hz = hz;
            out[count].duration_ms = ms;
            count++;
            total += ms;
        }
        if (*p == ',') p++;
    }
    return sounds ? count : 0;
}
