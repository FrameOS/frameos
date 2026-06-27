import os
import pixie
import locks
import algorithm
import tables
import strutils
import assets/fonts as fontAssets
when defined(frameosEmbedded):
  import zippy

const defaultFont = "Ubuntu-Regular.ttf" # compiled into the binary by nimassets
const emojiFallbackFont = "NotoColorEmoji.ttf"
var typefaces: Table[string, Typeface] = initTable[string, Typeface]()

var typefaceLock: Lock

proc readEmbeddedFont(path: string): string =
  when defined(frameosEmbedded):
    # zippy's gzip path verifies the trailer with `dst.len mod (1 shl 32)`,
    # and `1 shl 32` overflows a 32-bit Xtensa int to 0 -> divide-by-zero.
    # The compiled assets use a plain 10-byte gzip header (flags=0), so strip
    # the header + 8-byte trailer and raw-inflate, skipping that check.
    let gz = fontAssets.getCompressedAsset(path)
    if gz.len >= 18 and gz[0] == '\x1f' and gz[1] == '\x8b' and gz[3] == '\0':
      return uncompress(gz[10 ..< gz.len - 8], dfDeflate)
    return fontAssets.getAsset(path)
  elif compiles(fontAssets.getAssetToStr(path)):
    fontAssets.getAssetToStr(path)
  else:
    fontAssets.getAsset(path)

proc getDefaultTypeface*(): Typeface =
  if not typefaces.hasKey(defaultFont):
    withLock typefaceLock:
      if not typefaces.hasKey(defaultFont):
        typefaces[defaultFont] = parseTtf(readEmbeddedFont("assets/compiled/fonts/" & defaultFont))
  return typefaces[defaultFont]

proc hasFallbackTypeface(typeface, fallback: Typeface): bool =
  for existing in typeface.fallbacks:
    if existing == fallback:
      return true
  false

proc getEmojiFallbackTypeface(assetsPath: string): Typeface =
  when defined(frameosEmbedded):
    return nil
  else:
    if assetsPath.len == 0:
      return nil

    let fontPath = assetsPath / "fonts" / emojiFallbackFont
    if not fileExists(fontPath):
      return nil

    let cacheKey = "emoji:" & normalizedPath(fontPath)
    if not typefaces.hasKey(cacheKey):
      withLock typefaceLock:
        if not typefaces.hasKey(cacheKey):
          typefaces[cacheKey] = parseTtf(readFile(fontPath))
    return typefaces[cacheKey]

proc withEmojiFallback(typeface: Typeface, assetsPath: string): Typeface =
  result = typeface
  when not defined(frameosEmbedded):
    let fallback = getEmojiFallbackTypeface(assetsPath)
    if fallback == nil or typeface.hasFallbackTypeface(fallback):
      return

    withLock typefaceLock:
      if not typeface.hasFallbackTypeface(fallback):
        typeface.fallbacks.add(fallback)

proc getTypeface*(font: string, assetsPath: string): Typeface =
  if font.len == 0 or font == defaultFont:
    return getDefaultTypeface().withEmojiFallback(assetsPath)
  when defined(frameosEmbedded):
    # Custom scene font names often come from desktop/web renders. On embedded
    # targets, reuse the parsed default typeface to avoid repeated TTF parsing
    # and scarce internal heap pressure.
    return getDefaultTypeface()
  else:
    # sanitize input, expect only a legit file name (can't go .. or /etc/passwd)
    if "/" in font or ".." in font or "~" in font:
      raise newException(ValueError, "Invalid font name")

    # Missing custom fonts use the default face. Do this before taking the
    # typeface lock because getDefaultTypeface uses the same lock.
    let fontPath = assetsPath & "/fonts/" & font
    if not fileExists(fontPath):
      return getDefaultTypeface().withEmojiFallback(assetsPath)

    if not typefaces.hasKey(font):
      withLock typefaceLock:
        if not typefaces.hasKey(font):
          typefaces[font] = parseTtf(readFile(fontPath))
    return typefaces[font].withEmojiFallback(assetsPath)

proc newFont*(typeface: Typeface, size: float, color: Color): Font =
  result = newFont(typeface)
  result.size = size
  result.paint.color = color

proc cloneFontWithColor*(f: Font, color: Color): Font =
  result = f.copy()
  result.paint.color = color

proc getAvailableFonts*(assetsPath: string): seq[string] =
  var fonts = @[""]
  if not dirExists(assetsPath & "/fonts"):
    return fonts
  for kind, path in walkDir(assetsPath & "/fonts"):
    if path.endsWith(".ttf") and kind == pcFile:
      fonts.add(path[assetsPath.len + 7..^1])
  fonts.sort()
  return fonts
