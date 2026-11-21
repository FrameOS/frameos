from __future__ import annotations

import re
from pathlib import Path

# Source invariants for the ESP32's shared 4-bit canvas.
#
# Gallery aborted the reTerminal E1003's render on its second photo
# (2026-11-10), partly because the canvas and the packed picture were two
# 1.31 MB blocks holding the same bytes: a sixteen-grey panel's pack is a copy.
# Unrotated, the panel buffer main.c reserves is now the canvas too. That is
# safe only while three rules hold, all across the C / Nim line, so they are
# read off the source here (the pack into its own buffer is tested in
# frameos/src/frameos/utils/tests/test_dither.nim):
#   - only a picture the pack would copy byte for byte shares (no turn, the
#     same size, four bits on both sides);
#   - the render borrows the buffer before the scene draws, and does not draw
#     when someone else has it;
#   - anything else that borrows it is counted, and the next render forgets
#     what it knew of the canvas (it was drawn over).

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
MAIN_C = ESP32_DIR / "main" / "main.c"
CLIENT_C = ESP32_DIR / "main" / "fos_client.c"
FRAMEBUFFER_C = ESP32_DIR / "main" / "fos_framebuffer.c"
EMBEDDED_MAIN = REPO_ROOT / "frameos" / "src" / "embedded" / "embedded_main.nim"


def _strip_comments(source: str) -> str:
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.DOTALL)
    return re.sub(r"//[^\n]*", "", source)


