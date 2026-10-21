#include "pk_json.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    const char *p;
    const char *end;
} cursor_t;

static void skip_ws(cursor_t *c)
{
    while (c->p < c->end && (*c->p == ' ' || *c->p == '\t' || *c->p == '\n' || *c->p == '\r')) {
        c->p++;
    }
}

static bool skip_string(cursor_t *c)
{
    if (c->p >= c->end || *c->p != '"') return false;
    c->p++;
    while (c->p < c->end) {
        char ch = *c->p++;
        if (ch == '"') return true;
        if (ch == '\\') {
            if (c->p >= c->end) return false;
            c->p++;
        } else if ((unsigned char)ch < 0x20) {
            return false;
        }
    }
    return false;
}

static bool skip_literal(cursor_t *c, const char *word)
{
    size_t len = strlen(word);
    if ((size_t)(c->end - c->p) < len || memcmp(c->p, word, len) != 0) return false;
    c->p += len;
    return true;
}

static bool skip_number(cursor_t *c)
{
    const char *start = c->p;
    if (c->p < c->end && *c->p == '-') c->p++;
    const char *digits = c->p;
    while (c->p < c->end && *c->p >= '0' && *c->p <= '9') c->p++;
    if (c->p == digits) return false;
    if (c->p < c->end && *c->p == '.') {
        c->p++;
        const char *fraction = c->p;
        while (c->p < c->end && *c->p >= '0' && *c->p <= '9') c->p++;
        if (c->p == fraction) return false;
    }
    if (c->p < c->end && (*c->p == 'e' || *c->p == 'E')) {
        c->p++;
        if (c->p < c->end && (*c->p == '+' || *c->p == '-')) c->p++;
        const char *exponent = c->p;
        while (c->p < c->end && *c->p >= '0' && *c->p <= '9') c->p++;
        if (c->p == exponent) return false;
    }
    return c->p > start;
}

static bool skip_value(cursor_t *c, int depth);

static bool skip_container(cursor_t *c, int depth, char open, char close)
{
    if (depth >= PK_JSON_MAX_DEPTH) return false;
    if (c->p >= c->end || *c->p != open) return false;
    c->p++;
    skip_ws(c);
    if (c->p < c->end && *c->p == close) {
        c->p++;
        return true;
    }
    for (;;) {
        skip_ws(c);
        if (open == '{') {
            if (!skip_string(c)) return false;
            skip_ws(c);
            if (c->p >= c->end || *c->p != ':') return false;
            c->p++;
        }
        if (!skip_value(c, depth + 1)) return false;
        skip_ws(c);
        if (c->p >= c->end) return false;
        if (*c->p == ',') {
            c->p++;
            continue;
        }
        if (*c->p == close) {
            c->p++;
            return true;
        }
        return false;
    }
}

static bool skip_value(cursor_t *c, int depth)
{
    skip_ws(c);
    if (c->p >= c->end) return false;
    switch (*c->p) {
        case '{': return skip_container(c, depth, '{', '}');
        case '[': return skip_container(c, depth, '[', ']');
        case '"': return skip_string(c);
        case 't': return skip_literal(c, "true");
        case 'f': return skip_literal(c, "false");
        case 'n': return skip_literal(c, "null");
        default: return skip_number(c);
    }
}

// Keys in the documents we read are plain ASCII identifiers, so a key matches
// when its raw bytes do; an escaped spelling of the same key is not a match.
static bool find_key(cursor_t *c, const char *key, size_t key_len, int depth)
{
    skip_ws(c);
    if (c->p >= c->end || *c->p != '{') return false;
    c->p++;
    skip_ws(c);
    if (c->p < c->end && *c->p == '}') return false;
    for (;;) {
        skip_ws(c);
        const char *name = c->p;
        if (!skip_string(c)) return false;
        size_t name_len = (size_t)(c->p - name) - 2;
        skip_ws(c);
        if (c->p >= c->end || *c->p != ':') return false;
        c->p++;
        skip_ws(c);
        if (name_len == key_len && memcmp(name + 1, key, key_len) == 0) {
            return true; // cursor sits on the value
        }
        if (!skip_value(c, depth + 1)) return false;
        skip_ws(c);
        if (c->p >= c->end || *c->p != ',') return false;
        c->p++;
    }
}

