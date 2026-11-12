#include "fos_json_guard.h"

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
