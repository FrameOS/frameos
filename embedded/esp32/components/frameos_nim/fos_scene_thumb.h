/*
 * A small picture of each scene for the scene switcher (docs/scene-switcher.md
 * "Pictures"): RGB565, one file per scene on the state partition. The Nim
 * runtime makes them from the canvas after a render and reads them back for
 * the tiles.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

/* The longest side a picture may have on this partition, 0 for no pictures. */
int fos_scene_thumb_edge(void);
/* This scene has a picture no older than `max_age` seconds. */
bool fos_scene_thumb_fresh(const char *scene_id, uint32_t now, uint32_t max_age);
/* Writes the picture, unless that would fill the partition past its share. */
bool fos_scene_thumb_save(const char *scene_id, int width, int height, uint32_t taken, const void *pixels);
/* The picture's pixels, malloc'd for the caller to free; NULL for none or no
 * memory to spare for it. */
uint16_t *fos_scene_thumb_load(const char *scene_id, int *width, int *height);
