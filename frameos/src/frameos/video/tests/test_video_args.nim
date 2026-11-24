## What a video's ffmpeg and ffprobe are told (video/args.nim), and what is
## read back: no ffmpeg needed.

import std/[strutils, unittest]
import ../args
from ../player import cleaned, renderWait

proc has(args: seq[string], flag, value: string): bool =
  for i in 0 ..< args.high:
    if args[i] == flag and args[i + 1] == value:
      return true

suite "video args":
  test "a file: only the file protocol, no playlists, looped inside one ffmpeg":
    let args = decodeArgs(VideoSource(input: "/srv/assets/videos/a.mp4"), 800, 480, vfContain, vpRgb565,
      12.5, 29.97, loopFile = true, threads = 3)
    check args.has("-protocol_whitelist", "file")
    check args.has("-threads", "3")
    check args.has("-ss", "12.500")
    check args.has("-stream_loop", "-1")
    check args.has("-pix_fmt", "rgb565le")
    check args[^1] == "pipe:1"
    # The demuxers a file may use: no hls, dash or concat to name other files.
    var formats = ""
    for i in 0 ..< args.high:
      if args[i] == "-format_whitelist": formats = args[i + 1]
    check "mov" in formats.split(',') and "matroska" in formats.split(',')
    check "hls" notin formats.split(',') and "concat" notin formats.split(',')
    # -ss and -stream_loop are the input's: before -i.
    check args.find("-ss") < args.find("-i") and args.find("-stream_loop") < args.find("-i")
    let vf = args[args.find("-vf") + 1]
    check vf.startsWith("fps=2997/100,scale=800:480:force_original_aspect_ratio=decrease")
    check "pad=800:480:(ow-iw)/2:(oh-ih)/2:color=black" in vf

  test "a URL: its scheme's protocols, the pinned host's name, headers without line breaks":
    let source = VideoSource(input: "https://192.0.2.10/v.mp4", scheme: "https", hostHeader: "videos.example",
      headers: @[("x-api-key", "secret"), ("Evil", "a\r\nHost: other"), ("Host", "other"), ("bad:name", "x")])
    let args = decodeArgs(source, 320, 180, vfCover, vpRgba, 0, 30, loopFile = true, threads = 0)
    check args.has("-protocol_whitelist", "https,http,tcp,tls,crypto")
    check args.has("-headers", "Host: videos.example\r\nx-api-key: secret\r\n")
    check "-stream_loop" notin args # a URL is started again by the player
    check "-ss" notin args
    check "-format_whitelist" notin args # playlists (HLS) play where no policy holds the URL
    let held = decodeArgs(VideoSource(input: "https://192.0.2.10/live.m3u8", scheme: "https", denyActive: true),
      320, 180, vfCover, vpRgba, 0, 30, loopFile = false, threads = 0)
    check "-format_whitelist" in held
    let vf = args[args.find("-vf") + 1]
    check "force_original_aspect_ratio=increase" in vf and "crop=320:180" in vf
    let camera = decodeArgs(VideoSource(input: "rtsp://cam/stream", scheme: "rtsp"), 320, 180, vfFill, vpGray,
      0, 15, loopFile = false, threads = 0)
    check camera.has("-protocol_whitelist", "rtsp,rtp,udp,tcp")
    check camera.has("-rtsp_transport", "tcp")
    check camera.has("-pix_fmt", "gray")

  test "rates, sizes and fits":
    check parseRate("30000/1001") > 29.96 and parseRate("30000/1001") < 29.98
    check parseRate("25/1") == 25
    check parseRate("0/0") == 0 and parseRate("N/A") == 0 and parseRate("") == 0
    check outputFps(59.94, 30) == 30
    check outputFps(24, 30) == 24
    check outputFps(0, 15) == 15
    check outputFps(25, 0) == 25 # 0: the default, 30
    check outputFps(120, 500) == 60 # never past 60
    check frameBytes(800, 480, vpRgba) == 800 * 480 * 4
    check frameBytes(800, 480, vpRgb565) == 800 * 480 * 2
    check parseFit("cover") == vfCover and parseFit("xMidYMid meet") == vfContain and parseFit("none") == vfFill
    check parseFit("nonsense") == vfContain
    check stillArgs(VideoSource(input: "/a.mp4"), 3, 64, 36, vfCover, vpRgba).has("-frames:v", "1")

  test "ffprobe's answer: a phone's turned video is tall, a stream has no duration":
    let phone = parseProbe("""{"streams": [{"codec_name": "h264", "width": 1920, "height": 1080,
      "avg_frame_rate": "30/1", "r_frame_rate": "30/1", "side_data_list": [{"rotation": -90}]}],
      "format": {"duration": "12.48"}}""")
    check phone.ok
    check phone.width == 1080 and phone.height == 1920
    check phone.fps == 30 and phone.codec == "h264"
    check phone.duration > 12.4 and phone.duration < 12.5
    let stream = parseProbe("""{"streams": [{"codec_name": "h264", "width": 640, "height": 360,
      "avg_frame_rate": "0/0", "r_frame_rate": "25/1"}], "format": {}}""")
    check stream.ok and stream.duration < 0 and stream.fps == 25
    check not parseProbe("""{"streams": [], "format": {"duration": "3"}}""").ok
    check not parseProbe("not json").ok

  test "the next render: on time for a decoded frame, a frame away while the decoder is behind":
    # A frame in the ring due in 20 ms, renders coming 5 ms late: asked for in 15.
    check abs(renderWait(0.020, 1 / 30, 0.005, decoded = true) - 0.015) < 1e-9
    # One overdue: now (the floor).
    check renderWait(-0.1, 1 / 30, 0.0, decoded = true) == 0.002
    # Nothing decoded (a Pi Zero decoding 720p at 3 frames a second, renders
    # 50 ms late): a frame from now, not back to back, or the render loop takes
    # the core the decoder needs.
    check abs(renderWait(0, 1 / 30, 0.05, decoded = false) - 1 / 30) < 1e-9
    check renderWait(0, 0.05, 0.05, decoded = false) == 0.05
    # The decoder makes a frame in 0.7 s and its last came 0.2 s ago: in 0.5 s,
    # not every frame period in between.
    check abs(renderWait(0, 1 / 30, 0.05, decoded = false, madeIn = 0.5) - 0.5) < 1e-9
    # Overdue already: every frame until it comes; a stalled stream: a second at most.
    check abs(renderWait(0, 1 / 30, 0.05, decoded = false, madeIn = -0.3) - 1 / 30) < 1e-9
    check renderWait(0, 1 / 30, 0.0, decoded = false, madeIn = 6.0) == 1.0

  test "ffmpeg's reason, not its afterwords, the source's password left out":
    let said = "[in#0 @ 0x55aa] Error opening input: Connection refused\n" &
      "rtsp://admin:hunter2@10.0.0.5/stream: Connection refused\n" &
      "Error opening input files: Connection refused\n" &
      "[out#0/rawvideo @ 0x5811343f7e80] Nothing was written into output file, because at least one of its streams received no packets.\n"
    let reason = cleaned(said, "rtsp://10.0.0.5", "rtsp://admin:hunter2@10.0.0.5/stream")
    check reason == "rtsp://10.0.0.5: Connection refused"
    check "hunter2" notin reason
    check cleaned("[out#0/rawvideo @ 0x1] Nothing was written into output file", "", "") ==
      "Nothing was written into output file"
    check cleaned("", "", "") == ""
