## The ISP path's pure parts (docs/video.md "Hardware"): H.264 access units
## out of an Annex B stream, what ffmpeg demuxes with, when a launch takes
## the path, the ISP's size for a fit, the frames kept for a rate and
## dropped for an exact start, and the VideoCore's devices by name. The
## devices themselves are a Pi's: CI has none (the player falls back,
## test_video_player.nim).

import std/[os, strutils, unittest]
import ../annexb
import ../args
import ../v4l2

proc nal(kind: int, firstMbZero = true, fourByte = false, payload = 6): seq[byte] =
  ## A NAL unit with its start code: `kind`, and for a slice whether
  ## first_mb_in_slice is 0 (its first bit set).
  if fourByte:
    result.add 0
  result.add [0'u8, 0, 1, byte(0x60 or kind)]
  result.add(if firstMbZero: 0x88'u8 else: 0x08'u8)
  for i in 0 ..< payload:
    result.add byte(0x40 + i)

proc units(stream: seq[byte], chunk: int): seq[seq[byte]] =
  ## The access units a splitter gives, fed `chunk` bytes at a time.
  var sp: AnnexBSplitter
  var at = 0
  while true:
    let ended = at >= stream.len
    if not ended:
      let n = min(chunk, stream.len - at)
      sp.add stream[at ..< at + n]
      at += n
    var first, last: int
    while sp.nextUnit(first, last, eof = ended):
      result.add sp.buf[first ..< last]
    if ended:
      break

suite "the ISP path":
  test "access units: parameter sets with their picture, a picture's slices together":
    let sps = nal(7, fourByte = true)
    let pps = nal(8)
    let idr1 = nal(5)                       # first slice of a picture
    let idr2 = nal(5, firstMbZero = false)  # its second slice
    let sei = nal(6)
    let p1 = nal(1)
    let p2 = nal(1, fourByte = true)
    let aud = nal(9, fourByte = true)
    let p3 = nal(1)
    let stream = sps & pps & idr1 & idr2 & sei & p1 & p2 & aud & p3
    for chunk in [1, 3, 7, 64, stream.len]:
      let got = units(stream, chunk)
      checkpoint "fed " & $chunk & " bytes at a time"
      check got.len == 4
      if got.len == 4:
        check got[0] == sps & pps & idr1 & idr2  # SPS, PPS and both slices of the IDR
        check got[1] == sei & p1                  # an SEI starts the next picture
        check got[2] == p2                        # a four-byte start code's zero is the next unit's
        check got[3] == aud & p3                  # an AUD starts one
    check units(@[], 16).len == 0

  test "ffmpeg only demuxes: the H.264 as an Annex B stream, the input rules kept":
    let file = demuxArgs(VideoSource(input: "/srv/assets/videos/a.mp4"), 12.5, loopFile = true)
    check file[^1] == "pipe:1"
    for (flag, value) in [("-c:v", "copy"), ("-bsf:v", "h264_mp4toannexb"), ("-f", "h264"),
        ("-ss", "12.500"), ("-stream_loop", "-1"), ("-protocol_whitelist", "file"), ("-map", "0:v:0")]:
      var found = false
      for i in 0 ..< file.high:
        if file[i] == flag and file[i + 1] == value:
          found = true
      checkpoint flag & " " & value
      check found
    check file.find("-ss") < file.find("-i") and file.find("-stream_loop") < file.find("-i")
    check "-format_whitelist" in file
    let camera = demuxArgs(VideoSource(input: "rtsp://cam/stream", scheme: "rtsp"), 0, loopFile = false)
    check "-stream_loop" notin camera and "-ss" notin camera
    check "rtsp,rtp,udp,tcp" in camera

  test "a launch takes the path for H.264 the VideoCore decodes and its ISP makes":
    let caps = DecodeCaps(v4l2Decoders: @["h264_v4l2m2m"], v4l2Device: "/dev/video10", ispDevice: "/dev/video12")
    let decode = pickDecode("h264", caps, fast = true, software = false)
    let hd = ProbeResult(ok: true, codec: "h264", width: 1920, height: 1080, fps: 30)
    check ispFits(caps, decode, vfContain, 720, 720, hd)
    check ispFits(caps, decode, vfCover, 720, 720, hd)
    # No ISP, ffmpeg's own decoding (it failed here), another codec, a turned
    # picture (the ISP does not turn), a source past the decoder's 1920, a
    # frame the ISP does not make (under 32 a side).
    check not ispFits(DecodeCaps(v4l2Decoders: @["h264_v4l2m2m"], v4l2Device: "/dev/video10"), decode,
      vfContain, 720, 720, hd)
    check not ispFits(caps, pickDecode("h264", caps, fast = true, software = true), vfContain, 720, 720, hd)
    check not ispFits(caps, pickDecode("mpeg4", DecodeCaps(v4l2Decoders: @["mpeg4_v4l2m2m"],
      v4l2Device: "/dev/video10", ispDevice: "/dev/video12"), fast = true, software = false), vfContain, 720, 720,
      ProbeResult(ok: true, codec: "mpeg4", width: 640, height: 360))
    var phone = hd
    phone.rotation = 90
    check not ispFits(caps, decode, vfContain, 720, 720, phone)
    check not ispFits(caps, decode, vfContain, 720, 720,
      ProbeResult(ok: true, codec: "h264", width: 3840, height: 2160))
    check not ispFits(caps, decode, vfContain, 40, 40, hd) # a 40x23 picture
    check decodeName(VideoDecode(decoder: "h264_v4l2m2m", isp: true)) == "h264_v4l2m2m+isp"

  test "the ISP's size: the frame, or for cover the picture covering the box, its middle copied":
    check ispSize(720, 720, vfContain, 1920, 1080) == (720, 405, 0, 0)
    check ispSize(720, 720, vfFill, 1920, 1080) == (720, 720, 0, 0)
    check ispSize(720, 720, vfCover, 1920, 1080) == (1280, 720, 280, 0)
    check ispSize(800, 480, vfCover, 1080, 1920) == (800, 1422, 0, 471)
    check ispSize(320, 180, vfCover, 1280, 720) == (320, 180, 0, 0)

  test "frames kept for the output's rate, frames dropped for an exact start":
    var kept = 0
    for i in 0 ..< 60:
      if keepFrame(int64(i), 60, 30): inc kept
    check kept == 30
    check keepFrame(0, 60, 30) == false and keepFrame(1, 60, 30) == true
    kept = 0
    for i in 0 ..< 50:
      if keepFrame(int64(i), 25, 24): inc kept
    check kept == 48
    for i in 0 ..< 10:
      check keepFrame(int64(i), 30, 30) and keepFrame(int64(i), 0, 30) and keepFrame(int64(i), 24, 30)
    check startSkip(8.333, 10.0, 30) == 50
    check startSkip(10.0, 10.0, 30) == 0
    check startSkip(8.0, 10.0, 0) == 0

  test "the VideoCore's decoder and ISP are found by name, not number":
    let sys = getTempDir() / "frameos-v4l2-" & $getCurrentProcessId()
    for (dir, name) in [("video10", "bcm2835-codec-decode"), ("video11", "bcm2835-codec-encode"),
        ("video12", "bcm2835-codec-isp"), ("video13", "bcm2835-isp-output0")]:
      createDir(sys / dir)
      writeFile(sys / dir / "name", name & "\n")
    check codecDevices(sys) == ("/dev/video10", "/dev/video12")
    removeDir(sys / "video12")
    check codecDevices(sys) == ("/dev/video10", "")
    check codecDevices(sys / "nothing") == ("", "")
    removeDir(sys)

  test "ffprobe's rotation is kept: the ISP path leaves a turned picture to ffmpeg":
    let phone = parseProbe("""{"streams": [{"codec_name": "h264", "width": 1920, "height": 1080,
      "avg_frame_rate": "30/1", "side_data_list": [{"rotation": -90}]}], "format": {"duration": "12"}}""")
    check phone.rotation == 270 and phone.width == 1080
    check parseProbe("""{"streams": [{"codec_name": "h264", "width": 1920, "height": 1080}],
      "format": {}}""").rotation == 0
    check fourcc("NV12") == 0x3231564e'u32 and fourccText(FourccRgb565) == "RGBP"
