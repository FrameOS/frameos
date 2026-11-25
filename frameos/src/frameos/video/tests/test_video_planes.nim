## Videos on display planes (video/planes.nim, docs/video.md "Planes"): the
## geometry, the frames' layout, the colour, ffmpeg's arguments and the DRM
## ioctls (pure), and a player whose frames go to a plane, against a real
## ffmpeg and planes in memory (`setPlaneSinkForTest`): no /dev/dri here.

import std/[os, osproc, strutils, unittest]
import pixie
import ../player

let dir = getTempDir() / "frameos-video-planes-" & $getCurrentProcessId()
createDir(dir)
let clip = dir / "clip.mp4"
let haveFfmpeg = findExe("ffmpeg").len > 0 and findExe("ffprobe").len > 0

if haveFfmpeg:
  # Two seconds at 10 frames a second, 320x180: red for the first, blue after.
  let made = execCmdEx("ffmpeg -hide_banner -loglevel error -y -f lavfi -i color=c=red:size=320x180:rate=10:duration=1 " &
    "-f lavfi -i color=c=blue:size=320x180:rate=10:duration=1 -filter_complex \"[0:v][1:v]concat=n=2:v=1[v]\" " &
    "-map \"[v]\" -pix_fmt yuv420p -c:v mpeg4 " & quoteShell(clip))
  doAssert made.exitCode == 0, made.output

import ./plane_sink

proc playOnPlane(player: VideoPlayer, seconds: float, spot: VideoPlaneSpot, allowed = true,
    stopWhen: proc(p: VideoPlayer): bool = nil, width = 200, height = 100) =
  ## Renders as the runner would: a take where the video is drawn, then the
  ## pass settled (runner.nim settlePlanes), again when the player asks.
  let deadline = nowSeconds() + seconds
  while nowSeconds() < deadline:
    discard player.take(width, height, vfContain, nil, spot)
    settlePlanes(allowed)
    if not stopWhen.isNil and stopWhen(player):
      return
    let wait = player.nextFrameIn()
    sleep(int(clamp(if wait < 0: 0.05 else: wait, 0.01, 0.2) * 1000))

proc blue(image: Image): bool =
  let c = image[image.width div 2, image.height div 2].rgba
  c.b > 200 and c.r < 60

proc red(image: Image): bool =
  let c = image[image.width div 2, image.height div 2].rgba
  c.r > 200 and c.b < 60

# ------------------------------------------------------------- the tests

