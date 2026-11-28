#include "fos_rotation.h"

#include "esp_log.h"

#include "fos_client.h"
#include "fos_config.h"
#include "frameos_nim.h"

static const char *TAG = "fos_rotation";

static int s_applied = -1;     /* render task's; read by any */
static int s_upright = -1;     /* the accelerometer's, any task */
static bool s_asked = false;   /* a render is asked for to apply a turn */
static bool s_canvas_bound = false;

uint16_t fos_rotation(void)
{
    int applied = __atomic_load_n(&s_applied, __ATOMIC_RELAXED);
    return applied >= 0 ? (uint16_t)applied : fos_config()->rotate;
}

uint16_t fos_rotation_wanted(void)
{
    const fos_config_t *config = fos_config();
    int upright = __atomic_load_n(&s_upright, __ATOMIC_RELAXED);
    if (config->auto_rotate && !s_canvas_bound && upright >= 0) return (uint16_t)upright;
    return config->rotate;
}

void fos_rotation_follow(int upright)
{
    /* Called at every reading (fos_imu.c). Lying flat keeps the last way it
     * stood. One render is asked for while the picture is not drawn at the
     * rotation wanted: a new way up, or auto-rotate switched on or off (from
     * a plane, the console, the frame page) over a still scene. */
    if (upright == 0 || upright == 90 || upright == 180 || upright == 270) {
        __atomic_store_n(&s_upright, upright, __ATOMIC_RELAXED);
    }
    if (fos_rotation_wanted() != fos_rotation() && !__atomic_exchange_n(&s_asked, true, __ATOMIC_RELAXED)) {
        fos_client_render_fresh();
    }
}

bool fos_rotation_apply(void)
{
    uint16_t want = fos_rotation_wanted();
    __atomic_store_n(&s_asked, false, __ATOMIC_RELAXED);
    if (want == fos_rotation()) {
        if (s_applied < 0) __atomic_store_n(&s_applied, want, __ATOMIC_RELAXED);
        return false;
    }
    /* A frame its plane renders runs no scene here: the turn is the pull's
     * (fos_client.c asks the plane for the picture at fos_rotation()). */
    if (!frameos_nim_set_rotation(want) && fos_client_renders_locally()) return false;
    ESP_LOGI(TAG, "picture turned to %u (frame %u, auto-rotate %s)", (unsigned)want, (unsigned)fos_config()->rotate,
             fos_config()->auto_rotate ? "on" : "off");
    __atomic_store_n(&s_applied, want, __ATOMIC_RELAXED);
    return true;
}

void fos_rotation_set_canvas_bound(bool bound)
{
    s_canvas_bound = bound;
}

bool fos_rotation_canvas_bound(void)
{
    return s_canvas_bound;
}
