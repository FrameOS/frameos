################################################################################
# FrameOS Agent – hardened version                                             #
# * WSS transport only                                                        #
# * Challenge‑response handshake using HMAC‑SHA256                            #
# * All subsequent frames wrapped with {nonce,payload,mac}                    #
# * Secure 128‑bit random deviceId (hex)                                      #
# * Config stored under /etc/frameos.d (0600)                                 #
################################################################################

import std/[segfaults, strformat, strutils, asyncdispatch, terminal, times, os, sysrand]
import std/[jsonutils, tables]
import json, jsony
import ws
import nimcrypto
import nimcrypto/hmac


const
  DefaultConfigPath* = "/etc/frameos.d/creds.json" # secure location

# const TrustedOrigin* = "https://your.backend.fqdn"     # pin origin (not implemented)

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

  FrameConfig* = ref object
    name*: string
    # backend connection
    serverHost*: string
    serverPort*: int
    serverApiKey*: string # shared secret
                          # frame settings
    frameHost*: string
    framePort*: int
    frameAccessKey*: string
    frameAccess*: string
    width*: int
    height*: int
    deviceId*: string
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
  createDir(parentDir(path))
  writeFile(path, cfg.toJson())
  setFilePermissions(path, {fpUserRead, fpUserWrite}) # 0600

# ----------------------------------------------------------------------------
# HMAC helpers
# ----------------------------------------------------------------------------

proc hmacSha256Hex(key, data: string): string =
  ## Return lowercase hex of HMAC-SHA256(key, data) using nimcrypto ≥0.6.
  let digest = sha256.hmac(key, data) # MDigest[256]
  result = $digest # `$` gives uppercase hex
  result = result.toLowerAscii() # make it lowercase (toHex & co. are upper)

# ----------------------------------------------------------------------------
# Secure frame wrapper
# ----------------------------------------------------------------------------

template makeSecureEnvelope(payload: JsonNode; cfg: FrameConfig): JsonNode =
  let nonce = getTime().toUnix() # int64 epoch seconds – monotonic enough
  let body = $payload
  result = %*{
    "nonce": nonce,
    "payload": payload,
    "mac": hmacSha256Hex(cfg.serverApiKey, $nonce & body)
  }

template verifyEnvelope(node: JsonNode; cfg: FrameConfig): bool =
  node.hasKey("nonce") and node.hasKey("payload") and node.hasKey("mac") and
  node["mac"].getStr.toLowerAscii() ==
    hmacSha256Hex(cfg.serverApiKey, $node["nonce"].getInt & $node["payload"])


# ---------------------------------------------------------------------------
# utils – tiny print-and-quit helper
# ---------------------------------------------------------------------------
proc fatal(msg: string; code = 1) =
  ## Print a red "❌" + message to stderr and quit with the given exit code.
  styledWrite(stderr, fgRed, "❌ ")
  stderr.writeLine msg
  quit(code)

# ----------------------------------------------------------------------------
# Challenge‑response handshake (server‑initiated)
# ----------------------------------------------------------------------------

proc doHandshake(ws: WebSocket; cfg: FrameConfig): Future[void] {.async.} =
  ## Implements the protocol:
  ##   1) server → {action:"challenge", c:<hex‑rand>}
  ##   2) agent  → {action:"handshake", deviceId, mac:HMAC(key,c)}
  ##   3) server → {action:"handshake/ok" | "rotate" | close(1008)}

  # --- Step 1: wait for challenge -------------------------------------------
  let challengeMsg = await ws.receiveStrPacket()
  let challengeJson = parseJson(challengeMsg)
  if challengeJson["action"].getStr != "challenge":
    raise newException(Exception, "Expected challenge, got: " & challengeMsg)
  let challenge = challengeJson["c"].getStr

  # --- Step 2: answer -------------------------------------------------------
  let mac = hmacSha256Hex(cfg.serverApiKey, challenge)
  var reply = %*{
    "action": "handshake",
    "deviceId": cfg.deviceId,
    "mac": mac
  }
  await ws.send($reply)

  # --- Step 3: await OK / rotate -------------------------------------------
  let ackMsg = await ws.receiveStrPacket()
  let ack = parseJson(ackMsg)
  let act = ack["action"].getStr
  case act
  of "handshake/ok":
    echo "✅ handshake done"
  of "rotate":
    let newK = ack["newKey"].getStr
    echo "🔑 key rotated – persisting"
    cfg.serverApiKey = newK
    cfg.saveConfig()
  else:
    raise newException(Exception, "Handshake failed: " & ackMsg)

# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------


proc main() {.async.} =
  echo "→ FrameOS agent starting…"

  # Fail-fast: we expect an existing, fully-populated creds file
  var cfg: FrameConfig
  try:
    cfg = loadConfig()
  except IOError as e:
    fatal(e.msg)

  # Sanity – ensure deviceId printable & ≤64 chars
  if cfg.deviceId.len == 0:
    cfg.deviceId = generateSecureId()
    cfg.saveConfig()
  elif cfg.deviceId.len > 64 or
       (not cfg.deviceId.allCharsInSet(PrintableChars)):
    raise newException(ValueError, "Invalid deviceId in config → regenerate it.")

  let url = &"wss://{cfg.serverHost}/ws/agent" # always TLS via reverse-proxy
  echo &"🔗 Connecting → {url} …"

  var ws = await newWebSocket(url)

  try:
    await doHandshake(ws, cfg)

    # ────────────────────────────────────────────────────────────────────────
    # Main receive loop – verify envelope, then act on payload  -------------
    # ────────────────────────────────────────────────────────────────────────
    while true:
      let raw = await ws.receiveStrPacket()
      let node = parseJson(raw)
      if not verifyEnvelope(node, cfg):
        echo "⚠️  bad MAC – dropping packet"
        continue
      let payload = node["payload"]
      echo &"📥 {payload}"
      # TODO: handle backend commands…

  finally:
    ws.close()

when isMainModule:
  waitFor main()
