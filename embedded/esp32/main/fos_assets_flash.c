#include "fos_assets_flash.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "esp_log.h"
#include "esp_spiffs.h"
#include "esp_vfs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "sdkconfig.h"

/* Assets on the state partition, for a board with no SD card wired.
 *
 * A small VFS at the assets path (`/srv/assets`) forwards to `/state/a` on
 * the SPIFFS partition the scene store lives on, so the asset API
 * (fos_assets.c, local and cloud), the Nim apps (a scene's `/srv/assets/…`
 * paths) and the JS asset calls work unchanged. SPIFFS has no directories
 * and short names, so:
 *
 *   - a folder is a name prefix; mkdir leaves a hidden `.k` marker in it, so
 *     an empty folder still lists, and readdir reports each first path
 *     segment below the listed folder once, as a directory;
 *   - an asset path may be FLASH_PATH_MAX bytes at most (`photos/kitchen.jpg`
 *     fits, a camera's `DCIM/100MEDIA/IMG_20261025_101112.jpg` does not):
 *     longer is ENAMETOOLONG, never a truncated name;
 *   - every write leaves FLASH_RESERVE bytes of the partition free, so a
 *     full asset directory never costs the frame its scenes (ENOSPC).
 *
 * The 8 MB layout's state partition is 1 MB: a handful of photos. */

static const char *TAG = "fos_assets_flash";

#define FLASH_ROOT "/state/a"
/* The SPIFFS object name is the path inside the partition ("/a/<path>"),
 * CONFIG_SPIFFS_OBJ_NAME_LEN with its NUL. */
#define FLASH_PHYS_PREFIX_LEN 2 /* "/a" */
#define FLASH_PHYS_MAX (CONFIG_SPIFFS_OBJ_NAME_LEN - 1)
#define FLASH_PATH_MAX (FLASH_PHYS_MAX - FLASH_PHYS_PREFIX_LEN - 1)
#define FLASH_RESERVE (128 * 1024)
#define FLASH_MAX_FDS 8
#define FLASH_DIR_MARKER ".k"
#define FLASH_FULL_MAX 64
#define FLASH_SEEN_MAX 32

static bool s_active = false;
static int s_fds[FLASH_MAX_FDS];
static SemaphoreHandle_t s_lock = NULL;

static int64_t partition_free(void)
{
    size_t total = 0, used = 0;
    if (esp_spiffs_info("state", &total, &used) != ESP_OK) return -1;
    return total > used ? (int64_t)(total - used) : 0;
}

/* The VFS path (base path stripped: "", "/", "/photos/", "/photos/a.jpg")
 * without trailing slashes; "" is the root. */
static void normalize(const char *path, char *out, size_t cap)
{
    strlcpy(out, path ? path : "", cap);
    size_t len = strlen(out);
    while (len > 0 && out[len - 1] == '/') out[--len] = '\0';
}

static int map_path(const char *norm, char *out, size_t cap)
{
    if (FLASH_PHYS_PREFIX_LEN + strlen(norm) > FLASH_PHYS_MAX) {
        errno = ENAMETOOLONG;
        return -1;
    }
    snprintf(out, cap, "%s%s", FLASH_ROOT, norm);
    return 0;
}

/* Whether any file lives below `norm` (a folder exists while it holds one). */
static bool dir_exists(const char *norm)
{
    if (norm[0] == '\0') return true;
    char full[FLASH_FULL_MAX];
    if (map_path(norm, full, sizeof(full)) != 0) return false;
    DIR *dir = opendir(full);
    if (!dir) return false;
    bool any = readdir(dir) != NULL;
    closedir(dir);
    return any;
}

static int fd_alloc(int global_fd)
{
    int local = -1;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    for (int i = 0; i < FLASH_MAX_FDS; i++) {
        if (s_fds[i] < 0) {
            s_fds[i] = global_fd;
            local = i;
            break;
        }
    }
    xSemaphoreGive(s_lock);
    return local;
}