def _body(text: str, name: str) -> str:
    match = re.search(rf"^[a-z][^;{{}}\n]*\b{name}\([^;{{}}]*\)\s*\{{", text, re.MULTILINE)
    assert match is not None, f"no definition of {name}"
    depth = 0
    for index in range(match.end() - 1, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return text[match.end() - 1 : index + 1]
    raise AssertionError(f"unterminated body for {name}")


def test_only_an_unturned_sixteen_grey_picture_shares():
    main = _strip_comments(MAIN_C.read_text())
    rule = _body(main, "canvas_is_panel_picture")
    for condition in (
        "fos_display_format() == FOS_PIXEL_4BPP_GRAY",
        "fos_display_canvas_bits_per_pixel() == 4",
        "config->rotate == 0",
        "fos_display_canvas_bytes() == fos_display_buffer_size()",
        "fos_framebuffer_reserved_bytes() == fos_display_buffer_size()",
    ):
        assert condition in rule, f"main.c: canvas_is_panel_picture no longer checks {condition}"
    share = main.index("frameos_nim_share_canvas(")
    assert "canvas_is_panel_picture(config)" in main[main.rfind("if", 0, share) : share]


def test_the_render_borrows_the_panel_buffer_without_counting_itself():
    main = _strip_comments(MAIN_C.read_text())
    assert re.search(r"frameos_nim_set_render_buffer_hooks\(\(void \*\(\*\)\(size_t\)\)fos_framebuffer_acquire_render,", main), (
        "main.c: the Nim render's buffer hook must be fos_framebuffer_acquire_render, or every render counts as "
        "a foreign lend and the scene's damage records are thrown away each time"
    )
    framebuffer = _strip_comments(FRAMEBUFFER_C.read_text())
    assert "return acquire(len, false);" in _body(framebuffer, "fos_framebuffer_acquire")
    assert "return acquire(len, true);" in _body(framebuffer, "fos_framebuffer_acquire_render")
    assert re.search(r"if \(!render\) s_foreign_lends\+\+;", _body(framebuffer, "acquire"))


def test_a_render_after_a_foreign_lend_forgets_the_canvas():
    client = _strip_comments(CLIENT_C.read_text())
    check = re.search(
        r"if \(frameos_nim_canvas_shared\(\) && fos_framebuffer_foreign_lends\(\) != seen_foreign_lends\) \{"
        r"\s*seen_foreign_lends = fos_framebuffer_foreign_lends\(\);\s*frameos_nim_canvas_forget\(\);",
        client,
    )
    assert check is not None, "fos_client.c: a foreign lend of the shared canvas no longer makes the next render whole"


# The other way round: a colour panel's picture packed in the first bytes of
# its 565 canvas (the reTerminal E1004: 960 KB of 8 MB). The pack into its own
# bytes is tested in frameos/src/frameos/utils/tests/test_palette_pack.nim; the
# rules here are that only an unturned colour panel with a 565 canvas and no
# partial waveform does it, that it reserves no panel buffer of its own, that
# the display's task refreshes from the canvas without a copy while nothing
# writes it, and that the scene's records of the canvas go after each pack.

DISPLAY_C = ESP32_DIR / "components" / "frameos_display" / "frameos_display.c"


def test_only_an_unturned_colour_panel_with_a_565_canvas_packs_in_it():
    main = _strip_comments(MAIN_C.read_text())
    rule = _body(main, "canvas_holds_panel_picture")
    for condition in (
        "FOS_PIXEL_4BPP_SPECTRA6",
        "FOS_PIXEL_4BPP_7COLOR",
        "FOS_PIXEL_2BPP_BWYR",
        "fos_display_canvas_bits_per_pixel() == 16",
        "config->rotate == 0",
        "!fos_display_supports_partial()",
        "fos_display_buffer_size() <= fos_display_canvas_bytes()",
    ):
        assert condition in rule, f"main.c: canvas_holds_panel_picture no longer checks {condition}"
    # Only where memory needs it: the canvas is the display's for the whole
    # refresh, so the next render waits for the glass (37.9 s from a render's
    # start to its picture on an E1002 that packed in place, 2026-11-21).
    assert re.search(
        r"fos_display_canvas_bytes\(\) \+ fos_display_buffer_size\(\) >\s*"
        r"heap_caps_get_total_size\(MALLOC_CAP_SPIRAM\) / PACK_IN_CANVAS_PSRAM_SHARE_DIVISOR",
        rule,
    ), "main.c: canvas_holds_panel_picture packs in the canvas where a panel buffer of its own fits"
    assert "if (!canvas_holds_panel_picture(config)) fos_framebuffer_reserve(fos_display_buffer_size());" in main, (
        "main.c: a panel whose picture is packed in its canvas still reserves a panel buffer of its own"
    )
    adopt = re.search(
        r"else if \(canvas_holds_panel_picture\(config\) && frameos_nim_reserve_canvas\(fos_display_canvas_bytes\(\)\)\) \{"
        r"\s*uint8_t \*canvas = frameos_nim_canvas_buffer\(fos_display_canvas_bytes\(\)\);"
        r"\s*fos_framebuffer_adopt\(canvas, fos_display_buffer_size\(\)\);"
        r"\s*frameos_nim_share_canvas\(canvas, fos_display_canvas_bytes\(\)\);"
        r"\s*fos_display_lend\(canvas\);",
        main,
    )
    assert adopt is not None, "main.c: the canvas is no longer the panel buffer, shared and lent to the display"
    # Rendered on the server, or no canvas: a panel buffer of its own.
    assert re.search(
        r"canvas_holds_panel_picture\(config\) && fos_framebuffer_reserved_bytes\(\) == 0\) \{\s*"
        r"fos_framebuffer_reserve\(fos_display_buffer_size\(\)\);",
        main,
    )


def test_nothing_writes_the_canvas_while_the_display_refreshes_from_it():
    framebuffer = _strip_comments(FRAMEBUFFER_C.read_text())
    assert "!fos_display_holds(s_reserved)" in _body(framebuffer, "acquire"), (
        "fos_framebuffer.c: the panel buffer is lent while the display still refreshes from it"
    )
    client = _strip_comments(CLIENT_C.read_text())
    wait = client.index("fos_display_wait_for(fos_framebuffer_reserved_buffer());")
    assert wait < client.index("frameos_nim_render_alloc(&buf", wait), (
        "fos_client.c: the scene draws in the canvas before the display is done with the picture in it"
    )
    for overlay in ("lan_overlay_end", "notice_overlay_end"):
        body = _body(client, overlay)
        assert body.index("fos_display_wait_for(ov->surface.buf);") < body.index("fos_panel_box_copy"), (
            f"fos_client.c: {overlay} restores the picture under the overlay while the display reads it"
        )
    display = _strip_comments(DISPLAY_C.read_text())
    assert "s_refresh_queue.lent = buf;" in _body(display, "fos_display_lend")
    assert "refresh_wait();" in _body(display, "fos_display_wait_for")


def test_a_colour_canvas_packed_into_itself_is_forgotten():
    nim = EMBEDDED_MAIN.read_text()
    impl = nim[nim.index("proc fos_nim_render_alloc_impl(") :]
    impl = impl[: impl.index("\nproc ", 10)]
    forget = re.search(
        r"if drawsInPanel and not \(lastPackedFromCanvas and canvas\.format == pfGray4\):"
        r"(?:\s*#[^\n]*)*\s*rhythmForgetCanvases\(\)\s*lastPackedFromCanvas = false",
        impl,
    )
    assert forget is not None, (
        "embedded_main.nim: after a pack into the canvas the scene's records of what it drew there stay"
    )
    assert impl.index("packImageForFormat(image, packedBuf") < forget.start()


def test_the_scene_draws_in_the_panel_buffer_only_once_it_holds_it():
    nim = EMBEDDED_MAIN.read_text()
    impl = nim[nim.index("proc fos_nim_render_alloc_impl(") :]
    impl = impl[: impl.index("\nproc ", 10)]
    borrow = impl.index("if drawsInPanel:")
    draw = impl.index("renderKeptFrameImage()")
    assert borrow < draw, "embedded_main.nim: the scene draws before the panel buffer is borrowed"
    refused = impl[borrow:draw]
    assert "if borrowed != sharedCanvas:" in refused and "return 1" in refused, (
        "embedded_main.nim: a render goes ahead while the panel buffer is lent to something else"
    )


def test_the_planes_charge_the_panel_buffer_by_the_same_share():
    """esp32_canvas_is_panel_buffer (and its TS copies, pinned by
    docs/device-limits-fixtures.json) reads the share main.c packs in place by."""
    from app.utils.device_limits import ESP32_PACK_IN_CANVAS_PSRAM_SHARE_DIVISOR

    divisor = re.search(r"#define PACK_IN_CANVAS_PSRAM_SHARE_DIVISOR (\d+)", MAIN_C.read_text())
    assert divisor is not None, "main.c: no PACK_IN_CANVAS_PSRAM_SHARE_DIVISOR"
    assert int(divisor.group(1)) == ESP32_PACK_IN_CANVAS_PSRAM_SHARE_DIVISOR
    for ts in (REPO_ROOT / "frameos" / "wasm" / "src" / "devices.ts", REPO_ROOT / "frontend" / "src" / "utils" / "deviceLimits.ts"):
        assert f"ESP32_PACK_IN_CANVAS_PSRAM_SHARE_DIVISOR = {divisor.group(1)}" in ts.read_text(), ts
