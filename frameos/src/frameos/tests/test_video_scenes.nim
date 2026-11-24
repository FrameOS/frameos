## The video samples (repo/scenes/samples, docs/video.md) over real clips
## made with ffmpeg's lavfi, played by the scene as the runner would: again
## after each render's nextSleep. Video player through a folder, its controls
## on a tap; Files playing a video it opens; Slow movie stepping through a
## film; Video from URL over a local HTTP server. Skipped without ffmpeg.
## FRAMEOS_VIDEO_SHOTS=<dir> writes the last picture of each there.

import std/[json, os, osproc, strutils, times, unittest]
import pixie
import ../interpreter
import ../js_runtime/app_runtime
import ../scene_rhythm
import ../types
from ../ids import SceneId

const Samples = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / "repo" / "scenes" / "samples"

let haveFfmpeg = findExe("ffmpeg").len > 0 and findExe("ffprobe").len > 0
let assets = getTempDir() / "frameos-video-scenes-" & $getCurrentProcessId()
createDir(assets / "videos")

proc clip(path: string, colors: openArray[string], seconds = 1.0) =
  ## `seconds` of each color at 10 frames a second, 160x90.
  var args = "ffmpeg -hide_banner -loglevel error -y"
  var concat = ""
  for i, color in colors:
    args.add " -f lavfi -i color=c=" & color & ":size=160x90:rate=10:duration=" & $seconds
    concat.add "[" & $i & ":v]"
  args.add " -filter_complex \"" & concat & "concat=n=" & $colors.len & ":v=1[v]\" -map \"[v]\" -pix_fmt yuv420p -c:v mpeg4 " &
    quoteShell(path)
  let made = execCmdEx(args)
  doAssert made.exitCode == 0, made.output

const ServerPy = """
import http.server, json, os, re, sys
videos = sys.argv[2]
class Server(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def answer(self, status, body, kind):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def file(self, name):
        path = os.path.join(videos, name)
        if not os.path.isfile(path):
            return self.answer(404, b"", "text/plain")
        size = os.path.getsize(path)
        start, end = 0, size - 1
        wanted = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range") or "")
        if wanted:
            start = int(wanted.group(1) or 0)
            end = min(int(wanted.group(2) or size - 1), size - 1)
        with open(path, "rb") as f:
            f.seek(start)
            body = f.read(end - start + 1)
        self.send_response(206 if wanted else 200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(len(body)))
        if wanted:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.end_headers()
        self.wfile.write(body)
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.path != "/api/search/random" or self.headers.get("x-api-key") != "secret":
            return self.answer(401, b"{}", "application/json")
        assets = [{"id": "red", "type": "VIDEO", "originalFileName": "red.mp4", "fileCreatedAt": "2024-07-14T10:00:00Z",
                   "exifInfo": {"city": "Lisbon", "country": "Portugal"}},
                  {"id": "blue", "type": "VIDEO", "originalFileName": "blue.mp4", "fileCreatedAt": "2023-01-02T10:00:00Z"},
                  {"id": "photo", "type": "IMAGE"}]
        self.answer(200, json.dumps(assets).encode(), "application/json")
    def do_GET(self):
        parts = self.path.split("/")
        if self.path.startswith("/files/"):
            return self.file(parts[2])
        if self.headers.get("x-api-key") != "secret" or len(parts) != 6 or parts[5] != "playback":
            return self.answer(401, b"", "text/plain")
        name = {"red": "a.mp4", "blue": "b.mp4"}.get(parts[3])
        if not name:
            return self.answer(404, b"", "text/plain")
        self.file(name)
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Server).serve_forever()
"""

if haveFfmpeg:
  clip(assets / "videos" / "a.mp4", ["red"])
  clip(assets / "videos" / "b.mp4", ["blue"])
  clip(assets / "film.mp4", ["red", "blue"])

