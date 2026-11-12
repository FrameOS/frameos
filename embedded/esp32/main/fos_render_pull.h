/*
 * The render pull of a frame rendered on its control plane
 * (docs/server-rendering.md "The render pull"): the URL it asks, the ETag it
 * keeps across a deep sleep, and what an answer means. IDF-free and
 * host-tested (tests/test_fos_render_pull.c); fos_client.c does the HTTP.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

/* Where a pull goes. An ETag names one plane's picture: kept per source. */
enum {
    FOS_RENDER_PULL_NONE = 0,
    FOS_RENDER_PULL_BACKEND = 1,
    FOS_RENDER_PULL_CLOUD = 2,
};

typedef enum {
    FOS_RENDER_PULL_PICTURE,   /* 200: a FOSB bitmap follows */
    FOS_RENDER_PULL_UNCHANGED, /* 304: the panel shows it already */
    FOS_RENDER_PULL_REFUSED,   /* 403 from the cloud: it does not render for this frame */
    FOS_RENDER_PULL_FAILED,    /* anything else, the connect included */
} fos_render_pull_outcome_t;

/* An answer's status, read for the source that gave it. Only the cloud
 * refuses (`not_server_rendered`, a plan over its cloud-rendered frames); a
 * backend's 403 is as much a failure as its 500. */
static inline fos_render_pull_outcome_t fos_render_pull_outcome(int http_status, int source)
{
    if (http_status == 200) return FOS_RENDER_PULL_PICTURE;
    if (http_status == 304) return FOS_RENDER_PULL_UNCHANGED;
    if (http_status == 403 && source == FOS_RENDER_PULL_CLOUD) return FOS_RENDER_PULL_REFUSED;
    return FOS_RENDER_PULL_FAILED;
}

/* `{base}/api/frames/{frame}/embedded/render?width=W&height=H&format=F&rotate=R`.
 * Trailing slashes of `base` are dropped; `frame` is a backend's frame number
 * or the cloud's uuid, neither of which needs escaping. No `scene`: a frame
 * in remote mode runs no scene choice of its own. False (and `out` empty)
 * when it does not fit `out`, or there is no base or frame. */
bool fos_render_pull_url(char *out, size_t out_len, const char *base, const char *frame,
                         int width, int height, int format, int rotate);

#define FOS_RENDER_PULL_ETAG_LEN 72
#define FOS_RENDER_PULL_SHA_LEN 32

/* The picture the last pull put on the panel. Lives in RTC memory, so a
 * deep-sleeping frame wakes knowing what its panel shows. */
typedef struct {
    char etag[FOS_RENDER_PULL_ETAG_LEN];
    uint8_t sha256[FOS_RENDER_PULL_SHA_LEN]; /* the packed picture that ETag delivered */
    uint8_t source;                          /* FOS_RENDER_PULL_BACKEND / _CLOUD */
    bool valid;
} fos_render_pull_shown_t;

/* Keep `etag` for the picture whose packed bytes hash to `sha256`, from
 * `source`. Only an ETag that may go back in If-None-Match as it came:
 * printable ASCII, no CR/LF smuggled back out, short enough to keep;
 * anything else (or no source) leaves nothing kept. */
void fos_render_pull_remember(fos_render_pull_shown_t *kept, int source, const char *etag,
                              const uint8_t sha256[FOS_RENDER_PULL_SHA_LEN]);

static inline void fos_render_pull_forget(fos_render_pull_shown_t *kept)
{
    memset(kept, 0, sizeof(*kept));
}

/* The ETag to send, or NULL. Only while the panel still shows the picture it
 * came with (`shown_sha`: the hash of what the panel shows, NULL when that is
 * not known), from the same plane, and nothing is about to be drawn over it
 * (`overlay_pending`: a 304 leaves no picture to draw it on). A hash that
 * matches is all it takes, whoever drew it: the ETag names those bytes. */
static inline const char *fos_render_pull_if_none_match(const fos_render_pull_shown_t *kept, int source,
                                                        const uint8_t *shown_sha, bool overlay_pending)
{
    if (!kept->valid || kept->source != source || shown_sha == NULL || overlay_pending) return NULL;
    return memcmp(kept->sha256, shown_sha, FOS_RENDER_PULL_SHA_LEN) == 0 ? kept->etag : NULL;
}

/* The plane refused this frame (FOS_RENDER_PULL_REFUSED): a board with its
 * own runtime renders itself until `refused_until` (wall-clock seconds) and
 * then asks again. A clock that is not set yet (before 2001) asks at once. */
#define FOS_RENDER_PULL_REFUSED_RETRY_S 3600
static inline bool fos_render_pull_refused_now(int64_t refused_until_s, int64_t now_s)
{
    return refused_until_s > 0 && now_s >= 1000000000 && now_s < refused_until_s;
}