static int fd_global(int local)
{
    if (local < 0 || local >= FLASH_MAX_FDS || s_fds[local] < 0) {
        errno = EBADF;
        return -1;
    }
    return s_fds[local];
}

static int fv_open(const char *path, int flags, int mode)
{
    char norm[FLASH_FULL_MAX], full[FLASH_FULL_MAX];
    normalize(path, norm, sizeof(norm));
    if (map_path(norm, full, sizeof(full)) != 0) return -1;
    if ((flags & O_ACCMODE) != O_RDONLY && partition_free() < FLASH_RESERVE) {
        errno = ENOSPC;
        return -1;
    }
    int global_fd = open(full, flags, mode);
    if (global_fd < 0) return -1;
    int local = fd_alloc(global_fd);
    if (local < 0) {
        close(global_fd);
        errno = ENFILE;
    }
    return local;
}

static ssize_t fv_read(int fd, void *dst, size_t size)
{
    int global_fd = fd_global(fd);
    return global_fd < 0 ? -1 : read(global_fd, dst, size);
}

static ssize_t fv_write(int fd, const void *data, size_t size)
{
    int global_fd = fd_global(fd);
    if (global_fd < 0) return -1;
    if (partition_free() < FLASH_RESERVE + (int64_t)size) {
        errno = ENOSPC;
        return -1;
    }
    /* Room first, from the blocks holding only deleted pages
     * (fos_spiffs_gc.c): left to the write, SPIFFS collects the photos'
     * blocks, moving 14 pages for each one it frees. */
    esp_spiffs_gc("state", size);
    return write(global_fd, data, size);
}

static off_t fv_lseek(int fd, off_t offset, int whence)
{
    int global_fd = fd_global(fd);
    return global_fd < 0 ? -1 : lseek(global_fd, offset, whence);
}

static int fv_fstat(int fd, struct stat *st)
{
    int global_fd = fd_global(fd);
    return global_fd < 0 ? -1 : fstat(global_fd, st);
}

static int fv_close(int fd)
{
    int global_fd = fd_global(fd);
    if (global_fd < 0) return -1;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_fds[fd] = -1;
    xSemaphoreGive(s_lock);
    return close(global_fd);
}

static void dir_stat(struct stat *st)
{
    memset(st, 0, sizeof(*st));
    st->st_mode = S_IFDIR | 0775;
}

static int fv_stat(const char *path, struct stat *st)
{
    char norm[FLASH_FULL_MAX], full[FLASH_FULL_MAX];
    normalize(path, norm, sizeof(norm));
    if (norm[0] == '\0') {
        dir_stat(st);
        return 0;
    }
    if (map_path(norm, full, sizeof(full)) != 0) return -1;
    if (stat(full, st) == 0) return 0;
    if (dir_exists(norm)) {
        dir_stat(st);
        return 0;
    }
    errno = ENOENT;
    return -1;
}

static int fv_unlink(const char *path)
{
    char norm[FLASH_FULL_MAX], full[FLASH_FULL_MAX];
    normalize(path, norm, sizeof(norm));
    if (map_path(norm, full, sizeof(full)) != 0) return -1;
    return unlink(full);
}

/* A folder's marker: `<folder>/.k`. */
static int marker_path(const char *norm, char *out, size_t cap)
{
    char marked[FLASH_FULL_MAX + sizeof("/" FLASH_DIR_MARKER)];
    snprintf(marked, sizeof(marked), "%s/" FLASH_DIR_MARKER, norm);
    return map_path(marked, out, cap);
}

static int fv_mkdir(const char *path, mode_t mode)
{
    (void)mode;
    char norm[FLASH_FULL_MAX], marker[FLASH_FULL_MAX];
    normalize(path, norm, sizeof(norm));
    if (norm[0] == '\0' || dir_exists(norm)) {
        errno = EEXIST;
        return -1;
    }
    if (marker_path(norm, marker, sizeof(marker)) != 0) return -1;
    int global_fd = open(marker, O_WRONLY | O_CREAT | O_TRUNC, 0664);
    if (global_fd < 0) return -1;
    close(global_fd);
    return 0;
}

