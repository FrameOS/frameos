import std/[os, unicode, unittest]
import pixie
import ../font

when not defined(frameosEmbedded):
  proc copiedAssetsRoot(): string =
    normalizedPath(
      currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / "assets" / "copied"
    )

suite "font helpers":
  test "getAvailableFonts returns sorted ttf filenames with empty option":
    let root = getTempDir() / "frameos-font-tests"
    let fontsDir = root / "fonts"
    if dirExists(root):
      removeDir(root)
    createDir(fontsDir)
    defer:
      if dirExists(root):
        removeDir(root)

    writeFile(fontsDir / "b.ttf", "")
    writeFile(fontsDir / "a.ttf", "")
    writeFile(fontsDir / "ignored.otf", "")

    let fonts = getAvailableFonts(root)
    check fonts == @["", "a.ttf", "b.ttf"]

  test "getTypeface rejects path traversal names":
    expect(ValueError):
      discard getTypeface("../evil.ttf", getTempDir())
    expect(ValueError):
      discard getTypeface("/tmp/evil.ttf", getTempDir())
    expect(ValueError):
      discard getTypeface("~/evil.ttf", getTempDir())

  test "missing font falls back to default typeface":
    let tf = getTypeface("this-font-does-not-exist.ttf", getTempDir())
    check tf != nil

  when not defined(frameosEmbedded):
    test "default typeface uses Noto Color Emoji from assets path as fallback":
      let assetsRoot = copiedAssetsRoot()
      check fileExists(assetsRoot / "fonts" / "NotoColorEmoji.ttf")

      let
        tf = getTypeface("", assetsRoot)
        emojiTypeface = tf.fallbackTypeface(Rune(0x1F600))

      check emojiTypeface != nil
      check emojiTypeface != tf
      check emojiTypeface.hasColorGlyph(Rune(0x1F600))

  test "cloneFontWithColor keeps size and updates color":
    let original = newFont(getDefaultTypeface(), 19, parseHtmlColor("#112233"))
    let requestedColor = parseHtmlColor("#445566")
    let clone = cloneFontWithColor(original, requestedColor)

    check clone.size == original.size
    check clone.paint.color == requestedColor
