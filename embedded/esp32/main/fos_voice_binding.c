#include "fos_voice_binding.h"

#include <ctype.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <strings.h> /* strcasecmp: POSIX, not in <string.h> under strict C11 (glibc) */

#include "cJSON.h"

#include "fos_events_gen.h"

static void upper_copy(char *dst, const char *src, size_t len)
{
    size_t i = 0;
    for (; src[i] && i + 1 < len; i++) dst[i] = (char)toupper((unsigned char)src[i]);
    dst[i] = '\0';
}

static int label_index(char labels[][FOS_VOICE_BINDING_LABEL_LEN], size_t count, const char *label)
{
    for (size_t i = 0; i < count; i++) {
        if (strcasecmp(labels[i], label) == 0) return (int)i;
    }
    return -1;
}

/* The labels the first rule matching their `wanted` press binds to `emit`
 * (NULL: to anything at all). With `any_action`, a rule naming no action
 * matches every press, the wanted one included. */
static size_t bound_labels(const char *event_map_json, const char *wanted, bool any_action, const char *emit_name,
                           char labels[][FOS_VOICE_BINDING_LABEL_LEN], size_t max)
{
    if (!event_map_json || !event_map_json[0] || max == 0) return 0;
    cJSON *rules = cJSON_Parse(event_map_json);
    if (!cJSON_IsArray(rules)) {
        cJSON_Delete(rules);
        return 0;
    }
    /* The labels whose long press some earlier rule already took, voice or
     * not: the first matching rule wins, the rest never run. */
    char seen[16][FOS_VOICE_BINDING_LABEL_LEN];
    size_t seen_count = 0;
    size_t count = 0;
    const cJSON *rule;
    cJSON_ArrayForEach(rule, rules) {
        if (!cJSON_IsObject(rule)) continue;
        const cJSON *event = cJSON_GetObjectItem(rule, "event");
        if (!cJSON_IsString(event) || strcmp(event->valuestring, FOS_EVENT_BUTTON) != 0) continue;
        const cJSON *match = cJSON_GetObjectItem(rule, "match");
        if (!cJSON_IsObject(match)) continue;
        const cJSON *label = cJSON_GetObjectItem(match, "label");
        const cJSON *action = cJSON_GetObjectItem(match, "action");
        if (!cJSON_IsString(label) || !label->valuestring[0]) continue;
        /* A rule on this label's wanted press: with no `action` it matches
         * every press of the key, the wanted one included (where that counts). */
        if (cJSON_IsString(action) && strcmp(action->valuestring, wanted) != 0) continue;
        if (action != NULL && !cJSON_IsString(action)) continue;
        if (action == NULL && !any_action) continue;
        if (label_index(seen, seen_count, label->valuestring) >= 0) continue;
        if (seen_count < sizeof(seen) / sizeof(seen[0])) {
            upper_copy(seen[seen_count++], label->valuestring, FOS_VOICE_BINDING_LABEL_LEN);
        }
        const cJSON *emit = cJSON_GetObjectItem(rule, "emit");
        if (emit_name && (!cJSON_IsString(emit) || strcmp(emit->valuestring, emit_name) != 0)) continue;
        if (count < max) upper_copy(labels[count++], label->valuestring, FOS_VOICE_BINDING_LABEL_LEN);
    }
    cJSON_Delete(rules);
    return count;
}

size_t fos_voice_binding_labels(const char *event_map_json, char labels[][FOS_VOICE_BINDING_LABEL_LEN],
                                size_t max)
{
    return bound_labels(event_map_json, FOS_BUTTON_ACTION_LONG_PRESS, true, FOS_EVENT_VOICE_CHAT, labels, max);
}

size_t fos_voice_binding_triple_labels(const char *event_map_json, char labels[][FOS_VOICE_BINDING_LABEL_LEN],
                                       size_t max)
{
    return bound_labels(event_map_json, FOS_BUTTON_ACTION_TRIPLE_PRESS, false, NULL, labels, max);
}

