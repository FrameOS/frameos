import std/segfaults
import strformat, strutils, asyncdispatch, asynchttpserver
import random, times, os
import json, jsony
import ws # async websocket client

# --------------------------------------------------------------------------
type
  FrameConfig* = ref object
    name*: string
    serverHost*: string
    serverPort*: int
    serverApiKey*: string ##  ← renamed: becomes *serverKey* below
    frameHost*: string
    framePort*: int
    frameAccessKey*: string
    frameAccess*: string
    width*: int
    height*: int
    deviceId*: string     ##  ← NEW
    metricsInterval*: float
    rotate*: int
    scalingMode*: string
    assetsPath*: string
    logToFile*: string
    debug*: bool
    timeZone*: string
    network*: NetworkConfig

  NetworkConfig* = ref object
    networkCheck*: bool
    networkCheckTimeoutSeconds*: float
    networkCheckUrl*: string
    wifiHotspot*: string
    wifiHotspotSsid*: string
    wifiHotspotPassword*: string
    wifiHostpotTimeoutSeconds*: float

# --------------------------------------------------------------------------
proc loadConfig(filename: string): FrameConfig =
  readFile(filename).fromJson(FrameConfig)

proc saveConfig(cfg: FrameConfig; filename = "frame.json") =
  writeFile(filename, cfg.toJson())

proc genDeviceId*: string =
  "0123456789abcdef"
  # # quick UUID-v4 substitute (hex with dashes)
  # let hex = "0123456789abcdef"
  # for i in 0 ..< 32:
  #   result.add hex[rand(15)]
  # result.insert('-', 20)
  # result.insert('-', 16)
  # result.insert('-', 12)
  # result.insert('-', 8)

# --------------------------------------------------------------------------
proc doHandshake(ws: WebSocket; cfg: FrameConfig): Future[void] {.async.} =
  ## Build handshake JSON
  var payload = %*{
    "action": "handshake",
    "deviceId": cfg.deviceId,
    "serverKey": cfg.serverApiKey
  }
  await ws.send($payload)
  let reply = await ws.receiveStrPacket()
  let resp = parseJson(reply)
  if resp["action"].getStr == "handshake/ack":
    let newKey = resp["serverKey"].getStr
    if cfg.serverApiKey.len == 0 or cfg.serverApiKey != newKey:
      echo "🔑 received new serverKey from backend"
      cfg.serverApiKey = newKey
      cfg.saveConfig() ## persist for next boot
  else:
    raise newException(Exception,
      "Invalid handshake response: " & reply)

# --------------------------------------------------------------------------
proc main() {.async.} =
  echo "Starting FrameOS agent..."

  let cfg = loadConfig("frame.json")

  if cfg.deviceId.len == 0:
    cfg.deviceId = genDeviceId()
    echo &"Generated new deviceId: {cfg.deviceId}"
    cfg.saveConfig()

  let url = &"ws://{cfg.serverHost}:{cfg.serverPort}/ws/agent"
  echo &"Connecting to backend: {url}"

  var ws = await newWebSocket(url)

  try:
    await doHandshake(ws, cfg)
    echo "✅ handshake done – keeping socket open"

    # ----------------------------------------------------------------------
    while true:
      let msg = await ws.receiveStrPacket()
      echo &"[backend] {msg}"
      ## TODO: parse commands and respond

  finally:
    ws.close()

when isMainModule:
  randomize()
  waitFor main()
