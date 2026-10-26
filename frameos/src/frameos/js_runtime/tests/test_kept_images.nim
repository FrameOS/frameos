import std/[base64, json, strutils, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/values
import frameos/utils/font # the typeface resolver the layout's text uses

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
