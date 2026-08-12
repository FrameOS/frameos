import std/[json, net, os, strutils, tables, times]
import pixie
import ../interpreter
import ../types
import ../values
import ../utils/http_client
import ../utils/memory

# The byte-side tier, end to end through the interpreter: the Calendar graph
# (downloadUrl -> icalJson -> render/calendar -> render/image) fed a multi-MB
# ICS document over real HTTP, with an ESP32-sized memory budget so the body
# spools to a file. This is the scene shape phase 2 was built for — big input,
# small output — exercised as a scene rather than as units
# (docs/value-pipeline.md, phase 2).

const
  CanvasWidth = 200
  CanvasHeight = 120
  EventCount = 6000 # ~2MB of ICS, comfortably past the 1MB spool threshold

var serverPort: Port
var serverThread: Thread[void]

proc buildIcs(): string =
  ## Events spread around "now" so icalJson's last-month..next-month window
  ## keeps them, with descriptions padding each event to a realistic size.
  var lines = @["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//FrameOS//byte tier test//EN"]
  let today = now()
  for i in 0 ..< EventCount:
    let day = today + initDuration(days = (i mod 21) - 10)
    let stamp = day.format("yyyyMMdd")
    lines.add("BEGIN:VEVENT")
    lines.add("UID:byte-tier-" & $i & "@frameos.test")
    lines.add("DTSTART:" & stamp & "T" & align($(6 + i mod 12), 2, '0') & "0000Z")
    lines.add("DTEND:" & stamp & "T" & align($(7 + i mod 12), 2, '0') & "0000Z")
    lines.add("SUMMARY:Event " & $i)
    lines.add("DESCRIPTION:byte tier test event " & $i & " " & repeat('x', 180 + i mod 120))
    lines.add("END:VEVENT")
  lines.add("END:VCALENDAR")
  lines.join("\r\n") & "\r\n"

proc serverLoop() {.thread.} =
  let body = buildIcs()
  var server = newSocket()
  server.setSockOpt(OptReuseAddr, true)
  server.bindAddr(Port(0), "127.0.0.1")
  server.listen()
  var boundAddr: string
  var boundPort: Port
  (boundAddr, boundPort) = server.getLocalAddr()
  serverPort = boundPort
  while true:
    var client: Socket
    server.accept(client)
    var requestLine = ""
    try:
      requestLine = client.recvLine(timeout = 5000)
      while true:
        let line = client.recvLine(timeout = 5000)
        if line == "\r\n" or line.len == 0:
          break
    except CatchableError:
      client.close()
      continue
    let parts = requestLine.splitWhitespace()
    let path = if parts.len >= 2: parts[1] else: "/"
    if path == "/quit":
      client.send("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
      client.close()
      break
    client.send("HTTP/1.1 200 OK\r\nContent-Length: " & $body.len & "\r\n\r\n" & body)
    client.close()
  server.close()

proc node(id: int, nodeType: string, data: JsonNode): DiagramNode =
  DiagramNode(id: id.NodeId, nodeType: nodeType, data: data)

proc edge(id, source: int, sourceHandle: string, target: int,
    targetHandle: string): DiagramEdge =
  DiagramEdge(id: id.NodeId, source: source.NodeId, sourceHandle: sourceHandle,
    target: target.NodeId, targetHandle: targetHandle, data: %*{})

proc buildScene(url: string): ExportedInterpretedScene =
  ExportedInterpretedScene(
    name: "Byte tier calendar",
    backgroundColor: parseHtmlColor("#204080"),
    refreshInterval: 60.0,
    publicStateFields: @[],
    nodes: @[
      node(1, "event", %*{"keyword": "render"}),
      node(2, "app", %*{"keyword": "render/image", "config": {}}),
      node(3, "app", %*{"keyword": "render/calendar", "config": {}}),
      node(4, "app", %*{"keyword": "data/icalJson", "config": {
        "exportFrom": "last month", "exportUntil": "next month",
        "exportCount": "500"}}),
      node(5, "app", %*{"keyword": "data/downloadUrl", "config": {"url": url}})
    ],
    edges: @[
      edge(1, 1, "next", 2, "prev"),
      edge(2, 3, "fieldOutput", 2, "fieldInput/image"),
      edge(3, 4, "fieldOutput", 3, "fieldInput/events"),
      edge(4, 5, "fieldOutput", 4, "fieldInput/ical")
    ],
    apps: %*{}
  )

createThread(serverThread, serverLoop)
for _ in 0 ..< 200:
  if int(serverPort) != 0:
    break
  sleep(10)
doAssert int(serverPort) != 0, "test server did not start"

# ESP32-class headroom: makes spoolThreshold() land at 1MB, under the ~2MB body.
availableRenderBytesOverride = 4 * 1024 * 1024

var spoolEvents: seq[JsonNode] = @[]
var errorEvents: seq[string] = @[]

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: false)
  logger.log = proc(payload: JsonNode) =
    let event = payload{"event"}.getStr()
    # App JSON logs arrive wrapped as "log:<nodeId>:<event>".
    if event == "spool" or event.endsWith(":spool"):
      spoolEvents.add(payload)
    if event.contains(":error") or event.startsWith("error:"):
      errorEvents.add($payload)
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

