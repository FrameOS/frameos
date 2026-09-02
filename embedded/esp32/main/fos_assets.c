#include "fos_assets.h"

#include <dirent.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>

#include "esp_log.h"

#include "fos_assets_sd.h"
#include "fos_config.h"

static const char *TAG = "fos_assets";

bool fos_assets_available(void)
{
    return fos_assets_sd_mounted();
}

const char *fos_assets_root(void)
{
    const fos_config_t *config = fos_config();
    return config->assets_path[0] ? config->assets_path : "/srv/assets";
}

/* Relative, inside the assets root, no dot-segments. Returns false on
 * anything a client should never send (providers validate too, but the
 * device is the enforcement point). */
bool fos_assets_sanitize_path(const char *raw, char *out, size_t out_len)
{
    if (!raw) return false;
    /* FatFS treats '\\' as a separator too, so "photos\\..\\.cache" would
     * walk past every check below that only looks for '/'. Refuse the byte
     * outright rather than normalise it: no client of the assets API ever
     * legitimately sends one. */
    if (strchr(raw, '\\')) return false;
    while (raw[0] == '/' || (raw[0] == '.' && raw[1] == '/')) {
        raw += (raw[0] == '/') ? 1 : 2;
    }
    size_t len = strlen(raw);
    if (len == 0 || len >= out_len || len >= FOS_ASSETS_PATH_MAX) return false;
    const char *p = raw;
    while (*p) {
        const char *slash = strchr(p, '/');
        size_t seg = slash ? (size_t)(slash - p) : strlen(p);
        if (seg == 0) return false;                       /* "a//b" */
        if (seg == 1 && p[0] == '.') return false;
        if (seg == 2 && p[0] == '.' && p[1] == '.') return false;
        p += seg;
        if (*p == '/') p++;
    }
    memcpy(out, raw, len + 1);
    return true;
}

/* Write rule: additionally refuse any dot-component — dot directories are
 * reserved for device-local state (docs/cloud-frames.md). */
bool fos_assets_sanitize_write_path(const char *raw, char *out, size_t out_len)
{
    if (!fos_assets_sanitize_path(raw, out, out_len)) return false;
    const char *p = out;
    while (*p) {
        if (p[0] == '.' && (p == out || p[-1] == '/')) return false;
        const char *slash = strchr(p, '/');
        if (!slash) break;
        p = slash + 1;
    }
    return true;
}

void fos_assets_full_path(char *out, size_t out_len, const char *rel)
{
    snprintf(out, out_len, "%s/%s", fos_assets_root(), rel);
}

const char *fos_assets_content_type(const char *path)
{
    const char *dot = strrchr(path, '.');
    if (!dot) return "application/octet-stream";
    if (!strcasecmp(dot, ".png")) return "image/png";
    if (!strcasecmp(dot, ".jpg") || !strcasecmp(dot, ".jpeg")) return "image/jpeg";
    if (!strcasecmp(dot, ".gif")) return "image/gif";
    if (!strcasecmp(dot, ".bmp")) return "image/bmp";
    if (!strcasecmp(dot, ".webp")) return "image/webp";
    if (!strcasecmp(dot, ".svg")) return "image/svg+xml";
    if (!strcasecmp(dot, ".txt") || !strcasecmp(dot, ".log")) return "text/plain";
    if (!strcasecmp(dot, ".json")) return "application/json";
    return "application/octet-stream";
}

/* OS droppings on a card that has been in a Windows/macOS/NAS machine. The
 * dot-prefixed ones (`._IMG.jpg` AppleDouble sidecars, `.Trashes`,
 * `.Spotlight-V100`) are already covered by the dotfile rule in
 * asset_list_walk; these are the ones that do not start with a dot. Mirrors
 * frameos/src/frameos/utils/paths.nim — keep the lists in sync.
 *
 * Listing-only, exactly like the dotfile rule: asset_get can still read one
 * by exact path. */