bool pk_json_find(const char *json, size_t len, const char *path, pk_json_slice_t *out)
{
    if (json == NULL || path == NULL || out == NULL) return false;
    cursor_t c = {json, json + len};
    int depth = 0;
    while (*path) {
        const char *dot = strchr(path, '.');
        size_t key_len = dot ? (size_t)(dot - path) : strlen(path);
        if (key_len == 0 || depth >= PK_JSON_MAX_DEPTH) return false;
        if (!find_key(&c, path, key_len, depth)) return false;
        path += key_len + (dot ? 1 : 0);
        depth++;
    }
    skip_ws(&c);
    const char *start = c.p;
    if (!skip_value(&c, depth)) return false;
    out->start = start;
    out->len = (size_t)(c.p - start);
    return true;
}

bool pk_json_valid(const char *json, size_t len)
{
    if (json == NULL) return false;
    cursor_t c = {json, json + len};
    if (!skip_value(&c, 0)) return false;
    skip_ws(&c);
    return c.p == c.end;
}

static bool slice_is(pk_json_slice_t value, const char *word)
{
    return value.start != NULL && value.len == strlen(word) &&
           memcmp(value.start, word, value.len) == 0;
}

bool pk_json_is_null(pk_json_slice_t value)
{
    return slice_is(value, "null");
}

bool pk_json_as_bool(pk_json_slice_t value, bool *out)
{
    if (slice_is(value, "true")) {
        *out = true;
        return true;
    }
    if (slice_is(value, "false")) {
        *out = false;
        return true;
    }
    return false;
}

bool pk_json_as_long(pk_json_slice_t value, long *out)
{
    if (value.start == NULL || value.len == 0 || value.len >= 32) return false;
    char first = value.start[0];
    if (first != '-' && (first < '0' || first > '9')) return false;
    char text[32];
    memcpy(text, value.start, value.len);
    text[value.len] = '\0';
    char *end = NULL;
    long parsed = strtol(text, &end, 10);
    if (end == text) return false;
    *out = parsed;
    return true;
}

static int hex_digit(char ch)
{
    if (ch >= '0' && ch <= '9') return ch - '0';
    if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
    if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
    return -1;
}

static bool read_hex4(const char *p, const char *end, uint32_t *out)
{
    if (end - p < 4) return false;
    uint32_t value = 0;
    for (int i = 0; i < 4; i++) {
        int digit = hex_digit(p[i]);
        if (digit < 0) return false;
        value = (value << 4) | (uint32_t)digit;
    }
    *out = value;
    return true;
}

