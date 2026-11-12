/* The events a frame rendered on the server relays to its plane. See the header. */
#include "fos_render_relay.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* `{"nowMs":` + the longest int64 + `,"events":[` + `]}` + the NUL. */
#define BODY_FRAME_BYTES (9 + 20 + 11 + 2 + 1)

static bool plain_name(const char *name)
{
    if (name == NULL || name[0] == '\0' || strlen(name) > FOS_CUSTOM_EVENT_MAX_NAME_LENGTH) return false;
    for (const unsigned char *p = (const unsigned char *)name; *p; p++) {
        if (*p < 0x20 || *p >= 0x7f || *p == '"' || *p == '\\') return false;
    }
    return true;
}

static const char *skip_ws(const char *p)
{
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    return p;
}

/* `p` at a `{`: one JSON object, its strings closed and free of raw control
 * characters, its brackets balanced. Returns just past it, or NULL. Not a
 * parser: what passes and still does not parse is the plane's 400, and the
 * pull that carried it drops it (fos_client.c). */
static const char *object_end(const char *p)
{
    if (*p != '{') return NULL;
    int depth = 0;
    while (*p) {
        unsigned char c = (unsigned char)*p;
        if (c == '"') {
            p++;
            while (*p && *p != '"') {
                if ((unsigned char)*p < 0x20) return NULL;
                if (*p == '\\') {
                    p++;
                    if (*p == '\0') return NULL;
                }
                p++;
            }
            if (*p != '"') return NULL;
            p++;
            continue;
        }
        if (c == '{' || c == '[') {
            if (++depth > 64) return NULL;
        } else if (c == '}' || c == ']') {
            if (--depth == 0) return c == '}' ? p + 1 : NULL;
            if (depth < 0) return NULL;
        }
        p++;
    }
    return NULL;
}

/* The payload as it is kept: the object with the blanks around it trimmed,
 * `{}` for none. NULL for anything else, or no memory. */
static char *payload_copy(const char *payload_json)
{
    const char *start = payload_json ? skip_ws(payload_json) : "";
    if (*start == '\0') start = "{}";
    const char *end = object_end(start);
    if (end == NULL || *skip_ws(end) != '\0') return NULL;
    size_t len = (size_t)(end - start);
    char *copy = malloc(len + 1);
    if (copy == NULL) return NULL;
    memcpy(copy, start, len);
    copy[len] = '\0';
    return copy;
}

/* `{"origin":"…","name":"…","payload":…}` and the comma before the next. */
static size_t event_bytes(fos_event_origin_t origin, const char *name, const char *payload)
{
    return strlen("{\"origin\":\"\",\"name\":\"\",\"payload\":}") + strlen(fos_event_origin_name(origin)) +
           strlen(name) + strlen(payload) + 1;
}

/* A top-level `"pointerId":N` of a firmware-made pointer payload; -1 without. */
static int pointer_id(const char *payload)
{
    const char *at = strstr(payload, "\"pointerId\":");
    if (at == NULL) return -1;
    at += strlen("\"pointerId\":");
    int value = 0;
    if (*at < '0' || *at > '9') return -1;
    while (*at >= '0' && *at <= '9' && value < 1000) value = value * 10 + (*at++ - '0');
    return value;
}

static void track_pointers(fos_render_relay_t *relay, fos_event_origin_t origin, const char *name,
                           const char *payload)
{
    if (origin != FOS_ORIGIN_DRIVER) return;
    bool down = strcmp(name, FOS_EVENT_POINTER_DOWN) == 0;
    bool up = strcmp(name, FOS_EVENT_POINTER_UP) == 0 || strcmp(name, FOS_EVENT_POINTER_CANCEL) == 0;
    if (!down && !up) return;
    int id = pointer_id(payload);
    if (id < 0 || id > 31) return;
    if (down) {
        relay->pointers_down |= 1u << id;
    } else {
        relay->pointers_down &= ~(1u << id);
    }
}

static void drop_oldest(fos_render_relay_t *relay)
{
    fos_render_relay_event_t *oldest = &relay->events[0];
    relay->body_bytes -= oldest->bytes;
    free(oldest->payload);
    memmove(&relay->events[0], &relay->events[1], (relay->count - 1) * sizeof(relay->events[0]));
    relay->count--;
    if (relay->in_flight > 0) relay->in_flight--;
}

