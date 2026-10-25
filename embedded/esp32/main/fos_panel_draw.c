/* Drawing into a packed panel buffer. See fos_panel_draw.h. */
#include "fos_panel_draw.h"
#include "fos_font5x7.h"

#include <string.h>

/* ---------------------------------------------------------------- pixels */

static int bits_per_pixel(fos_pixel_format_t format)
{
    switch (format) {
        case FOS_PIXEL_1BPP:
        case FOS_PIXEL_DUAL_1BPP_RED:
        case FOS_PIXEL_DUAL_1BPP_YELLOW:
            return 1;
        case FOS_PIXEL_2BPP_GRAY:
        case FOS_PIXEL_2BPP_BWYR:
            return 2;
        case FOS_PIXEL_4BPP_7COLOR:
        case FOS_PIXEL_4BPP_SPECTRA6:
        case FOS_PIXEL_4BPP_GRAY:
            return 4;
        case FOS_PIXEL_RGB565:
            return 16;
        default:
            return 0;
    }
}

static bool two_planes(fos_pixel_format_t format)
{
    return format == FOS_PIXEL_DUAL_1BPP_RED || format == FOS_PIXEL_DUAL_1BPP_YELLOW;
}

/* The palette index that is white; black is 0 in every format. */
static uint8_t white_index(fos_pixel_format_t format)
{
    switch (format) {
        case FOS_PIXEL_2BPP_GRAY: return 3;
        case FOS_PIXEL_4BPP_GRAY: return 15;
        default: return 1; /* 1bpp bit, BWYR, 7-colour and Spectra 6 index 1 */
    }
}

uint8_t fos_panel_white_fill(fos_pixel_format_t format)
{
    switch (format) {
        case FOS_PIXEL_2BPP_BWYR:
            return 0x55; /* palette index 1 (white) */
        case FOS_PIXEL_4BPP_7COLOR:
        case FOS_PIXEL_4BPP_SPECTRA6:
            return 0x11; /* palette index 1 (white) */
        default:
            return 0xFF;
    }
}

static size_t row_bytes(int width, int bpp)
{
    return ((size_t)width * (size_t)bpp + 7u) / 8u;
}

static void put_panel(const fos_panel_surface_t *s, int px, int py, bool black)
{
    if (px < 0 || py < 0 || px >= s->width || py >= s->height) return;
    const int bpp = bits_per_pixel(s->format);
    if (bpp == 0) return;
    const size_t stride = row_bytes(s->width, bpp);
    if (bpp == 16) {
        /* One little-endian 5/6/5 word: black 0x0000, white 0xFFFF. */
        uint8_t *at = s->buf + (size_t)py * stride + (size_t)px * 2u;
        at[0] = black ? 0x00 : 0xFF;
        at[1] = black ? 0x00 : 0xFF;
        return;
    }
    const size_t bit = (size_t)px * (size_t)bpp;
    const size_t index = (size_t)py * stride + bit / 8u;
    const unsigned shift = 8u - (unsigned)bpp - (unsigned)(bit % 8u);
    const uint8_t mask = (uint8_t)(((1u << bpp) - 1u) << shift);
    const uint8_t value = black ? 0 : white_index(s->format);
    s->buf[index] = (uint8_t)((s->buf[index] & ~mask) | ((value << shift) & mask));
    /* The accent plane says "no red/yellow here" for both inks, so a box
     * over an accent-coloured scene is black and white, not tinted. */
    if (two_planes(s->format)) s->buf[stride * (size_t)s->height + index] |= mask;
}

int fos_panel_scene_width(const fos_panel_surface_t *s)
{
    return (s->rotate == 90 || s->rotate == 270) ? s->height : s->width;
}

int fos_panel_scene_height(const fos_panel_surface_t *s)
{
    return (s->rotate == 90 || s->rotate == 270) ? s->width : s->height;
}

