## What a video's ffmpeg and ffprobe are told (docs/video.md). Pure: no
## process, no thread, no file. The player (video/player.nim), the stills
## and the tests build the same command lines from here.
##
## Every frame comes out of ffmpeg at the size it is drawn at, in the canvas's
## own pixel format, at a constant rate: the scaling and the colour conversion
## are ffmpeg's work on the other cores, and the render thread's share of a
## frame is one copy (docs/video.md "How it plays").

import std/[json, math, strutils]

type
  VideoFit* = enum
    vfCover   ## the box filled, the overflow cropped (object-cover)
    vfContain ## the whole picture, black bars where it does not fill the box
    vfFill    ## stretched to the box (object-fill)

  VideoPixels* = enum
    vpRgba   ## pixie's RGBX (alpha 255): r, g, b, a bytes
    vpRgb565 ## pixie's 565: (r5 shl 11) or (g6 shl 5) or b5, little endian
    vpGray   ## pixie's gray8: one byte of luma

  VideoSource* = object
    ## Where the frames come from, as ffmpeg opens it.
    input*: string      ## a file's absolute path, or the URL (pinned, spawn_guard.nim)
    scheme*: string     ## "" for a file, else the URL's scheme in lower case
    hostHeader*: string ## the name an http(s) URL was written with when `input` carries the pinned address
    headers*: seq[(string, string)] ## http(s) request headers (an API key)
    denyActive*: bool   ## the private-network deny held the URL: no playlists (docs/video.md "Network")

  ProbeResult* = object
    ok*: bool
    error*: string
    duration*: float     ## seconds; -1 when unknown (a live stream)
    width*, height*: int ## as it is shown: a phone's turned video turned
    fps*: float          ## 0 when unknown
    codec*: string

  DecodeCaps* = object
    ## What this machine's ffmpeg can decode in hardware (docs/video.md
    ## "Hardware"): read once (`decodeCaps` in player.nim).
    v4l2Decoders*: seq[string] ## ffmpeg's V4L2 mem2mem decoders ("h264_v4l2m2m"), with a decoder device there
    vaapi*: bool               ## a VA-API render node, a VA driver and ffmpeg's vaapi hwaccel

  VideoDecode* = object
    ## How one ffmpeg decodes.
    decoder*: string ## a hardware decoder for `-c:v` ("h264_v4l2m2m"); "" for ffmpeg's own
    hwaccel*: string ## "vaapi"; ""
    fast*: bool      ## the decoder is behind: no loop filter, the scaler's fast bilinear

const
  DefaultMaxFps* = 30.0
  MaxMaxFps* = 60.0
  MinMaxFps* = 0.5
  MaxFrameEdge* = 4096
  NetworkTimeoutMicros = 15_000_000
  PlaylistFreeFormats = "mov,matroska,webm,avi,flv,mpegts,mpjpeg,mjpeg,rtsp,rtp,sdp,ogg,h264,hevc,m4v," &
    "mpegvideo,mpeg,asf,mxf,dv,ivf,gif"
    ## The demuxers a file, and a URL while the private-network deny holds
    ## it, may use: none that reads a list of further sources (hls, dash,
    ## concat), which ffmpeg would open without the guard seeing them (a
    ## playlist in the assets naming another file, a LAN address).

proc bytesPerPixel*(pixels: VideoPixels): int =
  case pixels
  of vpRgba: 4
  of vpRgb565: 2
  of vpGray: 1

proc pixFmt*(pixels: VideoPixels): string =
  case pixels
  of vpRgba: "rgba"
  of vpRgb565: "rgb565le"
  of vpGray: "gray"

proc frameBytes*(width, height: int, pixels: VideoPixels): int =
  max(width, 0) * max(height, 0) * pixels.bytesPerPixel

proc parseFit*(text: string, default = vfContain): VideoFit =
  case text.strip().toLowerAscii()
  of "cover", "slice", "xmidymid slice": vfCover
  of "contain", "meet", "xmidymid meet": vfContain
  of "fill", "stretch", "none": vfFill
  else: default

