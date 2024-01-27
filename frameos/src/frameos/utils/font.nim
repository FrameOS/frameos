import options
import pixie
import assets/fonts as fontAssets

var typeface: Option[Typeface] = none(TypeFace)

proc getDefaultTypeface*(): Typeface {.gcsafe.} =
  # We assume nobody overrides this font in a thread. Worse case they should override to the same data.
  {.cast(gcsafe).}:
    if typeface.isNone:
      typeface = some(parseTtf(fontAssets.getAsset(
          "assets/fonts/Ubuntu-Regular_1.ttf")))
    return typeface.get()

proc newFont*(typeface: Typeface, size: float, color: Color): Font =
  result = newFont(typeface)
  result.size = size
  result.paint.color = color
