#include "fos_json_guard.h"

/* In the firmware cJSON is compiled with this limit (CMakeLists.txt): a
 * build that lost the definition, or moved one number alone, stops here. */
#ifdef ESP_PLATFORM
#ifndef CJSON_NESTING_LIMIT
#error "CJSON_NESTING_LIMIT is not set for this build: see embedded/esp32/CMakeLists.txt"
#endif
_Static_assert(CJSON_NESTING_LIMIT == FOS_JSON_MAX_DEPTH, "cJSON's nesting limit is FOS_JSON_MAX_DEPTH");
#endif

bool fos_json_depth_ok(const char *text, size_t len, int max_depth)
{
    if (text == NULL) return true;
    int depth = 0;
    bool in_string = false;
    bool escaped = false;
    for (size_t i = 0; i < len && text[i] != '\0'; i++) {
        char c = text[i];
        if (in_string) {
            if (escaped) {
                escaped = false;
            } else if (c == '\\') {
                escaped = true;
            } else if (c == '"') {
                in_string = false;
            }
            continue;
        }
        switch (c) {
        case '"':
            in_string = true;
            break;
        case '[':
        case '{':
            if (++depth > max_depth) return false;
            break;
        case ']':
        case '}':
            if (depth > 0) depth--;
            break;
        default:
            break;
        }
    }
    return true;
}

static bool json_space(char c)
{
    return c == ' ' || c == '\n' || c == '\r' || c == '\t';
}

bool fos_json_whole(const char *text, size_t len)
{
    if (text == NULL) return false;
    size_t first = 0;
    while (first < len && json_space(text[first])) first++;
    size_t last = len;
    while (last > first && json_space(text[last - 1])) last--;
    if (last - first < 2) return false;
    char open = text[first], close = text[last - 1];
    return (open == '[' && close == ']') || (open == '{' && close == '}');
}
