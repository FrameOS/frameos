import os
import osproc
import pixie
import strutils
import times
import frameos/apps
import frameos/types
import frameos/utils/image

const
  FfmpegTimeoutMs = 15000
  MaxFfmpegOutputBytes = 50 * 1024 * 1024

type
  RtspSnapshotFfmpegRunHook* = proc(command: string): tuple[data: string, exitCode: int]

  AppConfig* = object
    url*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

var rtspSnapshotFfmpegRunHook*: RtspSnapshotFfmpegRunHook = nil

proc renderError(self: App, context: ExecutionContext, message: string): Image =
  return renderError(
    if context.hasImage: context.image.width else: self.frameConfig.renderWidth(),
    if context.hasImage: context.image.height else: self.frameConfig.renderHeight(),
    message
  )

proc runFfmpeg(command: string): tuple[data: string, exitCode: int] =
  if rtspSnapshotFfmpegRunHook != nil:
    return rtspSnapshotFfmpegRunHook(command)

  let outputPath = getTempDir() / ("frameos-rtsp-" & $getCurrentProcessId() & "-" & $(epochTime() * 1000).int & ".bmp")
  let commandWithOutput = command & " " & quoteShell(outputPath)
  var p = startProcess(commandWithOutput, options = {poUsePath, poEvalCommand, poDaemon})
  defer:
    p.close()
    if fileExists(outputPath):
      try:
        removeFile(outputPath)
      except OSError:
        discard

  result.exitCode = p.waitForExit(FfmpegTimeoutMs)
  if result.exitCode != 0:
    return

  if not fileExists(outputPath):
    result.exitCode = 1
    return

  if getFileSize(outputPath) > MaxFfmpegOutputBytes:
    raise newException(IOError, "ffmpeg output exceeded " & $MaxFfmpegOutputBytes & " bytes")

  result.data = readFile(outputPath)

proc get*(self: App, context: ExecutionContext): Image =
  try:
    let url = self.appConfig.url.replace("'", "\\'")
    let command = "ffmpeg -loglevel quiet -nostdin -y -i '" & url & "' -vframes 1 -f image2 -c:v bmp"

    if self.frameConfig.debug:
      self.log "Running: " & command

    # Run ffmpeg
    let (data, exitCode) = runFfmpeg(command)

    if exitCode != 0:
      self.logError "ffmpeg exited with code " & $exitCode
      return renderError(self, context, "ffmpeg failed to run (exit code " & $exitCode & ")")

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
