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
