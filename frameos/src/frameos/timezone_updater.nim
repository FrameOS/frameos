import checksums/sha2
import json
import os
import strformat
import strutils
import system
import times
import zippy
import std/httpclient

import frameos/channels
import frameos/types
import frameos/utils/http_client
import frameos/utils/process
import lib/tz

const
  TimeZoneUpdateMinute* = 0
  TimeZoneGzipMaxBytes = 4 * 1024 * 1024
  TimeZoneJsonMaxBytes = 8 * 1024 * 1024
  TimeZoneUpdateTimeoutMs = 30000
  TimeZoneDataGzipUrl* = "https://tz.frameos.net/tzdata.json.gz"

type
  TimeZoneUpdateResult* = enum
    tzUpdateSkipped, tzUpdateUnchanged, tzUpdateUpdated

var timezoneUpdaterThread: Thread[FrameOS]
var timezoneUpdaterStarted = false

const GunzipTimeoutMs = 60 * 1000

proc boundedGunzip*(compressed: string, maxBytes: int): string =
  ## Inflates a gzip body without ever holding more than `maxBytes` of
  ## output. The download URL is config-settable and the archive carries no
  ## publisher signature, so a 4 MB body that inflates to gigabytes has to
  ## be cut off DURING inflation, not measured afterwards (zippy's
  ## uncompress has no cap). Two layers: the gzip trailer's ISIZE first —
  ## cheap, and what an honest archive says about itself — then the
  ## inflation itself runs in `gzip -dc` under the process wrapper's output
  ## cap, so the bytes never enter this process's heap. Where there is no
  ## gzip binary (a dev box without coreutils is the only case; every image
  ## has busybox or coreutils gzip) the in-process inflate remains, checked
  ## after the fact.
  if compressed.len < 18 or compressed[0] != '\x1f' or compressed[1] != '\x8b':
    raise newException(IOError, "timezone data is not a gzip archive")
  let n = compressed.len
  let declaredSize = int(uint8(compressed[n - 4])) or (int(uint8(compressed[n - 3])) shl 8) or
    (int(uint8(compressed[n - 2])) shl 16) or (int(uint8(compressed[n - 1])) shl 24)
  if declaredSize > maxBytes:
    raise newException(IOError, &"timezone data declares {declaredSize} bytes, more than the {maxBytes} byte limit")
  if findExe("gzip").len > 0:
    let res = runProcessPiped("gzip", @["-dc"], input = compressed,
                              timeoutMs = GunzipTimeoutMs, maxOutputBytes = maxBytes)
    if res.outputExceeded:
      raise newException(IOError, &"timezone data inflated past the {maxBytes} byte limit")
    if res.timedOut:
      raise newException(IOError, "timezone data took too long to inflate")
    if res.exitCode != 0:
      raise newException(IOError, "timezone data could not be inflated (gzip exit " & $res.exitCode & ")")
    if res.output.len > maxBytes:
      raise newException(IOError, &"timezone data inflated past the {maxBytes} byte limit")
    return res.output
  result = uncompress(compressed, dataFormat = dfGzip)
  requireHttpResponseWithinLimit(result, maxBytes)

proc sha256Hex*(data: openArray[char]): string =
  var hasher = initSha_256()
  hasher.update(data)
  result = ($hasher.digest()).toLowerAscii()

proc sha256File(path: string): string =
  var file = open(path, fmRead)
  var buffer = newString(64 * 1024)
  var hasher = initSha_256()
  try:
    while true:
      let read = file.readBuffer(addr buffer[0], buffer.len)
      if read <= 0:
        break
      hasher.update(buffer.toOpenArray(0, read - 1))
  finally:
    file.close()
  result = ($hasher.digest()).toLowerAscii()

proc normalizeSha256(value: string): string =
  result = value.strip().toLowerAscii()
  if result.len != 64:
    raise newException(ValueError, "Timezone data has an invalid sha256")
  for ch in result:
    if ch notin {'0'..'9', 'a'..'f'}:
      raise newException(ValueError, "Timezone data has an invalid sha256")

proc timezoneUpdateHour*(frameConfig: FrameConfig): int =
  result = 3
  if frameConfig != nil and frameConfig.timeZoneUpdates != nil:
    result = frameConfig.timeZoneUpdates.hour
  if result < 0 or result > 23:
    result = 3

proc timezoneUpdateUrl*(frameConfig: FrameConfig): string =
  result = TimeZoneDataGzipUrl
  if frameConfig != nil and frameConfig.timeZoneUpdates != nil and frameConfig.timeZoneUpdates.url.strip().len > 0:
    result = frameConfig.timeZoneUpdates.url.strip()

proc timezoneUpdatesEnabled*(frameConfig: FrameConfig): bool =
  result = true
  if frameConfig != nil and frameConfig.timeZoneUpdates != nil:
    result = frameConfig.timeZoneUpdates.enabled

proc shouldRunTimezoneUpdate*(dt: DateTime, lastRunDate: string, updateHour = 3): bool =
  let today = dt.format("yyyy-MM-dd")
  let currentMinute = dt.hour * 60 + dt.minute
  let normalizedHour = if updateHour >= 0 and updateHour <= 23: updateHour else: 3
  let updateMinute = normalizedHour * 60 + TimeZoneUpdateMinute
  result = currentMinute >= updateMinute and today != lastRunDate

