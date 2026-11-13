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

/* X-FrameOS-Next-Render: when the scene the plane drew wants its next picture,
 * in whole seconds (docs/server-rendering.md "When the next picture is due").
 * The planes clamp it; here only digits count, held to 1 s .. 7 days. 0: no
 * header, or nothing usable in it (the frame's interval then). */
#define FOS_RENDER_PULL_NEXT_RENDER_MAX_S (7u * 86400u)
static inline uint32_t fos_render_pull_next_render_seconds(const char *value)
{
    if (value == NULL) return 0;
    while (*value == ' ') value++;
    uint32_t seconds = 0;
    const char *p = value;
    for (; *p >= '0' && *p <= '9'; p++) {
        if (seconds > FOS_RENDER_PULL_NEXT_RENDER_MAX_S) break;
        seconds = seconds * 10u + (uint32_t)(*p - '0');
    }
    while (*p == ' ') p++;
    if (p == value || (*p != '\0' && (*p < '0' || *p > '9'))) return 0;
    if (seconds > FOS_RENDER_PULL_NEXT_RENDER_MAX_S) return FOS_RENDER_PULL_NEXT_RENDER_MAX_S;
    return seconds;
}

/* ------------------------------------------------- FOSB version 2 */

/* docs/server-rendering.md "Only what changed". A pull that says
 * `X-FrameOS-Fosb: 2` may be answered in FOSB version 2: the version 1
 * header with version 2 and a flags word in the reserved u16, the packed
 * picture's sha256, then the payload, raw deflate when FOS_FOSB_DEFLATE is
 * set. The payload is the picture whole, or with FOS_FOSB_DELTA the runs
 * that changed since the picture the pull named in If-None-Match: each a
 * u32le offset into the packed picture, a u32le length and that many bytes.
 * A plane that does not know version 2 answers version 1 as before. */
#define FOS_FOSB_HEADER_LEN 12
#define FOS_FOSB_V2_HEADER_LEN 44
#define FOS_FOSB_DELTA 1u
#define FOS_FOSB_DEFLATE 2u
#define FOS_FOSB_VERSION_HEADER "X-FrameOS-Fosb"

typedef struct {
    uint8_t version; /* 1 or 2 */
    uint8_t format;
    uint16_t width, height;
    uint16_t flags; /* version 2: FOS_FOSB_DELTA | FOS_FOSB_DEFLATE; 0 in version 1 */
} fos_fosb_header_t;

/* The first FOS_FOSB_HEADER_LEN bytes of an answer. False when they are not
 * a FOSB header of a version this reads, or a flag it does not know is set. */
bool fos_fosb_header(const uint8_t bytes[FOS_FOSB_HEADER_LEN], fos_fosb_header_t *out);

/* What a version 2 payload, inflated, writes into the panel buffer, fed in
 * pieces as they come: the picture from its first byte, or the runs over
 * the picture the buffer holds. A run past the buffer, or a payload that
 * stops inside a run or (whole) short of the picture, is malformed. */
typedef struct {
    uint8_t *buf;
    size_t len;
    bool delta;
    bool failed;
    size_t written;    /* whole: bytes written so far */
    uint8_t head[8];   /* delta: the run header being read */
    uint8_t head_used;
    uint32_t at;       /* delta: where the run being read writes next */
    uint32_t left;     /* delta: its bytes still to come */
    uint32_t runs;     /* delta: runs read, for the log */
} fos_fosb_writer_t;

void fos_fosb_writer_begin(fos_fosb_writer_t *w, uint8_t *buf, size_t len, bool delta);
/* False once the payload is malformed (and from then on). */
bool fos_fosb_writer_feed(fos_fosb_writer_t *w, const uint8_t *data, size_t n);
/* Whether the payload ended where a payload may end. */
bool fos_fosb_writer_done(const fos_fosb_writer_t *w);

/* ------------------------------------------------------ the press map */

/* docs/server-rendering.md "The click": where a press on the picture does
 * something, as the plane said it with the picture (X-FrameOS-Press):
 * `x0,y0,x1,y1` in the panel's pixels, `;` between entries, a leading `!`
 * on one where a press is not taken. The first entry a press lands in
 * answers; a press in none is not taken. */
#define FOS_PRESS_MAP_MAX 64
#define FOS_PRESS_HEADER "X-FrameOS-Press"

typedef struct {
    uint16_t x0, y0, x1, y1; /* x1, y1 past the last pixel */
    bool taken;
} fos_press_rect_t;

/* The entries of `header` into `out` (at most `max`, the rest dropped: a
 * press there is not clicked at). -1 when it is not a press map. */
int fos_press_map_parse(const char *header, fos_press_rect_t *out, int max);

/* Whether a press at panel pixel (x, y) is taken. */
bool fos_press_map_takes(const fos_press_rect_t *map, int count, int x, int y);