static size_t utf8_encode(uint32_t cp, char *dst)
{
    if (cp < 0x80) {
        dst[0] = (char)cp;
        return 1;
    }
    if (cp < 0x800) {
        dst[0] = (char)(0xC0 | (cp >> 6));
        dst[1] = (char)(0x80 | (cp & 0x3F));
        return 2;
    }
    if (cp < 0x10000) {
        dst[0] = (char)(0xE0 | (cp >> 12));
        dst[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
        dst[2] = (char)(0x80 | (cp & 0x3F));
        return 3;
    }
    dst[0] = (char)(0xF0 | (cp >> 18));
    dst[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
    dst[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
    dst[3] = (char)(0x80 | (cp & 0x3F));
    return 4;
}

bool pk_json_as_string(pk_json_slice_t value, char *dst, size_t cap)
{
    if (value.start == NULL || value.len < 2 || cap == 0) return false;
    if (value.start[0] != '"' || value.start[value.len - 1] != '"') return false;
    const char *p = value.start + 1;
    const char *end = value.start + value.len - 1;
    size_t out = 0;
    while (p < end) {
        char encoded[4];
        size_t encoded_len = 1;
        char ch = *p++;
        if (ch != '\\') {
            encoded[0] = ch;
        } else {
            if (p >= end) return false;
            char escape = *p++;
            switch (escape) {
                case '"': encoded[0] = '"'; break;
                case '\\': encoded[0] = '\\'; break;
                case '/': encoded[0] = '/'; break;
                case 'b': encoded[0] = '\b'; break;
                case 'f': encoded[0] = '\f'; break;
                case 'n': encoded[0] = '\n'; break;
                case 'r': encoded[0] = '\r'; break;
                case 't': encoded[0] = '\t'; break;
                case 'u': {
                    uint32_t cp = 0;
                    if (!read_hex4(p, end, &cp)) return false;
                    p += 4;
                    if (cp >= 0xD800 && cp <= 0xDBFF) {
                        uint32_t low = 0;
                        if (end - p < 6 || p[0] != '\\' || p[1] != 'u' ||
                            !read_hex4(p + 2, end, &low) || low < 0xDC00 || low > 0xDFFF) {
                            return false;
                        }
                        p += 6;
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
                    } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
                        return false;
                    }
                    if (cp == 0) return false; // no embedded NULs in C strings
                    encoded_len = utf8_encode(cp, encoded);
                    break;
                }
                default:
                    return false;
            }
        }
        if (out + encoded_len >= cap) return false;
        memcpy(dst + out, encoded, encoded_len);
        out += encoded_len;
    }
    dst[out] = '\0';
    return true;
}

size_t pk_json_escaped_len(const char *src)
{
    size_t len = 0;
    for (const unsigned char *p = (const unsigned char *)(src ? src : ""); *p; p++) {
        if (*p == '"' || *p == '\\' || *p == '\n' || *p == '\r' || *p == '\t') len += 2;
        else if (*p < 0x20) len += 6;
        else len += 1;
    }
    return len;
}

size_t pk_json_escape(const char *src, char *dst, size_t cap)
{
    static const char hex[] = "0123456789abcdef";
    if (cap == 0) return 0;
    size_t out = 0;
    for (const unsigned char *p = (const unsigned char *)(src ? src : ""); *p; p++) {
        char encoded[6];
        size_t encoded_len;
        switch (*p) {
            case '"': encoded[0] = '\\'; encoded[1] = '"'; encoded_len = 2; break;
            case '\\': encoded[0] = '\\'; encoded[1] = '\\'; encoded_len = 2; break;
            case '\n': encoded[0] = '\\'; encoded[1] = 'n'; encoded_len = 2; break;
            case '\r': encoded[0] = '\\'; encoded[1] = 'r'; encoded_len = 2; break;
            case '\t': encoded[0] = '\\'; encoded[1] = 't'; encoded_len = 2; break;
            default:
                if (*p < 0x20) {
                    encoded[0] = '\\'; encoded[1] = 'u'; encoded[2] = '0'; encoded[3] = '0';
                    encoded[4] = hex[*p >> 4]; encoded[5] = hex[*p & 0x0F];
                    encoded_len = 6;
                } else {
                    // A UTF-8 sequence moves as one unit, so a cut never
                    // leaves half a character behind.
                    size_t want = *p >= 0xF0 ? 4 : *p >= 0xE0 ? 3 : *p >= 0xC0 ? 2 : 1;
                    encoded_len = 1;
                    while (encoded_len < want && (p[encoded_len] & 0xC0) == 0x80) encoded_len++;
                    memcpy(encoded, p, encoded_len);
                    p += encoded_len - 1;
                }
        }
        if (out + encoded_len >= cap) break;
        memcpy(dst + out, encoded, encoded_len);
        out += encoded_len;
    }
    dst[out] = '\0';
    return out;
}