proc parseRate*(text: string): float =
  ## "30000/1001", "25/1" or "29.97" as frames a second; 0 when unknown.
  let t = text.strip()
  if t.len == 0 or t == "N/A":
    return 0
  let slash = t.find('/')
  try:
    if slash < 0:
      result = parseFloat(t)
    else:
      let
        num = parseFloat(t[0 ..< slash])
        den = parseFloat(t[slash + 1 .. ^1])
      result = if den > 0: num / den else: 0
  except ValueError:
    return 0
  if result.classify in {fcNan, fcInf, fcNegInf} or result <= 0 or result > 1000:
    result = 0

proc outputFps*(probed, maxFps: float): float =
  ## The constant rate frames come out at: the source's, at most the app's
  ## maximum (30 by default). A source that does not say (a camera) gets the
  ## maximum, which ffmpeg's fps filter holds it to by repeating frames.
  let cap = if maxFps > 0: clamp(maxFps, MinMaxFps, MaxMaxFps) else: DefaultMaxFps
  if probed > 0: min(probed, cap) else: cap

proc safeHeader(text: string): bool =
  ## A header name or value that cannot start another header or request line.
  for c in text:
    if c in {'\r', '\n', '\0'}:
      return false
  true

proc headerBlock*(source: VideoSource): string =
  ## ffmpeg's `-headers`: CRLF-ended "Name: value" lines, the Host first when
  ## the URL carries a pinned address.
  if source.hostHeader.len > 0 and safeHeader(source.hostHeader):
    result.add "Host: " & source.hostHeader & "\r\n"
  for (name, value) in source.headers:
    let n = name.strip()
    if n.len == 0 or not safeHeader(n) or not safeHeader(value) or n.contains(':') or
        cmpIgnoreCase(n, "host") == 0:
      continue
    result.add n & ": " & value & "\r\n"

proc protocolWhitelist*(scheme: string): string =
  ## What ffmpeg may open for a source of this scheme, and nothing else: the
  ## guard checked one URL, but a demuxer follows redirects and playlists into
  ## any protocol they name, `file:` included.
  case scheme
  of "": "file"
  of "rtsp": "rtsp,rtp,udp,tcp"
  of "rtsps": "rtsps,rtsp,rtp,udp,tcp,tls"
  of "https": "https,http,tcp,tls,crypto"
  else: "http,tcp,crypto"

proc isLiveScheme*(scheme: string): bool =
  scheme in ["rtsp", "rtsps"]