suite "the video samples":
  setup:
    rhythmClockOverride = 0
    rhythmCanvasGeneration = nil

  var problems: seq[string]
  var logger = Logger(frameConfig: nil, enabled: true)
  logger.log = proc(payload: JsonNode) =
    if payload{"event"}.getStr().contains("error") or payload{"level"}.getStr() == "error":
      problems.add($payload)
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false

  proc frame(): FrameConfig =
    FrameConfig(name: "video", mode: "rpios", device: "framebuffer", width: 320, height: 180, rotate: 0,
      scalingMode: "cover", debug: false, settings: %*{}, renderScale: 1.0, saveAssets: %*false,
      assetsPath: assets)

  proc load(sample, id: string, state = %*{}): FrameScene =
    setUploadedInterpretedScenes(parseInterpretedScenes($(%*[parseFile(Samples / sample / "scenes.json")[0]])))
    resetInterpretedScenes()
    let config = frame()
    logger.frameConfig = config
    init(id.SceneId, config, logger, state)

  proc draw(scene: FrameScene): tuple[image: Image, wait: float] =
    let image = newImage(320, 180)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, image: image,
      hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
    (render(scene, context), context.nextSleep)

  proc shot(image: Image, name: string) =
    let dir = getEnv("FRAMEOS_VIDEO_SHOTS")
    if dir.len > 0:
      createDir(dir)
      image.writeFile(dir / (name & ".png"))

  proc color(image: Image, x = 160, y = 90): string =
    let c = image[x, y].rgba
    if c.r > 180 and c.g < 80 and c.b < 80: "red"
    elif c.b > 180 and c.r < 80 and c.g < 80: "blue"
    elif c.r < 30 and c.g < 30 and c.b < 30: "black"
    else: $c

  proc play(scene: FrameScene, seconds: float, until: proc(image: Image): bool = nil): Image =
    let deadline = epochTime() + seconds
    while epochTime() < deadline:
      let (image, wait) = scene.draw()
      result = image
      if not until.isNil and until(image):
        return
      sleep(int(clamp(if wait < 0: 0.05 else: wait, 0.001, 0.25) * 1000))

  test "Video player plays the folder one after another, and round again":
    if not haveFfmpeg:
      skip()
    else:
      problems = @[]
      let scene = load("Video player", "video-player")
      var seen: seq[string]
      let last = scene.play(40, proc(image: Image): bool =
        let c = image.color()
        if c in ["red", "blue"] and (seen.len == 0 or seen[^1] != c):
          seen.add c
        seen.len >= 3)
      last.shot("video-player")
      check seen.len >= 3
      check seen[0 .. 2] == @["red", "blue", "red"]
      check scene.state{"spot"}{"file"}.getStr() == "videos/a.mp4"
      check problems.len == 0
      if problems.len > 0: echo problems

  test "a tap on the Video player shows its controls over the video":
    if not haveFfmpeg:
      skip()
    else:
      problems = @[]
      let scene = load("Video player", "video-player")
      discard scene.play(20, proc(image: Image): bool = image.color() == "red")
      let (before, _) = scene.draw()
      check before.color(160, 6) == "red"
      runEvent(scene, ExecutionContext(scene: scene, event: "tap", payload: %*{"x": 160, "y": 90, "pointerId": 0,
        "pointerType": "touch"}, loopIndex: 0, loopKey: ".", nextSleep: -1))
      let (after, _) = scene.draw()
      after.shot("video-player-controls")
      # The bar over the top: the red darkened under it.
      let c = after[160, 6].rgba
      check c.r > 60 and c.r < 160 and c.g < 40
      check problems.len == 0

  test "Files plays a video it opens":
    if not haveFfmpeg:
      skip()
    else:
      problems = @[]
      let scene = load("Files", "asset-browser", %*{"spot": {"dir": "videos", "page": 1, "open": "videos/b.mp4"}})
      let image = scene.play(20, proc(image: Image): bool = image.color() == "blue")
      image.shot("files-video")
      check image.color() == "blue"
      check scene.state{"spot"}{"open"}.getStr() == "videos/b.mp4"
      check problems.len == 0
      if problems.len > 0: echo problems

  test "Files shows a frame of a video as its thumbnail":
    if not haveFfmpeg:
      skip()
    else:
      problems = @[]
      let scene = load("Files", "asset-browser", %*{"spot": {"dir": "videos", "page": 1}})
      var image: Image
      for i in 0 ..< 6:
        image = scene.draw().image
      image.shot("files-thumbnails")
      var red, blue = 0
      for y in countup(0, 179, 3):
        for x in countup(0, 319, 3):
          case image.color(x, y)
          of "red": inc red
          of "blue": inc blue
          else: discard
      check red > 30 and blue > 30
      check problems.len == 0

  test "Slow movie steps through the film, and starts it again at its end":
    if not haveFfmpeg:
      skip()
    else:
      problems = @[]
      let scene = load("Slow movie", "slow-movie", %*{"file": "film.mp4", "step": 1.2, "caption": false})
      var seen: seq[string]
      for i in 0 ..< 3:
        let (image, wait) = scene.draw()
        seen.add image.color()
        check wait < 0 # its own interval, never a video's pace
      check seen == @["red", "blue", "red"]
      check problems.len == 0
      if problems.len > 0: echo problems

  proc serve(port: int): Process =
    ## A web server over the clips, with Range requests as a real one has
    ## (an MP4 whose index is at its end is read with a seek), and a
    ## stand-in for Immich: two videos in a random search, each one's stream
    ## only with the key.
    writeFile(assets / "server.py", ServerPy)
    result = startProcess("python3", args = [assets / "server.py", $port, assets / "videos"],
      options = {poUsePath, poStdErrToStdOut})
    sleep(700)

  test "Video from URL plays a file over HTTP":
    if not haveFfmpeg or findExe("python3").len == 0:
      skip()
    else:
      problems = @[]
      let port = 18000 + getCurrentProcessId() mod 1000
      let server = serve(port)
      try:
        let scene = load("Video from URL", "video-url", %*{"url": "http://127.0.0.1:" & $port & "/files/b.mp4"})
        let image = scene.play(30, proc(image: Image): bool = image.color() == "blue")
        image.shot("video-url")
        check image.color() == "blue"
        check problems.len == 0
        if problems.len > 0: echo problems
      finally:
        server.terminate()
        discard server.waitForExit()
        server.close()

  test "Immich videos plays the server's videos with its key, one after another":
    if not haveFfmpeg or findExe("python3").len == 0:
      skip()
    else:
      problems = @[]
      let port = 19000 + getCurrentProcessId() mod 1000
      let server = serve(port)
      try:
        let scene = load("Immich videos", "immich-videos")
        scene.frameConfig.settings = %*{"immich": {"url": "http://127.0.0.1:" & $port, "apiKey": "secret"}}
        var seen: seq[string]
        let last = scene.play(30, proc(image: Image): bool =
          let c = image.color()
          if c in ["red", "blue"] and (seen.len == 0 or seen[^1] != c):
            seen.add c
          seen.len >= 2)
        last.shot("immich-videos")
        check seen.len >= 2
        check problems.len == 0
        if problems.len > 0: echo problems
      finally:
        server.terminate()
        discard server.waitForExit()
        server.close()

  test "Video player plays in a window of a desktop, and paces the frame":
    if not haveFfmpeg:
      skip()
    else:
      problems = @[]
      # A desktop: the scene it wraps on the left, a window of the Video
      # player on the right, as the windowed layouts draw one (hostSceneFor).
      let desk = %*{"id": "tests/desk", "name": "Desk", "settings": {"execution": "interpreted",
        "refreshInterval": 300, "backgroundColor": "#ffffff", "isLayout": true}, "fields": [],
        "apps": {"desk": {"name": "desk", "category": "data", "version": "1.0.0", "fields": [],
          "output": [{"name": "image", "type": "image"}], "sources": {"config.json": "{}", "app.tsx":
            "export function get(app) { return (<div className=\"relative w-full h-full bg-white\">" &
            "<div className=\"absolute left-0 top-0 w-[100px] h-[180px] flex\"><yield /></div>" &
            "<div className=\"absolute left-[120px] top-[20px] w-[180px] h-[120px] flex\"><Scene id=\"video-player\" /></div>" &
            "</div>) }"}}},
        "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
          {"id": "2", "type": "app", "data": {"keyword": "desk", "config": {}}},
          {"id": "3", "type": "app", "data": {"keyword": "render/image", "config": {"placement": "stretch"}}}],
        "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "3", "targetHandle": "prev"},
          {"id": "2", "source": "2", "sourceHandle": "fieldOutput", "target": "3", "targetHandle": "fieldInput/image"}]}
      let front = %*{"id": "tests/front", "name": "Front", "settings": {"execution": "interpreted",
        "refreshInterval": 600, "backgroundColor": "#00ff00"}, "fields": [], "apps": {},
        "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}}], "edges": [],
        "layout": {"sceneId": "tests/desk", "state": {}}}
      setUploadedInterpretedScenes(parseInterpretedScenes($(%*[desk, front,
        parseFile(Samples / "Video player" / "scenes.json")[0]])))
      resetInterpretedScenes()
      let config = frame()
      logger.frameConfig = config
      var hosted: seq[FrameScene]
      hostSceneFor = proc(sceneId: SceneId): FrameScene {.closure, gcsafe.} =
        {.cast(gcsafe).}:
          for scene in hosted:
            if scene.id == sceneId: return scene
          result = init(sceneId, config, logger, %*{})
          hosted.add result
      defer: hostSceneFor = nil
      let scene = hostSceneFor("tests/front".SceneId)
      var seen: seq[string]
      var waits: seq[float]
      let deadline = epochTime() + 40
      var last: Image
      while epochTime() < deadline and seen.len < 3:
        let (image, _) = scene.draw()
        last = image
        let c = image.color(210, 80) # the window's middle
        if c in ["red", "blue"] and (seen.len == 0 or seen[^1] != c):
          seen.add c
        # When the frame wakes next: the video's next frame, not the desk's 300 s.
        let wait = scene.refreshInterval
        if c in ["red", "blue"]:
          waits.add wait
        sleep(int(clamp(wait, 0.001, 0.25) * 1000))
      last.shot("video-player-window")
      check seen.len >= 3 and seen[0 .. 2] == @["red", "blue", "red"]
      check last.color(50, 90) != "red" and last.color(50, 90) != "blue" # the wrapped scene's half
      check waits.len > 0 and waits[0] < 1.0
      check problems.len == 0
      if problems.len > 0: echo problems

  test "Camera wall and Immich videos say what they need":
    problems = @[]
    let wall = load("Camera wall", "camera-wall")
    let (image, wait) = wall.draw()
    image.shot("camera-wall-empty")
    check wait < 0
    let immich = load("Immich videos", "immich-videos")
    discard immich.draw()
    check problems.len == 0

removeDir(assets)
