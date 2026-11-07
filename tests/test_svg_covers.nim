import pixie, pixie/fileformats/svg

# `coversOpaque`: an SVG whose first paint overwrites every pixel of the
# target, so a caller that would clear the target first need not.

proc covers(body: string, width = 480, height = 480): bool =
  let doc = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"480\" height=\"480\" viewBox=\"0 0 480 480\">" &
    body & "</svg>"
  parseSvg(doc, width, height).coversOpaque(width, height)

block:
  # The usual background rect, and the same at another raster size: the
  # viewBox scales it onto the target.
  doAssert covers("<rect x=\"0\" y=\"0\" width=\"480\" height=\"480\" fill=\"#090b14\"/><circle cx=\"10\" cy=\"10\" r=\"5\"/>")
  doAssert covers("<rect width=\"480\" height=\"480\" fill=\"#fff\"/>", 240, 120)
  doAssert covers("<rect x=\"-10\" y=\"-10\" width=\"500\" height=\"500\" fill=\"rgb(1,2,3)\"/>")
  # Translated and scaled, still covering.
  doAssert covers("<rect width=\"240\" height=\"240\" fill=\"#000\" transform=\"scale(2)\"/>")

block:
  # Not the first paint, not opaque, not solid, not whole, not square.
  doAssert not covers("<circle cx=\"10\" cy=\"10\" r=\"5\"/><rect width=\"480\" height=\"480\" fill=\"#000\"/>")
  doAssert not covers("<rect width=\"480\" height=\"480\" fill=\"#000\" opacity=\"0.5\"/>")
  doAssert not covers("<rect width=\"480\" height=\"480\" fill=\"#000\" fill-opacity=\"0.99\"/>")
  doAssert not covers("<rect width=\"480\" height=\"480\" fill=\"rgba(0,0,0,0.5)\"/>")
  doAssert not covers("<rect width=\"480\" height=\"480\" fill=\"none\" stroke=\"#000\"/>")
  doAssert not covers("<defs><linearGradient id=\"g\" gradientUnits=\"userSpaceOnUse\" x1=\"0\" y1=\"0\" x2=\"480\" y2=\"0\"><stop offset=\"0\" stop-color=\"#000\"/><stop offset=\"1\" stop-color=\"#fff\"/></linearGradient></defs><rect width=\"480\" height=\"480\" fill=\"url(#g)\"/>")
  doAssert not covers("<rect width=\"479\" height=\"480\" fill=\"#000\"/>")
  doAssert not covers("<rect x=\"0.5\" width=\"480\" height=\"480\" fill=\"#000\"/>")
  doAssert not covers("<rect width=\"480\" height=\"480\" rx=\"4\" fill=\"#000\"/>")
  doAssert not covers("<rect width=\"480\" height=\"480\" fill=\"#000\" transform=\"rotate(1 240 240)\"/>")
  doAssert not covers("<rect width=\"480\" height=\"480\" fill=\"#000\" display=\"none\"/>")
  doAssert not covers("<g opacity=\"0.5\"><rect width=\"480\" height=\"480\" fill=\"#000\"/></g>")
  doAssert not covers("")

block:
  # Inside a plain group it still counts; a group never makes its children a rect.
  doAssert covers("<g><rect width=\"480\" height=\"480\" fill=\"#123456\"/></g>")
  doAssert not covers("<g fill=\"#000\"><path d=\"M0 0H480V480H0Z\"/></g>")

block:
  # What it promises: rendered over anything, every pixel is the rect's colour.
  let
    doc = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"48\">" &
      "<rect width=\"64\" height=\"48\" fill=\"#204060\"/></svg>"
    svg = parseSvg(doc, 64, 48)
    target = newImage(64, 48)
  doAssert svg.coversOpaque(64, 48)
  target.fill(rgba(255, 0, 0, 128))
  svg.renderInto(target)
  for y in 0 ..< target.height:
    for x in 0 ..< target.width:
      doAssert target[x, y] == rgbx(0x20, 0x40, 0x60, 255), $target[x, y]

echo "svg coversOpaque ok"
