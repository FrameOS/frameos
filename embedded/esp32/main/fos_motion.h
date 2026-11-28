/*
 * What an accelerometer's readings mean (docs/accelerometer.md): which way
 * down is along the picture's axes, and the gestures the contract names —
 * `tilt`, `flick`, `shake` and `orientation` (docs/events-contract.json
 * `motion`, whose numbers fos_events_gen.h carries). Auto-rotate reads the
 * same position.
 *
 * Pure (main/tests/test_fos_motion.c): readings in, events out. fos_imu.c
 * reads the chip 50 times a second and feeds them here.
 *
 * Frames of reference. A reading is the panel's: x towards the unrotated
 * panel's right, y towards its bottom, z out of the glass, in thousandths of
 * g, as the chip reports a force (lying face up it reads z = +1000: the
 * table pushing up). What this module keeps is gravity, the opposite: lying
 * face up z = -1000, standing on the panel's bottom edge y = +1000. The
 * picture's frame is the panel's turned by the rotation the picture is drawn
 * at (fos_touch_scene_point's turn): what a scene hears.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef enum {
    FOS_MOTION_NONE = 0,
    FOS_MOTION_TILT,
    FOS_MOTION_FLICK,
    FOS_MOTION_SHAKE,
    FOS_MOTION_ORIENTATION,
} fos_motion_kind_t;

/* motion.positions, in the contract's order. */
typedef enum {
    FOS_POSITION_UNKNOWN = -1,
    FOS_POSITION_UPRIGHT = 0,
    FOS_POSITION_TURNED_LEFT,
    FOS_POSITION_TURNED_RIGHT,
    FOS_POSITION_UPSIDE_DOWN,
    FOS_POSITION_FACE_UP,
    FOS_POSITION_FACE_DOWN,
} fos_position_t;

typedef struct {
    fos_motion_kind_t kind;
    const char *direction; /* tilt, flick: "left", "right", "up", "down" */
    int x_mg, y_mg;        /* tilt, flick: the lean, the picture's axes */
    int strength_mg;       /* shake: the hardest jolt */
    fos_position_t position; /* orientation */
    int rotate;            /* orientation: the rotation that stands the picture upright, -1 lying flat */
} fos_motion_event_t;

#define FOS_MOTION_EVENTS_MAX 2

typedef struct {
    bool primed;
    int g[3];      /* gravity, smoothed (about 60 ms), the panel's axes */
    int rest[3];   /* how the frame rested last: tilts are from here */
    int anchor[3]; /* where it was when it last stopped moving */
    uint32_t still_since;
    bool armed;    /* rested since the last gesture: the next tip counts */
    /* A tip under way: since when, which way, the deepest of it. */
    bool tipping;
    uint32_t tip_at;
    int tip_dir; /* 0 left, 1 right, 2 up, 3 down */
    int tip_x, tip_y;
    /* Jolts towards a shake. */
    uint32_t jolt_at[8];
    int jolts;
    int jolt_peak;
    int jolt_dev[3]; /* the last jolt's way */
    bool jolt_high;
    bool shake_armed;
    /* The position it settled in, and what it reads now. */
    fos_position_t position;
    int upright_rotate; /* the rotation that stands the picture upright, -1 unknown or flat */
} fos_motion_t;

void fos_motion_init(fos_motion_t *m);

/* One reading (the panel's axes, as the chip reports a force) at `now_ms`.
 * `rotate` is the rotation the picture is drawn at now, `base_rotate` the
 * frame's own (its settings), which positions are named from. Writes up to
 * FOS_MOTION_EVENTS_MAX events and returns how many. */
int fos_motion_step(fos_motion_t *m, const int reading_mg[3], uint32_t now_ms, int rotate, int base_rotate,
                    fos_motion_event_t *out);

/* Gravity along the picture's axes at `rotate`, in thousandths of g: what
 * frameos.accelerometer() answers. False before the first reading. */
bool fos_motion_gravity(const fos_motion_t *m, int rotate, int out_mg[3]);

/* The rotation that shows the picture upright as the frame stands now, once
 * it has rested so for motion.restMs; -1 lying flat or not known yet: what
 * auto-rotate follows. */
int fos_motion_upright_rotate(const fos_motion_t *m);

/* A vector along the panel's axes turned into the picture's at `rotate`. */
void fos_motion_to_picture(int rotate, int px, int py, int *x, int *y);

const char *fos_motion_position_name(fos_position_t position);

/* The event's JSON payload, as the contract has it. */
int fos_motion_payload(const fos_motion_event_t *e, char *buf, int len);
const char *fos_motion_event_name(fos_motion_kind_t kind);

/* A board's axes: which of the chip's axes (and which way) is the panel's x,
 * y and z. `spec` is "x=-y,y=x,z=z" (each the panel's axis = the chip's,
 * signed); false for anything else. */
typedef struct {
    int8_t from[3]; /* chip axis 0..2 for the panel's x, y, z */
    int8_t sign[3]; /* +1 or -1 */
} fos_motion_axes_t;

bool fos_motion_parse_axes(const char *spec, fos_motion_axes_t *out);
void fos_motion_apply_axes(const fos_motion_axes_t *axes, const int chip_mg[3], int panel_mg[3]);