/* Scene (x, y) to the panel position the packers put it at. */
static void scene_to_panel(const fos_panel_surface_t *s, int x, int y, int *px, int *py)
{
    const int sw = fos_panel_scene_width(s);
    const int sh = fos_panel_scene_height(s);
    switch (s->rotate) {
        case 90: *px = sh - 1 - y; *py = x; break;
        case 180: *px = sw - 1 - x; *py = sh - 1 - y; break;
        case 270: *px = y; *py = sw - 1 - x; break;
        default: *px = x; *py = y; break;
    }
}

void fos_panel_fill_rect(const fos_panel_surface_t *s, int x, int y, int w, int h, bool black)
{
    if (s == NULL || s->buf == NULL) return;
    const int sw = fos_panel_scene_width(s);
    const int sh = fos_panel_scene_height(s);
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > sw) w = sw - x;
    if (y + h > sh) h = sh - y;
    for (int yy = y; yy < y + h; yy++) {
        for (int xx = x; xx < x + w; xx++) {
            int px, py;
            scene_to_panel(s, xx, yy, &px, &py);
            put_panel(s, px, py, black);
        }
    }
}

/* ------------------------------------------------------------------ text */

int fos_panel_text_width(const char *text, int scale)
{
    if (!text || scale <= 0) return 0;
    int chars = (int)strlen(text);
    return chars > 0 ? ((chars * 6) - 1) * scale : 0;
}

int fos_panel_fit_scale(const char *text, int scale, int avail)
{
    while (scale > 1 && fos_panel_text_width(text, scale) > avail) {
        scale--;
    }
    return scale;
}

static void draw_char(const fos_panel_surface_t *s, char c, int x, int y, int scale)
{
    const uint8_t *rows = fos_font5x7_glyph(c);
    if (!rows) return;
    for (int row = 0; row < 7; row++) {
        for (int col = 0; col < 5; col++) {
            if (rows[row] & (0x10u >> col)) {
                fos_panel_fill_rect(s, x + col * scale, y + row * scale, scale, scale, true);
            }
        }
    }
}

void fos_panel_draw_text(const fos_panel_surface_t *s, const char *text, int x, int y, int scale)
{
    if (!text || scale <= 0) return;
    for (size_t i = 0; text[i]; i++) {
        draw_char(s, text[i], x + (int)i * 6 * scale, y, scale);
    }
}

/* -------------------------------------------------------- the code's box */

static int max_int(int a, int b) { return a > b ? a : b; }
static int min_int(int a, int b) { return a < b ? a : b; }

bool fos_panel_code_box(const fos_panel_surface_t *s, const char *title, size_t code_len,
                        fos_panel_code_box_t *box)
{
    if (s == NULL || box == NULL || bits_per_pixel(s->format) == 0 || code_len == 0 ||
        code_len > 16) {
        return false;
    }
    memset(box, 0, sizeof(*box));
    const int sw = fos_panel_scene_width(s);
    const int sh = fos_panel_scene_height(s);
    const int digits_w1 = (int)code_len * 6 - 1; /* at scale 1 */

    /* Digits up to 3/5 of the width and 2/5 of the height: readable from
     * across a room, with the scene still around them; at least scale 1 on a
     * small panel, if the box fits at all. The title is at most a third of
     * the digits' scale and no wider than them, down to scale 1; at scale 1
     * a longer title ("Local network access code" on a 200 px panel) widens
     * the box if the scene has room, and is dropped if not. */
    const int digit_scale = max_int(1, min_int((sw * 3 / 5) / digits_w1, (sh * 2 / 5) / 7));
    const int digits_w = digits_w1 * digit_scale;
    const int pad = 2 * digit_scale;
    int title_scale = title == NULL ? 0 : digit_scale / 3; /* 0: the digits alone */
    while (title_scale > 1 && fos_panel_text_width(title, title_scale) > digits_w) {
        title_scale--;
    }
    if (title_scale == 1 && fos_panel_text_width(title, 1) + 2 * pad > sw) {
        title_scale = 0;
    }
    box->pad = pad;
    box->gap = title_scale ? digit_scale : 0;
    box->title_scale = title_scale;
    box->digit_scale = digit_scale;
    box->w = max_int(digits_w, fos_panel_text_width(title, title_scale)) + 2 * pad;
    box->h = 7 * digit_scale + 2 * box->pad + (title_scale ? 7 * title_scale + box->gap : 0);
    if (box->w > sw || box->h > sh) return false;
    box->x = (sw - box->w) / 2;
    box->y = (sh - box->h) / 2;

    /* The scene rectangle on the panel: its two opposite corners mapped. */
    int ax, ay, bx, by;
    scene_to_panel(s, box->x, box->y, &ax, &ay);
    scene_to_panel(s, box->x + box->w - 1, box->y + box->h - 1, &bx, &by);
    box->px = min_int(ax, bx);
    box->py = min_int(ay, by);
    box->pw = max_int(ax, bx) - box->px + 1;
    box->ph = max_int(ay, by) - box->py + 1;
    return true;
}

