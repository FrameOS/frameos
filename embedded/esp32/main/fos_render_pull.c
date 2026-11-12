/* The render pull's rules: URL, ETag, answers. See the header. */
#include "fos_render_pull.h"

#include <stdio.h>
#include <string.h>

fos_render_pull_outcome_t fos_render_pull_outcome(int http_status, int source)
{
    if (http_status == 200) return FOS_RENDER_PULL_PICTURE;
    if (http_status == 304) return FOS_RENDER_PULL_UNCHANGED;
    if (http_status == 403 && source == FOS_RENDER_PULL_CLOUD) return FOS_RENDER_PULL_REFUSED;
    return FOS_RENDER_PULL_FAILED;
}

/* RFC 3986 unreserved characters pass; everything else is %XX. */
static bool append_encoded(char *out, size_t out_len, size_t *used, const char *value)
{
    static const char hex[] = "0123456789ABCDEF";
    for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
        unsigned char c = *p;
        bool plain = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                     c == '-' || c == '_' || c == '.' || c == '~';
        size_t need = plain ? 1 : 3;
        if (*used + need >= out_len) return false;
        if (plain) {
            out[(*used)++] = (char)c;
        } else {
            out[(*used)++] = '%';
            out[(*used)++] = hex[c >> 4];
            out[(*used)++] = hex[c & 0x0F];
        }
    }
    out[*used] = '\0';
    return true;
}

bool fos_render_pull_url(char *out, size_t out_len, const char *base, const char *frame,
                         int width, int height, int format, int rotate, const char *scene)
{
    if (out == NULL || out_len == 0) return false;
    out[0] = '\0';
    if (base == NULL || base[0] == '\0' || frame == NULL || frame[0] == '\0') return false;
    size_t base_len = strlen(base);
    while (base_len > 0 && base[base_len - 1] == '/') base_len--;
    int n = snprintf(out, out_len, "%.*s/api/frames/", (int)base_len, base);
    if (n < 0 || (size_t)n >= out_len) {
        out[0] = '\0';
        return false;
    }
    size_t used = (size_t)n;
    if (!append_encoded(out, out_len, &used, frame)) {
        out[0] = '\0';
        return false;
    }
    n = snprintf(out + used, out_len - used, "/embedded/render?width=%d&height=%d&format=%d&rotate=%d",
                 width, height, format, rotate);
    if (n < 0 || (size_t)n >= out_len - used) {
        out[0] = '\0';
        return false;
    }
    used += (size_t)n;
    if (scene != NULL && scene[0] != '\0') {
        n = snprintf(out + used, out_len - used, "&scene=");
        if (n < 0 || (size_t)n >= out_len - used) {
            out[0] = '\0';
            return false;
        }
        used += (size_t)n;
        if (!append_encoded(out, out_len, &used, scene)) {
            out[0] = '\0';
            return false;
        }
    }
    return true;
}

bool fos_render_pull_etag_keep(const char *header_value, char *out, size_t out_len)
{
    if (out == NULL || out_len == 0) return false;
    out[0] = '\0';
    if (header_value == NULL) return false;
    const char *start = header_value;
    while (*start == ' ' || *start == '\t') start++;
    size_t len = strlen(start);
    while (len > 0 && (start[len - 1] == ' ' || start[len - 1] == '\t')) len--;
    if (len == 0 || len >= out_len) return false;
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)start[i];
        /* A header line's own characters only: no CR/LF smuggled back out. */
        if (c < 0x20 || c > 0x7E) return false;
    }
    memcpy(out, start, len);
    out[len] = '\0';
    return true;
}

void fos_render_pull_remember(fos_render_pull_shown_t *kept, int source, const char *etag,
                              const uint8_t sha256[FOS_RENDER_PULL_SHA_LEN])
{
    if (kept == NULL) return;
    fos_render_pull_forget(kept);
    if (sha256 == NULL || (source != FOS_RENDER_PULL_BACKEND && source != FOS_RENDER_PULL_CLOUD)) return;
    if (!fos_render_pull_etag_keep(etag, kept->etag, sizeof(kept->etag))) return;
    memcpy(kept->sha256, sha256, FOS_RENDER_PULL_SHA_LEN);
    kept->source = (uint8_t)source;
    kept->valid = true;
}

void fos_render_pull_forget(fos_render_pull_shown_t *kept)
{
    if (kept == NULL) return;
    memset(kept, 0, sizeof(*kept));
}

const char *fos_render_pull_if_none_match(const fos_render_pull_shown_t *kept, int source,
                                          const uint8_t *shown_sha, bool overlay_pending)
{
    if (kept == NULL || !kept->valid || kept->etag[0] == '\0') return NULL;
    if (kept->source != source || shown_sha == NULL || overlay_pending) return NULL;
    if (memcmp(kept->sha256, shown_sha, FOS_RENDER_PULL_SHA_LEN) != 0) return NULL;
    return kept->etag;
}

void fos_render_pull_error_code(const char *body, char *out, size_t out_len)
{
    if (out == NULL || out_len == 0) return;
    out[0] = '\0';
    if (body == NULL) return;
    const char *key = strstr(body, "\"error\"");
    if (key == NULL) return;
    const char *p = key + strlen("\"error\"");
    while (*p == ' ' || *p == '\t') p++;
    if (*p != ':') return;
    p++;
    while (*p == ' ' || *p == '\t') p++;
    if (*p != '"') return;
    p++;
    size_t used = 0;
    while (*p && *p != '"') {
        char c = *p++;
        bool ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_';
        if (!ok || used + 1 >= out_len) {
            out[0] = '\0';
            return;
        }
        out[used++] = c;
    }
    if (*p != '"') used = 0;
    out[used] = '\0';
}

bool fos_render_pull_refused_now(int64_t refused_until_s, int64_t now_s)
{
    if (refused_until_s <= 0) return false;
    if (now_s < 1000000000) return false; /* no clock: ask the plane again */
    return now_s < refused_until_s;
}
