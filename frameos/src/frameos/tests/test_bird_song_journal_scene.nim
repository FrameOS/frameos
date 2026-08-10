import std/[base64, json, net, os, strutils, tables]
import pixie
import ../interpreter
import ../types

# End-to-end test for the "Bird song journal" sample scene: a mock BirdWeather
# GraphQL endpoint reports two well-heard species (plus one below the detection
# floor and one without a reference photo), and a mock OpenAI Responses API
# returns a canned plate for image_generation calls and an approving verdict for
# verification calls. The scene must log only the usable species, draw + verify
# one plate per render, save them as assets, and cycle through the collection.

const ScenesPath = "../repo/scenes/samples/Bird song journal/scenes.json"

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
# The mock thread inspects the query itself and reports value types, so no
# GC'd request bodies have to travel back to the main thread.
var graphqlCalls = 0
var sawTopSpecies = false
var sawBoundingBox = false
var sawClassification = false
var sawStationIds = false

proc birdweatherBody(): string =
  let imageBase = "http://127.0.0.1:" & $int(mockPort) & "/species"
  $(%*{
    "data": {
      "topSpecies": [
        {
          "count": 4836,
          "species": {
            "id": "11",
            "commonName": "Great Tit",
            "scientificName": "Parus major",
            "imageUrl": imageBase & "/11/GreatTit-standard.jpg",
            "imageCredit": "<a href=\"//commons.wikimedia.org/wiki/User:Tester\">Tester</a>",
            "imageLicense": "CC BY-SA 3.0"
          }
        },
        {
          "count": 7282,
          "species": {
            "id": "6",
            "commonName": "European Robin",
            "scientificName": "Erithacus rubecula",
            "imageUrl": imageBase & "/6/EuropeanRobin-standard.jpg",
            "imageCredit": "Tester",
            "imageLicense": "CC BY 2.0"
          }
        },
        {
          # Below minDetections: one of BirdNET's one-off guesses.
          "count": 1,
          "species": {
            "id": "99",
            "commonName": "Ghost Bird",
            "scientificName": "Nullus avis",
            "imageUrl": imageBase & "/99/GhostBird-standard.jpg"
          }
        },
        {
          # Well heard, but no reference photo to draw a plate from.
          "count": 500,
          "species": {
            "id": "77",
            "commonName": "No Photo Bird",
            "scientificName": "Sine imagine"
          }
        }
      ],
      "detections": {
        "speciesCount": 157,
        "totalCount": 95067,
        "nodes": [
          {"speciesId": "6", "timestamp": "2026-08-10T18:56:33+02:00",
           "station": {"name": "PUC-6767"}},
          {"speciesId": "11", "timestamp": "2026-08-10T18:12:01+02:00",
           "station": {"name": "BirdNET-Pi - Thuis"}},
          # Older than the one above: the newest detection per species wins.
          {"speciesId": "6", "timestamp": "2026-08-10T17:00:00+02:00",
           "station": {"name": "Far away station"}}
        ]
      }
    }
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
    elif path.startsWith("/graphql"):
      inc graphqlCalls
      if body.contains("topSpecies"):
        sawTopSpecies = true
      if body.contains("\"classifications\":[\"avian\"]"):
        sawClassification = true
      # 50.85/4.35 with a 25km radius; asserting a prefix keeps the test off
      # the exact float formatting.
      if body.contains("\"ne\":{\"lat\":51.07"):
        sawBoundingBox = true
      if body.contains("\"stationIds\":[\"6767\"]"):
        sawStationIds = true
      jsonResponse(client, birdweatherBody())
    elif path.startsWith("/species/"):
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

let assetsDir = getTempDir() / "frameos-bird-song-journal-test"
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
doAssert scenesJson.len == 1, "expected one Bird Song Journal sample scene"
let birdSongApp = scenesJson[0]["apps"]["birdSongJournal"]
doAssert not birdSongApp.hasKey("origin"),
  "Bird Song Journal must remain an inline scene app without a catalog origin"
doAssert birdSongApp["sources"]{"app.ts"}.getStr().len > 0,
  "Bird Song Journal must keep its app source inline in the scene"
for scene in scenesJson.items:
  for node in scene["nodes"].items:
    if node["data"]{"keyword"}.getStr() == "birdSongJournal":
      node["data"]["config"]["birdweatherHost"] = %*mockBase
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

# Render 1: polls BirdWeather, draws + verifies the first plate (the most-heard
# species of this poll: the Robin), and shows it.
let image1 = renderOnce()
doAssert image1.width == 800 and image1.height == 480
doAssert renderChainErrors.len == 0, "render 1 errors:\n" & renderChainErrors.join("\n")
doAssert graphqlCalls == 1, "render 1 graphql calls: " & $graphqlCalls
doAssert sawTopSpecies, "the poll must ask BirdWeather for topSpecies"
doAssert sawClassification, "the poll must pass the configured classifications"
doAssert sawBoundingBox, "the poll must turn latitude/longitude/radius into a bounding box"
doAssert not sawStationIds, "no station IDs are configured yet"
doAssert fileExists(assetsDir / "birdSongJournal" / "6-erithacus-rubecula.png"),
  "European Robin plate was not saved"
doAssert not fileExists(assetsDir / "birdSongJournal" / "11-parus-major.png"),
  "only one plate should be drawn per render"
doAssert generationCalls == 1 and verificationCalls == 1,
  "render 1 calls: " & $generationCalls & " generations, " & $verificationCalls & " verifications"
var caption = scene.state{"birdCaption"}.getStr()
doAssert "European Robin" in caption and "Erithacus rubecula" in caption, "caption 1: " & caption
doAssert "heard 7,282" in caption, "caption 1: " & caption
doAssert "last 18:56 at PUC-6767" in caption, "caption 1: " & caption
doAssert "1/1" in caption, "caption 1: " & caption
# The plate must actually be drawn onto the canvas (solid #336699 fixture)
let center1 = image1.data[image1.dataIndex(400, 240)]
doAssert center1.b.int > center1.r.int + 40, "canvas does not show the plate color"

# Journal state: only the species that can actually become plates are logged.
let journal1 = scene.state{"birdSongJournal"}
doAssert journal1{"species"}{"6"}{"plate"}.getStr() == "birdSongJournal/6-erithacus-rubecula.png"
doAssert journal1{"species"}{"11"}{"detections"}.getInt() == 4836
doAssert journal1{"species"}{"11"}{"plate"}.getStr() == ""
doAssert not journal1{"species"}.hasKey("99"),
  "species below the detection floor must be ignored"
doAssert not journal1{"species"}.hasKey("77"),
  "species without a reference photo must be ignored"
# BirdWeather credits arrive as HTML; they are stored as plain attribution text.
let robinCredit = journal1{"species"}{"6"}{"photos"}[0]{"attribution"}.getStr()
doAssert robinCredit == "Tester (CC BY 2.0)", "robin credit: " & robinCredit
let titCredit = journal1{"species"}{"11"}{"photos"}[0]{"attribution"}.getStr()
doAssert titCredit == "Tester (CC BY-SA 3.0)", "great tit credit: " & titCredit
doAssert journal1{"lastPoll"}{"totalDetections"}.getInt() == 95067

# Render 2: draws the Great Tit, collection cycles to plate 2/2.
renderChainErrors = @[]
let image2 = renderOnce()
doAssert renderChainErrors.len == 0, "render 2 errors:\n" & renderChainErrors.join("\n")
doAssert fileExists(assetsDir / "birdSongJournal" / "11-parus-major.png"),
  "Great Tit plate was not saved"
doAssert generationCalls == 2 and verificationCalls == 2
caption = scene.state{"birdCaption"}.getStr()
doAssert "Great Tit" in caption and "2/2" in caption, "caption 2: " & caption
doAssert "heard 4,836" in caption, "caption 2: " & caption
doAssert "last 18:12 at BirdNET-Pi - Thuis" in caption, "caption 2: " & caption
doAssert image2.width == 800 and image2.height == 480

# Render 3: nothing pending, no new API calls, cycles back to plate 1/2.
renderChainErrors = @[]
let image3 = renderOnce()
doAssert renderChainErrors.len == 0, "render 3 errors:\n" & renderChainErrors.join("\n")
doAssert generationCalls == 2 and verificationCalls == 2, "render 3 must not call OpenAI"
doAssert graphqlCalls == 1, "pollMinutes must keep renders 2 and 3 off the network"
caption = scene.state{"birdCaption"}.getStr()
doAssert "European Robin" in caption and "1/2" in caption, "caption 3: " & caption
doAssert image3.width == 800 and image3.height == 480

discard renderOnce() # one more cycle for good measure: 2/2 again
caption = scene.state{"birdCaption"}.getStr()
doAssert "2/2" in caption, "caption 4: " & caption

# Render 5: a configured station takes over from the location box. Clearing the
# poll timestamp is what a restart past pollMinutes would do.
scene.state["stationIds"] = %*"6767"
scene.state["birdSongJournal"]["lastPollAt"] = %*0
sawBoundingBox = false
renderChainErrors = @[]
discard renderOnce()
doAssert renderChainErrors.len == 0, "render 5 errors:\n" & renderChainErrors.join("\n")
doAssert graphqlCalls == 2, "render 5 should poll again: " & $graphqlCalls
doAssert sawStationIds, "a configured station ID must be sent to BirdWeather"
doAssert not sawBoundingBox, "a configured station ID must replace the bounding box"

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

echo "test_bird_song_journal_scene: 2 plates drawn, verified, and cycling"
