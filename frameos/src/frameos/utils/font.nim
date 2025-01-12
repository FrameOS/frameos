import os
import pixie
import locks
import algorithm
import tables
import strutils
import assets/fonts as fontAssets

const defaultFont = "Ubuntu-Regular_1.ttf" # compiled into the binary by nimassets
var typefaces: Table[string, Typeface] = initTable[string, Typeface]()

var typefaceLock: Lock

proc getDefaultTypeface*(): Typeface =
  if not typefaces.hasKey(defaultFont):
    typefaces[defaultFont] = parseTtf(fontAssets.getAsset("assets/compiled/fonts/" & defaultFont))
  return typefaces[defaultFont]

proc getTypeface*(font: string, assetsPath: string): Typeface =
  if not typefaces.hasKey(font):
    # sanitize input, expect only a legit file name (can't go .. or /etc/passwd)
    if "/" in font or ".." in font or "~" in font:
      raise newException(ValueError, "Invalid font name")
    withLock typefaceLock:
      let ttf = if font == defaultFont:
        fontAssets.getAsset("assets/compiled/fonts/" & font)
      elif fileExists(assetsPath & "/fonts/" & font):
        readFile(assetsPath & "/fonts/" & font)
      else:
        fontAssets.getAsset("assets/compiled/fonts/" & defaultFont)
      typefaces[font] = parseTtf(ttf)
  return typefaces[font]

proc newFont*(typeface: Typeface, size: float, color: Color): Font =
  result = newFont(typeface)
  result.size = size
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
