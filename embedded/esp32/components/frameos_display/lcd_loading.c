#include "lcd_loading.h"

#include <string.h>

static uint16_t *at(const fos_lcd_loading_t *m, uint16_t *fb)
{
    return fb + (size_t)m->rect.y * (size_t)m->width + (size_t)m->rect.x;
}

/* The pixels under the mark, between the panel's buffer and `saved`. */
static void copy_rect(const fos_lcd_loading_t *m, uint16_t *fb, bool to_panel)
{
    uint16_t *panel = at(m, fb);
    uint16_t *saved = m->saved;
    size_t row_bytes = (size_t)m->rect.w * sizeof(uint16_t);
    for (int32_t y = 0; y < m->rect.h; y++) {
        if (to_panel) memcpy(panel, saved, row_bytes);
        else memcpy(saved, panel, row_bytes);
        panel += m->width;
        saved += m->rect.w;
    }
}

static void put_back(fos_lcd_loading_t *m)
{
    if (!m->drawn_in) return;
    copy_rect(m, m->drawn_in, true);
    m->drawn_in = NULL;
}

bool fos_lcd_loading_begin(fos_lcd_loading_t *m, int rotation, uint32_t since_ms)
{
    fos_lcd_loading_rect_t rect;
    m->draw(m->width, m->height, rotation, 0, (int32_t *)&rect, NULL, 0, NULL, 0);
    if (memcmp(&rect, &m->rect, sizeof(rect)) != 0) put_back(m);
    m->rotation = rotation;
    m->rect = rect;
    if (rect.w <= 0 || (size_t)rect.w * (size_t)rect.h > m->saved_words) {
        m->active = false;
        return false;
    }
    if (!m->active) {
        m->active = true;
        m->since_ms = since_ms;
    }
    return true;
}

int32_t fos_lcd_loading_step(fos_lcd_loading_t *m, uint16_t *scanned, uint32_t now_ms)
{
    uint32_t elapsed_ms = now_ms - m->since_ms;
    if (elapsed_ms >= FOS_LCD_LOADING_MAX_MS) m->active = false;
    if (!m->active) {
        put_back(m);
        return -1;
    }
    if (elapsed_ms < FOS_LCD_LOADING_DELAY_MS) return (int32_t)(FOS_LCD_LOADING_DELAY_MS - elapsed_ms);
    /* A picture went up in between (not this switch's: that ends it). */
    if (m->drawn_in != scanned) {
        put_back(m);
        copy_rect(m, scanned, false);
        m->drawn_in = scanned;
    }
    m->draw(m->width, m->height, m->rotation, (int32_t)(elapsed_ms - FOS_LCD_LOADING_DELAY_MS),
            (int32_t *)&m->rect, m->saved, m->rect.w * (int32_t)sizeof(uint16_t), at(m, scanned),
            m->width * (int32_t)sizeof(uint16_t));
    return FOS_LCD_LOADING_FRAME_MS;
}

void fos_lcd_loading_end(fos_lcd_loading_t *m)
{
    m->active = false;
    put_back(m);
}
