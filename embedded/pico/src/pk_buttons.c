#include "pk_buttons.h"

#include <stdio.h>
#include <string.h>

static void keep(pk_buttons_t *buttons, uint8_t index, bool down, bool wake, uint32_t at_ms)
{
    if (buttons->count == PK_BUTTON_EDGES_MAX) {
        memmove(buttons->edges, buttons->edges + 1, (PK_BUTTON_EDGES_MAX - 1) * sizeof(buttons->edges[0]));
        buttons->count--;
        buttons->dropped++;
    }
    buttons->edges[buttons->count++] = (pk_button_edge_t){
        .index = index, .down = down, .wake = wake, .at_ms = at_ms};
}

void pk_buttons_init(pk_buttons_t *buttons, uint8_t held, uint32_t now_ms)
{
    memset(buttons, 0, sizeof(*buttons));
    for (uint8_t i = 0; i < PK_BUTTON_COUNT; i++) {
        bool down = (held >> i) & 1u;
        // The line's level as the timing reads it: 0 is down.
        fos_button_timing_init(&buttons->timing[i], down ? 0 : 1, now_ms);
        if (down) {
            fos_button_timing_press(&buttons->timing[i], 0);
            keep(buttons, i, true, true, 0);
        }
    }
}

uint8_t pk_buttons_sample(pk_buttons_t *buttons, uint8_t held, uint32_t now_ms)
{
    uint8_t pressed = 0;
    for (uint8_t i = 0; i < PK_BUTTON_COUNT; i++) {
        fos_button_timing_t *timing = &buttons->timing[i];
        switch (fos_button_timing_sample(timing, ((held >> i) & 1u) ? 0 : 1, now_ms)) {
            case FOS_BUTTON_EDGE_PRESS:
                fos_button_timing_press(timing, now_ms);
                keep(buttons, i, true, false, now_ms);
                pressed |= (uint8_t)(1u << i);
                break;
            case FOS_BUTTON_EDGE_RELEASE:
                fos_button_timing_release(timing, now_ms, NULL);
                keep(buttons, i, false, false, now_ms);
                break;
            default:
                break;
        }
    }
    return pressed;
}

bool pk_buttons_busy(const pk_buttons_t *buttons, uint32_t now_ms)
{
    for (uint8_t i = 0; i < PK_BUTTON_COUNT; i++) {
        if (fos_button_timing_busy(&buttons->timing[i], now_ms, PK_BUTTON_SETTLE_SLACK_MS)) return true;
    }
    return false;
}

bool pk_buttons_ready(const pk_buttons_t *buttons, uint32_t now_ms)
{
    return buttons->count > 0 && !pk_buttons_busy(buttons, now_ms);
}

size_t pk_buttons_json(const pk_buttons_t *buttons, uint32_t now_ms, char *dst, size_t cap, size_t *sent)
{
    if (sent) *sent = 0;
    int used = snprintf(dst, cap, "{\"nowMs\":%lu,\"edges\":[", (unsigned long)now_ms);
    if (used < 0 || (size_t)used >= cap) return 0;
    for (size_t i = 0; i < buttons->count; i++) {
        const pk_button_edge_t *edge = &buttons->edges[i];
        int n = snprintf(dst + used, cap - (size_t)used, "%s{\"label\":\"%c\",\"action\":\"%s\",\"atMs\":%lu%s}",
                         i ? "," : "", 'A' + edge->index, edge->down ? "down" : "up",
                         (unsigned long)edge->at_ms, edge->wake ? ",\"wake\":true" : "");
        if (n < 0 || (size_t)n >= cap - (size_t)used) return 0;
        used += n;
    }
    if ((size_t)used + 3 > cap) return 0;
    memcpy(dst + used, "]}", 3);
    if (sent) *sent = buttons->count;
    return (size_t)used + 2;
}

void pk_buttons_consume(pk_buttons_t *buttons, size_t count)
{
    if (count >= buttons->count) {
        buttons->count = 0;
        return;
    }
    memmove(buttons->edges, buttons->edges + count, (buttons->count - count) * sizeof(buttons->edges[0]));
    buttons->count -= count;
}
