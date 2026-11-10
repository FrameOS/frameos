import std/[base64, json, os, strutils, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/values
import frameos/utils/font # the typeface resolver the layout's text uses
import frameos/utils/memory # availableRenderBytesOverride
import frameos/utils/image # probeSourceTarget, SourceProbeBytes: the device's sized downloads

# Pictures a JS app keeps across renders (`fetchImage(url, {keep: true})`,
# docs/jsx-ui.md "Images"): a JSX gallery shows its photo again after a tap
# without downloading it again, until it lets go (`frameos.releaseImage`) or
# the interpreter goes.

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) = discard
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

type Ui = object
  runtime: JsAppRuntime
  owner: AppRoot
  scene: FrameScene

proc newUi(source: string, id: string): Ui =
  let config = FrameConfig(width: 40, height: 20, rotate: 0, scalingMode: "cover", debug: true,
    saveAssets: %*false, assetsPath: "/tmp")
  result.scene = FrameScene(id: id.SceneId, frameConfig: config, state: %*{}, logger: testLogger(config))
  result.owner = AppRoot(nodeId: 1.NodeId, nodeName: "ui", scene: result.scene, frameConfig: config)
  result.runtime = newJsAppRuntime(category = "data", outputType = "image", source = source,
    sourceName = "app.tsx")

proc render(ui: Ui, target: Image = nil): Image =
  let context = ExecutionContext(scene: ui.scene, event: "render", payload: %*{},
    hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1,
    decodeTargetImage: target, decodeTargetNodeId: 1.NodeId, decodeTargetScalingMode: "cover")
  ui.runtime.get(ui.owner, %*{}, context).asImage()

proc dataUrl(color: ColorRGBX): string =
  let image = newImage(8, 8)
  image.fill(color)
  "data:image/png;base64," & base64.encode(encodeImage(image, PngFormat))

let
  red = dataUrl(rgbx(255, 0, 0, 255))
  blue = dataUrl(rgbx(0, 0, 255, 255))

proc gallery(keep: bool): string =
  # Fetches only when it holds no photo, and counts its downloads.
  """
  let photo = null
  let fetches = 0
  let want = 'RED'
  let stopped = false
  export function get(app) {
    if (app.state.release && photo) { frameos.setState('released', frameos.releaseImage(photo)); photo = null; stopped = true }
    if (app.state.next) { want = app.state.next; frameos.setState('next', ''); photo = null }
    if (!photo && !stopped) {
      photo = frameos.fetchImage(want === 'BLUE' ? 'BLUEURL' : 'REDURL', { keep: KEEP }).image
      fetches++
      frameos.setState('fetches', fetches)
    }
    return <div className="w-full h-full bg-white"><img className="w-full h-full" src={photo} /></div>
  }
  """.replace("REDURL", red).replace("BLUEURL", blue).replace("KEEP", $keep)

