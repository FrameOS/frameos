/*
 * The rotation the picture is drawn at now (docs/accelerometer.md
 * "Auto-rotate"). The frame's own rotation (`rotate`, its settings) unless
 * auto-rotate is on and the accelerometer says the frame stands another way:
 * then that one, applied live by the render task between renders (the Nim
 * runtime's canvas, the packers, the touch, the overlays all follow), never
 * saved and never reported as the frame's rotation.
 *
 * A board whose canvas is its panel buffer because nothing turns it (a
 * sixteen-grey or colour e-paper unrotated: main.c canvas_is_panel_picture)
 * decides that at boot and cannot turn live: auto-rotate there takes a
 * restart (fos_rotation_canvas_bound), as a rotation does.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

/* The rotation every picture-orientation reader uses: what the runtime last
 * drew at. The frame's own rotation before the first pass. */
uint16_t fos_rotation(void);
/* What the next pass should draw at. */
uint16_t fos_rotation_wanted(void);
/* The accelerometer's upright rotation (fos_imu.c) at every reading, -1
 * lying flat or not known (the last way it stood is kept): followed while
 * auto-rotate is on, and a render asked for whenever the picture is not at
 * the rotation wanted. Any task. */
void fos_rotation_follow(int upright);
/* Render task, once a pass before the render: hands the runtime the wanted
 * rotation if it changed. True when it did. */
bool fos_rotation_apply(void);
/* Boot: the canvas is the panel buffer because nothing turns it. */
void fos_rotation_set_canvas_bound(bool bound);
bool fos_rotation_canvas_bound(void);
