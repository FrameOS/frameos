#include "fos_restart.h"

#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"

/* FrameOS's hooks before a restart (fos_restart.h): one of ESP-IDF's five
 * shutdown handlers, whatever the number of modules that need one. */

#define FOS_RESTART_HOOKS_MAX 10

static const char *TAG = "fos_restart";
static fos_restart_hook_t s_hooks[FOS_RESTART_HOOKS_MAX];
static int s_count = 0;
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;

/* Newest first, as esp_restart() runs ESP-IDF's handlers. Nothing else runs
 * by then that could add one. */
static void run_hooks(void)
{
    for (int i = s_count - 1; i >= 0; i--) s_hooks[i]();
}

bool fos_on_restart(fos_restart_hook_t hook)
{
    if (hook == NULL) return false;
    bool known = false;
    bool first = false;
    bool full = false;
    taskENTER_CRITICAL(&s_lock);
    for (int i = 0; i < s_count && !known; i++) known = s_hooks[i] == hook;
    if (!known) {
        if (s_count < FOS_RESTART_HOOKS_MAX) {
            s_hooks[s_count++] = hook;
            first = s_count == 1;
        } else {
            full = true;
        }
    }
    taskEXIT_CRITICAL(&s_lock);
    if (full) {
        ESP_LOGW(TAG, "no room for another restart hook (FOS_RESTART_HOOKS_MAX %d)", FOS_RESTART_HOOKS_MAX);
        return false;
    }
    if (first) {
        esp_err_t err = esp_register_shutdown_handler(run_hooks);
        if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
            ESP_LOGW(TAG, "restart hooks not registered: %s", esp_err_to_name(err));
        }
    }
    return true;
}