proc inputArgs*(source: VideoSource): seq[string] =
  ## The options before `-i`: what may be opened, the headers, the timeouts.
  result = @["-protocol_whitelist", protocolWhitelist(source.scheme)]
  case source.scheme
  of "http", "https":
    let headers = source.headerBlock()
    if headers.len > 0:
      result.add @["-headers", headers]
    result.add @["-rw_timeout", $NetworkTimeoutMicros,
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"]
  of "rtsp", "rtsps":
    result.add @["-rtsp_transport", "tcp", "-timeout", $NetworkTimeoutMicros]
  else:
    discard
  if source.denyActive or source.scheme.len == 0:
    result.add @["-format_whitelist", PlaylistFreeFormats]

proc fitFilter*(width, height: int, fit: VideoFit, fast = false): string =
  ## Scaled to exactly `width` x `height` whatever the fit, so the draw is a
  ## copy: contain pads with black, cover crops. `fast`: the scaler's fast
  ## bilinear, a sixth less of a Pi Zero's 720p frame than bilinear.
  let
    w = $clamp(width, 1, MaxFrameEdge)
    h = $clamp(height, 1, MaxFrameEdge)
    flags = if fast: "fast_bilinear" else: "bilinear"
  case fit
  of vfFill:
    "scale=" & w & ":" & h & ":flags=" & flags & ",setsar=1"
  of vfContain:
    "scale=" & w & ":" & h & ":force_original_aspect_ratio=decrease:flags=" & flags & "," &
      "pad=" & w & ":" & h & ":(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"
  of vfCover:
    "scale=" & w & ":" & h & ":force_original_aspect_ratio=increase:flags=" & flags & "," &
      "crop=" & w & ":" & h & ",setsar=1"

proc v4l2Decoder*(codec: string): string =
  ## ffmpeg's V4L2 mem2mem decoder for a codec as ffprobe names it.
  case codec
  of "h264", "hevc", "vp8", "vp9", "vc1", "h263", "mpeg4": codec & "_v4l2m2m"
  of "mpeg2video": "mpeg2_v4l2m2m"
  of "mpeg1video": "mpeg1_v4l2m2m"
  else: ""

proc pickDecode*(codec: string, caps: DecodeCaps, fast: bool, software: bool): VideoDecode =
  ## The decoder for a source of `codec`: the machine's V4L2 decoder for it
  ## (a Pi 0 to 4's VideoCore), else VA-API (Intel, AMD), else ffmpeg's own.
  ## `software`: the hardware failed for it before (player.nim falls back).
  result.fast = fast
  if software or codec.len == 0:
    return
  let v4l2 = v4l2Decoder(codec)
  if v4l2.len > 0 and v4l2 in caps.v4l2Decoders:
    result.decoder = v4l2
  elif caps.vaapi and codec in ["h264", "hevc", "vp8", "vp9", "av1", "mpeg2video", "vc1"]:
    result.hwaccel = "vaapi"

proc decodeName*(decode: VideoDecode): string =
  ## What a status says decodes it.
  if decode.decoder.len > 0: decode.decoder
  elif decode.hwaccel.len > 0: decode.hwaccel
  else: "software"

proc parseDecoderList*(text: string, suffix = "_v4l2m2m"): seq[string] =
  ## Names from `ffmpeg -decoders` that end in `suffix`.
  for line in text.splitLines():
    let parts = line.strip().splitWhitespace()
    if parts.len >= 2 and parts[0].len == 6 and parts[0][0] == 'V' and parts[1].endsWith(suffix):
      result.add parts[1]

proc parseHwaccels*(text: string): seq[string] =
  ## Names from `ffmpeg -hwaccels` (a heading, then one a line).
  for line in text.splitLines():
    let name = line.strip()
    if name.len > 0 and not name.endsWith(":") and ' ' notin name:
      result.add name

proc fpsText(fps: float): string =
  ## A rate ffmpeg reads exactly: 29.97 as 2997/100.
  let hundredths = max(1, int(round(fps * 100)))
  if hundredths mod 100 == 0: $(hundredths div 100) else: $hundredths & "/100"

proc decodeArgs*(source: VideoSource, width, height: int, fit: VideoFit, pixels: VideoPixels,
    startAt, fps: float, loopFile: bool, threads: int, decode = VideoDecode()): seq[string] =
  ## ffmpeg playing `source` from `startAt` seconds as raw frames on stdout:
  ## `width` x `height`, `pixels`, `fps` a second. `loopFile`: a file plays
  ## again from its start for ever (`-stream_loop`, no gap); anything else is
  ## started again by the player. `decode`: a hardware decoder, and the
  ## shortcuts of a decoder that is behind (pickDecode).
  result = @["-hide_banner", "-loglevel", "error", "-nostdin", "-nostats"]
  if threads > 0 and decode.decoder.len == 0:
    result.add @["-threads", $threads]
  result.add source.inputArgs()
  if decode.hwaccel.len > 0:
    # Frames come back to memory for the scaler: no -hwaccel_output_format.
    result.add @["-hwaccel", decode.hwaccel]
  if decode.decoder.len > 0:
    result.add @["-c:v", decode.decoder]
  if decode.fast:
    # No deblocking filter (a tenth of a Pi Zero's 720p frame, 2026-11-24):
    # what it smooths is hardly seen on a frame's panel.
    result.add @["-skip_loop_filter", "all", "-flags2", "fast"]
  if startAt > 0.001:
    result.add @["-ss", formatFloat(startAt, ffDecimal, 3)]
  if loopFile and source.scheme.len == 0:
    result.add @["-stream_loop", "-1"]
  result.add @["-i", source.input, "-an", "-sn", "-dn",
    "-vf", "fps=" & fpsText(fps) & "," & fitFilter(width, height, fit, decode.fast),
    "-f", "rawvideo", "-pix_fmt", pixels.pixFmt, "pipe:1"]

proc stillArgs*(source: VideoSource, at: float, width, height: int, fit: VideoFit,
    pixels: VideoPixels): seq[string] =
  ## One frame `at` seconds in, as raw pixels on stdout.
  result = @["-hide_banner", "-loglevel", "error", "-nostdin", "-nostats"]
  result.add source.inputArgs()
  if at > 0.001:
    result.add @["-ss", formatFloat(at, ffDecimal, 3)]
  result.add @["-i", source.input, "-an", "-sn", "-dn", "-frames:v", "1",
    "-vf", fitFilter(width, height, fit),
    "-f", "rawvideo", "-pix_fmt", pixels.pixFmt, "pipe:1"]

proc probeArgs*(source: VideoSource): seq[string] =
  result = @["-v", "error", "-print_format", "json",
    "-show_entries", "format=duration:stream=codec_name,width,height,avg_frame_rate,r_frame_rate" &
      ":stream_tags=rotate:stream_side_data=rotation",
    "-select_streams", "v:0"]
  result.add source.inputArgs()
  result.add source.input

proc keyframeArgs*(source: VideoSource, at: float): seq[string] =
  ## ffprobe answering with the time of the keyframe at or before `at`: the
  ## first packet read after seeking there.
  result = @["-v", "error", "-select_streams", "v:0", "-read_intervals",
    formatFloat(max(at, 0), ffDecimal, 3) & "%+#1", "-show_entries", "packet=pts_time", "-of", "csv=p=0"]
  result.add source.inputArgs()
  result.add source.input

proc parseKeyframe*(text: string, at: float): float =
  ## What keyframeArgs printed; `at` itself when it says nothing usable (no
  ## keyframe before it, or after it).
  for line in text.splitLines():
    let value = line.strip().strip(chars = {','})
    if value.len == 0: continue
    try:
      let t = parseFloat(value)
      return if t >= 0 and t <= at + 0.001: t else: at
    except ValueError:
      return at
  at

proc jsonFloat(node: JsonNode): float =
  if node.isNil: return -1
  case node.kind
  of JFloat: node.getFloat()
  of JInt: node.getInt().float
  of JString:
    try: parseFloat(node.getStr())
    except ValueError: -1.0
  else: -1.0

proc parseProbe*(text: string): ProbeResult =
  ## ffprobe's JSON (probeArgs) as what a player needs.
  result.duration = -1
  var root: JsonNode
  try:
    root = parseJson(text)
  except CatchableError:
    result.error = "the video could not be read"
    return
  let streams = root{"streams"}
  if streams.isNil or streams.kind != JArray or streams.len == 0 or streams[0].kind != JObject:
    result.error = "no video in it"
    return
  let stream = streams[0]
  result.codec = stream{"codec_name"}.getStr()
  result.width = stream{"width"}.getInt()
  result.height = stream{"height"}.getInt()
  result.fps = parseRate(stream{"avg_frame_rate"}.getStr())
  if result.fps <= 0:
    result.fps = parseRate(stream{"r_frame_rate"}.getStr())
  var rotation = 0.0
  let sideData = stream{"side_data_list"}
  if not sideData.isNil and sideData.kind == JArray:
    for item in sideData:
      if item.kind == JObject and item.hasKey("rotation"):
        rotation = jsonFloat(item["rotation"])
  let tags = stream{"tags"}
  if rotation == 0 and not tags.isNil and tags.kind == JObject and tags.hasKey("rotate"):
    rotation = jsonFloat(tags["rotate"])
  if int(round(abs(rotation))) mod 180 == 90:
    swap(result.width, result.height)
  let duration = jsonFloat(root{"format"}{"duration"})
  if duration > 0 and duration.classify notin {fcNan, fcInf}:
    result.duration = duration
  result.ok = result.width > 0 and result.height > 0
  if not result.ok:
    result.error = "no video in it"
