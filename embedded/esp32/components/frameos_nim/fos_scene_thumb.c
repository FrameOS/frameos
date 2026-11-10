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

/* Which scenes have a picture, by the hash in the file's name, read from the
 * directory once. Opening a file that is not there walks the whole partition,
 * 700 ms on a 24 MB one, and the scene switcher asks for every tile. */
#define KNOWN_MAX 64
static uint32_t s_known[KNOWN_MAX];
static size_t s_known_count = 0;
static bool s_known_listed = false;
static bool s_known_overflow = false;

static uint32_t thumb_hash(const char *scene_id)
{
    uint32_t hash = 2166136261u;
    for (const unsigned char *p = (const unsigned char *)scene_id; *p; p++) {
        hash = (hash ^ *p) * 16777619u;
    }
    return hash;
}

static void thumb_path(const char *scene_id, char *out)
{
    snprintf(out, PATH_MAX_BYTES, STATE_DIR "/" PREFIX "%08lx.bin", (unsigned long)thumb_hash(scene_id));
}

static void note_known(uint32_t hash)
{
    for (size_t i = 0; i < s_known_count; i++) {
        if (s_known[i] == hash) return;
    }
    if (s_known_count == KNOWN_MAX) s_known_overflow = true;
    else s_known[s_known_count++] = hash;
}

/* False only when there is certainly no picture. */
static bool maybe_has_picture(uint32_t hash)
{
    if (!s_known_listed) {
        s_known_listed = true;
        DIR *dir = opendir(STATE_DIR);
        if (dir != NULL) {
            for (struct dirent *entry = readdir(dir); entry != NULL; entry = readdir(dir)) {
                if (strncmp(entry->d_name, PREFIX, strlen(PREFIX)) == 0) {
                    note_known((uint32_t)strtoul(entry->d_name + strlen(PREFIX), NULL, 16));
                }
            }
            closedir(dir);
        }
    }
    if (s_known_overflow) return true;
    for (size_t i = 0; i < s_known_count; i++) {
        if (s_known[i] == hash) return true;
    }
    return false;
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
    s_known_count = 0;
    s_known_overflow = false;
}

/* A picture taken and not on flash yet: the newest, one at a time. Writing it
 * is seconds of SPIFFS, on the task a tap and the picture are waiting for. */
static struct {
    char path[PATH_MAX_BYTES];
    uint32_t hash;
    uint16_t *pixels;
    size_t bytes;
    int w, h;
    uint32_t now;
} s_pending;

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
    free(s_pending.pixels);
    thumb_path(scene_id, s_pending.path);
    s_pending.hash = thumb_hash(scene_id);
    s_pending.pixels = pixels;
    s_pending.bytes = bytes;
    s_pending.w = w;
    s_pending.h = h;
    s_pending.now = now;
}

void fos_scene_thumb_flush(void)
{
    if (s_pending.pixels == NULL) return;
    uint16_t size[2];
    uint32_t taken = 0;
    uint32_t now = s_pending.now;
    FILE *file = open_thumb(s_pending.path, size, &taken);
    if (file != NULL) fclose(file);
    if (file == NULL || taken > now || now - taken > MAX_AGE_SECONDS) {
        unlink(s_pending.path); /* its own old copy is room too */
        if (!has_room(s_pending.bytes + HEADER_BYTES)) drop_all();
        if (has_room(s_pending.bytes + HEADER_BYTES) && (file = fopen(s_pending.path, "wb")) != NULL) {
            uint32_t header[2] = {(uint32_t)s_pending.w | ((uint32_t)s_pending.h << 16), now};
            bool ok = fwrite(header, 1, HEADER_BYTES, file) == HEADER_BYTES &&
                      fwrite(s_pending.pixels, 1, s_pending.bytes, file) == s_pending.bytes;
            fclose(file);
            if (!ok) unlink(s_pending.path); /* a torn picture reads as none */
            else note_known(s_pending.hash);
        }
    }
    free(s_pending.pixels);
    s_pending.pixels = NULL;
}

uint16_t *fos_scene_thumb_load(const char *scene_id, int tile_width, int tile_height, int *width, int *height)
{
    if (!maybe_has_picture(thumb_hash(scene_id))) return NULL;
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
