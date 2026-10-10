#include "fos_scene_request.h"

#include <string.h>

static bool is_empty(const char *value)
{
    return value == NULL || value[0] == '\0';
}

static bool valid_request_id(const char *value)
{
    size_t len = strlen(value);
    if (len == 0 || len >= FOS_SCENE_REQUEST_ID_LEN) return false;
    for (const char *p = value; *p; p++) {
        char c = *p;
        bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                  (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == ':';
        if (!ok) return false;
    }
    return true;
}

static bool valid_scene_id(const char *value)
{
    size_t len = strlen(value);
    if (len == 0 || len >= FOS_SCENE_REQUEST_SCENE_LEN) return false;
    for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
        if (*p < 0x20 || *p > 0x7e || *p == '"' || *p == '\\') return false;
    }
    return true;
}

fos_scene_request_decision_t fos_scene_request_decide(const char *request_id,
                                                      const char *scene_id,
                                                      const char *applied_id)
{
    if (is_empty(request_id) && is_empty(scene_id)) return FOS_SCENE_REQUEST_NONE;
    if (is_empty(request_id) || is_empty(scene_id)) return FOS_SCENE_REQUEST_INVALID;
    if (!valid_request_id(request_id) || !valid_scene_id(scene_id)) {
        return FOS_SCENE_REQUEST_INVALID;
    }
    if (!is_empty(applied_id) && strcmp(applied_id, request_id) == 0) {
        return FOS_SCENE_REQUEST_SEEN;
    }
    return FOS_SCENE_REQUEST_APPLY;
}