suite "kept images":
  test "a kept photo is drawn again on the next render without a download":
    let ui = newUi(gallery(true), "tests/kept")
    check ui.render()[20, 10] == rgbx(255, 0, 0, 255)
    check ui.render()[20, 10] == rgbx(255, 0, 0, 255)
    check ui.render()[20, 10] == rgbx(255, 0, 0, 255)
    check ui.scene.state{"fetches"}.getInt() == 1

  test "a transient photo is gone after its render":
    # What keep is for: the ref an app held over from the last render names
    # nothing, so the photo is not drawn (or the app downloads it again).
    let ui = newUi(gallery(false), "tests/transient")
    check ui.render()[20, 10] == rgbx(255, 0, 0, 255)
    check ui.render()[20, 10] == rgbx(255, 255, 255, 255)
    check ui.scene.state{"fetches"}.getInt() == 1

  test "releaseImage lets a kept photo go, once":
    let ui = newUi(gallery(true), "tests/release")
    discard ui.render()
    ui.scene.state["release"] = %*true
    check ui.render()[20, 10] == rgbx(255, 255, 255, 255)
    check ui.scene.state{"released"}.getBool() == true
    # A ref that was never kept, or was let go already, is not released.
    let probe = newUi("""
      export function get() {
        const t = frameos.fetchImage('REDURL').image
        frameos.setState('transient', frameos.releaseImage(t))
        const k = frameos.fetchImage('REDURL', { keep: true })
        frameos.setState('first', frameos.releaseImage(k))
        frameos.setState('again', frameos.releaseImage(k))
        return <div className="bg-white" />
      }
    """.replace("REDURL", red), "tests/release-probe")
    discard probe.render()
    check probe.scene.state{"transient"}.getBool() == false
    check probe.scene.state{"first"}.getBool() == true
    check probe.scene.state{"again"}.getBool() == false

  test "the next photo replaces it, and the interpreter's end takes it":
    let ui = newUi(gallery(true), "tests/next")
    discard ui.render()
    ui.scene.state["next"] = %*"BLUE"
    check ui.render()[20, 10] == rgbx(0, 0, 255, 255)
    check ui.render()[20, 10] == rgbx(0, 0, 255, 255)
    check ui.scene.state{"fetches"}.getInt() == 2
    releaseIdleJsAppRuntimes()
    # A new interpreter: module state is new, so the app fetches again.
    check ui.render()[20, 10] == rgbx(255, 0, 0, 255)
    check ui.scene.state{"fetches"}.getInt() == 1

  test "a kept picture never takes the consumer's target":
    let ui = newUi("""
      export function get() {
        const k = frameos.fetchImage('REDURL', { keep: true, width: 12, height: 6 })
        frameos.setState('size', `${k.width}x${k.height}`)
        return <div className="w-full h-full bg-white"><img className="w-full h-full" src={k} /></div>
      }
    """.replace("REDURL", red), "tests/kept-target")
    let canvas = newImage(40, 20)
    let drawn = ui.render(canvas)
    # The UI took the canvas (it draws into the target it was offered), the
    # photo did not: it is its own image, decoded where the host decodes it.
    check drawn == canvas
    check canvas[20, 10] == rgbx(255, 0, 0, 255)

  test "short of room, a kept picture steps down to its photo's own resolution first":
    # A reTerminal E1003's gallery window (1848x1179) and the gallery's own
    # 1024x653 photo: the shape asked for, at the photo's pixels.
    check keptDecodeSize(1848, 1179, 1024, 653, fitCover) == (1023, 653)
    check keptDecodeSize(1848, 1179, 1024, 653, fitContain) == (1024, 653)
    # A photo with the pixels to fill the box is decoded at the box.
    check keptDecodeSize(800, 480, 4000, 3000, fitCover) == (800, 480)
    check keptDecodeSize(800, 480, 4000, 3000, fitContain) == (800, 480)
    check keptDecodeSize(800, 480, 400, 600, fitStretch) == (400, 480)
    # Unknown source size, or a 1:1 fit: as asked.
    check keptDecodeSize(800, 480, 0, 0, fitCover) == (800, 480)
    check keptDecodeSize(800, 480, 400, 300, fitCenter) == (800, 480)

  test "short of memory the older kept pictures go, then the fetch says so":
    # An allocation the heap cannot make aborts the render on an ESP32 (and
    # two in a row restart it), so a kept picture is only made with room
    # for it; this host is told it has 100 bytes, less than the 12x6 picture.
    let ui = newUi("""
      const refs = []
      export function get() {
        refs.push(frameos.fetchImage('REDURL', { keep: true, width: 12, height: 6 }))
        if (refs.length === 2) {
          frameos.setState('second', refs[1].error ?? 'ok')
          frameos.setState('firstKept', frameos.releaseImage(refs[0]))
        }
        return <div className="bg-white" />
      }
    """.replace("REDURL", red), "tests/kept-room")
    discard ui.render()
    availableRenderBytesOverride = 100
    try:
      discard ui.render()
    finally:
      availableRenderBytesOverride = 0
    check ui.scene.state{"second"}.getStr().contains("no room for the picture")
    check ui.scene.state{"firstKept"}.getBool() == false

  test "at most eight are kept; the oldest goes for a ninth":
    let ui = newUi("""
      const refs = []
      export function get() {
        for (let i = 0; i < 9; i++) refs.push(frameos.fetchImage('REDURL', { keep: true }))
        frameos.setState('first', frameos.releaseImage(refs[0]))
        frameos.setState('second', frameos.releaseImage(refs[1]))
        return <div className="bg-white" />
      }
    """.replace("REDURL", red), "tests/kept-limit")
    discard ui.render()
    check ui.scene.state{"first"}.getBool() == false
    check ui.scene.state{"second"}.getBool() == true

# What a kept picture with a size decodes into once the start of its download
# says how big the photo is: utils/image.nim probeSourceTarget feeding
# keptTargetFor, as the device's sized download does (downloadImageWithDataSizedBy;
# the socket and buffer halves around it are the firmware's alone, a host
# decodes a download at its own size). Gallery on a reTerminal E1003 asked for
# 1848x1179 kept pictures of 1024x653 photos and aborted its render; these are
# that in miniature: 400x300 asked, 240x180 photos (2026-11-10).

