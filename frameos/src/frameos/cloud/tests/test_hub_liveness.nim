## Liveness: a provider that completes the handshake and then goes silent —
## not even answering pings — must not keep a dead socket forever. The stub
## here is a raw TCP server rather than mummy precisely because mummy answers
## pings for you, which is the case that already works.
##
## The idle deadline is 90 s in production (three of the hub's 30 s heartbeat
## windows); FRAMEOS_CLOUD_HUB_IDLE_SECONDS shortens it for this test.

import std/[json, locks, net, os, strutils, times, unittest]

import ../hub_client
import ../identity
import ../link_state
import ../../types

const TestPort = 19474
const IdleSeconds = 3.0

let workDir = getTempDir() / ("frameos-test-hub-liveness-" & $(epochTime().int64) &
  "-" & $getCurrentProcessId())
createDir(workDir)
setCurrentDir(workDir)
putEnv("FRAMEOS_CLOUD_DEVICE_KEY_PATH", workDir / "cloud_device_key")
putEnv("FRAMEOS_CLOUD_ENROLL_PENDING_PATH", workDir / "cloud_enroll_pending.json")
putEnv("FRAMEOS_CLOUD_HUB_IDLE_SECONDS", $IdleSeconds)

const AccessToken = "hub-liveness-token"

var stubLock: Lock
initLock(stubLock)
var connections = 0
var pingsSeen = 0

proc textFrame(payload: string): string =
  ## Server → client frames are never masked.
  result = "\x81"
  if payload.len <= 125:
    result.add(char(payload.len))
  else:
    result.add(char(126))
    result.add(char((payload.len shr 8) and 0xff))
    result.add(char(payload.len and 0xff))
  result.add(payload)

proc readFrame(client: Socket): tuple[opcode: int, data: string] =
  ## Minimal client→server frame reader. `Socket.recv(size, timeout)` waits for
  ## exactly `size` bytes, so every field is read at its exact length.
  let header = client.recv(2, timeout = 20000)
  if header.len < 2:
    return (-1, "")
  let opcode = int(header[0].uint8 and 0x0f'u8)
  let masked = (header[1].uint8 and 0x80'u8) != 0
  var length = int(header[1].uint8 and 0x7f'u8)
  if length == 126:
    let extended = client.recv(2, timeout = 20000)
    if extended.len < 2:
      return (-1, "")
    length = (int(extended[0].uint8) shl 8) or int(extended[1].uint8)
  var mask = ""
  if masked:
    mask = client.recv(4, timeout = 20000)
    if mask.len < 4:
      return (-1, "")
  var payload = if length > 0: client.recv(length, timeout = 20000) else: ""
  if payload.len < length:
    return (-1, "")
  if masked:
    for index in 0 ..< payload.len:
      payload[index] = char(payload[index].uint8 xor mask[index mod 4].uint8)
  (opcode, payload)

proc serveSilent() {.thread.} =
  ## Completes the HTTP upgrade and the hello → challenge → auth → ready
  ## handshake, then reads and discards everything — pings included.
  var server = newSocket()
  server.setSockOpt(OptReuseAddr, true)
  server.bindAddr(Port(TestPort), "127.0.0.1")
  server.listen()
  while true:
    var client: Socket
    try:
      server.accept(client)
    except CatchableError:
      break
    {.gcsafe.}:
      withLock stubLock:
        connections += 1
    try:
      var secKey = ""
      while true: # request line + headers
        let line = client.recvLine(timeout = 5000)
        if line == "\r\n" or line.len == 0:
          break
        if line.toLowerAscii().startsWith("sec-websocket-key:"):
          secKey = line.split(":", 1)[1].strip()
      # The client refuses any 101 whose Sec-WebSocket-Accept does not answer
      # the key it sent (RFC 6455 §4.2.2), so the stub has to compute it.
      client.send("HTTP/1.1 101 Switching Protocols\r\n" &
                  "Upgrade: websocket\r\nConnection: Upgrade\r\n" &
                  "Sec-WebSocket-Accept: " & webSocketAcceptFor(secKey) & "\r\n\r\n")
      discard readFrame(client) # hello
      # A 32-byte nonce, base64 as the wire contract says.
      client.send(textFrame($(%*{"type": "challenge",
        "nonce": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="})))
      discard readFrame(client) # auth
      client.send(textFrame($(%*{"type": "ready"})))
      # Silence from here on: read whatever arrives (pings included) and answer
      # nothing at all.
      while true:
        let (opcode, _) = readFrame(client)
        if opcode < 0:
          break
        if opcode == 0x9:
          {.gcsafe.}:
            withLock stubLock:
              pingsSeen += 1
    except CatchableError:
      discard
    try:
      client.close()
    except CatchableError:
      discard

var serverThread: Thread[void]
createThread(serverThread, serveSilent)
sleep(200)

discard ensureDeviceKeypair()

withLock cloudLinkLock:
  let state = loadCloudLinkState()
  state["provider_url"] = %("http://127.0.0.1:" & $TestPort)
  state["status"] = %"connected"
  state["mode"] = %"managed"
  state["access_token"] = %AccessToken
  state["scope"] = %"frame:managed"
  state["ws_path"] = %"/api/frames/ws"
  state["frame_id"] = %"frame-liveness-test"
  saveCloudLinkState(state)

let frameConfig = FrameConfig(
  name: "Liveness test frame", mode: "test", device: "web_only",
  width: 320, height: 240, metricsInterval: 60, serverHost: "")

startCloudManagement(frameConfig)

proc waitUntil(timeoutSeconds: float, condition: proc(): bool {.gcsafe.}): bool =
  let deadline = epochTime() + timeoutSeconds
  while epochTime() < deadline:
    if condition():
      return true
    sleep(100)
  condition()

suite "cloud hub liveness":
  test "a silent provider is dropped and redialed":
    # First connect.
    check waitUntil(20.0, proc(): bool {.gcsafe.} =
      {.gcsafe.}:
        withLock stubLock:
          result = connections >= 1)
    # Nothing ever arrives on that socket, so the idle deadline fires and the
    # thread reconnects (backoff is 1.5–3 s for the first retry). The window is
    # deliberately shorter than the 20 s handshake timeout, so only the idle
    # deadline can make this pass.
    check waitUntil(12.0, proc(): bool {.gcsafe.} =
      {.gcsafe.}:
        withLock stubLock:
          result = connections >= 2)

  test "the device prods a quiet link with a ping first":
    check waitUntil(10.0, proc(): bool {.gcsafe.} =
      {.gcsafe.}:
        withLock stubLock:
          result = pingsSeen >= 1)

stopCloudHubClient()
sleep(300)
