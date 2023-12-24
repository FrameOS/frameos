import options
import pixie
import times
import assets/fonts as fontAssets

var typeface: Option[Typeface] = none(TypeFace)

proc getDefaultTypeface*(): Typeface =
  if typeface.isNone:
    let parseTtfTimer = epochTime()
    typeface = some(parseTtf(fontAssets.getAsset(
        "assets/fonts/Ubuntu-Regular_1.ttf")))
    echo "Time taken to parse ttf: ", (epochTime() - parseTtfTimer) * 1000, " ms"
  return typeface.get()

proc newFont*(typeface: Typeface, size: float32, color: Color): Font =
  result = newFont(typeface)
  result.size = size
  result.paint.color = color
