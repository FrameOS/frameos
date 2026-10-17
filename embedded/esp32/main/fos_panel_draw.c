/* Drawing into a packed panel buffer. See fos_panel_draw.h. */
#include "fos_panel_draw.h"

#include <string.h>

static const uint8_t DIGITS[10][7] = {
    {0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E},
    {0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E},
    {0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F},
    {0x1E, 0x01, 0x01, 0x0E, 0x01, 0x01, 0x1E},
    {0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02},
    {0x1F, 0x10, 0x10, 0x1E, 0x01, 0x01, 0x1E},
    {0x0E, 0x10, 0x10, 0x1E, 0x11, 0x11, 0x0E},
    {0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08},
    {0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E},
    {0x0E, 0x11, 0x11, 0x0F, 0x01, 0x01, 0x0E},
};

static const uint8_t LETTERS[26][7] = {
    {0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11},
    {0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E},
    {0x0F, 0x10, 0x10, 0x10, 0x10, 0x10, 0x0F},
    {0x1E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1E},
    {0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F},
    {0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10},
    {0x0F, 0x10, 0x10, 0x17, 0x11, 0x11, 0x0F},
    {0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11},
    {0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E},
    {0x07, 0x02, 0x02, 0x02, 0x12, 0x12, 0x0C},
    {0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11},
    {0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F},
    {0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11},
    {0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11},
    {0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E},
    {0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10},
    {0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D},
    {0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11},
    {0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E},
    {0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04},
    {0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E},
    {0x11, 0x11, 0x11, 0x11, 0x0A, 0x0A, 0x04},
    {0x11, 0x11, 0x11, 0x15, 0x15, 0x1B, 0x11},
    {0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11},
    {0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04},
    {0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F},
};

static const uint8_t LOWER_LETTERS[26][7] = {
    {0x00, 0x00, 0x0E, 0x01, 0x0F, 0x11, 0x0F},
    {0x10, 0x10, 0x1E, 0x11, 0x11, 0x11, 0x1E},
    {0x00, 0x00, 0x0F, 0x10, 0x10, 0x10, 0x0F},
    {0x01, 0x01, 0x0F, 0x11, 0x11, 0x11, 0x0F},
    {0x00, 0x00, 0x0E, 0x11, 0x1F, 0x10, 0x0F},
    {0x06, 0x08, 0x1E, 0x08, 0x08, 0x08, 0x08},
    {0x00, 0x00, 0x0F, 0x11, 0x0F, 0x01, 0x0E},
    {0x10, 0x10, 0x1E, 0x11, 0x11, 0x11, 0x11},
    {0x04, 0x00, 0x0C, 0x04, 0x04, 0x04, 0x0E},
    {0x02, 0x00, 0x06, 0x02, 0x02, 0x12, 0x0C},
    {0x10, 0x10, 0x12, 0x14, 0x18, 0x14, 0x12},
    {0x0C, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E},
    {0x00, 0x00, 0x1A, 0x15, 0x15, 0x15, 0x15},
    {0x00, 0x00, 0x1E, 0x11, 0x11, 0x11, 0x11},
    {0x00, 0x00, 0x0E, 0x11, 0x11, 0x11, 0x0E},
    {0x00, 0x00, 0x1E, 0x11, 0x1E, 0x10, 0x10},
    {0x00, 0x00, 0x0F, 0x11, 0x0F, 0x01, 0x01},
    {0x00, 0x00, 0x17, 0x18, 0x10, 0x10, 0x10},
    {0x00, 0x00, 0x0F, 0x10, 0x0E, 0x01, 0x1E},
    {0x08, 0x08, 0x1E, 0x08, 0x08, 0x08, 0x06},
    {0x00, 0x00, 0x11, 0x11, 0x11, 0x13, 0x0D},
    {0x00, 0x00, 0x11, 0x11, 0x0A, 0x0A, 0x04},
    {0x00, 0x00, 0x11, 0x15, 0x15, 0x15, 0x0A},
    {0x00, 0x00, 0x11, 0x0A, 0x04, 0x0A, 0x11},
    {0x00, 0x00, 0x11, 0x11, 0x0F, 0x01, 0x0E},
    {0x00, 0x00, 0x1F, 0x02, 0x04, 0x08, 0x1F},
};

static const uint8_t GLYPH_DASH[7] = {0x00, 0x00, 0x00, 0x1F, 0x00, 0x00, 0x00};
static const uint8_t GLYPH_DOT[7] = {0x00, 0x00, 0x00, 0x00, 0x00, 0x0C, 0x0C};
static const uint8_t GLYPH_COLON[7] = {0x00, 0x0C, 0x0C, 0x00, 0x0C, 0x0C, 0x00};
static const uint8_t GLYPH_SLASH[7] = {0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10};
static const uint8_t GLYPH_LPAREN[7] = {0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02};
static const uint8_t GLYPH_RPAREN[7] = {0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08};
static const uint8_t GLYPH_COMMA[7] = {0x00, 0x00, 0x00, 0x00, 0x0C, 0x04, 0x08};
static const uint8_t GLYPH_QUOTE[7] = {0x0A, 0x0A, 0x00, 0x00, 0x00, 0x00, 0x00};

