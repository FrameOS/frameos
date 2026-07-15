import std/[base64, json, net, os, strutils, tables]
import pixie
import ../interpreter
import ../types

# End-to-end test for the "Bird field journal" sample scene: a mock iNaturalist
# serves two bird sightings with licensed photos, a mock OpenAI Responses API
# returns a canned plate for image_generation calls and an approving verdict
# for verification calls. The scene must log both species, draw + verify one
# plate per render, save them as assets, and cycle through the collection.

const ScenesPath = "../repo/scenes/samples/Bird field journal/scenes.json"

var mockPort: Port
var mockThread: Thread[void]

proc jsonResponse(client: Socket, body: string) =
  client.send("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " &
    $body.len & "\r\n\r\n" & body)
  client.close()

proc bytesResponse(client: Socket, body: string) =
  client.send("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: " &
    $body.len & "\r\n\r\n" & body)
  client.close()

var generationCalls = 0
var verificationCalls = 0

proc observationsBody(): string =
  let photoBase = "http://127.0.0.1:" & $int(mockPort) & "/photos"
  $(%*{
    "total_results": 2,
    "results": [
      {
        "observed_on": "2026-07-10",
        "taxon": {"id": 111, "name": "Parus major", "preferred_common_name": "Great Tit"},
        "photos": [
          {"url": photoBase & "/1/square.jpg", "license_code": "cc-by", "attribution": "(c) tester, CC BY"}
        ]
      },
      {
        "observed_on": "2026-07-12",
        "taxon": {"id": 222, "name": "Erithacus rubecula", "preferred_common_name": "European Robin"},
        "photos": [
          {"url": photoBase & "/2/square.jpg", "license_code": "cc-by-nc", "attribution": "(c) tester, CC BY-NC"}
        ]
      },
      {
        "observed_on": "2026-07-12",
        "taxon": {"id": 222, "name": "Erithacus rubecula", "preferred_common_name": "European Robin"},
        "photos": [
          {"url": photoBase & "/3/square.jpg", "license_code": "cc-by-nc", "attribution": "(c) tester, CC BY-NC"}
        ]
      }
    ]
  })

