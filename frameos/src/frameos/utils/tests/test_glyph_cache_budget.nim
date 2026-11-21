import std/unittest
import frameos/utils/memory

# The ESP32's glyph cache budget (docs/jsx-ui.md "The glyph cache",
# docs/esp32-fonts.md): a 32nd of what the panel leaves the scenes, 64 KB at
# least, and a ceiling by the board's PSRAM: 128 KB on 8 MB, 512 KB on 16 MB,
# 1 MB on 32 MB.

const
  KB = 1024
  MB = 1024 * 1024

var panelBytes = 0

proc panel(): int {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    panelBytes

proc board(psram, panelTakes: int) =
  deviceMemoryBytesOverride = psram
  panelBytes = panelTakes
  panelMemoryBytes = panel

suite "glyph cache budget":
  teardown:
    deviceMemoryBytesOverride = 0
    panelMemoryBytes = nil

  test "a host with plenty sets its own":
    deviceMemoryBytesOverride = 0
    check glyphCacheBudgetBytes() == 0

  test "8 MB boards keep the 64-128 KB of before":
    # The 13.3" colour E1004: about 2.5 MB left beside its canvas.
    board(8 * MB - 200 * KB, 8 * MB - 200 * KB - 2_540_000)
    check glyphCacheBudgetBytes() == 2_540_000 div 32
    # A small panel leaves most of 8 MB: the ceiling.
    board(8 * MB - 200 * KB, 1 * MB)
    check glyphCacheBudgetBytes() == 128 * KB
    # Next to nothing left: the floor.
    board(8 * MB - 200 * KB, 7 * MB)
    check glyphCacheBudgetBytes() == 64 * KB

  test "16 MB boards may keep up to 512 KB, for many faces from the card":
    # The heap of a 16 MB board reports a little under 16 MiB.
    board(16 * MB - 300 * KB, 2 * MB)
    check glyphCacheBudgetBytes() == (16 * MB - 300 * KB - 2 * MB) div 32
    check glyphCacheBudgetBytes() > 128 * KB
    check glyphCacheBudgetBytes() <= 512 * KB
    # A 13.3" panel on 16 MB leaves less, and the share follows it.
    board(16 * MB - 300 * KB, 9 * MB)
    check glyphCacheBudgetBytes() == (16 * MB - 300 * KB - 9 * MB) div 32

  test "32 MB boards up to 1 MB":
    board(32 * MB - 300 * KB, 1 * MB)
    check glyphCacheBudgetBytes() == (32 * MB - 300 * KB - 1 * MB) div 32
    check glyphCacheBudgetBytes() > 512 * KB
    board(32 * MB - 300 * KB, 20 * MB)
    check glyphCacheBudgetBytes() == (32 * MB - 300 * KB - 20 * MB) div 32

  test "the page cache for fonts on the card grows from 16 MB":
    board(8 * MB - 200 * KB, 2 * MB)
    check fontPageSlots() == 16
    board(16 * MB - 300 * KB, 2 * MB)
    check fontPageSlots() == 64
