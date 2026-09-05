#include "fos_version.h"

#include <ctype.h>
#include <string.h>

bool fos_version_parse(const char *version, unsigned parts[FOS_VERSION_PARTS_MAX], size_t *count)
{
    if (count) *count = 0;
    for (size_t i = 0; i < FOS_VERSION_PARTS_MAX; i++) parts[i] = 0;
    if (version == NULL) return false;
    const char *p = version;
    while (*p == ' ' || *p == '\t') p++;
    if (*p == 'v' || *p == 'V') p++;
    if (!isdigit((unsigned char)*p)) return false;

    size_t n = 0;
    for (;;) {
        if (n >= FOS_VERSION_PARTS_MAX) return false;
        if (!isdigit((unsigned char)*p)) return false;
        unsigned value = 0;
        while (isdigit((unsigned char)*p)) {
            if (value > 100000000u) return false; /* absurd; not a version */
            value = value * 10u + (unsigned)(*p - '0');
            p++;
        }
        parts[n++] = value;
        if (*p == '.') {
            p++;
            continue;
        }
        break;
    }
    /* Anything after the numeric core must be a suffix separator or the end.
     * "2026.9.9-rc1" and "2026.9.9+build" compare as 2026.9.9. */
    if (*p != '\0' && *p != '-' && *p != '+' && *p != ' ') return false;
    if (count) *count = n;
    return true;
}

int fos_version_compare(const char *a, const char *b)
{
    unsigned pa[FOS_VERSION_PARTS_MAX], pb[FOS_VERSION_PARTS_MAX];
    if (!fos_version_parse(a, pa, NULL) || !fos_version_parse(b, pb, NULL)) return 0;
    for (size_t i = 0; i < FOS_VERSION_PARTS_MAX; i++) {
        if (pa[i] < pb[i]) return -1;
        if (pa[i] > pb[i]) return 1;
    }
    return 0;
}

bool fos_version_is_downgrade(const char *offered, const char *running)
{
    unsigned po[FOS_VERSION_PARTS_MAX], pr[FOS_VERSION_PARTS_MAX];
    if (!fos_version_parse(offered, po, NULL) || !fos_version_parse(running, pr, NULL)) return false;
    return fos_version_compare(offered, running) < 0;
}
