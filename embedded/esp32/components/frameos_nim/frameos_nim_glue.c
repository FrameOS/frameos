/* Glue between the firmware and the Nim-generated C (nimcache/).
 * Owns NimMain() (one-shot Nim module init) and the log hook. */
#include "frameos_nim.h"

#include "esp_log.h"

extern void NimMain(void);
extern bool fos_nim_init_impl(int width, int height, const char *name);
extern int fos_nim_render_1bpp_impl(uint8_t *buf, size_t len);
extern const char *fos_nim_info_impl(void);

static bool s_nim_started = false;
static bool s_nim_ready = false;

bool frameos_nim_available(void) { return true; }

bool frameos_nim_init(int width, int height, const char *frame_name)
{
    if (!s_nim_started) {
        NimMain();
        s_nim_started = true;
    }
    s_nim_ready = fos_nim_init_impl(width, height, frame_name);
    return s_nim_ready;
}

int frameos_nim_render_1bpp(uint8_t *buf, size_t len)
{
    if (!s_nim_ready) return -1;
    return fos_nim_render_1bpp_impl(buf, len);
}

const char *frameos_nim_info(void)
{
    if (!s_nim_ready) return "nim runtime compiled in, not initialized";
    return fos_nim_info_impl();
}

void frameos_nim_log_hook(const char *msg)
{
    ESP_LOGI("nim", "%s", msg);
}
