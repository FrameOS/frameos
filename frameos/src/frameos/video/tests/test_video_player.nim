## The player against a real ffmpeg (skipped where there is none): a clip
## made with lavfi, played at a box's size in each pixel format, paced by
## its clock, sought, looped, ended, failed and closed. The deadlines only
## bound a wait (each loop stops as soon as what it waits for happens): a
## loaded machine drops frames and starts ffmpeg later, which is no failure.

import std/[os, osproc, strutils, unittest]
import pixie
import ../player

let dir = getTempDir() / "frameos-video-test-" & $getCurrentProcessId()
createDir(dir)
let clip = dir / "clip.mp4"
let haveFfmpeg = findExe("ffmpeg").len > 0 and findExe("ffprobe").len > 0

if haveFfmpeg:
  # Two seconds of a test pattern at 10 frames a second, red for the first
  # second and blue for the next.
  let made = execCmdEx("ffmpeg -hide_banner -loglevel error -y -f lavfi -i color=c=red:size=320x180:rate=10:duration=1 " &
    "-f lavfi -i color=c=blue:size=320x180:rate=10:duration=1 -filter_complex \"[0:v][1:v]concat=n=2:v=1[v]\" " &
    "-map \"[v]\" -pix_fmt yuv420p -c:v mpeg4 " & quoteShell(clip))
  doAssert made.exitCode == 0, made.output

# Six seconds, red to 3 and blue after, a keyframe every 2 seconds (mpeg4's
# -g 20 at 10 a second) and none where the colour changes: a slow decoder's
# start goes to the one before.
let keyed = dir / "keyed.mp4"
if haveFfmpeg:
  let made = execCmdEx("ffmpeg -hide_banner -loglevel error -y -f lavfi -i color=c=red:size=320x180:rate=10:duration=3 " &
    "-f lavfi -i color=c=blue:size=320x180:rate=10:duration=3 -filter_complex \"[0:v][1:v]concat=n=2:v=1[v]\" " &
    "-map \"[v]\" -pix_fmt yuv420p -c:v mpeg4 -g 20 -sc_threshold 1000000000 " & quoteShell(keyed))
  doAssert made.exitCode == 0, made.output

proc fileSource(path: string): VideoSource =
  VideoSource(input: path)

proc playUntil(player: VideoPlayer, width, height: int, fit: VideoFit, like: Image,
    seconds: float, stopWhen: proc(p: VideoPlayer): bool = nil): int =
  ## Renders as a scene would, at the times the player asks for: frames taken.
  let deadline = nowSeconds() + seconds
  while nowSeconds() < deadline:
    if player.take(width, height, fit, like):
      inc result
    if not stopWhen.isNil and stopWhen(player):
      return
    let wait = player.nextFrameIn()
    sleep(int(clamp(if wait < 0: 0.02 else: wait, 0.001, 0.1) * 1000))

proc red(image: Image): bool =
  let c = image[image.width div 2, image.height div 2].rgba
  c.r > 200 and c.b < 60

proc blue(image: Image): bool =
  let c = image[image.width div 2, image.height div 2].rgba
  c.b > 200 and c.r < 60

