/*
 * A small picture of each scene for the scene switcher (docs/scene-switcher.md
 * "Pictures"): RGB565, one file per scene on the state partition.
 */
#pragma once

#include <stdint.h>

/* After a render: the canvas (`stride` in pixels; 1, 2 or 4 bytes a pixel, as
 * pixie's gray8, rgb565 and rgbx) as this scene's picture, unless it has one
 * under an hour old or the partition is too full. */
void fos_scene_thumb_capture(const char *scene_id, const void *canvas, int width, int height, int stride,
                             int bytes_per_pixel, uint32_t now);
/* The picture cropped to the shape of a tile, malloc'd for the caller to free;
 * NULL for none or no memory to spare for it. */
uint16_t *fos_scene_thumb_load(const char *scene_id, int tile_width, int tile_height, int *width, int *height);
