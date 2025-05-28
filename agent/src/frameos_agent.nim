import std/[algorithm, segfaults, strformat, strutils, asyncdispatch, terminal,
            times, os, sysrand]
import json, jsony
import ws
import nimcrypto
import nimcrypto/hmac

const
  DefaultConfigPath* = "./frame.json" # secure location
  MaxBackoffSeconds* = 60             # don’t wait longer than this
  InitialBackoffSeconds = 1           # first retry

# ----------------------------------------------------------------------------
# Types
# ----------------------------------------------------------------------------

type
  NetworkConfig* = ref object
    networkCheck*: bool
    networkCheckTimeoutSeconds*: float
    networkCheckUrl*: string
    wifiHotspot*: string
    wifiHotspotSsid*: string
    wifiHotspotPassword*: string
    wifiHotspotTimeoutSeconds*: float
    agentConnection*: bool
    agentSharedSecret*: string

  FrameConfig* = ref object
    name*: string
    serverHost*: string
    serverPort*: int
    serverApiKey*: string # shared secret, may be empty
    frameHost*: string
    framePort*: int
    frameAccessKey*: string
    frameAccess*: string
    width*: int
    height*: int
    metricsInterval*: float
    rotate*: int
    scalingMode*: string
    assetsPath*: string
    logToFile*: string
    debug*: bool
    timeZone*: string
    network*: NetworkConfig

# ----------------------------------------------------------------------------
# Helper – secure random hex id
# ----------------------------------------------------------------------------

proc generateSecureId(): string =
  ## Generate a 128-bit random ID encoded as lowercase hex (32 chars).
  var buf: array[16, byte] # 16 bytes = 128 bits of storage
  discard randomBytes(buf) # fill it with CSPRNG data
  result = toHex(buf) # nimcrypto helper

# ----------------------------------------------------------------------------
# Config IO (fails hard if unreadable)
# ----------------------------------------------------------------------------

proc loadConfig(path = DefaultConfigPath): FrameConfig =
  if not fileExists(path):
    raise newException(IOError, "⚠️  config file not found: " & path)
  let raw = readFile(path)
  result = raw.fromJson(FrameConfig)

proc saveConfig(cfg: FrameConfig; path = DefaultConfigPath) =
  createDir parentDir(path)
  writeFile(path, (%cfg).pretty(2) & '\n')
  setFilePermissions(path, {fpUserRead, fpUserWrite}) # 0600

# ----------------------------------------------------------------------------
# HMAC helpers
# ----------------------------------------------------------------------------

proc hmacSha256Hex(key, data: string): string =
  ## Return lowercase hex of HMAC-SHA256(key, data).
  let digest = sha256.hmac(key, data) # MDigest[256]
  result = $digest # `$` gives uppercase hex
  result = result.toLowerAscii() # make it lowercase

# ----------------------------------------------------------------------------
# Signing helper – HMAC(secret, apiKey||data)
# ----------------------------------------------------------------------------
proc sign(data: string; cfg: FrameConfig): string =
  ## data   = the “open” string we want to protect
  ## secret = cfg.network.agentSharedSecret   (never leaves the device)
  ## apiKey = cfg.serverApiKey                (public “username”)
  ##
  ## The server re-creates exactly the same byte-sequence:
  ##   apiKey || data   (no separators, keep order)
  result = hmacSha256Hex(cfg.network.agentSharedSecret,
                         cfg.serverApiKey & data)

# ----------------------------------------------------------------------------
# Secure frame wrapper
# ----------------------------------------------------------------------------
proc canonical(node: JsonNode): string =
  case node.kind
  of JObject:
    var keys = newSeq[string]()
    for k, _ in node: keys.add k
    keys.sort(cmp)
    result.add('{')
    for i, k in keys:
      if i > 0: result.add(',')
      result.add(k.escapeJson())
      result.add(':')
      result.add(canonical(node[k]))
    result.add('}')
  of JArray:
    result.add('[')
    for i in 0 ..< node.len:
      if i > 0: result.add(',')
      result.add(canonical(node[i]))
    result.add(']')
  of JString:
    result.add(node.getStr().escapeJson())
  of JInt, JFloat, JBool, JNull:
    result = $node

proc makeSecureEnvelope(payload: JsonNode; cfg: FrameConfig): JsonNode =
  let nonce = getTime().toUnix()
  let body = canonical(payload)
  let mac = sign($nonce & body, cfg) # api-key is injected in sign()
  result = %*{
    "nonce": nonce,
    "serverApiKey": cfg.serverApiKey, # visible “username”
    "payload": payload,
    "mac": mac
  }

proc verifyEnvelope(node: JsonNode; cfg: FrameConfig): bool =
  node.hasKey("nonce") and node.hasKey("payload") and node.hasKey("mac") and
  node.hasKey("serverApiKey") and
  node["serverApiKey"].getStr == cfg.serverApiKey and
  node["mac"].getStr.toLowerAscii() ==
    sign($node["nonce"].getInt & $node["payload"], cfg)