suite "video player":
  test "plays a file at the box's size, paced by its clock":
    if not haveFfmpeg:
      skip()
    else:
      let player = newVideoPlayer(fileSource(clip), "clip.mp4", loop = false, maxFps = 30, startAt = 0)
      let started = nowSeconds()
      let taken = player.playUntil(200, 100, vfContain, nil, 30,
        proc(p: VideoPlayer): bool = p.state == "ended")
      let elapsed = nowSeconds() - started
      check player.state == "ended"
      # Never a frame the clip does not have (late ones are dropped).
      check taken >= 1 and taken <= 20
      # Paced by the clock: two seconds of video take two seconds at least.
      check elapsed > 1.8
      check player.image.width == 200 and player.image.height == 100
      check player.image.blue
      # Contained: a 16:9 picture in a 2:1 box has black bars at its sides.
      let edge = player.image[2, 50].rgba
      check edge.r < 20 and edge.g < 20 and edge.b < 20
      let status = player.status
      check status.duration > 1.9 and status.duration < 2.1
      check status.width == 320 and status.height == 180
      check status.fps > 9.9 and status.fps < 10.1
      player.close()

  test "a 565 canvas gets 565 frames, a seek starts where it says":
    if not haveFfmpeg:
      skip()
    else:
      let like = newImage565(4, 4)
      let player = newVideoPlayer(fileSource(clip), "clip.mp4", loop = false, maxFps = 30, startAt = 1.2)
      discard player.playUntil(160, 90, vfCover, like, 20,
        proc(p: VideoPlayer): bool = not p.image.isNil)
      check not player.image.isNil
      check player.image.format == pfRgb565
      check player.image.blue
      player.seek(0.1)
      discard player.playUntil(160, 90, vfCover, like, 20,
        proc(p: VideoPlayer): bool = p.image.red)
      check player.image.red
      check player.status.time < 0.9
      player.close()

  test "loops a file, and a new size starts ffmpeg again where it was":
    if not haveFfmpeg:
      skip()
    else:
      let player = newVideoPlayer(fileSource(clip), "clip.mp4", loop = true, maxFps = 30, startAt = 1.5)
      var sawBlue, sawRedAfter = false
      discard player.playUntil(120, 60, vfFill, nil, 30,
        proc(p: VideoPlayer): bool =
          if p.image.isNil: return false
          if p.image.blue: sawBlue = true
          elif sawBlue and p.image.red: sawRedAfter = true
          sawRedAfter)
      check sawBlue and sawRedAfter
      check player.state == "playing"
      discard player.playUntil(64, 32, vfFill, nil, 20,
        proc(p: VideoPlayer): bool = p.image.width == 64)
      check player.image.width == 64 and player.image.height == 32
      player.close()

  test "pausing holds the picture, and the first frame shows while paused":
    if not haveFfmpeg:
      skip()
    else:
      let player = newVideoPlayer(fileSource(clip), "clip.mp4", loop = false, maxFps = 30, startAt = 0)
      player.setPaused(true)
      discard player.playUntil(100, 50, vfFill, nil, 20,
        proc(p: VideoPlayer): bool = not p.image.isNil)
      check player.state == "paused"
      check player.image.red
      check player.nextFrameIn() < 0
      let taken = player.playUntil(100, 50, vfFill, nil, 1.5)
      check taken == 0
      check player.status.time < 0.2
      player.setPaused(false)
      discard player.playUntil(100, 50, vfFill, nil, 30,
        proc(p: VideoPlayer): bool = p.image.blue)
      check player.image.blue
      player.close()

  test "a source that loops and failed is opened again until it plays":
    if not haveFfmpeg:
      skip()
    else:
      retrySeconds = 0.3
      defer: retrySeconds = 10.0
      let later = dir / "later.mp4"
      let player = newVideoPlayer(fileSource(later), "later.mp4", loop = true, maxFps = 30, startAt = 0)
      discard player.playUntil(100, 50, vfFill, nil, 30,
        proc(p: VideoPlayer): bool = p.state == "error")
      check player.state == "error"
      check player.nextFrameIn() > 0 # it is tried again: a render now and then shows it
      copyFile(clip, later)
      discard player.playUntil(100, 50, vfFill, nil, 30,
        proc(p: VideoPlayer): bool = p.state == "playing" and not p.image.isNil)
      check player.state == "playing"
      check player.image.red or player.image.blue
      player.close()

  test "a file that is not a video fails with ffmpeg's reason":
    if not haveFfmpeg:
      skip()
    else:
      writeFile(dir / "notes.txt", "not a video")
      let player = newVideoPlayer(fileSource(dir / "notes.txt"), "notes.txt", loop = false, maxFps = 30, startAt = 0)
      discard player.playUntil(100, 50, vfFill, nil, 30,
        proc(p: VideoPlayer): bool = p.state == "error")
      check player.state == "error"
      check player.status.error.len > 0
      check player.nextFrameIn() < 0
      player.close()

  test "a missing ffmpeg says so":
    putEnv("FRAMEOS_FFMPEG", dir / "no-ffmpeg-here")
    putEnv("FRAMEOS_FFPROBE", dir / "no-ffprobe-here")
    check not videoAvailable()
    let player = newVideoPlayer(fileSource(clip), "clip.mp4", loop = false, maxFps = 30, startAt = 0)
    discard player.playUntil(100, 50, vfFill, nil, 20,
      proc(p: VideoPlayer): bool = p.state == "error")
    check player.state == "error"
    check "not installed" in player.status.error
    player.close()
    delEnv("FRAMEOS_FFMPEG")
    delEnv("FRAMEOS_FFPROBE")

  test "a still at a time, and a probe":
    if not haveFfmpeg:
      skip()
    else:
      var error = ""
      let still = videoStill(fileSource(clip), "clip.mp4", 1.5, 64, 36, vfCover, nil, error)
      check error == ""
      check not still.isNil and still.blue
      let first = videoStill(fileSource(clip), "clip.mp4", 0, 64, 36, vfCover, nil, error)
      check not first.isNil and first.red
      let past = videoStill(fileSource(clip), "clip.mp4", 30, 64, 36, vfCover, nil, error)
      check past.isNil
      check error.len > 0
      let probe = probeVideo(fileSource(clip), "clip.mp4")
      check probe.ok
      check probe.width == 320 and probe.height == 180

  test "a hardware decoder that fails gives way to ffmpeg's own, which plays it, and is not tried again":
    if not haveFfmpeg:
      skip()
    else:
      # This machine says it has the VideoCore's MPEG-4 decoder (the clip's
      # codec); there is no such device, so ffmpeg fails with it.
      setDecodeCapsForTest(DecodeCaps(v4l2Decoders: @["mpeg4_v4l2m2m"]))
      defer: setDecodeCapsForTest(DecodeCaps())
      check not hardwareFailed("mpeg4")
      let player = newVideoPlayer(fileSource(clip), "clip.mp4", loop = false, maxFps = 30, startAt = 0)
      discard player.playUntil(200, 100, vfContain, nil, 30,
        proc(p: VideoPlayer): bool = p.state == "ended")
      check player.state == "ended" # not "error": ffmpeg's own played it
      check player.image.blue
      check player.status.decoder == "software"
      check hardwareFailed("mpeg4")
      let fallback = player.lastFallback()
      check fallback.count == 1 and player.fallbacks() == 1
      check fallback.decoder == "mpeg4_v4l2m2m"
      check fallback.reason.len > 0 and not fallback.busy
      player.close()
      # The next player of this codec starts with ffmpeg's own.
      let next = newVideoPlayer(fileSource(clip), "clip.mp4", loop = false, maxFps = 30, startAt = 0)
      discard next.playUntil(200, 100, vfContain, nil, 30, proc(p: VideoPlayer): bool = not p.image.isNil)
      check next.status.decoder == "software"
      next.close()

  test "a hardware decoder that cannot take it now gives way for this player only":
    if not haveFfmpeg:
      skip()
    else:
      # An ffmpeg that fails a V4L2 launch as a Pi Zero W's did with its CMA
      # taken, and is the real one otherwise.
      let fake = dir / "ffmpeg-short"
      writeFile(fake, "#!/bin/sh\ncase \"$*\" in\n  *_v4l2m2m*)\n" &
        "    echo '[mpeg4_v4l2m2m @ 0x1] output VIDIOC_REQBUFS failed: Cannot allocate memory' >&2\n" &
        "    echo '[vost#0:0/rawvideo @ 0x2] Error initializing a simple filtergraph' >&2\n" &
        "    echo 'Error opening output file pipe:1.' >&2\n    exit 1;;\nesac\nexec " &
        quoteShell(findExe("ffmpeg")) & " \"$@\"\n")
      setFilePermissions(fake, {fpUserRead, fpUserWrite, fpUserExec})
      putEnv("FRAMEOS_FFMPEG", fake)
      setDecodeCapsForTest(DecodeCaps(v4l2Decoders: @["mpeg4_v4l2m2m"]))
      defer:
        delEnv("FRAMEOS_FFMPEG")
        setDecodeCapsForTest(DecodeCaps())
      let player = newVideoPlayer(fileSource(clip), "clip.mp4", loop = false, maxFps = 30, startAt = 0)
      discard player.playUntil(200, 100, vfContain, nil, 30,
        proc(p: VideoPlayer): bool = p.state == "ended")
      check player.state == "ended"
      check player.image.blue
      check player.status.decoder == "software"
      let fallback = player.lastFallback()
      check fallback.count == 1
      check fallback.busy
      check fallback.reason == "output VIDIOC_REQBUFS failed: Cannot allocate memory"
      # Not the hardware's fault: the codec's hardware stays on, and the next
      # player tries it first.
      check not hardwareFailed("mpeg4")
      player.close()
      let next = newVideoPlayer(fileSource(clip), "clip.mp4", loop = false, maxFps = 30, startAt = 0)
      discard next.playUntil(200, 100, vfContain, nil, 30, proc(p: VideoPlayer): bool = p.fallbacks() > 0)
      check next.fallbacks() == 1 and next.lastFallback().busy
      next.close()

  test "a hardware decoder that makes no frame is stopped and gives way":
    if not haveFfmpeg:
      skip()
    else:
      # A V4L2 launch that waits on its device for ever, as one did on a Pi
      # Zero W with part of its buffers; the real ffmpeg otherwise.
      let fake = dir / "ffmpeg-hangs"
      writeFile(fake, "#!/bin/sh\ncase \"$*\" in\n  *_v4l2m2m*) exec sleep 60;;\nesac\nexec " &
        quoteShell(findExe("ffmpeg")) & " \"$@\"\n")
      setFilePermissions(fake, {fpUserRead, fpUserWrite, fpUserExec})
      putEnv("FRAMEOS_FFMPEG", fake)
      setDecodeCapsForTest(DecodeCaps(v4l2Decoders: @["mpeg4_v4l2m2m"]))
      hardwareFirstFrameSeconds = 1.0
      defer:
        delEnv("FRAMEOS_FFMPEG")
        setDecodeCapsForTest(DecodeCaps())
        hardwareFirstFrameSeconds = 20.0
      let started = nowSeconds()
      let player = newVideoPlayer(fileSource(clip), "clip.mp4", loop = false, maxFps = 30, startAt = 0)
      discard player.playUntil(200, 100, vfContain, nil, 30,
        proc(p: VideoPlayer): bool = p.state == "ended")
      check player.state == "ended"
      check player.image.blue
      check player.status.decoder == "software"
      check nowSeconds() - started < 20 # the sleep was stopped, not waited out
      let fallback = player.lastFallback()
      check fallback.count == 1 and not fallback.busy
      check "made no frame" in fallback.reason
      check hardwareFailed("mpeg4") # ffmpeg's own played it: the hardware's fault
      player.close()

  test "a slow decoder starts at the keyframe before the time asked for, and says that time":
    if not haveFfmpeg:
      skip()
    else:
      startFastForTest = true
      defer: startFastForTest = false
      # 3.5 s in is blue; the keyframe before it, at 2 s, is red.
      let player = newVideoPlayer(fileSource(keyed), "keyed.mp4", loop = false, maxFps = 30, startAt = 3.5)
      discard player.playUntil(200, 100, vfContain, nil, 20, proc(p: VideoPlayer): bool = not p.image.isNil)
      check player.image.red
      check player.status.fast
      check player.status.time >= 1.9 and player.status.time < 2.6
      discard player.playUntil(200, 100, vfContain, nil, 20, proc(p: VideoPlayer): bool = p.image.blue)
      check player.image.blue
      player.close()

  test "closed players are joined once their reader ends":
    if not haveFfmpeg:
      skip()
    else:
      for i in 0 ..< 3:
        let player = newVideoPlayer(fileSource(clip), "clip.mp4", loop = true, maxFps = 30, startAt = 0)
        discard player.playUntil(80, 40, vfFill, nil, 0.4)
        player.close()
      let deadline = nowSeconds() + 30
      while closingPlayers() > 0 and nowSeconds() < deadline:
        reapClosedPlayers()
        sleep(20)
      check closingPlayers() == 0

removeDir(dir)
