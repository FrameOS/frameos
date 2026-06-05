import os
import pixie
import json
import math
import sequtils
import strutils
import times
import strformat
import frameos/apps
import frameos/types
import frameos/utils/image
import frameos/utils/process

const
  DefaultFfmpegTimeoutSeconds = 15
  MaxFfmpegOutputBytes = 50 * 1024 * 1024

type
  RtspSnapshotFfmpegRunHook* = proc(command: string, timeoutMs: int): tuple[data: string, exitCode: int]

  AppConfig* = object
    url*: string
    timeoutSeconds*: int

  App* = ref object of AppRoot
    appConfig*: AppConfig

var rtspSnapshotFfmpegRunHook*: RtspSnapshotFfmpegRunHook = nil

proc renderError(self: App, context: ExecutionContext, message: string): Image =
  return renderError(
    if context.hasImage: context.image.width else: self.frameConfig.renderWidth(),
    if context.hasImage: context.image.height else: self.frameConfig.renderHeight(),
    message
  )

proc ffmpegTimeoutMs(self: App): int =
  max(1, (if self.appConfig.timeoutSeconds > 0: self.appConfig.timeoutSeconds else: DefaultFfmpegTimeoutSeconds)) * 1000

proc ffmpegArgs(url: string, outputPath: string): seq[string] =
  result = @[
    "-loglevel", "quiet",
    "-nostdin",
    "-y",
    "-threads", "1",
    "-i", url,
    "-an",
    "-vframes", "1",
    "-f", "image2",
    "-c:v", "bmp",
    outputPath
  ]

proc shellDisplayArg(arg: string): string =
  for ch in arg:
    if ch in {' ', '\'', '"', '$', '&', '?', '*', '(', ')', ';', '<', '>', '|', '\\'}:
      return quoteShell(arg)
  arg

proc ffmpegCommandForLog(url: string, outputPath = ""): string =
  let args = ffmpegArgs(url, outputPath).filterIt(it.len > 0)
  "ffmpeg " & args.mapIt(shellDisplayArg(it)).join(" ")

proc runFfmpeg(command: string, url: string, timeoutMs: int): tuple[data: string, exitCode: int] =
  if rtspSnapshotFfmpegRunHook != nil:
    return rtspSnapshotFfmpegRunHook(command, timeoutMs)

  let processResult = runProcessPiped(
    "ffmpeg",
    ffmpegArgs(url, "pipe:1"),
    timeoutMs = timeoutMs,
    maxOutputBytes = MaxFfmpegOutputBytes
  )
  result.exitCode = processResult.exitCode
  if processResult.timedOut:
    result.exitCode = -1
    return
  if processResult.outputExceeded:
    raise newException(IOError, "ffmpeg output exceeded " & $MaxFfmpegOutputBytes & " bytes")
  if result.exitCode != 0:
    return
  result.data = processResult.output

proc get*(self: App, context: ExecutionContext): Image =
  try:
    let url = self.appConfig.url
    let command = ffmpegCommandForLog(url, "pipe:1")
    let timeoutMs = self.ffmpegTimeoutMs()

    if self.frameConfig.debug:
      self.log(%*{
        "event": "ffmpeg:start",
        "message": "Running: " & command,
        "timeoutMs": timeoutMs
      })

    let startedAt = epochTime()
    let (data, exitCode) = runFfmpeg(command, url, timeoutMs)
    let elapsedMs = round((epochTime() - startedAt) * 1000, 3)

    if exitCode != 0:
      let reason = if exitCode == -1: "timeout after " & $(timeoutMs div 1000) & "s" else: "exit code " & $exitCode
      self.logError "ffmpeg failed: " & reason & " after " & $elapsedMs & "ms"
      return renderError(self, context, "ffmpeg failed to run (" & reason & ")")

    if data.len > MaxFfmpegOutputBytes:
      raise newException(IOError, &"ffmpeg output exceeded {MaxFfmpegOutputBytes} bytes")

    if self.frameConfig.debug:
      self.log(%*{
        "event": "ffmpeg:done",
        "ms": elapsedMs,
        "bytes": data.len
      })

    try:
      return decodeImageWithFallback(data)
    except CatchableError as decodeErr:
      self.logError "Failed to decode image: " & decodeErr.msg
      return renderError(self, context, "Could not decode image from ffmpeg output")

  except OSError as osErr:
    self.logError "OS error when starting ffmpeg: " & osErr.msg
    return renderError(self, context, "ffmpeg not found or not executable")

  except CatchableError as e:
    self.logError "Unexpected error: " & e.msg
    return renderError(self, context, "An unexpected error occurred")
