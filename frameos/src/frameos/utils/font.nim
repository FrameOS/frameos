import os
import pixie
import tables
import strutils
import assets/fonts as fontAssets

var defaultFont = "Ubuntu-Regular_1.ttf" # compiled into the binary by nimassets
var typefaces: Table[string, Typeface] = initTable[string, Typeface]()

proc getTypeface*(font: string, assetsPath: string): Typeface =
  if not typefaces.hasKey(font):
    # sanitize input, expect only a legit file name (can't go .. or /etc/passwd)
    if "/" in font or ".." in font or "~" in font:
      raise newException(ValueError, "Invalid font name")
    let ttf = if font == defaultFont:
      fontAssets.getAsset("assets/compiled/fonts/" & font)
    else:
      readFile(assetsPath & "/fonts/" & font)
    typefaces[font] = parseTtf(ttf)
  return typefaces[font]

proc hasTypeface*(font: string, assetsPath: string): bool =
  if "/" in font or ".." in font or "~" in font:
    raise newException(ValueError, "Invalid font name")
  return typefaces.hasKey(font) or font == defaultFont or fileExists(assetsPath & "/fonts/" & font)

proc getDefaultTypeface*(): Typeface =
  if not typefaces.hasKey(defaultFont):
    typefaces[defaultFont] = parseTtf(fontAssets.getAsset("assets/compiled/fonts/" & defaultFont))
  return typefaces[defaultFont]

proc newFont*(typeface: Typeface, size: float, color: Color): Font =
  result = newFont(typeface)
  result.size = size
  result.paint.color = color
