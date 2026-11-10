/*
 * A small picture of each scene for the scene switcher (docs/scene-switcher.md
 * "Pictures"): RGB565, one file per scene on the state partition.
 */
#pragma once

#include <stdint.h>

/* After a render: the canvas (`stride` in pixels; 4, 8, 16 or 32 bits a pixel,
 * as pixie's gray4, gray8, rgb565 and rgbx) as this scene's picture, in memory:
 * the render does not wait for the flash. */
void fos_scene_thumb_capture(const char *scene_id, const void *canvas, int width, int height, int stride,
                             int bits_per_pixel, uint32_t now);
/* Writes the picture taken last, unless the scene has one under an hour old
 * or the partition is too full. Seconds of SPIFFS: when nobody is waiting. */
void fos_scene_thumb_flush(void);
/* The picture cropped to the shape of a tile, malloc'd for the caller to free;
 * NULL for none or no memory to spare for it. */
uint16_t *fos_scene_thumb_load(const char *scene_id, int tile_width, int tile_height, int *width, int *height);
