#include "fos_status_screen.h"
#include "fos_client.h"
#include "fos_config.h"
#include "fos_framebuffer.h"
#include "fos_panel_draw.h"
#include "fos_portal_screen.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"

#include "frameos_display.h"

static const char *TAG = "fos_status";

esp_err_t fos_status_screen_show_portal(const char *ssid, const char *psk, const char *ip)
{
    if (!fos_display_present()) return ESP_ERR_INVALID_STATE;

    size_t len = fos_display_buffer_size();
    uint8_t *buf = fos_framebuffer_acquire(len);
    if (!buf) {
        ESP_LOGE(TAG, "out of memory for %u byte status screen", (unsigned)len);
        return ESP_ERR_NO_MEM;
    }
    fos_pixel_format_t format = fos_display_format();
    memset(buf, fos_panel_white_fill(format), len);
    /* Upright the way the frame's scenes are: a frame that lost its network
     * keeps its rotation; a new one has none yet (0). */
    uint16_t rotate = fos_config()->rotate;
    const fos_panel_surface_t surface = {
        .buf = buf, .width = fos_display_width(), .height = fos_display_height(), .format = format,
        .rotate = rotate == 90 || rotate == 180 || rotate == 270 ? rotate : 0,
    };
    /* The two codes' working memory, for this draw alone. Without it the
     * screen is the same facts as text. */
    fos_qr_t *codes = heap_caps_malloc(2 * sizeof(fos_qr_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!codes) codes = malloc(2 * sizeof(fos_qr_t));
    /* White on e-paper; on an LCD white on black, as a Pi's hotspot screen. */
    fos_portal_screen_layout_t layout =
        fos_portal_screen_draw(&surface, ssid, psk, ip, fos_display_is_lcd(), codes);
    free(codes);

    esp_err_t err = fos_display_blit(buf, len);
    fos_framebuffer_release(buf);
    /* The panel no longer shows the last render: the next one refreshes. */
    fos_client_note_panel_drawn();
    if (err == ESP_OK) {
        static const char *const LAYOUTS[] = {"text", "codes side by side", "codes stacked"};
        ESP_LOGI(TAG, "portal screen drawn (%s): ssid=%s ip=%s", LAYOUTS[layout],
                 ssid && ssid[0] ? ssid : "FrameOS", ip && ip[0] ? ip : "192.168.4.1");
    } else {
        ESP_LOGW(TAG, "portal status screen failed: %s", esp_err_to_name(err));
    }
    return err;
}
