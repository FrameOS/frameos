## End-to-end hub client session test: a mummy WebSocket server plays the
## provider hub, so the real dial (Authorization header, HTTP upgrade), the
## hello → challenge → auth → ready handshake (with a genuine Ed25519
## signature check) and the verb loop all run over a live socket — no cloud,
## no network beyond 127.0.0.1.

import std/[base64, json, locks, net, os, strutils, sysrand, times, unittest]
import mummy
import mummy/routers

import ../hub_client
import ../identity
import ../link_state
import ../../types
import ../../channels
import ../../utils/http_client

const TestPort = 19468

let workDir = getTempDir() / ("frameos-test-hub-session-" & $(epochTime().int64) & "-" & $getCurrentProcessId())
createDir(workDir)
setCurrentDir(workDir)
putEnv("FRAMEOS_CLOUD_DEVICE_KEY_PATH", workDir / "cloud_device_key")
putEnv("FRAMEOS_CLOUD_ENROLL_PENDING_PATH", workDir / "cloud_enroll_pending.json")

# ---------------------------------------------------------------------------
# Provider hub stub
# ---------------------------------------------------------------------------

const AccessToken = "hub-session-token"

# The real hub mints 32 raw random bytes, sends them base64-encoded and
# verifies the device signature over the RAW bytes
# (cloud/apps/frame-hub/src/hub.ts). The stub does exactly that — signing the
# base64 text instead would sail through a stub that used a plain-text nonce,
# and did.
let NonceBytes = block:
  var bytes = newString(32)
  let random = urandom(32)
  for index in 0 ..< bytes.len:
    bytes[index] = char(random[index])
  bytes
let NonceBase64 = base64.encode(NonceBytes)

type HubRecord = ref object
  authHeader: string
  hello: JsonNode
  helloCount: int
  socket: mummy.WebSocket
  authMessage: JsonNode
  signatureValid: bool
  replies: seq[JsonNode]
  closed: bool

var stubLock: Lock
initLock(stubLock)
var recorded = HubRecord()
var devicePublicKey = ""

proc withRecorded(body: proc(r: HubRecord) {.gcsafe.}) {.gcsafe.} =
  {.gcsafe.}:
    withLock stubLock:
      body(recorded)

var router: Router
router.get("/api/frames/ws", proc(request: Request) {.gcsafe.} =
  {.gcsafe.}:
    var auth = ""
    for (name, value) in request.headers:
      if cmpIgnoreCase(name, "authorization") == 0:
        auth = value
    withLock stubLock:
      recorded.authHeader = auth
    if auth != "Bearer " & AccessToken:
      request.respond(401, body = $(%*{"error": "invalid_link_token"}))
      return
    discard request.upgradeToWebSocket()
)

proc websocketHandler(websocket: mummy.WebSocket, event: mummy.WebSocketEvent,
                      message: mummy.Message) {.gcsafe.} =
  {.gcsafe.}:
    case event
    of mummy.OpenEvent:
      withLock stubLock:
        recorded.socket = websocket
    of mummy.MessageEvent:
      var msg: JsonNode
      try:
        msg = parseJson(message.data)
      except CatchableError:
        return
      let msgType = msg{"type"}.getStr("")
      case msgType
      of "hello":
        withLock stubLock:
          recorded.hello = msg
          recorded.helloCount += 1
        websocket.send($(%*{"type": "challenge", "nonce": NonceBase64}))
      of "auth":
        var valid = false
        withLock stubLock:
          recorded.authMessage = msg
          valid = verifySignatureBase64(devicePublicKey, NonceBytes, msg{"signature"}.getStr(""))
          recorded.signatureValid = valid
        if not valid:
          websocket.send($(%*{"type": "error", "error": "bad_signature"}))
          websocket.close()
          return
        websocket.send($(%*{"type": "ready", "pending_commands": 2}))
        # Drain the queue: one legitimate verb, one that must not exist.
        websocket.send($(%*{"id": "cmd-1", "type": "get_state"}))
        websocket.send($(%*{"id": "cmd-2", "type": "shell", "command": "id"}))
      else:
        withLock stubLock:
          recorded.replies.add(msg)
    of mummy.ErrorEvent, mummy.CloseEvent:
      withLock stubLock:
        recorded.closed = true

var server = newServer(router.toHandler(), websocketHandler, workerThreads = 2)
var serverThread: Thread[(mummy.Server, Port)]
proc serveStub(args: (mummy.Server, Port)) {.thread.} =
  try:
    args[0].serve(args[1], "127.0.0.1")
  except CatchableError:
    discard
createThread(serverThread, serveStub, (server, Port(TestPort)))
sleep(200)

# ---------------------------------------------------------------------------
# Device side
# ---------------------------------------------------------------------------

devicePublicKey = ensureDeviceKeypair().publicKeyBase64

withLock cloudLinkLock:
  let state = loadCloudLinkState()
  state["provider_url"] = %("http://127.0.0.1:" & $TestPort)
  state["status"] = %"connected"
  state["mode"] = %"managed"
  state["access_token"] = %AccessToken
  state["scope"] = %"frame:managed telemetry:logs"
  state["ws_path"] = %"/api/frames/ws"
  state["frame_id"] = %"frame-session-test"
  state["scenes_checksum"] = %"sum-0"
  saveCloudLinkState(state)

let frameConfig = FrameConfig(
  name: "Session test frame", mode: "test", device: "web_only",
  width: 320, height: 240, metricsInterval: 60, serverHost: "")

startCloudManagement(frameConfig)

