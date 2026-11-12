/* The events a frame rendered on the server relays to its plane. See the header. */
#include "fos_render_relay.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fos_json_guard.h"

/* `{"nowMs":` + the longest int64 + `,"events":[` + `]}` + the NUL. */
#define BODY_FRAME 43

bool fos_render_relay_add(fos_render_relay_t *relay, const char *origin, const char *name,
                          const char *payload_json, unsigned *dropped)
{
    *dropped = 0;
    const char *payload = payload_json && payload_json[0] ? payload_json : "{}";
    size_t payload_len = strlen(payload);
    const char *first = payload + strspn(payload, " \t\r\n");
    /* A payload made by the firmware is one object; one from HTTP may be
     * anything, and one that does not parse would cost the whole body (the
     * plane's 400). Not a parser: the frame's own JSON guard. */
    if (strpbrk(name, "\"\\") != NULL || *first != '{' || !fos_json_whole(payload, payload_len)) return false;
    size_t size = strlen(origin) + strlen(name) + payload_len + sizeof("{\"origin\":\"\",\"name\":\"\",\"payload\":}");
    if (size + BODY_FRAME > FOS_RENDER_RELAY_MAX_BODY) return false;
    char *event = malloc(size);
    if (event == NULL) return false;
    snprintf(event, size, "{\"origin\":\"%s\",\"name\":\"%s\",\"payload\":%s}", origin, name, payload);
    /* `size` counts the NUL, which is the comma's share of the body. */
    while (relay->count > 0 &&
           (relay->count == FOS_RENDER_RELAY_MAX_EVENTS || relay->body + size + BODY_FRAME > FOS_RENDER_RELAY_MAX_BODY)) {
        fos_render_relay_drop(relay, 1);
        (*dropped)++;
    }
    relay->events[relay->count++] = event;
    relay->body += (uint16_t)size;
    return true;
}

char *fos_render_relay_take(fos_render_relay_t *relay, int64_t now_ms, size_t *len)
{
    if (relay->count == 0) return NULL;
    char *body = malloc(relay->body + BODY_FRAME);
    if (body == NULL) return NULL;
    size_t used = (size_t)snprintf(body, BODY_FRAME, "{\"nowMs\":%lld,\"events\":[", (long long)now_ms);
    for (unsigned i = 0; i < relay->count; i++) {
        if (i) body[used++] = ',';
        size_t event_len = strlen(relay->events[i]);
        memcpy(body + used, relay->events[i], event_len);
        used += event_len;
    }
    memcpy(body + used, "]}", 3);
    *len = used + 2;
    relay->in_flight = relay->count;
    return body;
}

void fos_render_relay_drop(fos_render_relay_t *relay, unsigned n)
{
    if (n > relay->count) n = relay->count;
    for (unsigned i = 0; i < n; i++) {
        relay->body -= (uint16_t)(strlen(relay->events[i]) + 1);
        free(relay->events[i]);
    }
    relay->count -= (uint8_t)n;
    memmove(&relay->events[0], &relay->events[n], relay->count * sizeof(relay->events[0]));
    relay->in_flight = relay->in_flight > n ? (uint8_t)(relay->in_flight - n) : 0;
}
