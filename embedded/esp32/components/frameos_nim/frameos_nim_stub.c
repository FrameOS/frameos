/* Stub used when the Nim runtime hasn't been compiled in (no nimcache/).
 * See build_nim.sh for producing the real thing. */
#include "frameos_nim.h"

bool frameos_nim_available(void) { return false; }
bool frameos_nim_init(int width, int height, const char *frame_name)
{
    (void)width; (void)height; (void)frame_name;
    return false;
}
int frameos_nim_render_1bpp(uint8_t *buf, size_t len)
{
    (void)buf; (void)len;
    return -1;
}
const char *frameos_nim_info(void) { return "nim runtime not compiled in"; }
