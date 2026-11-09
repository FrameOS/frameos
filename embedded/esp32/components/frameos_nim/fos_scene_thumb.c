#include "fos_scene_thumb.h"

#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_spiffs.h"

static const char *TAG = "fos_scene_thumb";

#define STATE_DIR "/state"
#define PREFIX "th-"
/* width, height (uint16), the time it was taken (uint32), then the rows. */
#define HEADER_BYTES 8
/* A partition this big holds pictures that read well on a large panel. */
#define ROOMY_PARTITION_BYTES (8u * 1024u * 1024u)
#define EDGE_ROOMY 200
#define EDGE_TIGHT 96
/* Scenes and their state come first: pictures stop at this share in use. */
#define USED_PERCENT_MAX 60u
/* What a picture may not take the render's PSRAM below. */
#define LOAD_KEEP_FREE_BYTES (600u * 1024u)

static void thumb_path(const char *scene_id, char *out, size_t cap)
{
    uint32_t hash = 2166136261u;
    for (const unsigned char *p = (const unsigned char *)scene_id; *p; p++) {
        hash = (hash ^ *p) * 16777619u;
    }
    snprintf(out, cap, STATE_DIR "/" PREFIX "%08lx.bin", (unsigned long)hash);
}

int fos_scene_thumb_edge(void)
{
    size_t total = 0, used = 0;
    if (esp_spiffs_info("state", &total, &used) != ESP_OK || total == 0) return 0;
    return total >= ROOMY_PARTITION_BYTES ? EDGE_ROOMY : EDGE_TIGHT;
}

static bool read_header(FILE *file, uint16_t *width, uint16_t *height, uint32_t *taken)
{
    uint8_t h[HEADER_BYTES];
    if (fread(h, 1, sizeof(h), file) != sizeof(h)) return false;
    *width = (uint16_t)(h[0] | (h[1] << 8));
    *height = (uint16_t)(h[2] | (h[3] << 8));
    *taken = (uint32_t)h[4] | ((uint32_t)h[5] << 8) | ((uint32_t)h[6] << 16) | ((uint32_t)h[7] << 24);
    return *width > 0 && *height > 0;
}

bool fos_scene_thumb_fresh(const char *scene_id, uint32_t now, uint32_t max_age)
{
    char path[48];
    thumb_path(scene_id, path, sizeof(path));
    FILE *file = fopen(path, "rb");
    if (file == NULL) return false;
    uint16_t width, height;
    uint32_t taken = 0;
    bool ok = read_header(file, &width, &height, &taken);
    fclose(file);
    return ok && taken <= now && now - taken <= max_age;
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
    if (esp_spiffs_info("state", &total, &used) != ESP_OK || total == 0) return false;
    return used + bytes <= total / 100u * USED_PERCENT_MAX;
}

bool fos_scene_thumb_save(const char *scene_id, int width, int height, uint32_t taken, const void *pixels)
{
    if (width <= 0 || height <= 0 || width > UINT16_MAX || height > UINT16_MAX || pixels == NULL) return false;
    size_t bytes = HEADER_BYTES + (size_t)width * (size_t)height * 2u;
    char path[48];
    thumb_path(scene_id, path, sizeof(path));
    unlink(path); /* its own old copy is room too */
    if (!has_room(bytes)) {
        drop_all();
        if (!has_room(bytes)) {
            ESP_LOGW(TAG, "no room for a %u byte scene picture", (unsigned)bytes);
            return false;
        }
    }
    FILE *file = fopen(path, "wb");
    if (file == NULL) return false;
    const uint8_t h[HEADER_BYTES] = {
        (uint8_t)width, (uint8_t)(width >> 8), (uint8_t)height, (uint8_t)(height >> 8),
        (uint8_t)taken, (uint8_t)(taken >> 8), (uint8_t)(taken >> 16), (uint8_t)(taken >> 24),
    };
    bool ok = fwrite(h, 1, sizeof(h), file) == sizeof(h) &&
              fwrite(pixels, 2, (size_t)width * (size_t)height, file) == (size_t)width * (size_t)height;
    fclose(file);
    if (!ok) unlink(path); /* a torn picture reads as none */
    return ok;
}

uint16_t *fos_scene_thumb_load(const char *scene_id, int *width, int *height)
{
    char path[48];
    thumb_path(scene_id, path, sizeof(path));
    FILE *file = fopen(path, "rb");
    if (file == NULL) return NULL;
    uint16_t w, h;
    uint32_t taken;
    uint16_t *pixels = NULL;
    if (read_header(file, &w, &h, &taken)) {
        size_t count = (size_t)w * (size_t)h;
        if (heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) >= count * 4u + LOAD_KEEP_FREE_BYTES) {
            pixels = heap_caps_malloc(count * 2u, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        }
        if (pixels != NULL && fread(pixels, 2, count, file) != count) {
            free(pixels);
            pixels = NULL;
        }
        *width = w;
        *height = h;
    }
    fclose(file);
    return pixels;
}
