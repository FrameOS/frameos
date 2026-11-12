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
