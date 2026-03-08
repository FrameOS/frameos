import json
import times
import strutils
import locks
import mummy
import assets/frame_web as frameWebAssets
import frameos/types

var globalFrameOS*: FrameOS
var globalFrameConfig*: FrameConfig
var globalRunner*: RunnerControl
var globalAdminSessionSalt*: cstring
var globalAdminConnectionsState*: ConnectionsState
var globalRecentLogs*: seq[JsonNode] = @[]
var globalRecentLogsLock*: Lock
var globalRecentLogId* = 0

let frameWebIndexHtml* = frameWebAssets.getAsset("assets/compiled/frame_web/index.html")

const MAX_RECENT_LOGS* = 5000
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

proc toUiLog*(payload: (float, JsonNode)): JsonNode =
  let (timestamp, logPayload) = payload
  globalRecentLogId += 1
  let isoTimestamp = format(fromUnix(int64(timestamp)), "yyyy-MM-dd'T'HH:mm:ss'Z'", utc())
  result = %*{
    "id": globalRecentLogId,
    "timestamp": isoTimestamp,
    "ip": "",
    "type": "webhook",
    "line": $logPayload,
    "frame_id": FRAME_API_ID,
  }

proc storeUiLog*(logEntry: JsonNode) =
  {.gcsafe.}:
    withLock globalRecentLogsLock:
      globalRecentLogs.add(logEntry)
      if globalRecentLogs.len > MAX_RECENT_LOGS:
        globalRecentLogs = globalRecentLogs[(globalRecentLogs.len - MAX_RECENT_LOGS) .. (globalRecentLogs.len - 1)]

proc getUiLogs*(): JsonNode =
  {.gcsafe.}:
    withLock globalRecentLogsLock:
      return %*globalRecentLogs
