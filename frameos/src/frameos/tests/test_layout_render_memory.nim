## The Windows 98 layout around the Wikimedia Commons sample on a 13.3" ESP32
## panel (a reTerminal E1004: 8 MB of PSRAM, 1200x1600, frame 70 on 2026-11-09).
## That render aborted out of memory every time: the caption's single path
## over all its lines asked for buffers of 300-450 KB at once, and the outline's
## scratch was tried with nothing under the reserve, since a 0 from
## availableRenderBytes read as "unknown".
##
## The real samples and the real layout, drawn into a 565 canvas the way the
## board draws. The photo is stubbed (its decode has a budget of its own); what
## comes after it is what this pins.

import std/[json, os, strutils, unittest]
import pixie
import ../channels
import ../interpreter
import ../scene_rhythm
import ../types
import ../utils/app_images
from ../utils/image import decodeOutputMaxPixels, boundedRequestedDimensions
import ../utils/http_client
import ../utils/memory
import ../utils/text
import ../js_runtime/app_runtime

const
  Samples = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / "repo" / "scenes" / "samples"
  PeakAllowedBytes = 1536 * 1024
    ## What this render may hold above what it started with, canvas excluded.
    ## 1.1 MB measured on a 64-bit host; one path per span took 1.9 MB.
  Description = "Panorama of the Himalayas from Ranikhet, Uttarakhand, India. The Kumaon range stands behind " &
    "layered forested ridges in the blue morning haze, with Trishul, Nanda Devi and Panchachuli catching the " &
    "first light of the day above the valleys. The view looks north east across the Almora district from the " &
    "army cantonment town, famous for its pine and oak forests, and takes in more than three hundred " &
    "kilometres of the snowbound Great Himalaya in a single sweep from the Garhwal peaks in the west to the " &
    "Nepal border in the east, on a very clear winter day."

proc sample(name: string): JsonNode =
  parseFile(Samples / name / "scenes.json")[0]

let photo = rgba(40, 120, 200, 255)

jsHttpRequestHook = proc(url, httpMethod, body: string, headers: seq[SimpleHttpHeader]): tuple[code: int, body: string] =
  let info = %*{"thumburl": "https://upload.wikimedia.org/thumb/himalayas.jpg", "url": "https://upload.wikimedia.org/himalayas.jpg",
    "mime": "image/jpeg", "width": 4000, "height": 3000, "size": 1234567,
    "descriptionurl": "https://commons.wikimedia.org/wiki/File:Himalayas.jpg",
    "extmetadata": {"ObjectName": {"value": "Panorama of Himalayas from Ranikhet"}, "Artist": {"value": "A photographer"},
      "LicenseShortName": {"value": "CC BY-SA 4.0"}, "ImageDescription": {"value": Description}}}
  (200, $(%*{"query": {"pages": [{"title": "File:Himalayas.jpg", "imageinfo": [info]}]}}))

var decodedInto: Image
contextDownloadHook = proc(url: string, maxBytes: int, target: Image, fit: ScaledDecodeFit,
    boundWidth, boundHeight: int): tuple[image: Image, data: string] =
  decodedInto = target
  target.fill(photo)
  (target, "")

