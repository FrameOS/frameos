#include "fos_motion.h"

#include <stdio.h>
#include <string.h>

#include "fos_events_gen.h"

/* A frame that moves less than this between readings (smoothed) is still. */
#define STILL_MG 50
/* A rest this far from the last one is taken as the new rest only after this
 * many restMs of stillness: a tilt held is a tilt, not a new way of holding. */
#define NEW_REST_FACTOR 3

static const char *const k_directions[4] = {"left", "right", "up", "down"};
static const char *const k_positions[6] = {
    FOS_MOTION_POSITION_UPRIGHT,     FOS_MOTION_POSITION_TURNED_LEFT, FOS_MOTION_POSITION_TURNED_RIGHT,
    FOS_MOTION_POSITION_UPSIDE_DOWN, FOS_MOTION_POSITION_FACE_UP,     FOS_MOTION_POSITION_FACE_DOWN,
};

static int iabs(int v) { return v < 0 ? -v : v; }

static int isqrt(long long v)
{
    if (v <= 0) return 0;
    long long r = 0, bit = 1LL << 40;
    while (bit > v) bit >>= 2;
    while (bit) {
        if (v >= r + bit) {
            v -= r + bit;
            r = (r >> 1) + bit;
        } else {
            r >>= 1;
        }
        bit >>= 2;
    }
    return (int)r;
}

static int magnitude(const int v[3])
{
    return isqrt((long long)v[0] * v[0] + (long long)v[1] * v[1] + (long long)v[2] * v[2]);
}

static int distance(const int a[3], const int b[3])
{
    int d[3] = {a[0] - b[0], a[1] - b[1], a[2] - b[2]};
    return magnitude(d);
}

static int normal_rotate(int rotate)
{
    rotate = ((rotate % 360) + 360) % 360;
    return rotate == 90 || rotate == 180 || rotate == 270 ? rotate : 0;
}

void fos_motion_to_picture(int rotate, int px, int py, int *x, int *y)
{
    /* fos_touch_scene_point's turn, for a vector: at 90 the scene's x is the
     * panel's y and its y the panel's x the other way. */
    switch (normal_rotate(rotate)) {
    case 90: *x = py; *y = -px; break;
    case 180: *x = -px; *y = -py; break;
    case 270: *x = -py; *y = px; break;
    default: *x = px; *y = py; break;
    }
}

void fos_motion_init(fos_motion_t *m)
{
    memset(m, 0, sizeof(*m));
    m->position = FOS_POSITION_UNKNOWN;
    m->upright_rotate = -1;
    m->shake_armed = true;
}

/* Which way the picture stands upright, by which of the panel's edges points
 * down: its bottom 0, its left 90, its top 180, its right 270 (the inverse of
 * fos_motion_to_picture: the picture's down along the panel). -1 lying flat,
 * -2 between the two (keep what was). */
static int standing_rotate(const int g[3])
{
    int mag = magnitude(g);
    if (mag < 300) return -2; /* falling, or a reading that makes no sense */
    int az = iabs(g[2]);
    if (az * 10 > mag * 8) return -1;
    if (az * 10 > mag * 6) return -2;
    int ax = iabs(g[0]), ay = iabs(g[1]);
    if (ay * 2 > ax * 3) return g[1] > 0 ? 0 : 180;
    if (ax * 2 > ay * 3) return g[0] < 0 ? 90 : 270;
    return -2;
}

static fos_position_t position_of(const int g[3], int base_rotate, int standing)
{
    if (standing == -1) return g[2] < 0 ? FOS_POSITION_FACE_UP : FOS_POSITION_FACE_DOWN;
    int x, y;
    fos_motion_to_picture(base_rotate, g[0], g[1], &x, &y);
    if (iabs(y) >= iabs(x)) return y > 0 ? FOS_POSITION_UPRIGHT : FOS_POSITION_UPSIDE_DOWN;
    return x < 0 ? FOS_POSITION_TURNED_LEFT : FOS_POSITION_TURNED_RIGHT;
}

static void emit_lean(fos_motion_event_t *e, fos_motion_kind_t kind, int dir, int x, int y)
{
    memset(e, 0, sizeof(*e));
    e->kind = kind;
    e->direction = k_directions[dir];
    e->x_mg = x;
    e->y_mg = y;
    e->rotate = -1;
}