proc waitUntil(timeoutSeconds: float, condition: proc(): bool {.gcsafe.}): bool =
  let deadline = epochTime() + timeoutSeconds
  while epochTime() < deadline:
    if condition():
      return true
    sleep(100)
  condition()

proc repliesOfType(msgType: string): seq[JsonNode] {.gcsafe.} =
  {.gcsafe.}:
    withLock stubLock:
      for reply in recorded.replies:
        if reply{"type"}.getStr("") == msgType:
          result.add(reply.copy())

suite "cloud hub session over a live socket":
  test "the frame dials, authenticates with its Ed25519 key, and serves verbs":
    check waitUntil(20.0, proc(): bool {.gcsafe.} =
      {.gcsafe.}:
        withLock stubLock:
          result = recorded.signatureValid and recorded.replies.len >= 3)

    withLock stubLock:
      # Bearer header made it onto the upgrade request.
      check recorded.authHeader == "Bearer " & AccessToken
      # hello carried version, hardware and the persisted scenes checksum.
      check recorded.hello != nil
      check recorded.hello{"frameos_version"}.getStr("") != ""
      check recorded.hello{"hardware"}{"width"}.getInt(0) == 320
      check recorded.hello{"scenes_checksum"}.getStr("") == "sum-0"
      # The challenge nonce was signed with the enrolled device key.
      check recorded.signatureValid
      # Regression: the signature must cover the DECODED nonce bytes, not the
      # base64 text the challenge carried. The hub verifies against the raw
      # bytes, so signing the text would fail every real handshake.
      let signature = recorded.authMessage{"signature"}.getStr("")
      check signature.len > 0
      check verifySignatureBase64(devicePublicKey, NonceBytes, signature)
      check not verifySignatureBase64(devicePublicKey, NonceBase64, signature)

    # get_state produced an ok ack plus a state message with the same id.
    let acks = repliesOfType("ack")
    var sawStateAck, sawShellRefusal = false
    for ack in acks:
      if ack{"id"}.getStr("") == "cmd-1":
        check ack{"ok"}.getBool(false)
        check ack{"state"}{"hardware"}{"height"}.getInt(0) == 240
        sawStateAck = true
      if ack{"id"}.getStr("") == "cmd-2":
        check not ack{"ok"}.getBool(true)
        check ack{"error"}.getStr("") == "unknown_verb"
        sawShellRefusal = true
    check sawStateAck
    check sawShellRefusal
    let states = repliesOfType("state")
    check states.len >= 1
    check states[0]{"id"}.getStr("") == "cmd-1"

  test "log lines ship as batched log_batch messages (telemetry:logs granted)":
    log(%*{"event": "test:hub:logline", "n": 1})
    log(%*{"event": "test:hub:logline", "n": 2})
    check waitUntil(10.0, proc(): bool {.gcsafe.} =
      {.gcsafe.}:
        for batch in repliesOfType("log_batch"):
          for entry in batch{"logs"}:
            if entry{"payload"}{"event"}.getStr("") == "test:hub:logline":
              return true
        false)

  test "managed mode activates the private-network deny with a provider exemption":
    check waitUntil(10.0, proc(): bool {.gcsafe.} =
      localNetworkPolicySnapshot().active)
    let snapshot = localNetworkPolicySnapshot()
    # The provider's own endpoint (a "private" dev provider on 127.0.0.1) is
    # exempt — the local admin linked it deliberately.
    check snapshot.exemptHostPorts == @["127.0.0.1:" & $TestPort]

  test "the local admin override lifts the deny while managed":
    frameConfig.network = NetworkConfig(allowLocalNetworkAccess: true)
    check waitUntil(10.0, proc(): bool {.gcsafe.} =
      not localNetworkPolicySnapshot().active)
    frameConfig.network = NetworkConfig(allowLocalNetworkAccess: false)
    check waitUntil(10.0, proc(): bool {.gcsafe.} =
      localNetworkPolicySnapshot().active)

  test "an oversized inbound message drops the session instead of allocating":
    # ws 0.5.0 would happily assemble whatever length the provider claims; the
    # client caps inbound messages at 4 MiB, closes and reconnects instead.
    var socket: mummy.WebSocket
    var helloesBefore = 0
    withLock stubLock:
      socket = recorded.socket
      helloesBefore = recorded.helloCount
    socket.send(newString(5 * 1024 * 1024))
    # The frame reconnects (a fresh hello) rather than dying or hanging on.
    check waitUntil(30.0, proc(): bool {.gcsafe.} =
      {.gcsafe.}:
        withLock stubLock:
          result = recorded.helloCount > helloesBefore)
    check waitUntil(10.0, proc(): bool {.gcsafe.} =
      {.gcsafe.}:
        withLock stubLock:
          result = recorded.signatureValid)

  test "a local disconnect closes the management session":
    withLock stubLock:
      # The reconnect above already produced a close; only a close from here on
      # proves the disconnect route tore the session down.
      recorded.closed = false
    withLock cloudLinkLock:
      let state = loadCloudLinkState()
      resetLinkState(state)
      saveCloudLinkState(state)
    check waitUntil(10.0, proc(): bool {.gcsafe.} =
      {.gcsafe.}:
        withLock stubLock:
          result = recorded.closed)
    # Standalone again: the private-network deny is gone.
    check waitUntil(10.0, proc(): bool {.gcsafe.} =
      not localNetworkPolicySnapshot().active)

stopCloudHubClient()
sleep(300)
# Deliberately no server.close(): mummy's shutdown segfaults here (verified —
# adding it makes this suite crash after every test has passed, which is how
# test_enrollment.nim was failing on CI). The stub dies with the process.