const jpegMasters = currentSourcePath().parentDir / "../../../../pixie/tests/fileformats/jpeg/masters"

proc encoded(width, height: int): string =
  let image = newImage(width, height)
  image.fill(rgbx(10, 20, 30, 255))
  encodeImage(image, PngFormat)

proc head(body: string): string =
  ## What the device peeks of a body before it decodes it.
  body[0 ..< min(body.len, SourceProbeBytes)]

template withRoom(bytes: int, body: untyped) =
  availableRenderBytesOverride = bytes
  try:
    body
  finally:
    availableRenderBytesOverride = 0

proc capturing(ui: Ui): ref seq[JsonNode] =
  let logs = new(seq[JsonNode])
  ui.scene.logger.log = proc(payload: JsonNode) = logs[].add(payload)
  logs

suite "kept images sized by the start of the download":
  test "with room, a kept picture is made at the size asked":
    let ui = newUi(gallery(true), "tests/sized-room")
    let targetFor = ui.runtime.keptTargetFor(ui.owner, nil, 400, 300, fitCover)
    var made: Image
    withRoom(400 * 300 * 4):                      # exactly enough
      made = probeSourceTarget(head(encoded(240, 180)), targetFor)
    check (made.width, made.height) == (400, 300)
    # Unknown memory (a host without the numbers): as asked too.
    made = probeSourceTarget(head(encoded(240, 180)), targetFor)
    check (made.width, made.height) == (400, 300)

  test "short of room for the size asked, the photo's own resolution":
    let ui = newUi(gallery(true), "tests/sized-source")
    let logs = ui.capturing()
    var made: Image
    withRoom(200_000):                            # 480 000 bytes asked, 172 800 at source
      made = probeSourceTarget(head(encoded(240, 180)),
        ui.runtime.keptTargetFor(ui.owner, nil, 400, 300, fitCover))
    check (made.width, made.height) == (240, 180)
    var told = false
    for payload in logs[]:
      if payload{"event"}.getStr().endsWith("js:keptImages") and
          payload{"reason"}.getStr() == "no room" and payload{"width"}.getInt() == 240:
        told = true
    check told

  test "the photo's size is as shown, its EXIF orientation applied":
    # f6-exif.jpg is stored 80x40 and turned a quarter: shown 40x80. Asked
    # for 60x120 its own resolution is 40x80 (the 80x40 as stored would be
    # under half the size asked, and refused).
    let body = readFile(jpegMasters / "f6-exif.jpg")
    let ui = newUi(gallery(true), "tests/sized-exif")
    var made: Image
    withRoom(20_000):                             # 28 800 asked, 12 800 at source
      made = probeSourceTarget(head(body),
        ui.runtime.keptTargetFor(ui.owner, nil, 60, 120, fitCover))
    check (made.width, made.height) == (40, 80)

  test "a picture is never kept at under half the size asked":
    # Drawn at over twice its size, pixie doubles it first in a full-colour
    # copy of its own: the size saved, asked for again at the draw.
    let ui = newUi(gallery(true), "tests/sized-half")
    var message = ""
    withRoom(200_000):
      try:
        discard probeSourceTarget(head(encoded(150, 100)),
          ui.runtime.keptTargetFor(ui.owner, nil, 400, 300, fitCover))
      except PixieError as err:
        message = err.msg
    check message == NoRoomForPicture

  test "a frame header past the part peeked leaves the size asked":
    # A JPEG's frame header can sit behind a large EXIF block: the source's
    # size is then unknown, and the picture is the size asked or nothing.
    let master = readFile(jpegMasters / "f6-exif.jpg")
    let padding = newString(SourceProbeBytes + 1024)
    let segment = "\xFF\xE2" & chr(((padding.len + 2) shr 8) and 0xFF) &
      chr((padding.len + 2) and 0xFF) & padding
    check padding.len + 2 < 65536
    let body = master[0 ..< 2] & segment & master[2 .. ^1]
    check decodeImageDimensions(body).width == 40   # the whole body still says it
    let ui = newUi(gallery(true), "tests/sized-late-header")
    let targetFor = ui.runtime.keptTargetFor(ui.owner, nil, 60, 120, fitCover)
    var made: Image
    withRoom(60 * 120 * 4):
      made = probeSourceTarget(head(body), targetFor)
    check (made.width, made.height) == (60, 120)
    var message = ""
    withRoom(20_000):
      try:
        discard probeSourceTarget(head(body), targetFor)
      except PixieError as err:
        message = err.msg
    check message == NoRoomForPicture
