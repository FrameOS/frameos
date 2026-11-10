#include "fos_scene_thumb.h"

#include <dirent.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "esp_heap_caps.h"
#include "esp_spiffs.h"

#define STATE_DIR "/state"
#define PREFIX "th-"
/* width, height (uint16), the time it was taken (uint32), then the rows. */
#define HEADER_BYTES 8
#define PATH_MAX_BYTES 48
#define MAX_AGE_SECONDS 3600u
#define CLOCK_SET_AFTER 1000000000u
/* A partition this big holds pictures that read well on a large panel. */
#define ROOMY_PARTITION_BYTES (8u * 1024u * 1024u)
#define EDGE_ROOMY 200
#define EDGE_TIGHT 96
/* Scenes and their state come first: pictures stop at this share in use. */
#define USED_PERCENT_MAX 60u
/* What a picture may not take the render's PSRAM below. */
#define LOAD_KEEP_FREE_BYTES (600u * 1024u)
#define PSRAM (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)

static void thumb_path(const char *scene_id, char *out)
{
    uint32_t hash = 2166136261u;
    for (const unsigned char *p = (const unsigned char *)scene_id; *p; p++) {
        hash = (hash ^ *p) * 16777619u;
    }
    snprintf(out, PATH_MAX_BYTES, STATE_DIR "/" PREFIX "%08lx.bin", (unsigned long)hash);
}

/* The open picture and its header; NULL for none. */
static FILE *open_thumb(const char *path, uint16_t size[2], uint32_t *taken)
{
    FILE *file = fopen(path, "rb");
    if (file == NULL) return NULL;
    uint32_t h[2];
    if (fread(h, 1, HEADER_BYTES, file) != HEADER_BYTES || (h[0] & 0xffff) == 0 || (h[0] >> 16) == 0) {
        fclose(file);
        return NULL;
    }
    size[0] = (uint16_t)h[0];
    size[1] = (uint16_t)(h[0] >> 16);
    *taken = h[1];
    return file;
}

/* Out of room: every picture goes, and the ones in use come back as their
 * scenes are shown. Cheaper than knowing which scenes are still installed. */
static void drop_all(void)
{
    DIR *dir = opendir(STATE_DIR);
    if (dir == NULL) return;
    char path[300];
    for (struct dirent *entry = readdir(dir); entry != NULL; entry = readdir(dir)) {
        if (strncmp(entry->d_name, PREFIX, strlen(PREFIX)) == 0) {
            snprintf(path, sizeof(path), STATE_DIR "/%s", entry->d_name);
            unlink(path);
        }
    }
    closedir(dir);
}

static bool has_room(size_t bytes)
{
    size_t total = 0, used = 0;
    return esp_spiffs_info("state", &total, &used) == ESP_OK && used + bytes <= total / 100u * USED_PERCENT_MAX;
}

void fos_scene_thumb_capture(const char *scene_id, const void *canvas, int width, int height, int stride,
                             int bytes_per_pixel, uint32_t now)
{
    size_t total = 0, used = 0;
    if (now < CLOCK_SET_AFTER || esp_spiffs_info("state", &total, &used) != ESP_OK || total == 0) return;
    char path[PATH_MAX_BYTES];
    thumb_path(scene_id, path);
    uint16_t size[2];
    uint32_t taken = 0;
    FILE *file = open_thumb(path, size, &taken);
    if (file != NULL) {
        fclose(file);
        if (taken <= now && now - taken <= MAX_AGE_SECONDS) return;
    }
    int edge = total >= ROOMY_PARTITION_BYTES ? EDGE_ROOMY : EDGE_TIGHT;
    int longest = width > height ? width : height;
    int scale = (longest + edge - 1) / edge;
    int w = width / scale, h = height / scale;
    if (w < 1 || h < 1) return;
    size_t bytes = (size_t)w * (size_t)h * 2u;
    uint16_t *pixels = heap_caps_malloc(bytes, PSRAM);
    if (pixels == NULL) return;
    /* Four samples a cell, so dither and thin lines do not read as noise. */
    int step = scale / 2;
    int quarter = scale / 4;
    const uint8_t *base = canvas;
    uint16_t *out = pixels;
    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
            int r = 0, g = 0, b = 0;
            for (int s = 0; s < 4; s++) {
                int px = x * scale + quarter + (s & 1) * step;
                int py = y * scale + quarter + (s >> 1) * step;
                const uint8_t *p = base + (size_t)(py * stride + px) * (size_t)bytes_per_pixel;
                if (bytes_per_pixel == 2) {
                    uint16_t v = (uint16_t)(p[0] | (p[1] << 8));
                    r += (v >> 8) & 0xF8;
                    g += (v >> 3) & 0xFC;
                    b += (v << 3) & 0xF8;
                } else if (bytes_per_pixel == 1) {
                    r += p[0], g += p[0], b += p[0];
                } else {
                    r += p[0], g += p[1], b += p[2];
                }
            }
            *out++ = (uint16_t)((((r / 4) & 0xF8) << 8) | (((g / 4) & 0xFC) << 3) | ((b / 4) >> 3));
        }
    }
    unlink(path); /* its own old copy is room too */
    if (!has_room(bytes + HEADER_BYTES)) drop_all();
    if (has_room(bytes + HEADER_BYTES) && (file = fopen(path, "wb")) != NULL) {
        uint32_t header[2] = {(uint32_t)w | ((uint32_t)h << 16), now};
        bool ok = fwrite(header, 1, HEADER_BYTES, file) == HEADER_BYTES && fwrite(pixels, 1, bytes, file) == bytes;
        fclose(file);
        if (!ok) unlink(path); /* a torn picture reads as none */
    }
    free(pixels);
}

uint16_t *fos_scene_thumb_load(const char *scene_id, int tile_width, int tile_height, int *width, int *height)
{
    char path[PATH_MAX_BYTES];
    thumb_path(scene_id, path);
    uint16_t size[2];
    uint32_t taken;
    FILE *file = open_thumb(path, size, &taken);
    if (file == NULL) return NULL;
    int w = size[0], h = size[1];
    size_t count = (size_t)w * (size_t)h;
    uint16_t *pixels = NULL;
    if (heap_caps_get_free_size(PSRAM) >= count * 4u + LOAD_KEEP_FREE_BYTES) pixels = heap_caps_malloc(count * 2u, PSRAM);
    if (pixels != NULL && fread(pixels, 2, count, file) != count) {
        free(pixels);
        pixels = NULL;
    }
    fclose(file);
    if (pixels == NULL) return NULL;
    int crop_w = w, crop_h = h;
    if (w * tile_height > h * tile_width) crop_w = h * tile_width / tile_height;
    else crop_h = w * tile_height / tile_width;
    if (crop_w < 1) crop_w = 1;
    if (crop_h < 1) crop_h = 1;
    for (int y = 0; y < crop_h; y++) {
        memmove(pixels + (size_t)y * (size_t)crop_w, pixels + (size_t)((h - crop_h) / 2 + y) * (size_t)w + (size_t)((w - crop_w) / 2),
                (size_t)crop_w * 2u);
    }
    *width = crop_w;
    *height = crop_h;
    return pixels;
}
