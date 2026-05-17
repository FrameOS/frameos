import os
import osproc
import pixie
import strutils
import times
import strformat
import frameos/apps
import frameos/types
import frameos/utils/image

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

proc runFfmpeg(command: string, timeoutMs: int): tuple[data: string, exitCode: int] =
  if rtspSnapshotFfmpegRunHook != nil:
    return rtspSnapshotFfmpegRunHook(command, timeoutMs)

  let outputPath = getTempDir() / ("frameos-rtsp-" & $getCurrentProcessId() & "-" & $(epochTime() * 1000).int & ".bmp")
  let commandWithOutput = command & " " & quoteShell(outputPath)
  var p = startProcess(commandWithOutput, options = {poUsePath, poEvalCommand})
  defer:
    if p != nil:
      if p.running():
        try:
          p.terminate()
          discard p.waitForExit(1500)
          if p.running():
            p.kill()
            discard p.waitForExit(500)
        except CatchableError:
          discard
      p.close()
    if fileExists(outputPath):
      try:
        removeFile(outputPath)
      except OSError:
        discard

  let startedAt = epochTime()
  while p.running():
    if fileExists(outputPath) and getFileSize(outputPath) > MaxFfmpegOutputBytes:
      p.terminate()
      discard p.waitForExit(1500)
      if p.running():
        p.kill()
        discard p.waitForExit(500)
      raise newException(IOError, "ffmpeg output exceeded " & $MaxFfmpegOutputBytes & " bytes")
    if epochTime() > startedAt + (timeoutMs.float / 1000.0):
      p.terminate()
      discard p.waitForExit(1500)
      if p.running():
        p.kill()
        discard p.waitForExit(500)
      result.exitCode = -1
      return
    sleep(100)

  result.exitCode = p.waitForExit()
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
    let timeoutMs = self.ffmpegTimeoutMs()
    let (data, exitCode) = runFfmpeg(command, timeoutMs)

    if exitCode != 0:
      let reason = if exitCode == -1: "timeout after " & $(timeoutMs div 1000) & "s" else: "exit code " & $exitCode
      self.logError "ffmpeg failed: " & reason
      return renderError(self, context, "ffmpeg failed to run (" & reason & ")")

    if data.len > MaxFfmpegOutputBytes:
      raise newException(IOError, &"ffmpeg output exceeded {MaxFfmpegOutputBytes} bytes")

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