static bool asset_name_is_junk(const char *name)
{
    static const char *junk_names[] = {
        "Thumbs.db",   "ehthumbs.db", "ehthumbs_vista.db",
        "desktop.ini", "@eaDir",      "__MACOSX",
        "$RECYCLE.BIN", "RECYCLER",   "System Volume Information",
    };
    for (size_t i = 0; i < sizeof(junk_names) / sizeof(junk_names[0]); i++) {
        if (!strcasecmp(name, junk_names[i])) return true;
    }
    static const char *junk_exts[] = {
        ".tmp", ".temp", ".part", ".crdownload", ".download", ".lnk",
    };
    size_t len = strlen(name);
    if (len == 0) return true;
    if (name[len - 1] == '~') return true;
    for (size_t i = 0; i < sizeof(junk_exts) / sizeof(junk_exts[0]); i++) {
        size_t ext_len = strlen(junk_exts[i]);
        if (len > ext_len && !strcasecmp(name + len - ext_len, junk_exts[i])) return true;
    }
    return false;
}

/* Recursive walk for the asset listing. Dotfiles stay local (same rule as
 * the Linux firmware); entries beyond the cap flip `truncated` instead of
 * silently stopping. Returns false only on allocation failure. */
static bool asset_list_walk(cJSON *assets, char *rel, size_t rel_cap,
                            int depth, int *count, bool *truncated)
{
    if (depth > FOS_ASSETS_LIST_MAX_DEPTH) return true;
    char full[FOS_ASSETS_FULL_PATH_MAX];
    fos_assets_full_path(full, sizeof(full), rel);
    DIR *dir = opendir(full);
    if (!dir) return true;
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL) {
        if (entry->d_name[0] == '.') continue;
        if (asset_name_is_junk(entry->d_name)) continue;
        if (*count >= FOS_ASSETS_LIST_MAX_ENTRIES) {
            *truncated = true;
            break;
        }
        size_t rel_len = strlen(rel);
        size_t name_len = strlen(entry->d_name);
        if (rel_len + name_len + 2 >= rel_cap) continue;
        if (rel_len > 0) {
            rel[rel_len] = '/';
            memcpy(rel + rel_len + 1, entry->d_name, name_len + 1);
        } else {
            memcpy(rel, entry->d_name, name_len + 1);
        }
        fos_assets_full_path(full, sizeof(full), rel);
        struct stat st;
        if (stat(full, &st) == 0) {
            cJSON *item = cJSON_CreateObject();
            if (!item) {
                closedir(dir);
                rel[rel_len] = '\0';
                return false;
            }
            cJSON_AddStringToObject(item, "path", rel);
            bool is_dir = S_ISDIR(st.st_mode);
            cJSON_AddNumberToObject(item, "size", is_dir ? 0 : (double)st.st_size);
            cJSON_AddNumberToObject(item, "mtime", (double)st.st_mtime);
            cJSON_AddBoolToObject(item, "is_dir", is_dir);
            cJSON_AddItemToArray(assets, item);
            (*count)++;
            if (is_dir &&
                !asset_list_walk(assets, rel, rel_cap, depth + 1, count, truncated)) {
                closedir(dir);
                rel[rel_len] = '\0';
                return false;
            }
        }
        rel[rel_len] = '\0';
    }
    closedir(dir);
    return true;
}

bool fos_assets_list_json(cJSON *assets, bool *truncated)
{
    if (!assets) return false;
    if (truncated) *truncated = false;
    if (!fos_assets_available()) return true;
    char rel[FOS_ASSETS_PATH_MAX] = "";
    int count = 0;
    bool trunc = false;
    bool ok = asset_list_walk(assets, rel, sizeof(rel), 0, &count, &trunc);
    if (truncated) *truncated = trunc;
    return ok;
}

esp_err_t fos_assets_stat(const char *rel, struct stat *st)
{
    if (!fos_assets_available()) return ESP_ERR_INVALID_STATE;
    char full[FOS_ASSETS_FULL_PATH_MAX];
    fos_assets_full_path(full, sizeof(full), rel);
    return stat(full, st) == 0 ? ESP_OK : ESP_ERR_NOT_FOUND;
}

static void set_err(const char **err, const char *value)
{
    if (err) *err = value;
}