suite "a layout around a captioned photo on a 13.3\" ESP32":
  test "the caption and the chrome fit with nothing under the reserve":
    var scene = sample("Wikimedia Commons")
    let layout = sample("Windows 98 layout")
    scene["layout"] = %*{"sceneId": layout["id"]}
    setUploadedInterpretedScenes(parseInterpretedScenes($(%*[scene, layout])))
    resetInterpretedScenes()
    setSimulatedEmbedded(true)
    availableRenderBytesOverride = -1
    contiguousBudgetOverride = 256 * 1024
    rhythmCanvasGeneration = proc(canvas: Image): int64 {.nimcall, raises: [].} = 0
    rhythmClockOverride = 1000.0

    let config = FrameConfig(name: "e1004", mode: "embedded", device: "waveshare.EPD_13in3e",
      width: 1200, height: 1600, rotate: 0, scalingMode: "cover", debug: false, settings: %*{},
      # What this panel ran at when the long caption aborted it; automatic is 1 now.
      renderScale: 2.0,
      saveAssets: %*false, assetsPath: getTempDir() / "frameos-layout-memory-test")
    var problems: seq[string]
    var logger = Logger(frameConfig: config, enabled: true)
    logger.log = proc(payload: JsonNode) =
      if payload{"event"}.getStr().contains("error") or payload{"event"}.getStr() == "layout:missing":
        problems.add($payload)
    logger.enable = proc() = logger.enabled = true
    logger.disable = proc() = logger.enabled = false

    let canvas = newImage565(1200, 1600)
    canvas.ditherStores = true
    let frameScene = init(scene["id"].getStr().SceneId, config, logger, %*{})
    let context = ExecutionContext(scene: frameScene, event: "render", payload: %*{}, image: canvas,
      hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
    GC_fullCollect()
    let heldBefore = getOccupiedMem()
    fillOccupiedPeak = 0
    let image = render(frameScene, context)
    let peak = fillOccupiedPeak - heldBefore

    check problems.len == 0
    if problems.len > 0:
      echo problems
    check image == canvas
    # The photo went straight into the hole, a view of the canvas.
    check not decodedInto.isNil and decodedInto.isView and decodedInto.width < canvas.width
    # The outline was not tried in a scratch image there is no room for.
    check lastApproxStroke.availableBytes == 0
    check lastApproxStroke.path.startsWith("stamped")
    check peak < PeakAllowedBytes
    if peak >= PeakAllowedBytes:
      echo "peak above the start of the render: ", peak div 1024, " KB"

    # Something of each part reached the canvas: the taskbar's gray, the photo,
    # and the caption over it.
    proc at(x, y: int): ColorRGBX = canvas.getPixel(canvas.dataIndex(x, y))
    check at(600, 1599).r > 150 and at(600, 1599).g > 150 and at(600, 1599).b > 150
    check at(600, 500).b > at(600, 500).r
    var captionPixels = 0
    for y in 900 ..< 1480:
      for x in 40 ..< 900:
        if at(x, y).r > 200 and at(x, y).g > 200 and at(x, y).b > 200:
          inc captionPixels
    check captionPixels > 1000

## A Big typographic clock as the bench's reTerminal E1002 had it (an 800x480
## Spectra-6 panel, an RGBX canvas, 8 MB of PSRAM; 2026-11-16): its app drew
## its SVG at `app.frame.width` x `app.frame.height` and a `render/image`
## stretched it. In a Windows 98 window, a hole smaller than the panel, that
## SVG was rasterized on its own at 800x480 (1.5 MB) and then stretched into
## the hole: with 1.1 MB free, an out-of-memory abort and a restart. Drawn at
## the hole's size, it is the same picture with nothing allocated for it.
const panelClockApp = """
export function get(app) {
  const W = app.frame.width
  const H = app.frame.height
  return frameos.svg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' +
    '<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="' + H + '" gradientUnits="userSpaceOnUse">' +
    '<stop offset="0" stop-color="#132238"/><stop offset="1" stop-color="#2A1E3F"/></linearGradient></defs>' +
    '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="url(#bg)"/>' +
    '<rect x="' + (W / 2 - 40) + '" y="' + (H / 2 - 40) + '" width="80" height="80" fill="#D9A441"/></svg>',
    { width: W, height: H })
}
"""

proc panelClockScene(): JsonNode =
  let config = %*{"name": "panel", "category": "data", "output": [{"name": "image", "type": "image"}], "fields": []}
  %*{"id": "tests/panel-clock", "name": "Panel clock",
    "settings": {"execution": "interpreted", "refreshInterval": 60, "backgroundColor": "#000000"},
    "fields": [], "apps": {"panelClock": {"name": "panel", "category": "data", "version": "1.0.0", "fields": [],
      "output": [{"name": "image", "type": "image"}], "sources": {"app.ts": panelClockApp, "config.json": $config}}},
    "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
      {"id": "2", "type": "app", "data": {"keyword": "panelClock", "config": {}}},
      {"id": "3", "type": "app", "data": {"keyword": "render/image", "config": {"placement": "stretch"}}}],
    "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "3", "targetHandle": "prev"},
      {"id": "2", "source": "2", "sourceHandle": "fieldOutput", "target": "3", "targetHandle": "fieldInput/image"}]}