static int fv_rmdir(const char *path)
{
    char norm[FLASH_FULL_MAX], marker[FLASH_FULL_MAX];
    normalize(path, norm, sizeof(norm));
    if (norm[0] == '\0') {
        errno = EBUSY;
        return -1;
    }
    if (marker_path(norm, marker, sizeof(marker)) == 0) unlink(marker);
    if (dir_exists(norm)) {
        errno = ENOTEMPTY;
        return -1;
    }
    return 0;
}

/* Renaming a folder renames every file below it. The names are collected
 * first: SPIFFS walks its pages, and a rename moves the walk underneath. */
static int rename_folder(const char *src_norm, const char *dst_norm)
{
    char src_full[FLASH_FULL_MAX];
    if (map_path(src_norm, src_full, sizeof(src_full)) != 0) return -1;
    DIR *dir = opendir(src_full);
    if (!dir) return -1;
    size_t cap = 16, count = 0;
    char (*names)[FLASH_FULL_MAX] = malloc(cap * sizeof(*names));
    struct dirent *entry;
    while (names && (entry = readdir(dir)) != NULL) {
        if (count == cap) {
            cap *= 2;
            void *grown = realloc(names, cap * sizeof(*names));
            if (!grown) {
                free(names);
                names = NULL;
                break;
            }
            names = grown;
        }
        strlcpy(names[count++], entry->d_name, FLASH_FULL_MAX);
    }
    closedir(dir);
    if (!names) {
        errno = ENOMEM;
        return -1;
    }
    int result = 0;
    for (size_t i = 0; i < count && result == 0; i++) {
        char from_norm[2 * FLASH_FULL_MAX], to_norm[2 * FLASH_FULL_MAX];
        char from[FLASH_FULL_MAX], to[FLASH_FULL_MAX];
        snprintf(from_norm, sizeof(from_norm), "%s/%s", src_norm, names[i]);
        snprintf(to_norm, sizeof(to_norm), "%s/%s", dst_norm, names[i]);
        if (map_path(from_norm, from, sizeof(from)) != 0 || map_path(to_norm, to, sizeof(to)) != 0 ||
            rename(from, to) != 0) {
            result = -1;
        }
    }
    free(names);
    return result;
}

static int fv_rename(const char *src, const char *dst)
{
    char src_norm[FLASH_FULL_MAX], dst_norm[FLASH_FULL_MAX];
    char src_full[FLASH_FULL_MAX], dst_full[FLASH_FULL_MAX];
    normalize(src, src_norm, sizeof(src_norm));
    normalize(dst, dst_norm, sizeof(dst_norm));
    if (src_norm[0] == '\0' || dst_norm[0] == '\0') {
        errno = EINVAL;
        return -1;
    }
    if (map_path(src_norm, src_full, sizeof(src_full)) != 0 ||
        map_path(dst_norm, dst_full, sizeof(dst_full)) != 0) {
        return -1;
    }
    struct stat st;
    if (stat(src_full, &st) == 0) return rename(src_full, dst_full);
    if (dir_exists(src_norm)) return rename_folder(src_norm, dst_norm);
    errno = ENOENT;
    return -1;
}

typedef struct {
    DIR base; /* first: the VFS layer stamps it */
    DIR *inner;
    struct dirent entry;
    int seen_count;
    char seen[FLASH_SEEN_MAX][CONFIG_SPIFFS_OBJ_NAME_LEN];
} flash_dir_t;