static const uint8_t *glyph_for(char raw)
{
    unsigned char c = (unsigned char)raw;
    if (c >= 'A' && c <= 'Z') return LETTERS[c - 'A'];
    if (c >= 'a' && c <= 'z') return LOWER_LETTERS[c - 'a'];
    if (c >= '0' && c <= '9') return DIGITS[c - '0'];
    if (c == '-') return GLYPH_DASH;
    if (c == '.') return GLYPH_DOT;
    if (c == ':') return GLYPH_COLON;
    if (c == '/') return GLYPH_SLASH;
    if (c == '(') return GLYPH_LPAREN;
    if (c == ')') return GLYPH_RPAREN;
    if (c == ',') return GLYPH_COMMA;
    if (c == '"') return GLYPH_QUOTE;
    return NULL;
}

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
    const uint8_t *rows = glyph_for(c);
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
    if (sw < digits_w1 + 4 || sh < 7 + 4) return false;

    /* Digits up to 3/5 of the width and 2/5 of the height: readable from
     * across a room, with the scene still around them. */
    int digit_scale = max_int(1, min_int((sw * 3 / 5) / digits_w1, (sh * 2 / 5) / 7));
    int pad = max_int(2, digit_scale * 2);
    const int inner_max = sw - 2 * pad;
    while (digit_scale > 1 && digits_w1 * digit_scale > inner_max) digit_scale--;
    int title_scale = 0;
    if (title != NULL && title[0]) {
        title_scale = fos_panel_fit_scale(title, max_int(1, digit_scale * 2 / 5), inner_max);
        if (fos_panel_text_width(title, title_scale) > inner_max ||
            7 * (title_scale + digit_scale) + 2 * pad + 2 > sh) {
            title_scale = 0; /* a tiny panel shows the digits alone */
        }
    }
    const int gap = title_scale ? max_int(2, digit_scale) : 0;
    const int inner_w = max_int(digits_w1 * digit_scale,
                                title_scale ? fos_panel_text_width(title, title_scale) : 0);
    const int inner_h = 7 * digit_scale + (title_scale ? 7 * title_scale + gap : 0);

    box->w = min_int(inner_w + 2 * pad, sw);
    box->h = min_int(inner_h + 2 * pad, sh);
    box->x = (sw - box->w) / 2;
    box->y = (sh - box->h) / 2;
    box->pad = pad;
    box->gap = gap;
    box->title_scale = title_scale;
    box->digit_scale = digit_scale;

    /* The scene rectangle on the panel (scene_to_panel of its corners). */
    switch (s->rotate) {
        case 90:
            box->px = sh - (box->y + box->h); box->py = box->x;
            box->pw = box->h; box->ph = box->w;
            break;
        case 180:
            box->px = sw - (box->x + box->w); box->py = sh - (box->y + box->h);
            box->pw = box->w; box->ph = box->h;
            break;
        case 270:
            box->px = box->y; box->py = sw - (box->x + box->w);
            box->pw = box->h; box->ph = box->w;
            break;
        default:
            box->px = box->x; box->py = box->y;
            box->pw = box->w; box->ph = box->h;
            break;
    }
    return box->pw > 0 && box->ph > 0 && box->px >= 0 && box->py >= 0 &&
           box->px + box->pw <= s->width && box->py + box->ph <= s->height;
}

static void box_span(const fos_panel_surface_t *s, const fos_panel_code_box_t *box,
                     size_t *stride, size_t *first, size_t *span)
{
    const int bpp = bits_per_pixel(s->format);
    *stride = row_bytes(s->width, bpp);
    *first = ((size_t)box->px * (size_t)bpp) / 8u;
    *span = row_bytes(box->px + box->pw, bpp) - *first;
}

size_t fos_panel_box_bytes(const fos_panel_surface_t *s, const fos_panel_code_box_t *box)
{
    if (s == NULL || box == NULL || bits_per_pixel(s->format) == 0) return 0;
    size_t stride, first, span;
    box_span(s, box, &stride, &first, &span);
    return span * (size_t)box->ph * (two_planes(s->format) ? 2u : 1u);
}

void fos_panel_box_save(const fos_panel_surface_t *s, const fos_panel_code_box_t *box,
                        uint8_t *out)
{
    if (s == NULL || box == NULL || out == NULL || bits_per_pixel(s->format) == 0) return;
    size_t stride, first, span;
    box_span(s, box, &stride, &first, &span);
    const int planes = two_planes(s->format) ? 2 : 1;
    for (int plane = 0; plane < planes; plane++) {
        const uint8_t *base = s->buf + (size_t)plane * stride * (size_t)s->height;
        for (int row = box->py; row < box->py + box->ph; row++) {
            memcpy(out, base + (size_t)row * stride + first, span);
            out += span;
        }
    }
}

void fos_panel_box_restore(const fos_panel_surface_t *s, const fos_panel_code_box_t *box,
                           const uint8_t *saved)
{
    if (s == NULL || box == NULL || s->buf == NULL || bits_per_pixel(s->format) == 0) return;
    if (saved == NULL) {
        for (int py = box->py; py < box->py + box->ph; py++) {
            for (int px = box->px; px < box->px + box->pw; px++) put_panel(s, px, py, false);
        }
        return;
    }
    size_t stride, first, span;
    box_span(s, box, &stride, &first, &span);
    const int planes = two_planes(s->format) ? 2 : 1;
    for (int plane = 0; plane < planes; plane++) {
        uint8_t *base = s->buf + (size_t)plane * stride * (size_t)s->height;
        for (int row = box->py; row < box->py + box->ph; row++) {
            memcpy(base + (size_t)row * stride + first, saved, span);
            saved += span;
        }
    }
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
