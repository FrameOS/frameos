import json
import times
import strutils
import locks
import deques
import mummy
import assets/frame_web as frameWebAssets
import frameos/types

var globalFrameOS*: FrameOS
var globalFrameConfig*: FrameConfig
var globalRunner*: RunnerControl
var globalAdminSessionSalt*: cstring
var globalAdminConnectionsState*: ConnectionsState
var globalRecentLogs*: Deque[JsonNode]
var globalRecentMetrics*: Deque[JsonNode]
var globalRecentLogsLock*: Lock
var globalRecentLogId* = 0

let frameWebIndexHtml* =
  when compiles(frameWebAssets.getAssetToStr("assets/compiled/frame_web/index.html")):
    frameWebAssets.getAssetToStr("assets/compiled/frame_web/index.html")
  else:
    frameWebAssets.getAsset("assets/compiled/frame_web/index.html")

const MAX_RECENT_LOGS* = 5000
# Metrics are sampled about once a minute and only feed the admin UI charts;
# parsed JsonNodes are kept in RAM for the life of the process, so keep this
# small (500 entries covers ~8 hours).
const MAX_RECENT_METRICS* = 500
const FRAME_API_ID* = 1

proc initConnectionsState*(): ConnectionsState =
  new(result)
  initLock(result.lock)
  result.items = @[]

proc sendToAll*(state: ConnectionsState, message: string) {.gcsafe.} =
  withLock state.lock:
    for connection in state.items:
      connection.send(message)

proc addConnection*(state: ConnectionsState, websocket: WebSocket) {.gcsafe.} =
  withLock state.lock:
    state.items.add(websocket)

proc removeConnection*(state: ConnectionsState, websocket: WebSocket) {.gcsafe.} =
  withLock state.lock:
    let index = state.items.find(websocket)
    if index >= 0:
      state.items.delete(index)

proc hasConnections*(state: ConnectionsState): bool {.gcsafe.} =
  withLock state.lock:
    result = state.items.len > 0

proc frameApiId*(): int =
  FRAME_API_ID

proc setGlobalAdminSessionSalt*(salt: string) =
  let saltBuffer = cast[cstring](allocShared0(salt.len + 1))
  if salt.len > 0:
    copyMem(saltBuffer, unsafeAddr salt[0], salt.len)
  globalAdminSessionSalt = saltBuffer

proc adminSessionSalt*(): string {.gcsafe.} =
  if globalAdminSessionSalt == nil:
    return ""
  $globalAdminSessionSalt

proc parseFrameApiId*(rawId: string): int =
  try:
    return parseInt(rawId)
  except CatchableError:
    return -1

proc toUiLog*(payload: SerializedLog): JsonNode =
  globalRecentLogId += 1
  let isoTimestamp = format(fromUnix(int64(payload.timestamp)), "yyyy-MM-dd'T'HH:mm:ss'Z'", utc())
  result = %*{
    "id": globalRecentLogId,
    "timestamp": isoTimestamp,
    "ip": "",
    "type": "webhook",
    "event": payload.event,
    "line": payload.line,
    "frame_id": FRAME_API_ID,
  }

proc metricsEntryFromLog(logEntry: JsonNode): JsonNode =
  if not logEntry.hasKey("event") or logEntry["event"].getStr() != "metrics":
    return nil
  if not logEntry.hasKey("line"):
    return nil

  try:
    let payload = parseJson(logEntry["line"].getStr())
    if payload.kind != JObject:
      return nil

    var metricsPayload = newJObject()
    for key, value in payload:
      if key != "event":
        metricsPayload[key] = value

    return %*{
      "id": $logEntry["id"].getInt(),
      "timestamp": logEntry["timestamp"].getStr(),
      "frame_id": logEntry["frame_id"].getInt(),
      "metrics": metricsPayload,
    }
  except CatchableError:
    return nil

proc storeUiLog*(logEntry: JsonNode) =
  {.gcsafe.}:
    withLock globalRecentLogsLock:
      globalRecentLogs.addLast(logEntry)
      while globalRecentLogs.len > MAX_RECENT_LOGS:
        discard globalRecentLogs.popFirst()
      let metricEntry = metricsEntryFromLog(logEntry)
      if metricEntry != nil:
        globalRecentMetrics.addLast(metricEntry)
        while globalRecentMetrics.len > MAX_RECENT_METRICS:
          discard globalRecentMetrics.popFirst()

proc getUiLogs*(): JsonNode =
  {.gcsafe.}:
    withLock globalRecentLogsLock:
      result = newJArray()
      for entry in globalRecentLogs:
        result.add(entry)

proc getUiMetrics*(): JsonNode =
  {.gcsafe.}:
    withLock globalRecentLogsLock:
      result = newJArray()
      for entry in globalRecentMetrics:
        result.add(entry)