int fos_motion_step(fos_motion_t *m, const int reading_mg[3], uint32_t now_ms, int rotate, int base_rotate,
                    fos_motion_event_t *out)
{
    int n = 0;
    int grav[3] = {-reading_mg[0], -reading_mg[1], -reading_mg[2]};
    if (!m->primed) {
        memcpy(m->g, grav, sizeof(grav));
        memcpy(m->rest, grav, sizeof(grav));
        memcpy(m->anchor, grav, sizeof(grav));
        m->still_since = now_ms;
        m->primed = true;
        return 0;
    }
    for (int i = 0; i < 3; i++) m->g[i] += (grav[i] - m->g[i]) / 3;

    /* Jolts: the reading away from gravity, which is what moving it adds. */
    int dev[3] = {grav[0] - m->g[0], grav[1] - m->g[1], grav[2] - m->g[2]};
    int jolt = magnitude(dev);
    if (jolt > FOS_MOTION_SHAKE_MG) {
        /* A new jolt: the first, or one the other way (a shake goes back and
         * forth faster than the smoothing lets the reading come down). */
        long long dot = (long long)dev[0] * m->jolt_dev[0] + (long long)dev[1] * m->jolt_dev[1] +
                        (long long)dev[2] * m->jolt_dev[2];
        if (!m->jolt_high || dot < 0) {
            m->jolt_high = true;
            memcpy(m->jolt_dev, dev, sizeof(dev));
            if (m->jolts < (int)(sizeof(m->jolt_at) / sizeof(m->jolt_at[0]))) m->jolt_at[m->jolts++] = now_ms;
        }
        if (jolt > m->jolt_peak) m->jolt_peak = jolt;
    } else if (jolt < FOS_MOTION_SHAKE_MG / 2) {
        m->jolt_high = false;
    }
    int kept = 0;
    for (int i = 0; i < m->jolts; i++) {
        if (now_ms - m->jolt_at[i] <= FOS_MOTION_SHAKE_MS) m->jolt_at[kept++] = m->jolt_at[i];
    }
    m->jolts = kept;
    if (m->jolts >= 2) m->tipping = false; /* a shake is no tilt */
    if (m->jolts >= FOS_MOTION_SHAKE_COUNT && m->shake_armed) {
        fos_motion_event_t *e = &out[n++];
        memset(e, 0, sizeof(*e));
        e->kind = FOS_MOTION_SHAKE;
        e->strength_mg = m->jolt_peak;
        e->rotate = -1;
        m->shake_armed = false;
        m->armed = false;
        m->jolts = 0;
    }

    /* Still: barely moving since it last stopped. */
    if (distance(m->g, m->anchor) > STILL_MG || jolt > 2 * STILL_MG) {
        memcpy(m->anchor, m->g, sizeof(m->g));
        m->still_since = now_ms;
    }
    uint32_t still_ms = now_ms - m->still_since;

    int d[3] = {m->g[0] - m->rest[0], m->g[1] - m->rest[1], m->g[2] - m->rest[2]};
    int lean = magnitude(d);
    if (still_ms >= FOS_MOTION_REST_MS && !m->tipping) {
        m->shake_armed = true;
        m->jolt_peak = 0;
        if (lean < FOS_MOTION_REST_MG || still_ms >= NEW_REST_FACTOR * FOS_MOTION_REST_MS) {
            memcpy(m->rest, m->g, sizeof(m->g));
            m->armed = true;
            lean = 0;
            d[0] = d[1] = d[2] = 0;
        }
    }

    /* A tip, from the rest: a flick if it comes straight back, a tilt if it
     * stays. Named along the picture as it is drawn now. */
    int dx, dy;
    fos_motion_to_picture(rotate, d[0], d[1], &dx, &dy);
    if (m->tipping) {
        int along = m->tip_dir < 2 ? dx : dy, peak = m->tip_dir < 2 ? m->tip_x : m->tip_y;
        if (iabs(along) > iabs(peak)) {
            m->tip_x = dx;
            m->tip_y = dy;
        }
        uint32_t held = now_ms - m->tip_at;
        if (lean < FOS_MOTION_TILT_MG / 2 && held < FOS_MOTION_TILT_HOLD_MS) {
            if (n < FOS_MOTION_EVENTS_MAX) emit_lean(&out[n++], FOS_MOTION_FLICK, m->tip_dir, m->tip_x, m->tip_y);
            m->tipping = false;
        } else if (held >= FOS_MOTION_TILT_HOLD_MS) {
            if (lean >= FOS_MOTION_TILT_MG / 2 && n < FOS_MOTION_EVENTS_MAX) {
                emit_lean(&out[n++], FOS_MOTION_TILT, m->tip_dir, dx, dy);
            }
            m->tipping = false;
        }
    } else if (m->armed && lean > FOS_MOTION_TILT_MG) {
        int ax = iabs(dx), ay = iabs(dy);
        if ((ax > ay ? ax : ay) >= FOS_MOTION_TILT_MG / 3) {
            m->tipping = true;
            m->armed = false;
            m->tip_at = now_ms;
            m->tip_dir = ax > ay ? (dx < 0 ? 0 : 1) : (dy < 0 ? 2 : 3);
            m->tip_x = dx;
            m->tip_y = dy;
        }
    }

    /* Where it stands, once it has stood so a while. */
    if (still_ms >= FOS_MOTION_REST_MS) {
        int standing = standing_rotate(m->g);
        if (standing != -2) {
            m->upright_rotate = standing;
            fos_position_t position = position_of(m->g, base_rotate, standing);
            if (position != m->position) {
                if (m->position != FOS_POSITION_UNKNOWN && n < FOS_MOTION_EVENTS_MAX) {
                    fos_motion_event_t *e = &out[n++];
                    memset(e, 0, sizeof(*e));
                    e->kind = FOS_MOTION_ORIENTATION;
                    e->position = position;
                    e->rotate = standing;
                }
                m->position = position;
            }
        }
    }
    return n;
}