proc localTimezoneHash(): string =
  let hashPath = timeZoneHashPath()
  let dataPath = timeZoneDataPath()
  if fileExists(hashPath) and fileExists(dataPath):
    try:
      return normalizeSha256(readFile(hashPath))
    except CatchableError:
      return ""
  if fileExists(dataPath):
    return sha256File(dataPath)
  result = ""

proc localTimezoneEtag(): string =
  let etagPath = timeZoneEtagPath()
  if fileExists(etagPath):
    return readFile(etagPath).strip()
  result = ""

proc writeTimezoneEtag(etag: string) =
  if etag.len > 0:
    writeFile(timeZoneEtagPath(), etag & "\n")

proc displayTimezoneEtag*(etag: string): string =
  let stripped = etag.strip()
  if stripped.len >= 2 and stripped[0] == '"' and stripped[^1] == '"':
    if stripped.len == 2:
      return ""
    return stripped[1 .. stripped.len - 2]
  result = stripped

proc logTimezoneUpdate(logger: Logger, payload: JsonNode) {.gcsafe.} =
  discard logger
  log(payload)

proc runTimezoneUpdateOnce*(frameConfig: FrameConfig, logger: Logger): TimeZoneUpdateResult =
  if frameConfig == nil:
    logTimezoneUpdate(logger, %*{"event": "timezone:update", "state": "skipped", "reason": "missing-frame-config"})
    return tzUpdateSkipped
  if not timezoneUpdatesEnabled(frameConfig):
    logTimezoneUpdate(logger, %*{"event": "timezone:update", "state": "skipped", "reason": "disabled"})
    return tzUpdateSkipped

  let updateUrl = timezoneUpdateUrl(frameConfig)
  let headers = newHttpHeaders([
    ("Accept", "application/gzip"),
  ])
  createDir(parentDir(timeZoneDataPath()))
  let remote = boundedHeadMetadata(
    updateUrl,
    headers = headers,
    timeoutMs = TimeZoneUpdateTimeoutMs,
    maxBytes = TimeZoneGzipMaxBytes,
    maxSeconds = 10.0,
  )
  if remote.etag.len > 0 and localTimezoneEtag() == remote.etag:
    initTimeZone()
    if loadedTimeZoneDataSource() == "override":
      logTimezoneUpdate(logger, %*{
        "event": "timezone:update",
        "state": "unchanged",
        "etag": displayTimezoneEtag(remote.etag),
        "compressedSize": remote.contentLength,
      })
      return tzUpdateUnchanged

  let currentHash = localTimezoneHash()
  var compressed = boundedGetContent(
    updateUrl,
    headers = headers,
    timeoutMs = TimeZoneUpdateTimeoutMs,
    maxBytes = TimeZoneGzipMaxBytes,
    maxSeconds = 45.0,
  )
  let compressedSize = compressed.len
  var tzData = boundedGunzip(compressed, TimeZoneJsonMaxBytes)
  compressed.setLen(0)

  let actualHash = sha256Hex(tzData)
  if currentHash == actualHash:
    initTimeZone()
    if loadedTimeZoneDataSource() == "override":
      writeTimezoneEtag(remote.etag)
      tzData.setLen(0)
      GC_fullCollect()
      logTimezoneUpdate(logger, %*{
        "event": "timezone:update",
        "state": "unchanged",
        "sha256": actualHash,
        "etag": displayTimezoneEtag(remote.etag),
        "compressedSize": compressedSize,
      })
      return tzUpdateUnchanged

  let dataPath = timeZoneDataPath()
  let hashPath = timeZoneHashPath()
  let tempPath = dataPath & ".tmp"
  try:
    writeFile(tempPath, tzData)
    loadTimeZoneData(tzData, fromOverride = true)
    if fileExists(dataPath):
      removeFile(dataPath)
    moveFile(tempPath, dataPath)
    writeFile(hashPath, actualHash & "\n")
    writeTimezoneEtag(remote.etag)
  finally:
    if fileExists(tempPath):
      removeFile(tempPath)
    tzData.setLen(0)
    compressed.setLen(0)
    GC_fullCollect()

  logTimezoneUpdate(logger, %*{
    "event": "timezone:update",
    "state": "updated",
    "sha256": actualHash,
    "etag": displayTimezoneEtag(remote.etag),
    "size": getFileSize(dataPath),
    "compressedSize": compressedSize,
  })
  result = tzUpdateUpdated

proc start(self: FrameOS) =
  var lastRunDate = ""
  while true:
    let dt = now()
    if timezoneUpdatesEnabled(self.frameConfig) and shouldRunTimezoneUpdate(dt, lastRunDate, timezoneUpdateHour(self.frameConfig)):
      lastRunDate = dt.format("yyyy-MM-dd")
      try:
        discard runTimezoneUpdateOnce(self.frameConfig, self.logger)
      except CatchableError as e:
        logTimezoneUpdate(self.logger, %*{
          "event": "timezone:update",
          "state": "error",
          "message": e.msg,
        })

    let now2 = now()
    if now2.minute == dt.minute:
      sleep((60 - now2.second) * 1000)
    else:
      sleep(1000)

proc createThreadRunner(frameOS: FrameOS) {.thread.} =
  frameOS.start()

proc startTimezoneUpdater*(frameOS: FrameOS) =
  if timezoneUpdaterStarted:
    return
  createThread(timezoneUpdaterThread, createThreadRunner, frameOS)
  timezoneUpdaterStarted = true
