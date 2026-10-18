/*
 * The assets-path rule — the traversal boundary behind every asset verb
 * (cloud verbs, the local HTTP asset API). Pure string
 * code, no IDF, so it is tested on a laptop
 * (main/tests/test_fos_assets_path.c). Included by fos_assets.h.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>

#define FOS_ASSETS_PATH_MAX 256

/* Read-path rule: relative, non-empty, no dot-segments ("." / ".."), no
 * empty segments, no backslashes (a FatFS separator that would bypass the
 * segment checks). Leading "/" and "./" are stripped. Dotfiles are readable
 * when named directly (the walk skips them, mirroring the Linux runtime).
 * `out` receives the normalised relative path (out_len must exceed it). */
bool fos_assets_sanitize_path(const char *raw, char *out, size_t out_len);

/* Write-path rule: read rule plus refusing ANY dot-component — dot
 * directories are reserved for device-local state (docs/cloud-frames.md). */
bool fos_assets_sanitize_write_path(const char *raw, char *out, size_t out_len);

/* `assets_path` is the VFS mount point of the SD card, so it has to be one
 * esp_vfs_register accepts (absolute, 2-15 bytes, no trailing '/') and must
 * not land on a mount the firmware already owns (`/state`, the console's
 * `/dev`). Segments are [A-Za-z0-9._-], no "." or "..". The console's `set
 * assets_path` and the setup page's form both check it; a value this refuses
 * would otherwise surface as "SD not mounted" after the next restart. */
#define FOS_ASSETS_MOUNT_POINT_MAX 15
bool fos_assets_mount_point_valid(const char *path);
