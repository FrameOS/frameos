import options
import pixie
import assets/fonts as fontAssets

var typeface: Option[Typeface] = none(TypeFace)

proc getDefaultTypeface*(): Typeface {.gcsafe.} =
  {.cast(gcsafe).}: # TODO: find a better way
    if typeface.isNone:
      typeface = some(parseTtf(fontAssets.getAsset(
          "assets/fonts/Ubuntu-Regular_1.ttf")))
    return typeface.get()

proc newFont*(typeface: Typeface, size: float, color: Color): Font =
  result = newFont(typeface)
  result.size = size
  result.paint.color = color
