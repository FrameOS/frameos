/* The render pull's rules: URL, ETag. See the header. */
#include "fos_render_pull.h"

#include <stdio.h>

bool fos_render_pull_url(char *out, size_t out_len, const char *base, const char *frame,
                         int width, int height, int format, int rotate)
{
    size_t base_len = strlen(base);
    while (base_len > 0 && base[base_len - 1] == '/') base_len--;
    int n = snprintf(out, out_len, "%.*s/api/frames/%s/embedded/render?width=%d&height=%d&format=%d&rotate=%d",
                     (int)base_len, base, frame, width, height, format, rotate);
    if (base_len == 0 || frame[0] == '\0' || n < 0 || (size_t)n >= out_len) {
        out[0] = '\0';
        return false;
    }
    return true;
}

void fos_render_pull_remember(fos_render_pull_shown_t *kept, int source, const char *etag,
                              const uint8_t sha256[FOS_RENDER_PULL_SHA_LEN])
{
    fos_render_pull_forget(kept);
    size_t len = strlen(etag);
    if (len == 0 || len >= sizeof(kept->etag) || source == FOS_RENDER_PULL_NONE) return;
    for (size_t i = 0; i < len; i++) {
        if (etag[i] < 0x20 || etag[i] > 0x7E) return;
    }
    memcpy(kept->etag, etag, len + 1);
    memcpy(kept->sha256, sha256, FOS_RENDER_PULL_SHA_LEN);
    kept->source = (uint8_t)source;
    kept->valid = true;
}

/* ------------------------------------------------- FOSB version 2 */

bool fos_fosb_header(const uint8_t bytes[FOS_FOSB_HEADER_LEN], fos_fosb_header_t *out)
{
    if (memcmp(bytes, "FOSB", 4) != 0 || (bytes[4] != 1 && bytes[4] != 2)) return false;
    out->version = bytes[4];
    out->format = bytes[5];
    out->width = (uint16_t)(bytes[6] | (bytes[7] << 8));
    out->height = (uint16_t)(bytes[8] | (bytes[9] << 8));
    /* Reserved in version 1, whatever it holds; version 2 is deflated. */
    out->flags = out->version == 2 ? (uint16_t)(bytes[10] | (bytes[11] << 8)) : 0;
    return out->version == 1 || (out->flags & ~FOS_FOSB_DELTA) == FOS_FOSB_DEFLATE;
}

void fos_fosb_writer_begin(fos_fosb_writer_t *w, uint8_t *buf, size_t len, bool delta)
{
    memset(w, 0, sizeof(*w));
    w->buf = buf;
    w->len = len;
    w->delta = delta;
}

static uint32_t le32(const uint8_t *p)
{
    return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

bool fos_fosb_writer_feed(fos_fosb_writer_t *w, const uint8_t *data, size_t n)
{
    if (w->failed) return false;
    if (!w->delta) {
        if (n > w->len - w->written) {
            w->failed = true;
            return false;
        }
        memcpy(w->buf + w->written, data, n);
        w->written += n;
        return true;
    }
    while (n > 0) {
        if (w->left == 0) {
            /* A run's header, perhaps over two pieces. */
            size_t take = sizeof(w->head) - w->head_used;
            if (take > n) take = n;
            memcpy(w->head + w->head_used, data, take);
            w->head_used = (uint8_t)(w->head_used + take);
            data += take;
            n -= take;
            if (w->head_used < sizeof(w->head)) return true;
            uint32_t at = le32(w->head);
            uint32_t length = le32(w->head + 4);
            w->head_used = 0;
            if (length == 0 || at > w->len || length > w->len - at) {
                w->failed = true;
                return false;
            }
            w->at = at;
            w->left = length;
            w->runs++;
            continue;
        }
        size_t take = w->left < n ? w->left : n;
        memcpy(w->buf + w->at, data, take);
        w->at += (uint32_t)take;
        w->left -= (uint32_t)take;
        data += take;
        n -= take;
    }
    return true;
}

bool fos_fosb_writer_done(const fos_fosb_writer_t *w)
{
    if (w->failed) return false;
    return w->delta ? w->left == 0 && w->head_used == 0 : w->written == w->len;
}

/* ------------------------------------------------------ the press map */

static bool read_number(const char **p, uint16_t *out)
{
    uint32_t value = 0;
    const char *start = *p;
    while (**p >= '0' && **p <= '9') {
        value = value * 10u + (uint32_t)(**p - '0');
        if (value > 0xFFFFu) return false;
        (*p)++;
    }
    *out = (uint16_t)value;
    return *p != start;
}

int fos_press_map_parse(const char *header, fos_press_rect_t *out, int max)
{
    if (header == NULL) return -1;
    const char *p = header;
    int count = 0;
    while (*p) {
        fos_press_rect_t rect;
        rect.taken = *p != '!';
        if (!rect.taken) p++;
        if (!read_number(&p, &rect.x0) || *p++ != ',' || !read_number(&p, &rect.y0) || *p++ != ',' ||
            !read_number(&p, &rect.x1) || *p++ != ',' || !read_number(&p, &rect.y1)) {
            return -1;
        }
        if (*p == ';') {
            p++;
        } else if (*p != '\0') {
            return -1;
        }
        /* An entry past `max` is dropped, and so is everything after it:
         * the first entry a press lands in answers, so a later one kept
         * past a dropped one could answer for it. */
        if (count == max) break;
        if (rect.x1 > rect.x0 && rect.y1 > rect.y0) out[count++] = rect;
    }
    return count;
}

bool fos_press_map_takes(const fos_press_rect_t *map, int count, int x, int y)
{
    for (int i = 0; i < count; i++) {
        if (x >= map[i].x0 && y >= map[i].y0 && x < map[i].x1 && y < map[i].y1) return map[i].taken;
    }
    return false;
}
