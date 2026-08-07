#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <sys/stat.h>

#include "esp_err.h"

#include "cJSON.h"

/* Shared asset-directory layer: one path-safety + listing + write
 * implementation behind the cloud verbs, the local HTTP API and the USB
 * console. All paths are RELATIVE to the assets root (`assets_path`,
 * default /srv/assets — the SD card mount). */

#define FOS_ASSETS_PATH_MAX 256
#define FOS_ASSETS_FULL_PATH_MAX (FOS_ASSETS_PATH_MAX + 128)
#define FOS_ASSETS_LIST_MAX_ENTRIES 2000
#define FOS_ASSETS_LIST_MAX_DEPTH 8

/* True when the backing storage (SD card) is mounted. Every operation
 * fails cleanly when it is not. */
bool fos_assets_available(void);

const char *fos_assets_root(void);

/* Read-path rule: relative, non-empty, no dot-segments ("." / ".."), no
 * empty segments. Dotfiles are readable when named directly (the walk
 * skips them, mirroring the Linux runtime). */
bool fos_assets_sanitize_path(const char *raw, char *out, size_t out_len);

/* Write-path rule: read rule plus refusing ANY dot-component — dot
 * directories are reserved for device-local state (docs/cloud-frames.md). */
bool fos_assets_sanitize_write_path(const char *raw, char *out, size_t out_len);

void fos_assets_full_path(char *out, size_t out_len, const char *rel);

const char *fos_assets_content_type(const char *path);

/* Append {path,size,mtime,is_dir} entries for the whole tree to `assets`.
 * Returns false only on allocation failure; caps flip *truncated. */
bool fos_assets_list_json(cJSON *assets, bool *truncated);

/* stat() a sanitized relative path. */
esp_err_t fos_assets_stat(const char *rel, struct stat *st);

/* Streaming file write: temp file + rename, parents auto-created, existing
 * file replaced. `err` (optional) receives a stable protocol token
 * ("invalid_path", "not_found", "write_failed", "no_memory") on failure. */
typedef struct {
    FILE *file;
    char tmp_path[FOS_ASSETS_FULL_PATH_MAX + 16]; /* final path + ".fosput" */
    char final_path[FOS_ASSETS_FULL_PATH_MAX];
} fos_assets_writer_t;

esp_err_t fos_assets_write_begin(const char *rel, fos_assets_writer_t *writer,
                                 const char **err);
esp_err_t fos_assets_write_chunk(fos_assets_writer_t *writer, const void *data,
                                 size_t len);
esp_err_t fos_assets_write_commit(fos_assets_writer_t *writer, const char **err);
void fos_assets_write_abort(fos_assets_writer_t *writer);

/* Whole-buffer convenience over begin/chunk/commit. */
esp_err_t fos_assets_write_file(const char *rel, const void *data, size_t len,
                                const char **err);

esp_err_t fos_assets_mkdir(const char *rel, const char **err);
/* Recursive delete of a file or directory tree. */
esp_err_t fos_assets_delete(const char *rel, const char **err);
/* Rename/move; destination parents auto-created, existing file replaced. */
esp_err_t fos_assets_rename(const char *src_rel, const char *dst_rel,
                            const char **err);