let scratch = getTempDir() / "frameos-byte-tier-scene"
removeDir(scratch)
createDir(scratch)

let config = FrameConfig(
  name: "byte-tier", mode: "embedded", width: CanvasWidth, height: CanvasHeight,
  rotate: 0, scalingMode: "cover", assetsPath: scratch, debug: false,
  settings: %*{}, saveAssets: %*false
)

let sceneId = "tests/byte-tier-scene".SceneId
var uploaded = initTable[SceneId, ExportedInterpretedScene]()
uploaded[sceneId] = buildScene("http://127.0.0.1:" & $int(serverPort) & "/big.ics")
setUploadedInterpretedScenes(uploaded)
resetInterpretedScenes()

let scene = init(sceneId, config, testLogger(config), %*{})
var context = ExecutionContext(
  scene: scene, event: "render", payload: %*{}, hasImage: false,
  loopIndex: 0, loopKey: ".", nextSleep: 0.0
)
let canvas = render(scene, context)

# The render came out, and nothing errored along the chain.
doAssert canvas.width == CanvasWidth and canvas.height == CanvasHeight
doAssert errorEvents.len == 0, "render chain errored: " & errorEvents.join("; ")

# The document crossed the edge as a file, not as memory: the storage tier was
# reached, in the preferred spool dir (assetsPath/.cache), at full size.
doAssert spoolEvents.len >= 1, "downloadUrl never reported a spool decision"
let spoolEvent = spoolEvents[^1]
doAssert spoolEvent{"tier"}.getStr() == "storage",
  "expected the storage tier, got: " & $spoolEvent
doAssert spoolEvent{"path"}.getStr().startsWith(scratch),
  "spool file not in the preferred dir: " & $spoolEvent
doAssert spoolEvent{"bytes"}.getInt() > 1024 * 1024,
  "spooled body suspiciously small: " & $spoolEvent

# And the fold got real events out of it: the icalJson node, asked directly,
# yields the export cap's worth of parsed events from the file-backed body.
let icalContext = ExecutionContext(
  scene: scene, event: "data", payload: %*{}, hasImage: false,
  loopIndex: 0, loopKey: ".", nextSleep: 0.0
)
let events = runNode(scene, 4.NodeId, icalContext, asDataNode = true).asJson()
doAssert events.kind == JArray and events.len == 500,
  "expected the export cap of 500 events, got " & $events.len

discard boundedGetContent("http://127.0.0.1:" & $int(serverPort) & "/quit")

echo "test_byte_tier_scene: ", spoolEvent{"bytes"}.getInt(), " bytes spooled to ",
  spoolEvent{"path"}.getStr(), ", 500 events folded, render clean"
