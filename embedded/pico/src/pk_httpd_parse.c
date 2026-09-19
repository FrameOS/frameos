#include "pk_httpd_parse.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *find_header_end(const char *buf, size_t len)
{
    for (size_t i = 0; i + 3 < len; i++) {
        if (buf[i] == '\r' && buf[i + 1] == '\n' && buf[i + 2] == '\r' && buf[i + 3] == '\n') {
            return buf + i;
        }
    }
    return NULL;
}

static bool name_matches(const char *line, size_t line_len, const char *name)
{
    size_t name_len = strlen(name);
    if (line_len <= name_len || line[name_len] != ':') return false;
    for (size_t i = 0; i < name_len; i++) {
        char a = line[i];
        char b = name[i];
        if (a >= 'A' && a <= 'Z') a = (char)(a + 32);
        if (b >= 'A' && b <= 'Z') b = (char)(b + 32);
        if (a != b) return false;
    }
    return true;
}

pk_httpd_parse_t pk_httpd_parse(const char *buf, size_t len, pk_httpd_request_t *out)
{
    const char *header_end = find_header_end(buf, len);
    if (header_end == NULL) return PK_HTTPD_INCOMPLETE;
    memset(out, 0, sizeof(*out));
    out->body_offset = (size_t)(header_end - buf) + 4;

    // Request line: METHOD SP target SP HTTP/1.x
    const char *line_end = memchr(buf, '\r', (size_t)(header_end - buf) + 1);
    const char *sp1 = memchr(buf, ' ', (size_t)(line_end - buf));
    if (sp1 == NULL || sp1 == buf || (size_t)(sp1 - buf) >= sizeof(out->method)) {
        return PK_HTTPD_BAD_REQUEST;
    }
    memcpy(out->method, buf, (size_t)(sp1 - buf));
    const char *target = sp1 + 1;
    const char *sp2 = memchr(target, ' ', (size_t)(line_end - target));
    if (sp2 == NULL || sp2 == target || target[0] != '/') return PK_HTTPD_BAD_REQUEST;
    const char *query = memchr(target, '?', (size_t)(sp2 - target));
    size_t path_len = (size_t)((query ? query : sp2) - target);
    if (path_len >= sizeof(out->path)) return PK_HTTPD_BAD_REQUEST;
    memcpy(out->path, target, path_len);

    const char *line = line_end + 2;
    while (line < header_end) {
        const char *next = memchr(line, '\r', (size_t)(header_end - line) + 1);
        size_t line_len = (size_t)(next - line);
        if (name_matches(line, line_len, "content-length") ||
            name_matches(line, line_len, "authorization")) {
            const char *value = memchr(line, ':', line_len) + 1;
            while (value < next && (*value == ' ' || *value == '\t')) value++;
            size_t value_len = (size_t)(next - value);
            if (line[0] == 'c' || line[0] == 'C') {
                // Nine digits is far past anything this server accepts and
                // cannot overflow a 32-bit size_t.
                char digits[10];
                if (value_len == 0 || value_len >= sizeof(digits)) return PK_HTTPD_BAD_REQUEST;
                memcpy(digits, value, value_len);
                digits[value_len] = '\0';
                char *end = NULL;
                unsigned long parsed = strtoul(digits, &end, 10);
                if (*end != '\0') return PK_HTTPD_BAD_REQUEST;
                out->content_length = (size_t)parsed;
            } else if (value_len < sizeof(out->authorization)) {
                memcpy(out->authorization, value, value_len);
                out->authorization[value_len] = '\0';
            }
        }
        line = next + 2;
    }

    if (len - out->body_offset < out->content_length) return PK_HTTPD_INCOMPLETE;
    return PK_HTTPD_READY;
}

// Length leaks (it has to: strings differ in size), contents do not.
static bool constant_time_equal(const char *a, const char *b)
{
    size_t len_a = strlen(a);
    size_t len_b = strlen(b);
    unsigned char diff = (unsigned char)(len_a != len_b);
    for (size_t i = 0; i < len_a; i++) {
        diff |= (unsigned char)(a[i] ^ b[len_b ? i % len_b : 0]);
    }
    return diff == 0 && len_b != 0;
}

