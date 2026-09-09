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
import frameos/spawn_guard
import frameos/utils/image
import frameos/utils/process

const
  DefaultFfmpegTimeoutSeconds = 15
  # A scene picks the timeout, but the render thread is what waits: the
  # service watchdog restarts the whole frame after 900 s without a
  # heartbeat, so a dead camera with an unbounded timeout took the frame
  # down with it. Two minutes covers a slow RTSP handshake many times over.
  MaxFfmpegTimeoutSeconds* = 120
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

proc ffmpegTimeoutMs*(timeoutSeconds: int): int =
  let requested = if timeoutSeconds > 0: timeoutSeconds else: DefaultFfmpegTimeoutSeconds
  clamp(requested, 1, MaxFfmpegTimeoutSeconds) * 1000

proc ffmpegTimeoutMs(self: App): int =
  ffmpegTimeoutMs(self.appConfig.timeoutSeconds)

proc ffmpegProtocolWhitelist*(scheme: string): string =
  ## What ffmpeg may open for a URL of this scheme — and nothing else: the
  ## guard checked one URL, but ffmpeg's demuxers follow HTTP redirects and
  ## playlists (HLS, concat…) into any protocol they name, `file:` included.
  ## rtsp needs its transports (rtp/udp/tcp); the secure variants need tls.
  case scheme.toLowerAscii()
  of "rtsp": "rtsp,rtp,udp,tcp"
  of "rtsps": "rtsps,rtsp,rtp,udp,tcp,tls"
  of "https": "https,http,tcp,tls"
  else: "http,tcp"

proc ffmpegArgs*(url: string, outputPath: string, scheme = "", hostHeader = ""): seq[string] =
  result = @[
    "-loglevel", "quiet",
    "-nostdin",
    "-y",
    "-threads", "1",
  ]
  if scheme.len > 0:
    result.add(@["-protocol_whitelist", ffmpegProtocolWhitelist(scheme)])
  if hostHeader.len > 0:
    # The URL carries the pinned address (spawn_guard.nim); the name the
    # scene wrote still goes to the server as the HTTP Host.
    result.add(@["-headers", "Host: " & hostHeader & "\r\n"])
  result.add(@[
    "-i", url,
    "-an",
    "-vframes", "1",
    "-f", "image2",
    "-c:v", "bmp",
    outputPath
  ])

proc shellDisplayArg(arg: string): string =
  for ch in arg:
    if ch in {' ', '\'', '"', '$', '&', '?', '*', '(', ')', ';', '<', '>', '|', '\\'}:
      return quoteShell(arg)
  arg

proc ffmpegCommandForLog(args: seq[string]): string =
  "ffmpeg " & args.filterIt(it.len > 0).mapIt(shellDisplayArg(it)).join(" ")

proc runFfmpeg(command: string, args: seq[string], timeoutMs: int): tuple[data: string, exitCode: int] =
  if rtspSnapshotFfmpegRunHook != nil:
    return rtspSnapshotFfmpegRunHook(command, timeoutMs)

  let processResult = runProcessPiped(
    "ffmpeg",
    args,
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
  # Provenance and target checks before ffmpeg is spawned (spawn_guard.nim).
  let refusal = spawningAppRefusal(self.scene, "rstpSnapshot")
  if refusal.len > 0:
    return renderError(self, context, refusal)
  let target = spawnTarget(self.appConfig.url, ["rtsp", "rtsps", "http", "https"])
  if target.refusal.len > 0:
    return renderError(self, context, target.refusal)
  try:
    # While the private-network deny is on, ffmpeg connects to the address
    # the guard checked, never to a second lookup of the name; an http(s)
    # server still sees the name in the Host header. (An RTSP server gets
    # the address in its request URL — RTSP has no Host header — which the
    # cameras this app is for do not mind.)
    let hostHeader =
      if target.address.len > 0 and target.scheme in ["http", "https"]: target.hostname
      else: ""
    let args = ffmpegArgs(target.pinnedUrl, "pipe:1", scheme = target.scheme, hostHeader = hostHeader)
    let command = ffmpegCommandForLog(args)
    let timeoutMs = self.ffmpegTimeoutMs()

    if self.frameConfig.debug:
      self.log(%*{
        "event": "ffmpeg:start",
        "message": "Running: " & command,
        "timeoutMs": timeoutMs
      })

    let startedAt = epochTime()
    var (data, exitCode) = runFfmpeg(command, args, timeoutMs)
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
      # Bound the decode to the render target so oversized camera frames
      # cannot exhaust memory; never below the display decode defaults.
      let targetWidth = if context.hasImage: context.image.width else: self.frameConfig.renderWidth()
      let targetHeight = if context.hasImage: context.image.height else: self.frameConfig.renderHeight()
      return decodeImageWithDisplayBounds(
        data,
        maxEdge = max(DisplayDecodeMaxEdge, max(targetWidth, targetHeight)),
        maxPixels = max(DisplayDecodeMaxPixels, targetWidth * targetHeight)
      )
    except CatchableError as decodeErr:
      self.logError "Failed to decode image: " & decodeErr.msg
      return renderError(self, context, "Could not decode image from ffmpeg output")

  except OSError as osErr:
    self.logError "OS error when starting ffmpeg: " & osErr.msg
    return renderError(self, context, "ffmpeg not found or not executable")

  except CatchableError as e:
    self.logError "Unexpected error: " & e.msg
    return renderError(self, context, "An unexpected error occurred")