bool fos_motion_gravity(const fos_motion_t *m, int rotate, int out_mg[3])
{
    if (!m->primed) return false;
    fos_motion_to_picture(rotate, m->g[0], m->g[1], &out_mg[0], &out_mg[1]);
    out_mg[2] = m->g[2];
    return true;
}

int fos_motion_upright_rotate(const fos_motion_t *m)
{
    return m->primed ? m->upright_rotate : -1;
}

const char *fos_motion_position_name(fos_position_t position)
{
    return position >= 0 && position < 6 ? k_positions[position] : "";
}

const char *fos_motion_event_name(fos_motion_kind_t kind)
{
    switch (kind) {
    case FOS_MOTION_TILT: return FOS_EVENT_TILT;
    case FOS_MOTION_FLICK: return FOS_EVENT_FLICK;
    case FOS_MOTION_SHAKE: return FOS_EVENT_SHAKE;
    case FOS_MOTION_ORIENTATION: return FOS_EVENT_ORIENTATION;
    default: return "";
    }
}

/* Thousandths as a JSON number: -0.412, 1.000. */
static int put_g(char *buf, int len, int mg)
{
    int a = iabs(mg);
    return snprintf(buf, len > 0 ? (size_t)len : 0, "%s%d.%03d", mg < 0 ? "-" : "", a / 1000, a % 1000);
}

int fos_motion_payload(const fos_motion_event_t *e, char *buf, int len)
{
    int n = 0;
#define ROOM (n < len ? len - n : 0)
    switch (e->kind) {
    case FOS_MOTION_TILT:
    case FOS_MOTION_FLICK:
        n += snprintf(buf + n, ROOM, "{\"direction\":\"%s\",\"x\":", e->direction);
        n += put_g(buf + (n < len ? n : len), ROOM, e->x_mg);
        n += snprintf(buf + (n < len ? n : len), ROOM, ",\"y\":");
        n += put_g(buf + (n < len ? n : len), ROOM, e->y_mg);
        n += snprintf(buf + (n < len ? n : len), ROOM, "}");
        break;
    case FOS_MOTION_SHAKE:
        n += snprintf(buf + n, ROOM, "{\"strength\":");
        n += put_g(buf + (n < len ? n : len), ROOM, e->strength_mg);
        n += snprintf(buf + (n < len ? n : len), ROOM, "}");
        break;
    case FOS_MOTION_ORIENTATION:
        if (e->rotate >= 0) {
            n += snprintf(buf + n, ROOM, "{\"position\":\"%s\",\"rotate\":%d}", fos_motion_position_name(e->position),
                          e->rotate);
        } else {
            n += snprintf(buf + n, ROOM, "{\"position\":\"%s\"}", fos_motion_position_name(e->position));
        }
        break;
    default: n += snprintf(buf + n, ROOM, "{}"); break;
    }
#undef ROOM
    return n;
}

bool fos_motion_parse_axes(const char *spec, fos_motion_axes_t *out)
{
    /* "x=-y,y=x,z=z": the panel's x, y and z, each once, in that order. */
    if (!spec || !out) return false;
    const char *p = spec;
    for (int axis = 0; axis < 3; axis++) {
        while (*p == ' ') p++;
        if (*p != "xyz"[axis] || p[1] != '=') return false;
        p += 2;
        int sign = 1;
        if (*p == '-' || *p == '+') {
            sign = *p == '-' ? -1 : 1;
            p++;
        }
        if (*p < 'x' || *p > 'z') return false;
        out->from[axis] = (int8_t)(*p - 'x');
        out->sign[axis] = (int8_t)sign;
        p++;
        while (*p == ' ') p++;
        if (axis < 2) {
            if (*p != ',') return false;
            p++;
        }
    }
    if (*p) return false;
    if (out->from[0] == out->from[1] || out->from[0] == out->from[2] || out->from[1] == out->from[2]) return false;
    return true;
}

void fos_motion_apply_axes(const fos_motion_axes_t *axes, const int chip_mg[3], int panel_mg[3])
{
    for (int i = 0; i < 3; i++) panel_mg[i] = axes->sign[i] * chip_mg[axes->from[i]];
}
