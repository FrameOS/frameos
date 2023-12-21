import pixie
import assets/fonts as fontAssets
import httpclient
import std/strformat
import times

proc downloadImage(url: string): Image =
  let client = newHttpClient()
  try:
    let content = client.getContent(url)
    result = decodeImage(content)
  finally:
    client.close()

proc createImage(width, height: int): Image =
  echo "---- Creating image ----"
  let image = newImage(width, height)
  let keyword = "random"
  let url = &"https://source.unsplash.com/random/{width}x{height}/?{keyword}"

  let downloadTimer = epochTime()
  let background = downloadImage(url)
  echo "Time taken to downlooad: ", (epochTime() - downloadTimer) * 1000, " ms"

  let drawTimer = epochTime()
  image.draw(background)
  echo "Time taken to draw background: ", (epochTime() - drawTimer) * 1000, " ms"

  let parseTtfTimer = epochTime()
  let typeface = parseTtf(fontAssets.getAsset("assets/fonts/Ubuntu-Regular_1.ttf"))
  echo "Time taken to parse ttf: ", (epochTime() - parseTtfTimer) * 1000, " ms"

  proc newFont(typeface: Typeface, size: float32, color: Color): Font =
    result = newFont(typeface)
    result.size = size
    result.paint.color = color

  let drawFontTimer = epochTime()
  let spans = @[
    newSpan("verb [with object] ",
      newFont(typeface, 12, color(0.78125, 0.78125, 0.78125, 1))),
    newSpan("unladen strallow\n", newFont(typeface, 36, color(0, 0, 0, 1))),
    newSpan("\nstral·low\n", newFont(typeface, 13, color(0, 0.5, 0.953125, 1))),
    newSpan("\n1. free (something) from restrictive restrictions \"the regulations are intended to strallow changes in public policy\" ",
        newFont(typeface, 14, color(0.3125, 0.3125, 0.3125, 1)))
  ]

  image.fillText(typeset(spans, vec2(180, 180)), translate(vec2(10, 10)))
  echo "Time taken to draw text: ", (epochTime() - drawFontTimer) * 1000, " ms"
  return image

export createImage
