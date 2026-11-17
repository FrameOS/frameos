/*
 * Nim's unicode.toUpper / toLower (Rune) answered from QuickJS's case tables.
 *
 * The linker routes every call to `nuctoUpper` / `nuctoLower` (the C names
 * std/unicode exports them under) here: -Wl,--wrap in CMakeLists.txt. The
 * callers are pixie's text-transform (the JSX layer's `uppercase` /
 * `lowercase` / `capitalize` classes) and data/localImage's search. A
 * string's toLower / toUpper calls them inside std/unicode, where no wrap
 * reaches: Nim code for the ESP32 maps a string rune by rune instead. Nim's own tables (toUpperSinglets, toLowerSinglets and their
 * ranges, ~11 KB) then link nowhere, while QuickJS's are in the image anyway
 * for String#toUpperCase.
 *
 * The answer is Nim's simple one-rune mapping, from QuickJS's full one: where
 * that is one code point it is the answer; where it is several (ß -> SS, the
 * ligatures, İ -> i + dot above, the Greek capitals with a subscript iota)
 * the simple mapping is what Nim's tables hold, worked out below. QuickJS's
 * tables are newer Unicode than Nim's, so 281 code points Nim leaves alone
 * map too (Roman numerals, circled letters, recent scripts), as they do in
 * the frame's own JavaScript and in a browser.
 *
 * Host test: frameos/src/embedded/tests/test_unicode_case_wrap.nim (every
 * code point against Nim's std/unicode).
 */
#include <stddef.h>
#include <stdint.h>

#include "cutils.h"
#include "libunicode.h"

int32_t __wrap_nuctoUpper(int32_t c);
int32_t __wrap_nuctoLower(int32_t c);

static int32_t simple_case(int32_t c, int conv_type)
{
    if (c < 0 || c > 0x10FFFF)
        return c;
    uint32_t res[LRE_CC_RES_LEN_MAX];
    int n = lre_case_conv(res, (uint32_t)c, conv_type);
    if (n == 1)
        return (int32_t)res[0];
    if (conv_type == 1) {
        /* İ: the full lowercase is i + U+0307, the simple one is i. */
        return c == 0x130 ? 0x69 : c;
    }
    /* A Greek small letter with ypogegrammeni uppercases to two letters;
       its simple uppercase is the capital with prosgegrammeni, 8 or 9 on. */
    if (c >= 0x1F80 && c <= 0x1FAF && (c & 0xF) < 8)
        return c + 8;
    if (c == 0x1FB3 || c == 0x1FC3 || c == 0x1FF3)
        return c + 9;
    return c;
}

int32_t __wrap_nuctoUpper(int32_t c)
{
    return simple_case(c, 0);
}

int32_t __wrap_nuctoLower(int32_t c)
{
    return simple_case(c, 1);
}