size_t fos_panel_box_copy(const fos_panel_surface_t *s, const fos_panel_code_box_t *box,
                          uint8_t *buf, bool restore)
{
    const int bpp = s != NULL && box != NULL ? bits_per_pixel(s->format) : 0;
    if (bpp == 0) return 0;
    const size_t stride = row_bytes(s->width, bpp);
    const size_t first = ((size_t)box->px * (size_t)bpp) / 8u;
    const size_t span = row_bytes(box->px + box->pw, bpp) - first;
    const int planes = two_planes(s->format) ? 2 : 1;
    if (buf != NULL) {
        for (int plane = 0; plane < planes; plane++) {
            uint8_t *base = s->buf + (size_t)plane * stride * (size_t)s->height + first;
            for (int row = box->py; row < box->py + box->ph; row++, buf += span) {
                uint8_t *at = base + (size_t)row * stride;
                memcpy(restore ? at : buf, restore ? buf : at, span);
            }
        }
    }
    return span * (size_t)box->ph * (size_t)planes;
}

void fos_panel_draw_code(const fos_panel_surface_t *s, const fos_panel_code_box_t *box,
                         const char *title, const char *code)
{
    if (s == NULL || box == NULL || code == NULL) return;
    fos_panel_fill_rect(s, box->x, box->y, box->w, box->h, false);
    const int t = max_int(1, box->pad / 4);
    fos_panel_fill_rect(s, box->x, box->y, box->w, t, true);
    fos_panel_fill_rect(s, box->x, box->y + box->h - t, box->w, t, true);
    fos_panel_fill_rect(s, box->x, box->y, t, box->h, true);
    fos_panel_fill_rect(s, box->x + box->w - t, box->y, t, box->h, true);

    int y = box->y + box->pad;
    if (box->title_scale > 0 && title != NULL) {
        const int tw = fos_panel_text_width(title, box->title_scale);
        fos_panel_draw_text(s, title, box->x + (box->w - tw) / 2, y, box->title_scale);
        y += 7 * box->title_scale + box->gap;
    }
    const int cw = fos_panel_text_width(code, box->digit_scale);
    fos_panel_draw_text(s, code, box->x + (box->w - cw) / 2, y, box->digit_scale);
}

/* ------------------------------------------------------------- the notice */

/* Break `text` into lines of at most `max_chars` glyphs at the spaces (a
 * word longer than a line is cut), `\n` forcing a break. Returns the line
 * count; `starts` / `lens` (max_lines each) get each line's slice. */
static int wrap_text(const char *text, int max_chars, int max_lines, const char **starts, int *lens)
{
    int lines = 0;
    const char *p = text;
    while (*p && lines < max_lines) {
        while (*p == ' ') p++;
        if (*p == '\n') {
            starts[lines] = p;
            lens[lines] = 0;
            lines++;
            p++;
            continue;
        }
        if (!*p) break;
        const char *start = p;
        const char *last_space = NULL;
        int n = 0;
        while (p[n] && p[n] != '\n' && n < max_chars) {
            if (p[n] == ' ') last_space = p + n;
            n++;
        }
        int len = n;
        if (p[n] && p[n] != '\n' && last_space != NULL) len = (int)(last_space - start);
        starts[lines] = start;
        lens[lines] = len;
        lines++;
        p = start + len;
        if (*p == '\n') p++;
    }
    return lines;
}

