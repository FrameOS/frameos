import pixie
import tables
import strutils
import assets/fonts as fontAssets

var defaultFont = "Ubuntu-Regular_1.ttf"
var typefaces: Table[string, Typeface] = initTable[string, Typeface]()

proc getTypeface*(font: string): Typeface =
  {.cast(gcsafe).}: # We're reading an immutable global. It's fine.
    # sanitize input, expect only a legit file name (can't go .. or /etc/passwd)\
    if "/" in font or ".." in font:
      raise newException(ValueError, "Invalid font name")
    if not typefaces.hasKey(font):
      typefaces[font] = parseTtf(fontAssets.getAsset("assets/fonts/" & font))
    return typefaces[font]

proc getDefaultTypeface*(): Typeface =
  return getTypeface(defaultFont)

proc newFont*(typeface: Typeface, size: float, color: Color): Font =
  result = newFont(typeface)
  result.size = size
  result.paint.color = color