# ----------------------------------------------------------------------------
# utils – tiny print-and-quit helper
# ----------------------------------------------------------------------------
proc fatal(msg: string; code = 1) =
  ## Print a red "❌" + message to stderr and quit with the given exit code.
  styledWrite(stderr, fgRed, "❌ ")
  stderr.writeLine msg
  quit(code)

proc recvText(ws: WebSocket): Future[string] {.async.} =
  ## Wait for the next *text* frame, replying to pings automatically.
  while true:
    let (opcode, payload) = await ws.receivePacket()
    case opcode
    of Opcode.Text:
      return cast[string](payload)
    of Opcode.Ping:
      await ws.send(payload, OpCode.Pong) # keep-alive
    of Opcode.Close:
      # payload = 2-byte status code (BE) + optional UTF-8 reason
      if payload.len >= 2:
        let code = (uint16(payload[0]) shl 8) or uint16(payload[1])
        let reason = if payload.len > 2:
                       cast[string](payload[2 .. ^1])
                     else: ""
        raise newException(Exception,
          &"connection closed by server (code {code}): {reason}")
      else:
        raise newException(Exception, "connection closed by server")
    else:
      discard # ignore binary, pong …

# ----------------------------------------------------------------------------
# Challenge-response handshake (server-initiated)
# ----------------------------------------------------------------------------

proc doHandshake(ws: WebSocket; cfg: FrameConfig): Future[void] {.async.} =
  ## Implements the protocol:
  ##   0) agent  → {action:"hello", serverApiKey}
  ##   1) server → {action:"challenge", c:<hex-rand>}
  ##   2) agent  → {action:"handshake", mac:<hmac-sha256(serverApiKey || c, sharedSecret)>}
  ##   3) server → {action:"handshake/ok"}

  # --- Step 0: say hello ----------------------------------------------------
  var hello = %*{
    "action": "hello",
    "serverApiKey": cfg.serverApiKey
  }
  await ws.send($hello)

  # --- Step 1: wait for challenge -------------------------------------------
  let challengeMsg = await ws.recvText()
  echo &"🔑 challenge: {challengeMsg}"

  let challengeJson = parseJson(challengeMsg)
  if challengeJson["action"].getStr != "challenge":
    raise newException(Exception,
      "Expected challenge, got: " & challengeMsg)
  let challenge = challengeJson["c"].getStr

  # --- Step 2: answer -------------------------------------------------------
  let mac = if cfg.network.agentSharedSecret.len > 0:
              sign(challenge, cfg)
            else: ""
  let reply = %*{
    "action": "handshake",
    "mac": mac
  }
  await ws.send($reply)

  # --- Step 3: await OK ---------------------------------
  let ackMsg = await ws.recvText()
  let ack = parseJson(ackMsg)
  let act = ack["action"].getStr
  case act
  of "handshake/ok":
    echo "✅ handshake done"
  else:
    raise newException(Exception, "Handshake failed: " & ackMsg)

# ----------------------------------------------------------------------------
# Heartbeat helper
# ----------------------------------------------------------------------------
proc startHeartbeat(ws: WebSocket; cfg: FrameConfig): Future[void] {.async.} =
  ## Keeps server-side idle-timeout at bay.
  try:
    while true:
      await sleepAsync(20_000)
      let env = makeSecureEnvelope(%*{"type": "heartbeat"}, cfg)
      await ws.send($env)
  except Exception: discard # will quit when ws closes / errors out

# ----------------------------------------------------------------------------
# Run-forever loop with exponential back-off
# ----------------------------------------------------------------------------

proc runAgent(cfg: FrameConfig) {.async.} =
  var backoff = InitialBackoffSeconds
  while true:
    try:
      # --- Connect ----------------------------------------------------------
      let port = (if cfg.serverPort <= 0: 443 else: cfg.serverPort)
      let scheme = (if port mod 1000 == 443: "wss" else: "ws")
      let url = &"{scheme}://{cfg.serverHost}:{port}/ws/agent"
      echo &"🔗 Connecting → {url} …"

      var ws = await newWebSocket(url)
      try:
        await doHandshake(ws, cfg) # throws on failure
        backoff = InitialBackoffSeconds # reset back-off

        asyncCheck startHeartbeat(ws, cfg) # fire-and-forget

        # ── Main receive loop ───────────────────────────────────────────────
        while true:
          let raw = await ws.recvText()
          let node = parseJson(raw)
          if not verifyEnvelope(node, cfg):
            echo "⚠️  bad MAC – dropping packet"; continue
          let payload = node["payload"]
          echo &"📥 {payload}"
          # TODO: handle backend commands …

      finally:
        if not ws.isNil:
          ws.close()

    except Exception as e:
      echo &"⚠️  connection error: {e.msg}"

    # --- Back-off & retry ----------------------------------------------------
    echo &"⏳ reconnecting in {backoff}s …"
    await sleepAsync(backoff * 1_000)
    backoff = min(backoff * 2, MaxBackoffSeconds)

# ----------------------------------------------------------------------------
# Program entry
# ----------------------------------------------------------------------------

when isMainModule:
  try:
    var cfg = loadConfig()
    waitFor runAgent(cfg)
  except Exception as e:
    fatal(e.msg)