static DIR *fv_opendir(const char *name)
{
    char norm[FLASH_FULL_MAX], full[FLASH_FULL_MAX];
    normalize(name, norm, sizeof(norm));
    if (map_path(norm, full, sizeof(full)) != 0) return NULL;
    if (!dir_exists(norm)) {
        errno = ENOENT;
        return NULL;
    }
    flash_dir_t *dir = calloc(1, sizeof(*dir));
    if (!dir) {
        errno = ENOMEM;
        return NULL;
    }
    dir->inner = opendir(full);
    if (!dir->inner) {
        free(dir);
        return NULL;
    }
    return (DIR *)dir;
}

static struct dirent *fv_readdir(DIR *pdir)
{
    flash_dir_t *dir = (flash_dir_t *)pdir;
    struct dirent *inner;
    while ((inner = readdir(dir->inner)) != NULL) {
        const char *name = inner->d_name;
        const char *slash = strchr(name, '/');
        if (!slash) {
            strlcpy(dir->entry.d_name, name, sizeof(dir->entry.d_name));
            dir->entry.d_type = DT_REG;
            return &dir->entry;
        }
        /* A file deeper down: its first segment is a folder here, once. */
        size_t len = (size_t)(slash - name);
        if (len == 0 || len >= CONFIG_SPIFFS_OBJ_NAME_LEN) continue;
        bool seen = false;
        for (int i = 0; i < dir->seen_count && !seen; i++) {
            seen = strlen(dir->seen[i]) == len && strncmp(dir->seen[i], name, len) == 0;
        }
        if (seen) continue;
        if (dir->seen_count < FLASH_SEEN_MAX) {
            memcpy(dir->seen[dir->seen_count], name, len);
            dir->seen[dir->seen_count][len] = '\0';
            dir->seen_count++;
        }
        memcpy(dir->entry.d_name, name, len);
        dir->entry.d_name[len] = '\0';
        dir->entry.d_type = DT_DIR;
        return &dir->entry;
    }
    return NULL;
}

static int fv_closedir(DIR *pdir)
{
    flash_dir_t *dir = (flash_dir_t *)pdir;
    int result = closedir(dir->inner);
    free(dir);
    return result;
}

esp_err_t fos_assets_flash_mount(const char *assets_path)
{
    if (s_active) return ESP_OK;
    if (partition_free() < 0) {
        ESP_LOGW(TAG, "state partition not mounted; no assets");
        return ESP_ERR_INVALID_STATE;
    }
    s_lock = xSemaphoreCreateMutex();
    if (!s_lock) return ESP_ERR_NO_MEM;
    for (int i = 0; i < FLASH_MAX_FDS; i++) s_fds[i] = -1;
    esp_vfs_t vfs = {
        .flags = ESP_VFS_FLAG_DEFAULT,
        .open = fv_open,
        .read = fv_read,
        .write = fv_write,
        .lseek = fv_lseek,
        .fstat = fv_fstat,
        .close = fv_close,
        .stat = fv_stat,
        .unlink = fv_unlink,
        .rename = fv_rename,
        .opendir = fv_opendir,
        .readdir = fv_readdir,
        .closedir = fv_closedir,
        .mkdir = fv_mkdir,
        .rmdir = fv_rmdir,
    };
    esp_err_t err = esp_vfs_register(assets_path, &vfs, NULL);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "could not mount assets at %s: %s", assets_path, esp_err_to_name(err));
        return err;
    }
    s_active = true;
    ESP_LOGI(TAG, "no SD card: assets at %s live on the state partition (%lld KB free for them, "
                  "paths up to %d bytes)",
             assets_path, (long long)(fos_assets_flash_free_bytes() / 1024), FLASH_PATH_MAX);
    return ESP_OK;
}

bool fos_assets_flash_active(void)
{
    return s_active;
}

int64_t fos_assets_flash_free_bytes(void)
{
    if (!s_active) return -1;
    int64_t free_bytes = partition_free();
    if (free_bytes < 0) return -1;
    return free_bytes > FLASH_RESERVE ? free_bytes - FLASH_RESERVE : 0;
}
