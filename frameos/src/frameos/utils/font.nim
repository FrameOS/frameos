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
    typefaces[defaultFont] = parseTtf(readEmbeddedFont("assets/compiled/fonts/" & defaultFont))
  return typefaces[defaultFont]

proc getTypeface*(font: string, assetsPath: string): Typeface =
  if not typefaces.hasKey(font):
    # sanitize input, expect only a legit file name (can't go .. or /etc/passwd)
    if "/" in font or ".." in font or "~" in font:
      raise newException(ValueError, "Invalid font name")
    withLock typefaceLock:
      let ttf = if font == defaultFont:
        readEmbeddedFont("assets/compiled/fonts/" & font)
      elif fileExists(assetsPath & "/fonts/" & font):
        readFile(assetsPath & "/fonts/" & font)
      else:
        readEmbeddedFont("assets/compiled/fonts/" & defaultFont)
      typefaces[font] = parseTtf(ttf)
  return typefaces[font]

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
