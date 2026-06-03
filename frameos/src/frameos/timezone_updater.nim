import checksums/sha2
import json
import os
import strutils
import system
import times
import zippy
import std/httpclient

import frameos/channels
import frameos/types
import frameos/utils/http_client
import lib/tz

const
  TimeZoneUpdateHour* = 3
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

proc shouldRunTimezoneUpdate*(dt: DateTime, lastRunDate: string): bool =
  let today = dt.format("yyyy-MM-dd")
  let currentMinute = dt.hour * 60 + dt.minute
  let updateMinute = TimeZoneUpdateHour * 60 + TimeZoneUpdateMinute
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

proc logTimezoneUpdate(logger: Logger, payload: JsonNode) {.gcsafe.} =
  discard logger
  log(payload)

proc runTimezoneUpdateOnce*(frameConfig: FrameConfig, logger: Logger): TimeZoneUpdateResult =
  if frameConfig == nil:
    logTimezoneUpdate(logger, %*{"event": "timezone:update", "state": "skipped", "reason": "missing-frame-config"})
    return tzUpdateSkipped

  let headers = newHttpHeaders([
    ("Accept", "application/gzip"),
  ])
  createDir(parentDir(timeZoneDataPath()))
  let remote = boundedHeadMetadata(
    TimeZoneDataGzipUrl,
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
        "etag": remote.etag,
        "compressedSize": remote.contentLength,
      })
      return tzUpdateUnchanged

  let currentHash = localTimezoneHash()
  var compressed = boundedGetContent(
    TimeZoneDataGzipUrl,
    headers = headers,
    timeoutMs = TimeZoneUpdateTimeoutMs,
    maxBytes = TimeZoneGzipMaxBytes,
    maxSeconds = 45.0,
  )
  let compressedSize = compressed.len
  var tzData = uncompress(compressed, dataFormat = dfGzip)
  compressed.setLen(0)
  requireHttpResponseWithinLimit(tzData, TimeZoneJsonMaxBytes)

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
        "etag": remote.etag,
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
    "etag": remote.etag,
    "size": getFileSize(dataPath),
    "compressedSize": compressedSize,
  })
  result = tzUpdateUpdated

proc start(self: FrameOS) =
  var lastRunDate = ""
  while true:
    let dt = now()
    if shouldRunTimezoneUpdate(dt, lastRunDate):
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