bool fos_panel_notice_box(const fos_panel_surface_t *s, const char *text, int scale, int max_lines,
                          fos_panel_code_box_t *box)
{
    if (s == NULL || box == NULL || text == NULL || !text[0] || bits_per_pixel(s->format) == 0) {
        return false;
    }
    memset(box, 0, sizeof(*box));
    const int sw = fos_panel_scene_width(s);
    const int sh = fos_panel_scene_height(s);
    if (max_lines > FOS_PANEL_NOTICE_MAX_LINES) max_lines = FOS_PANEL_NOTICE_MAX_LINES;
    const char *starts[FOS_PANEL_NOTICE_MAX_LINES];
    int lens[FOS_PANEL_NOTICE_MAX_LINES];
    /* The largest scale at which the whole text fits the allowed lines and
     * the box fits the scene; a text too long for every scale is cut at
     * the last line (wrap_text stops at max_lines). */
    for (int sc = max_int(1, scale); sc >= 1; sc--) {
        const int pad = 3 * sc;
        const int margin = 2 * sc;
        const int inner_w = sw - 2 * margin - 2 * pad;
        const int max_chars = (inner_w + sc) / (6 * sc);
        if (max_chars < 4) continue;
        int lines = wrap_text(text, max_chars, max_lines, starts, lens);
        if (lines == 0) return false;
        const char *rest = starts[lines - 1] + lens[lines - 1];
        while (*rest == ' ' || *rest == '\n') rest++;
        if (*rest && sc > 1) continue; /* did not fit: smaller glyphs */
        const int line_h = 9 * sc; /* 7 px of glyph, 2 of leading */
        box->pad = pad;
        box->gap = margin;
        box->title_scale = sc;
        box->digit_scale = lines;
        box->w = sw - 2 * margin;
        box->h = lines * line_h - 2 * sc + 2 * pad;
        if (box->h > sh - 2 * margin) continue;
        box->x = margin;
        box->y = sh - margin - box->h;
        int ax, ay, bx, by;
        scene_to_panel(s, box->x, box->y, &ax, &ay);
        scene_to_panel(s, box->x + box->w - 1, box->y + box->h - 1, &bx, &by);
        box->px = min_int(ax, bx);
        box->py = min_int(ay, by);
        box->pw = max_int(ax, bx) - box->px + 1;
        box->ph = max_int(ay, by) - box->py + 1;
        return true;
    }
    return false;
}

void fos_panel_draw_notice(const fos_panel_surface_t *s, const fos_panel_code_box_t *box,
                           const char *text)
{
    if (s == NULL || box == NULL || text == NULL || box->title_scale <= 0) return;
    const int sc = box->title_scale;
    fos_panel_fill_rect(s, box->x, box->y, box->w, box->h, false);
    const int t = max_int(1, sc / 2 + 1);
    fos_panel_fill_rect(s, box->x, box->y, box->w, t, true);
    fos_panel_fill_rect(s, box->x, box->y + box->h - t, box->w, t, true);
    fos_panel_fill_rect(s, box->x, box->y, t, box->h, true);
    fos_panel_fill_rect(s, box->x + box->w - t, box->y, t, box->h, true);

    const int max_chars = (box->w - 2 * box->pad + sc) / (6 * sc);
    const char *starts[FOS_PANEL_NOTICE_MAX_LINES];
    int lens[FOS_PANEL_NOTICE_MAX_LINES];
    int lines = wrap_text(text, max_chars, box->digit_scale, starts, lens);
    int y = box->y + box->pad;
    for (int i = 0; i < lines; i++) {
        char line[160];
        int len = lens[i] < (int)sizeof(line) - 1 ? lens[i] : (int)sizeof(line) - 1;
        memcpy(line, starts[i], (size_t)len);
        line[len] = '\0';
        fos_panel_draw_text(s, line, box->x + box->pad, y, sc);
        y += 9 * sc;
    }
}