int pk_base64_decode(const char *src, size_t len, unsigned char *dst, size_t cap)
{
    unsigned buffer = 0;
    int bits = 0;
    size_t out = 0;
    for (size_t i = 0; i < len; i++) {
        char c = src[i];
        int value;
        if (c >= 'A' && c <= 'Z') value = c - 'A';
        else if (c >= 'a' && c <= 'z') value = c - 'a' + 26;
        else if (c >= '0' && c <= '9') value = c - '0' + 52;
        else if (c == '+') value = 62;
        else if (c == '/') value = 63;
        else if (c == '=') break;
        else return -1;
        buffer = (buffer << 6) | (unsigned)value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (out >= cap) return -1;
            dst[out++] = (unsigned char)((buffer >> bits) & 0xFF);
        }
    }
    return (int)out;
}

bool pk_httpd_authorized(const pk_httpd_request_t *request, const pk_config_t *config)
{
    const char *auth = request->authorization;
    if (strncmp(auth, "Bearer ", 7) == 0) {
        return config->api_key[0] != '\0' && constant_time_equal(auth + 7, config->api_key);
    }
    if (strncmp(auth, "Basic ", 6) == 0 && config->admin_auth && config->admin_user[0] &&
        config->admin_pass[0]) {
        unsigned char decoded[PK_HTTPD_AUTH_MAX];
        int decoded_len = pk_base64_decode(auth + 6, strlen(auth + 6), decoded, sizeof(decoded) - 1);
        if (decoded_len <= 0) return false;
        decoded[decoded_len] = '\0';
        char expected[PK_NAME_LEN + PK_STR_LEN + 2];
        snprintf(expected, sizeof(expected), "%s:%s", config->admin_user, config->admin_pass);
        return constant_time_equal((const char *)decoded, expected);
    }
    return false;
}

static int hex_value(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

bool pk_httpd_form_value(const char *body, size_t len, const char *key, char *dst, size_t cap)
{
    size_t key_len = strlen(key);
    const char *p = body;
    const char *end = body + len;
    while (p < end) {
        const char *pair_end = memchr(p, '&', (size_t)(end - p));
        if (pair_end == NULL) pair_end = end;
        if ((size_t)(pair_end - p) > key_len && p[key_len] == '=' && memcmp(p, key, key_len) == 0) {
            size_t out = 0;
            for (const char *v = p + key_len + 1; v < pair_end; v++) {
                char c = *v;
                if (c == '+') {
                    c = ' ';
                } else if (c == '%') {
                    if (pair_end - v < 3) return false;
                    int high = hex_value(v[1]);
                    int low = hex_value(v[2]);
                    if (high < 0 || low < 0 || (high == 0 && low == 0)) return false;
                    c = (char)(high * 16 + low);
                    v += 2;
                }
                if (out + 1 >= cap) return false;
                dst[out++] = c;
            }
            dst[out] = '\0';
            return true;
        }
        p = pair_end + 1;
    }
    return false;
}

size_t pk_html_escape(const char *src, char *dst, size_t cap)
{
    size_t out = 0;
    if (cap == 0) return 0;
    for (const char *p = src ? src : ""; *p; p++) {
        const char *entity = NULL;
        switch (*p) {
            case '&': entity = "&amp;"; break;
            case '<': entity = "&lt;"; break;
            case '>': entity = "&gt;"; break;
            case '"': entity = "&quot;"; break;
            case '\'': entity = "&#39;"; break;
            default: break;
        }
        size_t need = entity ? strlen(entity) : 1;
        if (out + need >= cap) break;
        if (entity) memcpy(dst + out, entity, need);
        else dst[out] = *p;
        out += need;
    }
    dst[out] = '\0';
    return out;
}
