## The Calendar app (repo/apps/image/calendar), the JavaScript that replaced the
## built-in render/calendar, run for real through the JS app runtime: the image
## the runtime rasterizes from its SVG, at the places the built-in app painted.
## The grouping, colour and layout rules are the app's own tests (app.test.ts).

import std/[json, os, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/values

const AppDir = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".." / "repo" / "apps" / "image" / "calendar"
let appSource = readFile(AppDir / "app.ts")
let appConfigJson = readFile(AppDir / "config.json")

proc draw(config: JsonNode, width = 800, height = 480): Image =
  let frame = FrameConfig(width: width, height: height, rotate: 0, scalingMode: "cover", debug: false,
    saveAssets: %*false)
  var logger = Logger(frameConfig: frame, enabled: true)
  logger.log = proc(payload: JsonNode) = discard
  logger.enable = proc() = discard
  logger.disable = proc() = discard
  let scene = FrameScene(id: "tests/calendar-js-app".SceneId, frameConfig: frame, state: %*{}, logger: logger)
  let owner = AppRoot(nodeId: 3.NodeId, nodeName: "calendar", appKeyword: "calendar", scene: scene, frameConfig: frame)
  let runtime = newJsAppRuntime(category = "data", outputType = "image", source = appSource, sourceName = "app.ts",
    sources = %*{"app.ts": appSource, "config.json": appConfigJson})
  let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: true,
    image: newImage(width, height), loopIndex: 0, loopKey: ".", nextSleep: -1)
  let value = runtime.get(owner, config, context)
  check value.kind == fkImage
  value.asImage()

suite "Calendar app":
  test "the light theme: background, weekday band and grid where the built-in app put them":
    # March 2024 starts on a Friday: five rows under a 50.4 px title and a
    # 24 px weekday band, inside 18 px of padding.
    let image = draw(%*{"year": 2024, "month": 3, "theme": "light"})
    check image.width == 800 and image.height == 480
    check image[5, 5] == rgbx(255, 255, 255, 255)        # the background
    check image[30, 80] == rgbx(240, 240, 240, 255)      # the weekday band
    check image[18, 200] == rgbx(220, 220, 220, 255)     # the left grid line
    check image[60, 110] == rgbx(255, 255, 255, 255)     # an empty cell

  test "the dark theme shades the weekend":
    let image = draw(%*{"year": 2024, "month": 3, "theme": "dark"})
    check image[5, 5] == rgbx(34, 34, 34, 255)
    # Saturday 2nd: the sixth column of the first row, well inside the cell.
    check image[640, 150] == rgbx(45, 45, 45, 255)

  test "an all-day event gets a chip in its colour":
    let image = draw(%*{"year": 2024, "month": 3, "theme": "light",
      "events": [{"summary": "Conference", "startTime": "2024-03-12", "allDay": true}]})
    # Tuesday 12th: column 1, row 2 (x 127, y 240); the chip is 16 px tall,
    # 24 px under the cell's top, 4 px in from its sides.
    var chip = 0
    for y in 262 ..< 284:
      for x in 127 ..< 237:
        if image[x, y] == rgbx(237, 196, 138, 255):
          inc chip
    check chip > 1000
    check image[200, 255] == rgbx(255, 255, 255, 255)  # above it, the cell

  test "a transparent background leaves the canvas showing":
    let image = draw(%*{"year": 2024, "month": 3, "theme": "custom", "transparentBackground": true,
      "showGrid": false})
    check image[5, 5].a == 0
    check image[60, 110].a == 0