/* mkdir -p over the relative path's parents (and optionally the leaf). */
static esp_err_t ensure_dirs(const char *rel, bool include_leaf)
{
    char partial[FOS_ASSETS_PATH_MAX];
    strlcpy(partial, rel, sizeof(partial));
    char full[FOS_ASSETS_FULL_PATH_MAX];
    char *p = partial;
    while (true) {
        char *slash = strchr(p, '/');
        if (!slash && !include_leaf) break;
        if (slash) *slash = '\0';
        fos_assets_full_path(full, sizeof(full), partial);
        if (mkdir(full, 0775) != 0 && errno != EEXIST) {
            ESP_LOGW(TAG, "mkdir %s failed: errno=%d", full, errno);
            return ESP_FAIL;
        }
        if (!slash) break;
        *slash = '/';
        p = slash + 1;
        if (*p == '\0') break;
    }
    return ESP_OK;
}

esp_err_t fos_assets_write_begin(const char *rel, fos_assets_writer_t *writer,
                                 const char **err)
{
    set_err(err, NULL);
    if (!writer) return ESP_ERR_INVALID_ARG;
    writer->file = NULL;
    if (!fos_assets_available()) {
        set_err(err, "not_found");
        return ESP_ERR_INVALID_STATE;
    }
    if (ensure_dirs(rel, false) != ESP_OK) {
        set_err(err, "write_failed");
        return ESP_FAIL;
    }
    fos_assets_full_path(writer->final_path, sizeof(writer->final_path), rel);
    snprintf(writer->tmp_path, sizeof(writer->tmp_path), "%s.fosput", writer->final_path);
    writer->file = fopen(writer->tmp_path, "wb");
    if (!writer->file) {
        ESP_LOGW(TAG, "open %s failed: errno=%d", writer->tmp_path, errno);
        set_err(err, "write_failed");
        return ESP_FAIL;
    }
    return ESP_OK;
}

esp_err_t fos_assets_write_chunk(fos_assets_writer_t *writer, const void *data,
                                 size_t len)
{
    if (!writer || !writer->file) return ESP_ERR_INVALID_STATE;
    if (len == 0) return ESP_OK;
    if (fwrite(data, 1, len, writer->file) != len) {
        return ESP_FAIL;
    }
    return ESP_OK;
}

esp_err_t fos_assets_write_commit(fos_assets_writer_t *writer, const char **err)
{
    set_err(err, NULL);
    if (!writer || !writer->file) return ESP_ERR_INVALID_STATE;
    bool flushed = fflush(writer->file) == 0;
    bool closed = fclose(writer->file) == 0;
    writer->file = NULL;
    if (!flushed || !closed) {
        unlink(writer->tmp_path);
        set_err(err, "write_failed");
        return ESP_FAIL;
    }
    /* FatFS rename refuses an existing destination — replace explicitly. */
    unlink(writer->final_path);
    if (rename(writer->tmp_path, writer->final_path) != 0) {
        ESP_LOGW(TAG, "rename %s -> %s failed: errno=%d", writer->tmp_path,
                 writer->final_path, errno);
        unlink(writer->tmp_path);
        set_err(err, "write_failed");
        return ESP_FAIL;
    }
    return ESP_OK;
}

void fos_assets_write_abort(fos_assets_writer_t *writer)
{
    if (!writer || !writer->file) return;
    fclose(writer->file);
    writer->file = NULL;
    unlink(writer->tmp_path);
}

void fos_assets_cleanup_stale_uploads(void)
{
    if (!fos_assets_available()) return;
    char dir_path[FOS_ASSETS_FULL_PATH_MAX];
    snprintf(dir_path, sizeof(dir_path), "%s/.uploads", fos_assets_root());
    DIR *dir = opendir(dir_path);
    if (!dir) return;
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL) {
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) {
            continue;
        }
        char full[FOS_ASSETS_FULL_PATH_MAX + sizeof(entry->d_name)];
        snprintf(full, sizeof(full), "%s/%s", dir_path, entry->d_name);
        unlink(full);
    }
    closedir(dir);
}

bool fos_assets_valid_upload_id(const char *upload_id)
{
    if (!upload_id || !upload_id[0]) return false;
    size_t len = strlen(upload_id);
    if (len >= FOS_ASSETS_UPLOAD_ID_MAX) return false;
    for (size_t i = 0; i < len; i++) {
        char c = upload_id[i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
              (c >= '0' && c <= '9') || c == '-' || c == '_')) {
            return false;
        }
    }
    return true;
}

