import std/[json, monotimes, os, osproc, strutils, times, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/values
import frameos/utils/font # the typeface resolver the layout's text uses
import frameos/utils/svg_frames
import frameos/video/player as video_player
import frameos/video/tests/plane_sink
import frameos/panel_canvas
import frameos/driver_render_hint

# Video for JS apps (docs/video.md, js_runtime/js_video.nim): `frameos.video`
# drawn with an <img>, decoded by ffmpeg at the size the layout gave it, the
# scene's next render when the next frame is due, a frame repainting only the
# video's box; `videoInfo`, `videoFrame`, `seekVideo`, `releaseVideo`.
# Skipped where there is no ffmpeg.

let haveFfmpeg = findExe("ffmpeg").len > 0 and findExe("ffprobe").len > 0
let assets = getTempDir() / "frameos-video-js-" & $getCurrentProcessId()
createDir(assets / "videos")

if haveFfmpeg:
  # A second of red and a second of blue, 10 frames a second, 160x90.
  let made = execCmdEx("ffmpeg -hide_banner -loglevel error -y -f lavfi -i color=c=red:size=160x90:rate=10:duration=1 " &
    "-f lavfi -i color=c=blue:size=160x90:rate=10:duration=1 -filter_complex \"[0:v][1:v]concat=n=2:v=1[v]\" " &
    "-map \"[v]\" -pix_fmt yuv420p -c:v mpeg4 " & quoteShell(assets / "videos" / "clip.mp4"))
  doAssert made.exitCode == 0, made.output

var logged: seq[JsonNode] ## what the scenes logged, newest last

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    if logger.enabled: logged.add payload
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

type Ui = object
  runtime: JsAppRuntime
  owner: AppRoot
  scene: FrameScene

const
  W = 120
  H = 80

proc newUi(source: string, id: string): Ui =
  let config = FrameConfig(width: W, height: H, rotate: 0, scalingMode: "cover", debug: false,
    saveAssets: %*false, assetsPath: assets)
  result.scene = FrameScene(id: id.SceneId, frameConfig: config, state: %*{}, logger: testLogger(config))
  result.owner = AppRoot(nodeId: 1.NodeId, nodeName: "ui", scene: result.scene, frameConfig: config)
  result.runtime = newJsAppRuntime(category = "data", outputType = "image", source = source,
    sourceName = "app.tsx")
  result.runtime.assetGrant = agRead

proc render(ui: Ui, target: Image = nil): tuple[image: Image, nextSleep: float] =
  let context = ExecutionContext(scene: ui.scene, event: "render", payload: %*{},
    hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1,
    decodeTargetImage: target, decodeTargetNodeId: 1.NodeId, decodeTargetScalingMode: "stretch",
    wholeFrame: not target.isNil)
  let image = ui.runtime.get(ui.owner, %*{}, context).asImage()
  (image, context.nextSleep)

proc playFor(ui: Ui, seconds: float, until: proc(): bool = nil, target: Image = nil): Image =
  ## Renders as the runner would: again after the scene's nextSleep.
  let deadline = epochTime() + seconds
  while epochTime() < deadline:
    let (image, wait) = ui.render(target)
    result = image
    if not until.isNil and until():
      return
    sleep(int(clamp(if wait < 0: 0.05 else: wait, 0.001, 0.2) * 1000))

proc color(image: Image, x, y: int): ColorRGBA =
  image[x, y].rgba

# The player: the video on grey, 100x56 at (10, 12); its state in the scene's.
const player = """
export function get(app) {
  const video = frameos.video('main', { src: app.state.src || 'videos/clip.mp4', paused: !!app.state.paused,
    loop: !!app.state.loop })
  frameos.setState('video', { state: video.state, time: video.time, duration: video.duration,
    width: video.videoWidth, height: video.videoHeight, error: video.error || null, id: video.id })
  if (app.state.seek !== undefined && app.state.seek !== null) {
    frameos.seekVideo(video, app.state.seek)
    frameos.setState('seek', null)
  }
  if (app.state.release) {
    frameos.setState('released', frameos.releaseVideo(video))
    frameos.setState('release', false)
  }
  return (
    <div className="w-full h-full pt-[12px] pl-[10px] bg-slate-300">
      <img className="w-[100px] h-[56px] object-contain" src={video} />
    </div>
  )
}
"""

proc videoState(ui: Ui): JsonNode = ui.scene.state{"video"}

suite "video in a JS app":
  test "plays in its <img>, paced by the scene's next render":
    if not haveFfmpeg:
      skip()
    else:
      let ui = newUi(player, "tests/video-play")
      let (first, wait) = ui.render()
      check wait > 0 and wait < 0.2 # it asks for a render soon
      check first.color(60, 40).r < 230 # black or grey until the first frame
      let red = ui.playFor(20, proc(): bool = ui.videoState{"state"}.getStr() == "playing")
      check ui.videoState{"state"}.getStr() == "playing"
      check ui.videoState{"width"}.getInt() == 160
      check ui.videoState{"duration"}.getFloat() > 1.9
      discard red
      let blue = ui.playFor(30, proc(): bool = ui.videoState{"state"}.getStr() == "ended")
      check ui.videoState{"state"}.getStr() == "ended"
      check blue.color(60, 40).b > 200 # the last frame stays
      check blue.color(5, 5).r > 150 and blue.color(5, 5).b > 150 # grey around it
      let (_, after) = ui.render()
      check after < 0 # ended: no more renders for it

  test "a frame repaints the video's box, not the UI":
    if not haveFfmpeg:
      skip()
    else:
      forgetPanelFrames()
      let ui = newUi(player, "tests/video-damage")
      ui.scene.state["loop"] = %*true
      let target = newImage(W, H)
      var frames = 0
      var most = 0
      # Until twelve frames played (a deadline only for a machine that never gets there).
      let deadline = epochTime() + 30
      while epochTime() < deadline and frames < 12:
        beginPanelFrame(target.bufferPointer, 0)
        svgFramePixelsForTest = -1
        let (_, wait) = ui.render(target)
        endPanelFrame()
        if ui.videoState{"state"}.getStr() == "playing":
          inc frames
          if frames > 3:
            most = max(most, svgFramePixelsForTest)
        sleep(int(clamp(wait, 0.001, 0.2) * 1000))
      check frames >= 6
      checkpoint $most
      check most > 0 and most <= 104 * 60 # the box and a pixel around it

  test "a letterboxed frame repaints its picture, not its bars":
    if not haveFfmpeg:
      skip()
    else:
      forgetPanelFrames()
      # The 16:9 clip in a 100x76 box: a 100x56 picture, 10 px of black above
      # and below it, painted once.
      let ui = newUi("""
export function get(app) {
  const video = frameos.video('main', { src: 'videos/clip.mp4', loop: true })
  frameos.setState('video', { state: video.state })
  return (
    <div className="w-full h-full pt-[2px] pl-[10px] bg-slate-300">
      <img className="w-[100px] h-[76px] object-contain" src={video} />
    </div>
  )
}
""", "tests/video-letterbox")
      let target = newImage(W, H)
      var frames = 0
      var most = 0
      var image: Image
      let deadline = epochTime() + 30
      while epochTime() < deadline and frames < 12:
        beginPanelFrame(target.bufferPointer, 0)
        svgFramePixelsForTest = -1
        let (shown, wait) = ui.render(target)
        image = shown
        endPanelFrame()
        if ui.videoState{"state"}.getStr() == "playing":
          inc frames
          if frames > 3:
            most = max(most, svgFramePixelsForTest)
        sleep(int(clamp(wait, 0.001, 0.2) * 1000))
      check frames >= 6
      checkpoint $most
      check most > 0 and most <= 104 * 60 # the picture and a pixel around it, not the 100x76 box
      # The bars are black, the picture is the clip.
      check image.color(60, 5).r < 20 and image.color(60, 5).b < 20
      check image.color(60, 74).r < 20 and image.color(60, 74).b < 20
      let c = image.color(60, 40)
      check c.r > 200 or c.b > 200

  test "seek, pause and release":
    if not haveFfmpeg:
      skip()
    else:
      let ui = newUi(player, "tests/video-seek")
      ui.scene.state["seek"] = %*1.4
      let blue = ui.playFor(20, proc(): bool = ui.videoState{"state"}.getStr() == "playing" and
        ui.videoState{"time"}.getFloat() >= 1.3)
      check blue.color(60, 40).b > 200
      ui.scene.state["paused"] = %*true
      discard ui.render()
      check ui.videoState{"state"}.getStr() == "paused"
      let (_, wait) = ui.render()
      check wait < 0
      ui.scene.state["release"] = %*true
      discard ui.render()
      check ui.scene.state{"released"}.getBool() == true

  test "a missing file is an error the app can show":
    let ui = newUi(player, "tests/video-missing")
    ui.scene.state["src"] = %*"videos/nothing.mp4"
    let (_, wait) = ui.render()
    check ui.videoState{"state"}.getStr() == "error"
    check "no such file" in ui.videoState{"error"}.getStr()
    check ui.videoState{"id"}.getInt() == 0
    check wait < 0

  test "a path out of the assets is refused":
    let ui = newUi(player, "tests/video-escape")
    ui.scene.state["src"] = %*"../etc/passwd"
    discard ui.render()
    check ui.videoState{"state"}.getStr() == "error"
    check "may read" in ui.videoState{"error"}.getStr()

  test "videoInfo and videoFrame":
    if not haveFfmpeg:
      skip()
    else:
      let ui = newUi("""
export function get(app) {
  const info = frameos.videoInfo('videos/clip.mp4')
  const still = frameos.videoFrame('videos/clip.mp4', { at: 1.5, width: 40, height: 30, keep: true })
  const none = frameos.videoFrame('videos/nothing.mp4')
  frameos.setState('info', info)
  frameos.setState('still', { width: still.width, height: still.height, error: still.error || null })
  frameos.setState('none', none.error || null)
  return <div className="w-full h-full bg-white"><img className="w-[40px] h-[30px]" src={still.image} /></div>
}
""", "tests/video-info")
      let (image, _) = ui.render()
      let info = ui.scene.state{"info"}
      check info{"width"}.getInt() == 160 and info{"height"}.getInt() == 90
      check info{"duration"}.getFloat() > 1.9
      check info{"fps"}.getFloat() > 9.9
      check ui.scene.state{"still"}{"width"}.getInt() == 40
      check ui.scene.state{"still"}{"error"}.kind == JNull
      check image.color(20, 15).b > 200
      check "no such file" in ui.scene.state{"none"}.getStr()

  test "a hardware decoder that gives way says so in the log, once":
    if not haveFfmpeg:
      skip()
    else:
      # A V4L2 launch short of memory, as on a Pi Zero W with its CMA taken;
      # the real ffmpeg otherwise.
      let fake = assets / "ffmpeg-short"
      writeFile(fake, "#!/bin/sh\ncase \"$*\" in\n  *_v4l2m2m*)\n" &
        "    echo '[mpeg4_v4l2m2m @ 0x1] output VIDIOC_REQBUFS failed: Cannot allocate memory' >&2\n" &
        "    exit 1;;\nesac\nexec " & quoteShell(findExe("ffmpeg")) & " \"$@\"\n")
      setFilePermissions(fake, {fpUserRead, fpUserWrite, fpUserExec})
      putEnv("FRAMEOS_FFMPEG", fake)
      setDecodeCapsForTest(DecodeCaps(v4l2Decoders: @["mpeg4_v4l2m2m"]))
      defer:
        delEnv("FRAMEOS_FFMPEG")
        setDecodeCapsForTest(DecodeCaps())
      logged.setLen(0)
      let ui = newUi(player, "tests/video-fallback")
      # A video renders fast: the runner has turned the scene's log off.
      ui.scene.logger.disable()
      let last = ui.playFor(30, proc(): bool = ui.videoState{"state"}.getStr() == "ended")
      check ui.videoState{"state"}.getStr() == "ended"
      check last.color(60, 40).b > 200 # ffmpeg's own played it
      var said: seq[JsonNode]
      for entry in logged:
        if entry{"event"}.getStr().endsWith(":video:fallback"):
          said.add entry
      check said.len == 1
      check not ui.scene.logger.enabled # and left as the runner had it
      if said.len == 1:
        check said[0]{"src"}.getStr() == "clip.mp4"
        check said[0]{"from"}.getStr() == "mpeg4_v4l2m2m"
        check said[0]{"to"}.getStr() == "software"
        check said[0]{"reason"}.getStr() == "output VIDIOC_REQBUFS failed: Cannot allocate memory"
        check said[0]{"hardwareKept"}.getBool()

  test "a video nothing covers is shown on a display plane, one under the UI stays in the canvas":
    if not haveFfmpeg:
      skip()
    else:
      # The runner's render: the scene draws into the panel's own canvas,
      # each pass settled after (runner.nim settlePlanes).
      useSink()
      reportPanelCanvas(W, H, PanelCanvasRgb565)
      let canvas = panelCanvasFor(W, H, W, H, 0, "")
      check not canvas.isNil
      defer:
        noSink()
        reportPanelCanvas(0, 0, 0)
        discard panelCanvasFor(W, H, W, H, 0, "")
      proc renderPanel(ui: Ui): float =
        let context = ExecutionContext(scene: ui.scene, event: "render", payload: %*{}, image: canvas,
          hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1, decodeTargetImage: canvas,
          decodeTargetNodeId: 1.NodeId, decodeTargetScalingMode: "stretch", wholeFrame: true)
        discard ui.runtime.get(ui.owner, %*{}, context)
        settlePlanes(true)
        context.nextSleep
      let ui = newUi(player, "tests/video-plane")
      var renders = 0 # once the plane shows: about one a second
      var showsAtFirst = -1
      var onPlaneSaid = false
      var deadline = epochTime() + 30
      while epochTime() < deadline and ui.videoState{"state"}.getStr() != "ended":
        let wait = ui.renderPanel()
        if showsSoFar() > 0:
          if showsAtFirst < 0: showsAtFirst = showsSoFar()
          inc renders
          # Its passes are the video's own clock: nobody waits for them, so
          # the runner puts no loading mark up (which takes the plane off).
          onPlaneSaid = onPlaneSaid or videoOnPlane(ui.scene)
        sleep(int(clamp(if wait < 0: 0.05 else: wait, 0.01, 1.0) * 1000))
      check ui.videoState{"state"}.getStr() == "ended"
      checkpoint "shows " & $showsSoFar() & ", renders on the plane " & $renders
      check showsSoFar() >= 15 # its frames on the plane
      check renders * 3 < showsSoFar() - showsAtFirst # and not a render each
      check onPlaneSaid
      # The <img>'s box, 100x56 at (10, 12): the 16:9 clip fills it.
      let at = shownAt(-1)
      check at.rect.x == 10 and at.rect.y == 12 and at.rect.w == 100 and at.rect.h == 56
      # The canvas holds a copy of the last (what a snapshot shows).
      check canvas.color(60, 40).b > 200
      # A box drawn over the video: no plane, the canvas draws it.
      useSink()
      let covered = newUi("""
export function get(app) {
  const video = frameos.video('main', { src: 'videos/clip.mp4', loop: true })
  frameos.setState('video', { state: video.state })
  return (
    <div className="relative w-full h-full pt-[12px] pl-[10px] bg-slate-300">
      <img className="w-[100px] h-[56px] object-contain" src={video} />
      <div className="absolute left-[40px] top-[30px] w-[20px] h-[10px] bg-white" />
    </div>
  )
}
""", "tests/video-covered")
      var drawn = false
      deadline = epochTime() + 30
      while epochTime() < deadline and not drawn:
        let wait = covered.renderPanel()
        let c = canvas.color(20, 20)
        drawn = covered.videoState{"state"}.getStr() == "playing" and (c.r > 200 or c.b > 200) and c.g < 60
        sleep(int(clamp(if wait < 0: 0.05 else: wait, 0.01, 0.2) * 1000))
      check drawn
      check showsSoFar() == 0
      check not videoOnPlane(covered.scene) # a pass for it may show the loading mark
      check canvas.color(50, 35).r > 200 and canvas.color(50, 35).g > 200 # the white box over it

  test "the mouse cursor over a video keeps it in the canvas, and the plane when it goes":
    if not haveFfmpeg:
      skip()
    else:
      useSink()
      reportPanelCanvas(W, H, PanelCanvasRgb565)
      let canvas = panelCanvasFor(W, H, W, H, 0, "")
      defer:
        discard planesCursor(false, 0, 0, 0, 0)
        noSink()
        reportPanelCanvas(0, 0, 0)
        discard panelCanvasFor(W, H, W, H, 0, "")
      proc renderPanel(ui: Ui): float =
        let context = ExecutionContext(scene: ui.scene, event: "render", payload: %*{}, image: canvas,
          hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1, decodeTargetImage: canvas,
          decodeTargetNodeId: 1.NodeId, decodeTargetScalingMode: "stretch", wholeFrame: true)
        discard ui.runtime.get(ui.owner, %*{}, context)
        settlePlanes(true)
        context.nextSleep
      # The cursor (drawn into /dev/fb0, under a plane) on the video's box.
      discard planesCursor(true, 50, 30, 12, 19)
      let ui = newUi(player, "tests/video-cursor")
      ui.scene.state["loop"] = %*true
      var playing = false
      var deadline = epochTime() + 30
      while epochTime() < deadline and not playing:
        let wait = ui.renderPanel()
        let c = canvas.color(30, 40)
        playing = ui.videoState{"state"}.getStr() == "playing" and (c.r > 200 or c.b > 200)
        sleep(int(clamp(if wait < 0: 0.05 else: wait, 0.01, 0.2) * 1000))
      check playing # in the canvas
      check showsSoFar() == 0
      # It goes: on the plane.
      discard planesCursor(false, 0, 0, 0, 0)
      deadline = epochTime() + 30
      while epochTime() < deadline and showsSoFar() < 3:
        let wait = ui.renderPanel()
        sleep(int(clamp(if wait < 0: 0.05 else: wait, 0.01, 0.2) * 1000))
      check showsSoFar() >= 3

removeDir(assets)
