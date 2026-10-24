#include "fos_voice_binding.h"

#include <ctype.h>
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

size_t fos_voice_binding_labels(const char *event_map_json, char labels[][FOS_VOICE_BINDING_LABEL_LEN],
                                size_t max)
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
        /* A rule on this label's long press: with no `action` it matches
         * every press of the key, the long one included. */
        if (cJSON_IsString(action) && strcmp(action->valuestring, "longPress") != 0) continue;
        if (action != NULL && !cJSON_IsString(action)) continue;
        if (label_index(seen, seen_count, label->valuestring) >= 0) continue;
        if (seen_count < sizeof(seen) / sizeof(seen[0])) {
            upper_copy(seen[seen_count++], label->valuestring, FOS_VOICE_BINDING_LABEL_LEN);
        }
        const cJSON *emit = cJSON_GetObjectItem(rule, "emit");
        if (!cJSON_IsString(emit) || strcmp(emit->valuestring, FOS_EVENT_VOICE_CHAT) != 0) continue;
        if (count < max) upper_copy(labels[count++], label->valuestring, FOS_VOICE_BINDING_LABEL_LEN);
    }
    cJSON_Delete(rules);
    return count;
}