static void chunk_part_path(char *out, size_t out_len, const char *upload_id)
{
    snprintf(out, out_len, "%s/.uploads/%s.part", fos_assets_root(), upload_id);
}

esp_err_t fos_assets_chunk_begin(const char *upload_id, long long offset,
                                 fos_assets_writer_t *writer, const char **err)
{
    set_err(err, NULL);
    if (!writer) return ESP_ERR_INVALID_ARG;
    writer->file = NULL;
    writer->final_path[0] = '\0';
    if (!fos_assets_available()) {
        set_err(err, "not_found");
        return ESP_ERR_INVALID_STATE;
    }
    if (!fos_assets_valid_upload_id(upload_id)) {
        set_err(err, "invalid_path");
        return ESP_ERR_INVALID_ARG;
    }
    char dir[FOS_ASSETS_FULL_PATH_MAX];
    snprintf(dir, sizeof(dir), "%s/.uploads", fos_assets_root());
    if (mkdir(dir, 0775) != 0 && errno != EEXIST) {
        ESP_LOGW(TAG, "mkdir %s failed: errno=%d", dir, errno);
        set_err(err, "write_failed");
        return ESP_FAIL;
    }
    chunk_part_path(writer->tmp_path, sizeof(writer->tmp_path), upload_id);
    if (offset <= 0) {
        writer->file = fopen(writer->tmp_path, "wb");
    } else {
        struct stat st;
        if (stat(writer->tmp_path, &st) != 0 || (long long)st.st_size < offset) {
            /* An earlier chunk never landed — the client must restart. */
            set_err(err, "chunk_gap");
            return ESP_ERR_INVALID_STATE;
        }
        writer->file = fopen(writer->tmp_path, "rb+");
        if (writer->file && fseek(writer->file, (long)offset, SEEK_SET) != 0) {
            fclose(writer->file);
            writer->file = NULL;
        }
    }
    if (!writer->file) {
        ESP_LOGW(TAG, "open %s failed: errno=%d", writer->tmp_path, errno);
        set_err(err, "write_failed");
        return ESP_FAIL;
    }
    return ESP_OK;
}

void fos_assets_chunk_close(fos_assets_writer_t *writer)
{
    if (!writer || !writer->file) return;
    fclose(writer->file);
    writer->file = NULL;
}

esp_err_t fos_assets_chunk_finish(fos_assets_writer_t *writer,
                                  const char *final_rel, long long *received,
                                  const char **err)
{
    set_err(err, NULL);
    if (received) *received = 0;
    if (!writer || !writer->file) return ESP_ERR_INVALID_STATE;
    bool flushed = fflush(writer->file) == 0;
    long size_now = flushed ? ftell(writer->file) : -1;
    bool closed = fclose(writer->file) == 0;
    writer->file = NULL;
    if (!flushed || !closed) {
        unlink(writer->tmp_path);
        set_err(err, "write_failed");
        return ESP_FAIL;
    }
    struct stat st;
    if (received) {
        if (stat(writer->tmp_path, &st) == 0) *received = (long long)st.st_size;
        else if (size_now >= 0) *received = size_now;
    }
    if (!final_rel) return ESP_OK; /* more chunks coming; part stays */
    if (ensure_dirs(final_rel, false) != ESP_OK) {
        unlink(writer->tmp_path);
        set_err(err, "write_failed");
        return ESP_FAIL;
    }
    fos_assets_full_path(writer->final_path, sizeof(writer->final_path), final_rel);
    /* FatFS rename refuses an existing destination — replace explicitly. */
    unlink(writer->final_path);
    if (rename(writer->tmp_path, writer->final_path) != 0) {
        ESP_LOGW(TAG, "rename %s -> %s failed: errno=%d", writer->tmp_path,
                 writer->final_path, errno);
        unlink(writer->tmp_path);
        set_err(err, "write_failed");
        return ESP_FAIL;
    }
    return ESP_OK;
}