fos_render_relay_result_t fos_render_relay_add(fos_render_relay_t *relay, fos_event_origin_t origin,
                                               const char *name, const char *payload_json,
                                               size_t *dropped)
{
    if (dropped) *dropped = 0;
    if (relay == NULL || !plain_name(name)) return FOS_RENDER_RELAY_REFUSED;
    char *payload = payload_copy(payload_json);
    if (payload == NULL) return FOS_RENDER_RELAY_REFUSED;
    size_t bytes = event_bytes(origin, name, payload);
    if (bytes + BODY_FRAME_BYTES > FOS_RENDER_RELAY_MAX_BODY) {
        free(payload);
        return FOS_RENDER_RELAY_REFUSED;
    }
    track_pointers(relay, origin, name, payload);

    /* A newer position of the same finger replaces the one still waiting,
     * unless that one is already out with a pull. */
    if (relay->count > relay->in_flight && fos_event_spec(name)->coalesce_latest) {
        fos_render_relay_event_t *newest = &relay->events[relay->count - 1];
        if (newest->origin == origin && strcmp(newest->name, name) == 0 &&
            pointer_id(newest->payload) == pointer_id(payload)) {
            relay->body_bytes = relay->body_bytes - newest->bytes + bytes;
            free(newest->payload);
            newest->payload = payload;
            newest->bytes = bytes;
            size_t gone = 0;
            while (relay->body_bytes + BODY_FRAME_BYTES > FOS_RENDER_RELAY_MAX_BODY && relay->count > 1) {
                drop_oldest(relay);
                gone++;
            }
            if (dropped) *dropped = gone;
            return FOS_RENDER_RELAY_COALESCED;
        }
    }

    size_t gone = 0;
    while (relay->count > 0 && (relay->count >= FOS_RENDER_RELAY_MAX_EVENTS ||
                                relay->body_bytes + bytes + BODY_FRAME_BYTES > FOS_RENDER_RELAY_MAX_BODY)) {
        drop_oldest(relay);
        gone++;
    }
    fos_render_relay_event_t *slot = &relay->events[relay->count++];
    slot->origin = origin;
    snprintf(slot->name, sizeof(slot->name), "%s", name);
    slot->payload = payload;
    slot->bytes = bytes;
    relay->body_bytes += bytes;
    if (dropped) *dropped = gone;
    return FOS_RENDER_RELAY_KEPT;
}

size_t fos_render_relay_count(const fos_render_relay_t *relay)
{
    return relay ? relay->count : 0;
}

bool fos_render_relay_pointer_down(const fos_render_relay_t *relay)
{
    return relay && relay->pointers_down != 0;
}

char *fos_render_relay_take(fos_render_relay_t *relay, int64_t now_ms, size_t *len)
{
    if (len) *len = 0;
    if (relay == NULL || relay->count == 0) return NULL;
    size_t cap = relay->body_bytes + BODY_FRAME_BYTES;
    char *body = malloc(cap);
    if (body == NULL) return NULL;
    size_t used = (size_t)snprintf(body, cap, "{\"nowMs\":%lld,\"events\":[", (long long)now_ms);
    for (size_t i = 0; i < relay->count && used < cap; i++) {
        const fos_render_relay_event_t *event = &relay->events[i];
        used += (size_t)snprintf(body + used, cap - used, "%s{\"origin\":\"%s\",\"name\":\"%s\",\"payload\":%s}",
                                 i ? "," : "", fos_event_origin_name(event->origin), event->name, event->payload);
    }
    if (used + 2 >= cap) {
        free(body);
        return NULL;
    }
    used += (size_t)snprintf(body + used, cap - used, "]}");
    relay->in_flight = relay->count;
    if (len) *len = used;
    return body;
}

void fos_render_relay_commit(fos_render_relay_t *relay)
{
    if (relay == NULL) return;
    while (relay->in_flight > 0 && relay->count > 0) drop_oldest(relay);
    relay->in_flight = 0;
}

void fos_render_relay_release(fos_render_relay_t *relay)
{
    if (relay) relay->in_flight = 0;
}

bool fos_render_relay_pop(fos_render_relay_t *relay, fos_event_origin_t *origin, char *name,
                          size_t name_len, char **payload)
{
    if (relay == NULL || relay->count == 0) return false;
    fos_render_relay_event_t *oldest = &relay->events[0];
    if (origin) *origin = oldest->origin;
    if (name && name_len) snprintf(name, name_len, "%s", oldest->name);
    if (payload) {
        *payload = oldest->payload;
        oldest->payload = NULL;
    }
    drop_oldest(relay);
    return true;
}

size_t fos_render_relay_clear(fos_render_relay_t *relay)
{
    if (relay == NULL) return 0;
    size_t held = relay->count;
    while (relay->count > 0) drop_oldest(relay);
    relay->in_flight = 0;
    relay->body_bytes = 0;
    return held;
}
