import std/[json, strutils, tables]
import pixie
import ../interpreter
import ../types
import ../utils/app_images
import ../utils/image
import ../utils/http_client
import ../js_runtime/app_runtime

# The Google Photos sample scene's Fit field, through the interpreter
# (issue #695). The app's fitMode alone did nothing: render/image drew the
# photo with its own placement, cover by default, so a contained photo was
# blown up and cropped again. The scene wires its Fit field into both the
# render/image placement and the app, and the app asks Google for the photo
# that placement draws. The album page and the photo are answered at the
# test seams, so this runs offline.

const ScenePath = "../repo/scenes/samples/Google Photos/scenes.json"
const PhotoHost = "https://lh3.googleusercontent.com/"
let photoPath = "pw/AP1GczN" & repeat("aB3", 20)

var photoUrls: seq[string] = @[]

proc stubPage(url, httpMethod, body: string, headers: seq[SimpleHttpHeader]): tuple[code: int, body: string] =
  (200, "[\"" & PhotoHost & photoPath & "=w600-h400\"]")

proc portraitPhoto(): Image =
  # What Google serves for a portrait photo at =w800-h480-no: the whole photo,
  # at most 800x480.
  result = newImage(288, 480)
  result.fill(rgba(220, 30, 30, 255))

proc stubDownload(url: string, maxBytes: int, target: Image, fit: ScaledDecodeFit,
    boundWidth: int, boundHeight: int): tuple[image: Image, data: string] =
  photoUrls.add(url)
  let photo = portraitPhoto()
  if target.isNil:
    return (photo, "")
  # A decode into the offered canvas draws with the consumer's placement.
  let mode = case fit
    of fitContain: "contain"
    of fitStretch: "stretch"
    of fitCenter: "center"
    else: "cover"
  scaleAndDrawImage(target, photo, mode)
  (target, "")

jsHttpRequestHook = stubPage
contextDownloadHook = stubDownload

proc logger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: false)
  logger.log = proc(payload: JsonNode) = discard payload
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

proc renderSample(state: JsonNode): Image =
  let inputs = parseInterpretedSceneInputs(readFile(ScenePath))
  var uploaded = initTable[SceneId, ExportedInterpretedScene]()
  for id, exported in buildInterpretedScenes(inputs):
    uploaded[id] = exported
  setUploadedInterpretedScenes(uploaded)
  resetInterpretedScenes()
  let config = FrameConfig(name: "test", mode: "embedded", width: 800, height: 480, rotate: 0,
    scalingMode: "cover", debug: false, settings: %*{}, saveAssets: %*false)
  let scene = init(inputs[0].id, config, logger(config), state)
  var context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false,
    loopIndex: 0, loopKey: ".", nextSleep: 0.0)
  render(scene, context)

proc isRed(c: ColorRGBX): bool = c.r > 200 and c.g < 60 and c.b < 60
proc isBlack(c: ColorRGBX): bool = c.r < 10 and c.g < 10 and c.b < 10

block contain_shows_the_whole_photo:
  photoUrls = @[]
  let image = renderSample(%*{"shareUrl": "https://photos.app.goo.gl/x", "fit": "contain"})
  doAssert photoUrls == @[PhotoHost & photoPath & "=w800-h480-no"], $photoUrls
  # A 288x480 photo in an 800x480 canvas: the bars are the scene's black.
  doAssert image[400, 240].isRed()
  doAssert image[20, 240].isBlack(), $image[20, 240]
  doAssert image[780, 240].isBlack(), $image[780, 240]

block cover_fills_the_screen:
  for state in [%*{"shareUrl": "https://photos.app.goo.gl/x", "fit": "cover"},
      %*{"shareUrl": "https://photos.app.goo.gl/x"}]:
    photoUrls = @[]
    let image = renderSample(state)
    doAssert photoUrls == @[PhotoHost & photoPath & "=w800-h480-c"], $photoUrls
    doAssert image[20, 240].isRed()
    doAssert image[780, 240].isRed()

setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())
contextDownloadHook = nil
jsHttpRequestHook = nil
echo "test_google_photos_scene_fit: all assertions passed"