esp_err_t fos_assets_write_file(const char *rel, const void *data, size_t len,
                                const char **err)
{
    fos_assets_writer_t writer;
    esp_err_t ret = fos_assets_write_begin(rel, &writer, err);
    if (ret != ESP_OK) return ret;
    if (fos_assets_write_chunk(&writer, data, len) != ESP_OK) {
        fos_assets_write_abort(&writer);
        set_err(err, "write_failed");
        return ESP_FAIL;
    }
    return fos_assets_write_commit(&writer, err);
}

esp_err_t fos_assets_mkdir(const char *rel, const char **err)
{
    set_err(err, NULL);
    if (!fos_assets_available()) {
        set_err(err, "not_found");
        return ESP_ERR_INVALID_STATE;
    }
    if (ensure_dirs(rel, true) != ESP_OK) {
        set_err(err, "write_failed");
        return ESP_FAIL;
    }
    return ESP_OK;
}

static esp_err_t delete_tree(char *full, size_t full_cap, int depth)
{
    struct stat st;
    if (stat(full, &st) != 0) return ESP_ERR_NOT_FOUND;
    if (!S_ISDIR(st.st_mode)) {
        return unlink(full) == 0 ? ESP_OK : ESP_FAIL;
    }
    if (depth > FOS_ASSETS_LIST_MAX_DEPTH) return ESP_FAIL;
    DIR *dir = opendir(full);
    if (!dir) return ESP_FAIL;
    size_t base_len = strlen(full);
    esp_err_t ret = ESP_OK;
    struct dirent *entry;
    while (ret == ESP_OK && (entry = readdir(dir)) != NULL) {
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) {
            continue;
        }
        size_t name_len = strlen(entry->d_name);
        if (base_len + name_len + 2 >= full_cap) {
            ret = ESP_FAIL;
            break;
        }
        full[base_len] = '/';
        memcpy(full + base_len + 1, entry->d_name, name_len + 1);
        esp_err_t child = delete_tree(full, full_cap, depth + 1);
        if (child != ESP_OK && child != ESP_ERR_NOT_FOUND) ret = child;
        full[base_len] = '\0';
    }
    closedir(dir);
    if (ret != ESP_OK) return ret;
    return rmdir(full) == 0 ? ESP_OK : ESP_FAIL;
}

esp_err_t fos_assets_delete(const char *rel, const char **err)
{
    set_err(err, NULL);
    if (!fos_assets_available()) {
        set_err(err, "not_found");
        return ESP_ERR_INVALID_STATE;
    }
    char full[FOS_ASSETS_FULL_PATH_MAX];
    fos_assets_full_path(full, sizeof(full), rel);
    esp_err_t ret = delete_tree(full, sizeof(full), 0);
    if (ret == ESP_ERR_NOT_FOUND) {
        set_err(err, "not_found");
    } else if (ret != ESP_OK) {
        set_err(err, "write_failed");
    }
    return ret;
}

esp_err_t fos_assets_rename(const char *src_rel, const char *dst_rel,
                            const char **err)
{
    set_err(err, NULL);
    if (!fos_assets_available()) {
        set_err(err, "not_found");
        return ESP_ERR_INVALID_STATE;
    }
    char src_full[FOS_ASSETS_FULL_PATH_MAX];
    fos_assets_full_path(src_full, sizeof(src_full), src_rel);
    struct stat st;
    if (stat(src_full, &st) != 0) {
        set_err(err, "not_found");
        return ESP_ERR_NOT_FOUND;
    }
    if (ensure_dirs(dst_rel, false) != ESP_OK) {
        set_err(err, "write_failed");
        return ESP_FAIL;
    }
    char dst_full[FOS_ASSETS_FULL_PATH_MAX];
    fos_assets_full_path(dst_full, sizeof(dst_full), dst_rel);
    struct stat dst_st;
    if (stat(dst_full, &dst_st) == 0 && !S_ISDIR(dst_st.st_mode)) {
        /* FatFS rename refuses an existing destination file. */
        unlink(dst_full);
    }
    if (rename(src_full, dst_full) != 0) {
        ESP_LOGW(TAG, "rename %s -> %s failed: errno=%d", src_full, dst_full, errno);
        set_err(err, "write_failed");
        return ESP_FAIL;
    }
    return ESP_OK;
}