suite "a scene that draws at the panel's size, in a window":
  test "is drawn at the window's size, not rasterized at the panel's and stretched":
    var scene = panelClockScene()
    let layout = sample("Windows 98 layout")
    scene["layout"] = %*{"sceneId": layout["id"]}
    setUploadedInterpretedScenes(parseInterpretedScenes($(%*[scene, layout])))
    resetInterpretedScenes()
    setSimulatedEmbedded(true)
    availableRenderBytesOverride = 0
    # The paint strips sized as on the board, whose largest block was 1.1 MB.
    contiguousBudgetOverride = 256 * 1024
    rhythmCanvasGeneration = proc(canvas: Image): int64 {.nimcall, raises: [].} = 0
    rhythmClockOverride = 2000.0
    let config = FrameConfig(name: "e1002", mode: "embedded", device: "waveshare.EPD_7in3e",
      width: 800, height: 480, rotate: 0, scalingMode: "cover", debug: false, settings: %*{},
      saveAssets: %*false, assetsPath: getTempDir() / "frameos-layout-memory-test")
    var problems: seq[string]
    var logger = Logger(frameConfig: config, enabled: true)
    logger.log = proc(payload: JsonNode) =
      if payload{"event"}.getStr().contains("error"):
        problems.add($payload)
    logger.enable = proc() = logger.enabled = true
    logger.disable = proc() = logger.enabled = false

    let canvas = newImage(800, 480)
    let frameScene = init("tests/panel-clock".SceneId, config, logger, %*{})
    let context = ExecutionContext(scene: frameScene, event: "render", payload: %*{}, image: canvas,
      hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
    GC_fullCollect()
    let heldBefore = getOccupiedMem()
    fillOccupiedPeak = 0
    check render(frameScene, context) == canvas
    let peak = fillOccupiedPeak - heldBefore
    check problems.len == 0
    if problems.len > 0:
      echo problems
    # An 800x480 RGBX raster is 1.5 MB; the fills into the hole need far less.
    check peak < 1024 * 1024
    if peak >= 1024 * 1024:
      echo "peak above the start of the render: ", peak div 1024, " KB"
    # The square in the middle of the window, where the stretched picture put it.
    var found = false
    for s in frameScene.wornLayout.slots:
      if s.child == frameScene:
        found = true
        check s.hole
        let midX = int((s.visible[0] + s.visible[2]) / 2)
        let midY = int((s.visible[1] + s.visible[3]) / 2)
        let mid = canvas.getPixel(canvas.dataIndex(midX, midY))
        check mid.r > 200 and mid.g > 140 and mid.b < 100
    check found
    setSimulatedEmbedded(false)

  test "a raster with nothing under the reserve on an ESP32 gets the floor, not every pixel it asks for":
    setSimulatedEmbedded(true)
    availableRenderBytesOverride = -1
    check decodeOutputMaxPixels() == 65_536
    check boundedRequestedDimensions(800, 480)[0] < 800
    setSimulatedEmbedded(false)
    check decodeOutputMaxPixels() == 0
    availableRenderBytesOverride = 0

  test "an SVG asked for at another size is the offer's size when its consumer stretches it":
    check svgStretchesOnto("stretch", 800, 480, 792, 404)
    check not svgStretchesOnto("center", 800, 480, 792, 404)
    check not svgStretchesOnto("cover", 800, 480, 792, 404)
    check svgStretchesOnto("contain", 800, 480, 400, 240)
