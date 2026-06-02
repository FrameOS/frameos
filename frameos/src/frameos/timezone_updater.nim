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
import lib/tz

const
  TimeZoneUpdateHour* = 3
  TimeZoneUpdateMinute* = 0
  TimeZoneManifestMaxBytes = 32 * 1024
  TimeZoneGzipMaxBytes = 4 * 1024 * 1024
  TimeZoneJsonMaxBytes = 8 * 1024 * 1024
  TimeZoneUpdateTimeoutMs = 30000

type
  TimeZoneManifest* = object
    sha256*: string
    size*: int
    compressedSize*: int
    url*: string

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
    raise newException(ValueError, "Timezone manifest has an invalid sha256")
  for ch in result:
    if ch notin {'0'..'9', 'a'..'f'}:
      raise newException(ValueError, "Timezone manifest has an invalid sha256")

proc parseTimeZoneManifest*(data: string): TimeZoneManifest =
  let parsed = parseJson(data)
  result = TimeZoneManifest(
    sha256: normalizeSha256(parsed{"sha256"}.getStr()),
    size: parsed{"size"}.getInt(),
    compressedSize: parsed{"compressedSize"}.getInt(),
    url: parsed{"url"}.getStr(),
  )
  if result.size <= 0 or result.size > TimeZoneJsonMaxBytes:
    raise newException(ValueError, "Timezone manifest has an invalid size")
  if result.compressedSize < 0 or result.compressedSize > TimeZoneGzipMaxBytes:
    raise newException(ValueError, "Timezone manifest has an invalid compressed size")

proc frameServerBaseUrl*(frameConfig: FrameConfig): string =
  if frameConfig == nil or frameConfig.serverHost.len == 0 or frameConfig.serverPort <= 0:
    return ""
  let protocol = if frameConfig.serverPort mod 1000 == 443: "https" else: "http"
  result = protocol & "://" & frameConfig.serverHost & ":" & $frameConfig.serverPort

proc resolveTimeZoneDataUrl*(baseUrl, manifestUrl: string): string =
  let url = manifestUrl.strip()
  if url.startsWith("http://") or url.startsWith("https://"):
    return url
  if baseUrl.len == 0:
    raise newException(ValueError, "Timezone data URL is relative without a server URL")
  if url.startsWith("/"):
    return baseUrl & url
  result = baseUrl & "/" & url

proc shouldRunTimezoneUpdate*(dt: DateTime, lastRunDate: string): bool =
  let today = dt.format("yyyy-MM-dd")
  result = dt.hour == TimeZoneUpdateHour and
    dt.minute == TimeZoneUpdateMinute and
    today != lastRunDate

proc localTimezoneHash(assetsPath: string): string =
  let hashPath = timeZoneHashPath(assetsPath)
  let dataPath = timeZoneDataPath(assetsPath)
  if fileExists(hashPath) and fileExists(dataPath):
    try:
      return normalizeSha256(readFile(hashPath))
    except CatchableError:
      return ""
  if fileExists(dataPath):
    return sha256File(dataPath)
  result = ""

proc logTimezoneUpdate(logger: Logger, payload: JsonNode) {.gcsafe.} =
  discard logger
  log(payload)

proc runTimezoneUpdateOnce*(frameConfig: FrameConfig, logger: Logger): TimeZoneUpdateResult =
  if frameConfig == nil or frameConfig.assetsPath.len == 0:
    logTimezoneUpdate(logger, %*{"event": "timezone:update", "state": "skipped", "reason": "missing-assets-path"})
    return tzUpdateSkipped

  let baseUrl = frameServerBaseUrl(frameConfig)
  if baseUrl.len == 0:
    logTimezoneUpdate(logger, %*{"event": "timezone:update", "state": "skipped", "reason": "missing-server"})
    return tzUpdateSkipped

  let headers = newHttpHeaders([
    ("Authorization", "Bearer " & frameConfig.serverApiKey),
    ("Accept", "application/json"),
  ])
  let manifestUrl = baseUrl & "/api/timezones/manifest"
  let manifest = parseTimeZoneManifest(boundedGetContent(
    manifestUrl,
    headers = headers,
    timeoutMs = TimeZoneUpdateTimeoutMs,
    maxBytes = TimeZoneManifestMaxBytes,
    maxSeconds = 30.0,
  ))

  createDir(parentDir(timeZoneDataPath(frameConfig.assetsPath)))
  let currentHash = localTimezoneHash(frameConfig.assetsPath)
  if currentHash == manifest.sha256:
    initTimeZone(frameConfig.assetsPath)
    if loadedTimeZoneDataSource() == "override":
      logTimezoneUpdate(logger, %*{"event": "timezone:update", "state": "unchanged", "sha256": manifest.sha256})
      return tzUpdateUnchanged

  let dataUrl = resolveTimeZoneDataUrl(baseUrl, manifest.url)
  var compressed = boundedGetContent(
    dataUrl,
    headers = headers,
    timeoutMs = TimeZoneUpdateTimeoutMs,
    maxBytes = TimeZoneGzipMaxBytes,
    maxSeconds = 45.0,
  )
  var tzData = uncompress(compressed, dataFormat = dfGzip)
  compressed.setLen(0)
  requireHttpResponseWithinLimit(tzData, TimeZoneJsonMaxBytes)

  let actualHash = sha256Hex(tzData)
  if actualHash != manifest.sha256:
    tzData.setLen(0)
    GC_fullCollect()
    raise newException(IOError, &"Timezone data checksum mismatch: expected {manifest.sha256}, got {actualHash}")

  let dataPath = timeZoneDataPath(frameConfig.assetsPath)
  let hashPath = timeZoneHashPath(frameConfig.assetsPath)
  let tempPath = dataPath & ".tmp"
  try:
    writeFile(tempPath, tzData)
    loadTimeZoneData(tzData, fromOverride = true)
    if fileExists(dataPath):
      removeFile(dataPath)
    moveFile(tempPath, dataPath)
    writeFile(hashPath, manifest.sha256 & "\n")
  finally:
    if fileExists(tempPath):
      removeFile(tempPath)
    tzData.setLen(0)
    compressed.setLen(0)
    GC_fullCollect()

  logTimezoneUpdate(logger, %*{
    "event": "timezone:update",
    "state": "updated",
    "sha256": manifest.sha256,
    "size": manifest.size,
    "compressedSize": manifest.compressedSize,
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
