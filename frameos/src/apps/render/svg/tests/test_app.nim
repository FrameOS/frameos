import std/[json, options, strutils, unittest]
import pixie
import pixie/fileformats/svg

import ../app
import frameos/types

proc makeConfig(width = 6, height = 4): FrameConfig =
  FrameConfig(width: width, height: height, rotate: 0)

proc makeScene(config: FrameConfig): FrameScene =
  FrameScene(
    frameConfig: config,
    logger: Logger(log: proc(payload: JsonNode) = discard)
  )

suite "render/svg app":
  test "empty svg string routes through error handling without raising":
    let config = makeConfig(5, 3)
    let app = App(
      frameConfig: config,
      scene: makeScene(config),
      appConfig: AppConfig(
        inputImage: none(Image),
        svg: "",
        placement: "cover",
        offsetX: 0,
        offsetY: 0,
        blendMode: "normal"
      )
    )

    let output = app.get(ExecutionContext(hasImage: false))
    check output.width == 5
    check output.height == 3

  test "invalid data url input is caught by render error path":
    let config = makeConfig(4, 2)
    let app = App(
      frameConfig: config,
      scene: makeScene(config),
      appConfig: AppConfig(
        inputImage: none(Image),
        svg: "data:image/svg+xml;base64",
        placement: "stretch",
        offsetX: 0,
        offsetY: 0,
        blendMode: "normal"
      )
    )

    let context = ExecutionContext(image: newImage(4, 2), hasImage: true)
    app.run(context)
    check context.image.width == 4
    check context.image.height == 2

  test "paints onto the canvas it is given, over what was there":
    # A gradient, a half-transparent shape and an outline over a canvas that
    # already has content. The app used to rasterize into a second image the
    # size of the canvas and draw that; it now paints the canvas directly.
    # The two composite in a different order, so anti-aliased edges round
    # differently (and differently again under x86 SIMD): the picture is
    # checked where only the content decides it.
    const svg = """<svg viewBox="0 0 48 32" width="48" height="32">
      <defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="32">
        <stop offset="0" stop-color="#efe7d7" stop-opacity="0.6"/><stop offset="1" stop-color="#20305f"/>
      </linearGradient></defs>
      <rect x="4" y="2" width="40" height="28" rx="6" fill="url(#g)"/>
      <circle cx="24" cy="16" r="9" fill="#9b2f24" opacity="0.5"/>
      <line x1="6" y1="28" x2="42" y2="4" stroke="#30251d" stroke-width="2" stroke-linecap="round"/>
    </svg>"""
    var under = newImage(48, 32)
    under.fill(rgba(30, 160, 90, 255))
    let expected = under.copy()
    expected.draw(newImage(parseSvg(svg, 48, 32)), blendMode = NormalBlend)

    for placement in ["stretch", "cover", "center"]:
      let config = makeConfig(48, 32)
      let app = App(
        frameConfig: config,
        scene: makeScene(config),
        appConfig: AppConfig(inputImage: none(Image), svg: svg, placement: placement,
          offsetX: 0, offsetY: 0, blendMode: "normal")
      )
      let context = ExecutionContext(image: under.copy(), hasImage: true)
      app.run(context)
      # Outside every shape the canvas is untouched: composited, not replaced.
      check context.image[1, 1] == under[1, 1]
      check context.image[46, 31] == under[46, 31]
      # Inside them, well away from any edge: the half-transparent gradient
      # over the canvas, the circle over both, the gradient's opaque end.
      for (x, y) in [(12, 6), (24, 12), (8, 20), (38, 26)]:
        let a = expected[x, y]
        let b = context.image[x, y]
        check max(max(abs(a.r.int - b.r.int), abs(a.g.int - b.g.int)), abs(a.b.int - b.b.int)) <= 3
        check b.a == 255

  test "markup pixie cannot parse is logged with the parser's reason":
    var logged: seq[string] = @[]
    let config = makeConfig(8, 8)
    let app = App(
      frameConfig: config,
      scene: FrameScene(
        frameConfig: config,
        logger: Logger(log: proc(payload: JsonNode) = logged.add($payload))
      ),
      appConfig: AppConfig(inputImage: none(Image), svg: "<svg><rect width=", placement: "stretch",
        offsetX: 0, offsetY: 0, blendMode: "normal")
    )
    app.run(ExecutionContext(image: newImage(8, 8), hasImage: true))
    check logged.len > 0
    check "Error rendering SVG: " in logged[^1]
    check "Failed to render SVG." notin logged[^1]