static const char *text_of(const cJSON *object, const char *key)
{
    const cJSON *item = cJSON_GetObjectItem(object, key);
    return cJSON_IsString(item) ? item->valuestring : "";
}

/* What a person does to fire `rule`, in a few words; false for a trigger
 * this does not put into words. */
static bool rule_words(const cJSON *rule, char *out, size_t out_len)
{
    const cJSON *match = cJSON_GetObjectItem(rule, "match");
    if (!cJSON_IsObject(match)) return false;
    const char *event = text_of(rule, "event");
    if (strcmp(event, FOS_EVENT_EDGE_SWIPE) == 0) {
        static const char *const edges[][2] = {
            {"top", "swipe down from the top"},
            {"bottom", "swipe up from the bottom"},
            {"left", "swipe in from the left edge"},
            {"right", "swipe in from the right edge"},
        };
        const char *edge = text_of(match, "edge");
        for (size_t i = 0; i < sizeof(edges) / sizeof(edges[0]); i++) {
            if (strcmp(edge, edges[i][0]) == 0) {
                snprintf(out, out_len, "%s", edges[i][1]);
                return true;
            }
        }
        return false;
    }
    if (strcmp(event, FOS_EVENT_BUTTON) != 0) return false;
    const char *label = text_of(match, "label");
    if (!label[0]) return false;
    if (strcasecmp(label, "AI") == 0) label = "Action";
    const char *action = text_of(match, "action");
    const char *verb = "press";
    const char *count = "";
    if (strcmp(action, FOS_BUTTON_ACTION_LONG_PRESS) == 0) {
        verb = "hold";
    } else if (strcmp(action, FOS_BUTTON_ACTION_DOUBLE_PRESS) == 0) {
        count = " twice";
    } else if (strcmp(action, FOS_BUTTON_ACTION_TRIPLE_PRESS) == 0) {
        count = " thrice";
    } else if (action[0] && strcmp(action, FOS_BUTTON_ACTION_PRESS) != 0) {
        return false;
    }
    snprintf(out, out_len, "%s the %s key%s", verb, label, count);
    return true;
}

fos_voice_page_way_t fos_voice_binding_page_way(const char *event_map_json, char *out, size_t out_len)
{
    if (out_len) out[0] = '\0';
    if (!event_map_json || !event_map_json[0] || out_len == 0) return FOS_VOICE_PAGE_NONE;
    cJSON *rules = cJSON_Parse(event_map_json);
    if (!cJSON_IsArray(rules)) {
        cJSON_Delete(rules);
        return FOS_VOICE_PAGE_NONE;
    }
    bool touch = false;
    const cJSON *rule;
    cJSON_ArrayForEach(rule, rules) {
        if (cJSON_IsObject(rule) && strcmp(text_of(rule, "event"), FOS_EVENT_BUTTON) != 0) touch = true;
    }
    fos_voice_page_way_t way = FOS_VOICE_PAGE_NONE;
    /* The panel first, then the list: each one's first rule put into words. */
    const char *const emits[] = {FOS_EVENT_SCENE_SETTINGS, FOS_EVENT_SCENE_SWITCHER};
    for (size_t e = 0; e < 2 && way == FOS_VOICE_PAGE_NONE; e++) {
        cJSON_ArrayForEach(rule, rules) {
            if (!cJSON_IsObject(rule) || strcmp(text_of(rule, "emit"), emits[e]) != 0) continue;
            if (!touch && strcmp(text_of(rule, "event"), FOS_EVENT_BUTTON) == 0) continue;
            if (!rule_words(rule, out, out_len)) continue;
            const cJSON *as = cJSON_GetObjectItem(rule, "as");
            way = e == 0 && strcmp(text_of(as, "page"), "frame") == 0 ? FOS_VOICE_PAGE_OPEN : FOS_VOICE_PAGE_GEAR;
            break;
        }
    }
    if (way == FOS_VOICE_PAGE_NONE) out[0] = '\0';
    cJSON_Delete(rules);
    return way;
}