suite "video planes":
  test "where a picture goes on the plane, by fit":
    # Contain: the picture's own size (args.frameSize) in the box's middle.
    let contain = planeRect(10, 20, 200, 100, ord(vfContain), 178, 100, 320, 180)
    check contain.x == 21 and contain.y == 20 and contain.w == 178 and contain.h == 100
    check contain.srcX == 0 and contain.srcW == 320 and contain.srcH == 180
    # Cover: the whole box, the frame's middle cropped to its shape.
    let cover = planeRect(0, 0, 720, 720, ord(vfCover), 720, 720, 1920, 1080)
    check cover.w == 720 and cover.h == 720
    check abs(cover.srcW - 1080) < 0.01 and abs(cover.srcH - 1080) < 0.01
    check abs(cover.srcX - 420) < 0.01 and cover.srcY == 0
    # Fill: the whole frame on the whole box.
    let fill = planeRect(5, 5, 100, 50, ord(vfFill), 100, 50, 640, 360)
    check fill.x == 5 and fill.w == 100 and fill.srcW == 640 and fill.srcH == 360
    check contain.fits(720, 720)
    check not planeRect(700, 0, 100, 100, ord(vfFill), 100, 100, 64, 64).fits(720, 720) # past the edge

  test "a plane is cut to the canvas its video is drawn in, its source in proportion":
    # A 200x100 picture at (-50, 10) in a window at (0, 0) of 120x200: its left
    # quarter and the part right of the window go, the source the same share.
    let r = PlaneRect(x: -50, y: 10, w: 200, h: 100, srcW: 400, srcH: 200).clipped(0, 0, 120, 200)
    check r.x == 0 and r.y == 10 and r.w == 120 and r.h == 100
    check abs(r.srcX - 100) < 0.01 and abs(r.srcW - 240) < 0.01 and r.srcH == 200
    check PlaneRect(x: 300, y: 0, w: 50, h: 50, srcW: 50, srcH: 50).clipped(0, 0, 200, 200).w == 0
    let inside = PlaneRect(x: 10, y: 10, w: 20, h: 20, srcW: 64, srcH: 64)
    check inside.clipped(0, 0, 720, 720) == inside
    check overlaps(0, 0, 10, 10, 9, 9, 5, 5)
    check not overlaps(0, 0, 10, 10, 10, 0, 5, 5) # touching is not covering

  test "an <img>'s box on the panel: its canvas's corner, render scale":
    # Laid out at (10, 12) 100x56 in a window at (120, 20) of 180x120.
    let r = holeOnPanel(10, 12, 100, 56, 1, 120, 20, 180, 120)
    check r.ok and r.x == 130 and r.y == 32 and r.w == 100 and r.h == 56
    # Render scale 2: laid out at half, drawn twice the size.
    let big = holeOnPanel(10, 12, 100, 56, 2, 0, 0, 720, 720)
    check big.ok and big.x == 20 and big.y == 24 and big.w == 200 and big.h == 112
    # Past its canvas (a window's): no plane.
    check not holeOnPanel(150, 12, 100, 56, 1, 120, 20, 180, 120).ok
    check not holeOnPanel(-1, 0, 10, 10, 1, 0, 0, 720, 720).ok

  test "settled around the push: off before it unless claimed, kept and unmoved; on after it":
    useSink()
    var owner = 1
    let plane = acquirePlane(addr owner)
    check plane >= 0
    let here = PlaneRect(x: 10, y: 10, w: 100, h: 56, srcW: 320, srcH: 180)
    claimPlane(plane, here)
    settlePlanes(true)
    var onGlass = false
    check presentPlane(plane, addr owner, 7, onGlass)
    # A pass that claims it where it is: it stays up through the push.
    claimPlane(plane, here)
    settlePlanesBefore(true)
    check hidesSoFar() == 0
    settlePlanesAfter()
    # A pass that does not claim it (covered, another scene): off before the push.
    settlePlanesBefore(true)
    check hidesSoFar() == 1
    check not presentPlane(plane, addr owner, 7, onGlass) # held meanwhile
    settlePlanesAfter()
    check not presentPlane(plane, addr owner, 7, onGlass)
    # Claimed again: up after the push.
    claimPlane(plane, here)
    settlePlanes(true)
    check presentPlane(plane, addr owner, 7, onGlass)
    # Claimed somewhere else (a window moved): off before the push, up after.
    claimPlane(plane, PlaneRect(x: 40, y: 10, w: 100, h: 56, srcW: 320, srcH: 180))
    settlePlanesBefore(true)
    check hidesSoFar() == 2
    settlePlanesAfter()
    check presentPlane(plane, addr owner, 7, onGlass)
    # Something over the scene on the panel (a presence code): off.
    claimPlane(plane, PlaneRect(x: 40, y: 10, w: 100, h: 56, srcW: 320, srcH: 180))
    settlePlanesBefore(false)
    settlePlanesAfter()
    check not presentPlane(plane, addr owner, 7, onGlass)
    releasePlane(plane)

  test "the mouse cursor on a plane takes it off, and keeps a video there in the canvas":
    useSink()
    var owner = 1
    let plane = acquirePlane(addr owner)
    let here = PlaneRect(x: 100, y: 100, w: 200, h: 100, srcW: 320, srcH: 180)
    claimPlane(plane, here)
    settlePlanes(true)
    var onGlass = false
    check presentPlane(plane, addr owner, 7, onGlass)
    # Away from it: nothing.
    check not planesCursor(true, 10, 10, 12, 19)
    check not cursorOver(100, 100, 200, 100)
    # Onto it: off now, so the cursor (in /dev/fb0, under it) shows.
    check planesCursor(true, 150, 150, 12, 19)
    check hidesSoFar() == 1
    check cursorOver(100, 100, 200, 100)
    # A pass that claims it while the cursor is there keeps it off.
    claimPlane(plane, here)
    settlePlanes(true)
    check not presentPlane(plane, addr owner, 7, onGlass)
    # The cursor goes: the next pass shows it again.
    discard planesCursor(false, 0, 0, 0, 0)
    claimPlane(plane, here)
    settlePlanes(true)
    check presentPlane(plane, addr owner, 7, onGlass)
    releasePlane(plane)

  test "a frame's YUV420 in one block, and what ffmpeg is told":
    check yuv420Bytes(320, 180) == 320 * 180 * 3 div 2
    check yuv420Bytes(5, 3) == 15 + 2 * 3 * 2 # odd: the chroma rounds up
    let (size, u, v, cp) = yuv420Layout(320, 180, 384)
    check u == 384 * 180 and cp == 192 and v == u + 192 * 90 and size == v + 192 * 90
    check planeFrameSize(1920, 1080) == (1920, 1080)
    check planeFrameSize(853, 481) == (852, 480)
    let args = decodeArgs(VideoSource(input: "/a.mp4"), 720, 720, vfContain, vpRgb565, 0, 30, loopFile = true,
      threads = 0, srcWidth = 1920, srcHeight = 1080, plane = true)
    check args[args.find("-vf") + 1] == "fps=30,setsar=1" # no scaler: the display scales it
    check args[args.find("-pix_fmt") + 1] == "yuv420p"
    let odd = decodeArgs(VideoSource(input: "/a.mp4"), 720, 720, vfContain, vpRgb565, 0, 30, loopFile = true,
      threads = 0, srcWidth = 853, srcHeight = 481, plane = true)
    check odd[odd.find("-vf") + 1] == "fps=30,scale=852:480:flags=neighbor,setsar=1"

  test "YUV to RGB, BT.601 limited range, and a frame into the canvas":
    check yuvToRgb(16, 128, 128) == (0, 0, 0)
    check yuvToRgb(235, 128, 128) == (255, 255, 255)
    let (r, g, b) = yuvToRgb(81, 90, 240) # ffmpeg's red
    check r > 240 and g < 15 and b < 15
    # A 4x2 frame: its left half Y 81/U 90/V 240 (red), its right Y 41/U 240/V 110 (blue).
    let (size, u, v, cp) = yuv420Layout(4, 2, 4)
    let mem = cast[ptr UncheckedArray[byte]](allocShared0(size))
    for row in 0 ..< 2:
      for col in 0 ..< 4:
        mem[row * 4 + col] = (if col < 2: 81'u8 else: 41'u8)
    mem[u] = 90; mem[u + 1] = 240
    mem[v] = 240; mem[v + 1] = 110
    discard cp
    let buf = PlaneBuffer(id: 1, map: mem, size: size, width: 4, height: 2, pitch: 4, uOffset: u, vOffset: v)
    let image = newImage565(8, 4)
    yuvInto(image, 0, 0, 8, 4, buf, 0, 0, 4, 2)
    check image[1, 1].rgba.r > 200 and image[1, 1].rgba.b < 60
    check image[6, 2].rgba.b > 200 and image[6, 2].rgba.r < 60
    deallocShared(mem)

  when defined(linux):
    const haveDrmHeaders = staticExec("test -f /usr/include/drm/drm.h && echo yes").strip() == "yes"
    when haveDrmHeaders:
      test "the DRM ioctls are the kernel's":
        var
          kVersion {.importc: "DRM_IOCTL_VERSION", header: "<drm/drm.h>", nodecl.}: culong
          kSetMaster {.importc: "DRM_IOCTL_SET_MASTER", header: "<drm/drm.h>", nodecl.}: culong
          kClientCap {.importc: "DRM_IOCTL_SET_CLIENT_CAP", header: "<drm/drm.h>", nodecl.}: culong
          kResources {.importc: "DRM_IOCTL_MODE_GETRESOURCES", header: "<drm/drm.h>", nodecl.}: culong
          kCrtc {.importc: "DRM_IOCTL_MODE_GETCRTC", header: "<drm/drm.h>", nodecl.}: culong
          kProperty {.importc: "DRM_IOCTL_MODE_GETPROPERTY", header: "<drm/drm.h>", nodecl.}: culong
          kRmFb {.importc: "DRM_IOCTL_MODE_RMFB", header: "<drm/drm.h>", nodecl.}: culong
          kCreateDumb {.importc: "DRM_IOCTL_MODE_CREATE_DUMB", header: "<drm/drm.h>", nodecl.}: culong
          kMapDumb {.importc: "DRM_IOCTL_MODE_MAP_DUMB", header: "<drm/drm.h>", nodecl.}: culong
          kDestroyDumb {.importc: "DRM_IOCTL_MODE_DESTROY_DUMB", header: "<drm/drm.h>", nodecl.}: culong
          kPlaneRes {.importc: "DRM_IOCTL_MODE_GETPLANERESOURCES", header: "<drm/drm.h>", nodecl.}: culong
          kGetPlane {.importc: "DRM_IOCTL_MODE_GETPLANE", header: "<drm/drm.h>", nodecl.}: culong
          kSetPlane {.importc: "DRM_IOCTL_MODE_SETPLANE", header: "<drm/drm.h>", nodecl.}: culong
          kAddFb2 {.importc: "DRM_IOCTL_MODE_ADDFB2", header: "<drm/drm.h>", nodecl.}: culong
          kObjProps {.importc: "DRM_IOCTL_MODE_OBJ_GETPROPERTIES", header: "<drm/drm.h>", nodecl.}: culong
          kSetProp {.importc: "DRM_IOCTL_MODE_OBJ_SETPROPERTY", header: "<drm/drm.h>", nodecl.}: culong
          kGetEncoder {.importc: "DRM_IOCTL_MODE_GETENCODER", header: "<drm/drm.h>", nodecl.}: culong
        check DrmIoctlVersion == kVersion
        check DrmIoctlSetMaster == kSetMaster
        check DrmIoctlSetClientCap == kClientCap
        check DrmIoctlModeGetResources == kResources
        check DrmIoctlModeGetCrtc == kCrtc
        check DrmIoctlModeGetProperty == kProperty
        check DrmIoctlModeRmFb == kRmFb
        check DrmIoctlModeCreateDumb == kCreateDumb
        check DrmIoctlModeMapDumb == kMapDumb
        check DrmIoctlModeDestroyDumb == kDestroyDumb
        check DrmIoctlModeGetPlaneResources == kPlaneRes
        check DrmIoctlModeGetPlane == kGetPlane
        check DrmIoctlModeSetPlane == kSetPlane
        check DrmIoctlModeAddFb2 == kAddFb2
        check DrmIoctlModeObjGetProperties == kObjProps
        check DrmIoctlModeObjSetProperty == kSetProp
        check DrmIoctlModeGetEncoder == kGetEncoder

  test "no device: no planes, and a player keeps the canvas":
    setPlaneSinkForTest(PlaneSink())
    putEnv("FRAMEOS_VIDEO_PLANES", "0")
    defer: delEnv("FRAMEOS_VIDEO_PLANES")
    check not planesReady(720, 720)
    check planesWhyNot() == "FRAMEOS_VIDEO_PLANES=0"
    check acquirePlane(nil) == -1

  test "a video on a plane: each frame shown when due, a copy in the canvas once a second, ended there":
    if not haveFfmpeg:
      skip()
    else:
      useSink()
      let player = newVideoPlayer(VideoSource(input: clip), "clip.mp4", loop = false, maxFps = 30, startAt = 0)
      let spot = VideoPlaneSpot(ok: true, x: 10, y: 20)
      var renders = 0
      let deadline = nowSeconds() + 30
      while nowSeconds() < deadline and player.state != "ended":
        discard player.take(200, 100, vfContain, nil, spot)
        settlePlanes(true)
        inc renders
        let wait = player.nextFrameIn()
        sleep(int(clamp(if wait < 0: 0.05 else: wait, 0.01, 1.0) * 1000))
      check player.state == "ended"
      let shows = showsSoFar()
      checkpoint "shows " & $shows & ", renders " & $renders
      check shows >= 15 and shows <= 21 # its 20 frames, each once (a late one may go)
      # Paced by its clock: two seconds of video, not as fast as ffmpeg makes them.
      let first = shownAt(0)
      let last = shownAt(-1)
      check last.at - first.at > 1.5
      # Not a render a frame: about one a second, and some at the start.
      check renders < shows
      # Where: the picture's own size in the box's middle, at its corner.
      check last.rect.x == 21 and last.rect.y == 20 and last.rect.w == 178 and last.rect.h == 100
      check last.rect.srcW == 320 and last.rect.srcH == 180
      # The canvas's copy, the last frame: blue, its bars black.
      check not player.image.isNil and player.image.width == 200 and player.image.height == 100
      check player.image.blue
      let bar = player.image[3, 50].rgba
      check bar.r < 20 and bar.g < 20 and bar.b < 20
      check player.status.time > 1.8
      player.close()
      check hidesSoFar() >= 1 # closed: off the glass

  test "a plane holds its frame while it may not show, and while paused":
    if not haveFfmpeg:
      skip()
    else:
      useSink()
      let player = newVideoPlayer(VideoSource(input: clip), "clip.mp4", loop = true, maxFps = 30, startAt = 0)
      let spot = VideoPlaneSpot(ok: true, x: 0, y: 0)
      player.playOnPlane(20, spot, stopWhen = proc(p: VideoPlayer): bool = showsSoFar() >= 3)
      check showsSoFar() >= 3
      # A pass that did not draw it (another scene, a code over the panel): off, and held.
      settlePlanes(false)
      check hidesSoFar() >= 1
      let held = showsSoFar()
      sleep(600)
      check showsSoFar() == held
      # Drawn again: it goes on.
      player.playOnPlane(20, spot, stopWhen = proc(p: VideoPlayer): bool = showsSoFar() >= held + 3)
      check showsSoFar() >= held + 3
      # Paused: the frame stays, nothing more is shown.
      player.setPaused(true)
      discard player.take(200, 100, vfContain, nil, spot)
      settlePlanes(true)
      let paused = showsSoFar()
      sleep(600)
      check showsSoFar() <= paused + 1
      check player.state == "paused"
      player.setPaused(false)
      player.playOnPlane(20, spot, stopWhen = proc(p: VideoPlayer): bool = showsSoFar() >= paused + 4)
      check showsSoFar() >= paused + 4
      player.close()

  test "back to the canvas: the plane's frame in it at once, then ffmpeg's":
    if not haveFfmpeg:
      skip()
    else:
      useSink()
      let player = newVideoPlayer(VideoSource(input: clip), "clip.mp4", loop = false, maxFps = 30, startAt = 0)
      let spot = VideoPlaneSpot(ok: true, x: 0, y: 0)
      # Into the blue second on the plane.
      player.playOnPlane(20, spot, stopWhen = proc(p: VideoPlayer): bool = p.status.time >= 1.3)
      let before = showsSoFar()
      check before >= 5
      # Something over it now: no spot. The image has the plane's frame
      # before ffmpeg's first for the canvas, and the plane goes after the pass.
      let changed = player.take(200, 100, vfContain, nil)
      check changed
      check player.image.blue
      let hid = hidesSoFar()
      settlePlanes(true)
      sleep(300)
      check hidesSoFar() >= hid + 1
      # The canvas plays it on, the plane no more.
      let deadline = nowSeconds() + 20
      while nowSeconds() < deadline and player.state != "ended":
        discard player.take(200, 100, vfContain, nil)
        settlePlanes(true)
        let wait = player.nextFrameIn()
        sleep(int(clamp(if wait < 0: 0.05 else: wait, 0.01, 0.2) * 1000))
      check player.state == "ended"
      check showsSoFar() <= before + 1
      check player.image.blue
      player.close()

  test "a plane the display would not show: the canvas draws the video":
    if not haveFfmpeg:
      skip()
    else:
      useSink(refusing = true)
      let player = newVideoPlayer(VideoSource(input: clip), "clip.mp4", loop = false, maxFps = 30, startAt = 0)
      let spot = VideoPlaneSpot(ok: true, x: 0, y: 0)
      player.playOnPlane(30, spot, stopWhen = proc(p: VideoPlayer): bool = not p.image.isNil and p.image.blue)
      check not player.image.isNil and player.image.blue
      check showsSoFar() == 0
      player.close()

  test "buffers whose rows are longer than the frame's take it a row at a time":
    if not haveFfmpeg:
      skip()
    else:
      useSink()
      pitchPad = 64
      defer: pitchPad = 0
      let player = newVideoPlayer(VideoSource(input: clip), "clip.mp4", loop = false, maxFps = 30, startAt = 0)
      let spot = VideoPlaneSpot(ok: true, x: 0, y: 0)
      player.playOnPlane(30, spot, stopWhen = proc(p: VideoPlayer): bool = p.state == "ended")
      check player.state == "ended"
      check player.image.blue
      check showsSoFar() >= 15
      player.close()

removeDir(dir)
