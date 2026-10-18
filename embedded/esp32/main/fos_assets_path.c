/* See fos_assets_path.h. Host-testable: main/tests/test_fos_assets_path.c. */
#include "fos_assets_path.h"

#include <string.h>

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

static bool mount_point_under(const char *path, const char *mount)
{
    size_t n = strlen(mount);
    return strncmp(path, mount, n) == 0 && (path[n] == '\0' || path[n] == '/');
}

bool fos_assets_mount_point_valid(const char *path)
{
    if (!path || path[0] != '/') return false;
    size_t len = strlen(path);
    if (len < 2 || len > FOS_ASSETS_MOUNT_POINT_MAX || path[len - 1] == '/') return false;
    const char *p = path + 1;
    while (*p) {
        const char *slash = strchr(p, '/');
        size_t seg = slash ? (size_t)(slash - p) : strlen(p);
        if (seg == 0) return false;                       /* "/a//b" */
        if (seg == 1 && p[0] == '.') return false;
        if (seg == 2 && p[0] == '.' && p[1] == '.') return false;
        for (size_t i = 0; i < seg; i++) {
            char c = p[i];
            bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                      (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
            if (!ok) return false;
        }
        p += seg;
        if (*p == '/') p++;
    }
    return !mount_point_under(path, "/state") && !mount_point_under(path, "/dev");
}