proc mockServerLoop() {.thread.} =
  var server = newSocket()
  server.setSockOpt(OptReuseAddr, true)
  server.bindAddr(Port(0), "127.0.0.1")
  server.listen()
  var boundAddr: string
  var boundPort: Port
  (boundAddr, boundPort) = server.getLocalAddr()
  mockPort = boundPort

  var photoBytes = ""
  var plateB64 = ""

  while true:
    var client: Socket
    server.accept(client)
    var requestLine = ""
    var contentLength = 0
    try:
      requestLine = client.recvLine(timeout = 10000)
      while true:
        let line = client.recvLine(timeout = 10000)
        if line == "\r\n" or line.len == 0:
          break
        if line.toLowerAscii().startsWith("content-length:"):
          contentLength = parseInt(line.split(":", maxsplit = 1)[1].strip())
    except CatchableError:
      client.close()
      continue

    var body = ""
    if contentLength > 0:
      try:
        body = client.recv(contentLength, timeout = 10000)
      except CatchableError:
        discard

    let parts = requestLine.splitWhitespace()
    let path = if parts.len >= 2: parts[1] else: "/"

    # Lazy fixtures: pixie can encode PNG (not JPEG); the photo bytes are only
    # base64-shuttled through the app so the format never matters.
    if photoBytes.len == 0:
      var photo = newImage(8, 8)
      photo.fill(parseHtmlColor("#8899aa"))
      photoBytes = encodeImage(photo, PngFormat)
    if plateB64.len == 0:
      var plate = newImage(100, 160)
      plate.fill(parseHtmlColor("#336699"))
      plateB64 = encode(encodeImage(plate, PngFormat))

    if path == "/quit":
      client.send("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
      client.close()
      break
    elif path.startsWith("/v2/observations"):
      jsonResponse(client, observationsBody())
    elif path.startsWith("/photos/"):
      bytesResponse(client, photoBytes)
    elif path.startsWith("/v1/responses"):
      if body.contains("image_generation"):
        inc generationCalls
        jsonResponse(client, $(%*{
          "output": [
            {"type": "reasoning", "summary": []},
            {"type": "image_generation_call", "status": "completed", "result": plateB64}
          ]
        }))
      else:
        inc verificationCalls
        jsonResponse(client, $(%*{
          "output": [
            {"type": "message", "content": [
              {"type": "output_text", "text": "{\"ok\": true, \"reason\": \"matches the reference\"}"}
            ]}
          ]
        }))
    else:
      client.send("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
      client.close()

  server.close()

createThread(mockThread, mockServerLoop)
for _ in 0 ..< 200:
  if int(mockPort) != 0:
    break
  sleep(20)
doAssert int(mockPort) != 0, "mock server did not start"
let mockBase = "http://127.0.0.1:" & $int(mockPort)

let assetsDir = getTempDir() / "frameos-bird-journal-test"
removeDir(assetsDir)
createDir(assetsDir)

var renderChainErrors: seq[string] = @[]

proc testLogger(): Logger =
  var logger = Logger(enabled: false)
  logger.log = proc(payload: JsonNode) =
    if getEnv("FRAMEOS_TEST_VERBOSE") == "1":
      echo payload
    let event = payload{"event"}.getStr()
    if event == "runEventInterpreted:error" or
        (event.startsWith("interpreter:") and event.contains(":error")) or
        event in ["interpreter:graph:hopLimit", "interpreter:graph:cycle", "interpreter:nodeNotFound"]:
      renderChainErrors.add($payload)
    # JS app errors surface as log events too; catch them so failures are loud.
    if event.startsWith("jsApp:error") or payload{"error"}.getStr().len > 0:
      renderChainErrors.add($payload)
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

# Point the scene's app at the mock server before building it.
var scenesJson = parseJson(readFile(ScenesPath))
doAssert scenesJson.len == 1, "expected one Bird Journal sample scene"
let birdJournalApp = scenesJson[0]["apps"]["birdJournal"]
doAssert not birdJournalApp.hasKey("origin"),
  "Bird Journal must remain an inline scene app without a catalog origin"
doAssert birdJournalApp["sources"]{"app.ts"}.getStr().len > 0,
  "Bird Journal must keep its app source inline in the scene"
for scene in scenesJson.items:
  for node in scene["nodes"].items:
    if node["data"]{"keyword"}.getStr() == "birdJournal":
      node["data"]["config"]["inatHost"] = %*mockBase
      node["data"]["config"]["openaiHost"] = %*mockBase
      node["data"]["config"]["pollMinutes"] = %*60

let inputs = parseInterpretedSceneInputs($scenesJson)
doAssert inputs.len == 1, "expected one scene, got " & $inputs.len
let exportedScenes = buildInterpretedScenes(inputs)
doAssert exportedScenes.len == 1, "failed to build the scene"

var uploaded = initTable[SceneId, ExportedInterpretedScene]()
for id, exported in exportedScenes:
  uploaded[id] = exported
setUploadedInterpretedScenes(uploaded)
resetInterpretedScenes()

let config = FrameConfig(
  name: "test",
  mode: "rpios",
  width: 800,
  height: 480,
  rotate: 0,
  scalingMode: "cover",
  assetsPath: assetsDir,
  debug: false,
  settings: %*{"openAI": {"apiKey": "sk-test"}},
  saveAssets: %*false
)

let persistedState = %*{"latitude": "50.85", "longitude": "4.35"}
let scene = init(inputs[0].id, config, testLogger(), persistedState)

proc renderOnce(): Image =
  var context = ExecutionContext(
    scene: scene, event: "render", payload: %*{}, hasImage: false,
    loopIndex: 0, loopKey: ".", nextSleep: 0.0
  )
  render(scene, context)

# Render 1: polls sightings, draws + verifies the first plate (oldest sighting
# first: the Great Tit), and shows it.
let image1 = renderOnce()
doAssert image1.width == 800 and image1.height == 480
doAssert renderChainErrors.len == 0, "render 1 errors:\n" & renderChainErrors.join("\n")
doAssert fileExists(assetsDir / "birdJournal" / "111-parus-major.png"),
  "Great Tit plate was not saved"
doAssert not fileExists(assetsDir / "birdJournal" / "222-erithacus-rubecula.png"),
  "only one plate should be drawn per render"
doAssert generationCalls == 1 and verificationCalls == 1,
  "render 1 calls: " & $generationCalls & " generations, " & $verificationCalls & " verifications"
var caption = scene.state{"birdCaption"}.getStr()
doAssert "Great Tit" in caption and "Parus major" in caption, "caption 1: " & caption
doAssert "1/1" in caption, "caption 1: " & caption
# The plate must actually be drawn onto the canvas (solid #336699 fixture)
let center1 = image1.data[image1.dataIndex(400, 240)]
doAssert center1.b.int > center1.r.int + 40, "canvas does not show the plate color"

# Journal state: both species logged, sightings counted per window
let journal1 = scene.state{"birdJournal"}
doAssert journal1{"species"}{"111"}{"plate"}.getStr() == "birdJournal/111-parus-major.png"
doAssert journal1{"species"}{"222"}{"sightings"}.getInt() == 2
doAssert journal1{"species"}{"222"}{"plate"}.getStr() == ""

# Render 2: draws the Robin, collection cycles to plate 2/2.
renderChainErrors = @[]
let image2 = renderOnce()
doAssert renderChainErrors.len == 0, "render 2 errors:\n" & renderChainErrors.join("\n")
doAssert fileExists(assetsDir / "birdJournal" / "222-erithacus-rubecula.png"),
  "Robin plate was not saved"
doAssert generationCalls == 2 and verificationCalls == 2
caption = scene.state{"birdCaption"}.getStr()
doAssert "European Robin" in caption and "2/2" in caption, "caption 2: " & caption
doAssert "2 sightings" in caption, "caption 2: " & caption
doAssert image2.width == 800 and image2.height == 480

# Render 3: nothing pending, no new API calls, cycles back to plate 1/2.
renderChainErrors = @[]
let image3 = renderOnce()
doAssert renderChainErrors.len == 0, "render 3 errors:\n" & renderChainErrors.join("\n")
doAssert generationCalls == 2 and verificationCalls == 2, "render 3 must not call OpenAI"
caption = scene.state{"birdCaption"}.getStr()
doAssert "Great Tit" in caption and "1/2" in caption, "caption 3: " & caption
doAssert image3.width == 800 and image3.height == 480

discard renderOnce() # one more cycle for good measure: 2/2 again
caption = scene.state{"birdCaption"}.getStr()
doAssert "2/2" in caption, "caption 4: " & caption

setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())

# Shut the mock down cleanly
try:
  var client = newSocket()
  client.connect("127.0.0.1", mockPort, timeout = 2000)
  client.send("GET /quit HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
  client.close()
except CatchableError:
  discard
joinThread(mockThread)
removeDir(assetsDir)

echo "test_bird_journal_scene: 2 plates drawn, verified, and cycling"
