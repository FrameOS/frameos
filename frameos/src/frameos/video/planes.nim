## Videos on the display's own planes (docs/video.md "Planes").
##
## On a Raspberry Pi whose panel is a vc4 KMS output (a HyperPixel on DPI, an
## HDMI screen of a Pi 0 to 4), the display's scaler (the HVS) can show a YUV
## picture on an overlay plane over the console's framebuffer, scaled and
## converted to RGB as it scans out. A video whose `<img>` nothing covers is
## shown there: its frames go from ffmpeg straight into the plane's buffers,
## and the runtime neither scales, converts, renders nor pushes them.
##
## The UI stays where it was: the frameBuffer driver keeps writing
## `/dev/fb0`, which the kernel's fbdev emulation scans out on the CRTC's
## primary plane. This runtime opens the DRM device behind it and is its
## master (the fbdev emulation is none), and puts overlay planes on that CRTC.
## When the process ends the kernel restores the fbdev's picture and turns
## the planes off (its lastclose), so a crash leaves no video on the glass.
##
## Who does what:
## - the render thread probes the device (`planesReady`), takes a plane for a
##   player (`acquirePlane`) and says where it goes every render pass that
##   draws the video (`claimPlane`); after the pass is on the panel the runner
##   settles them (`settlePlanes`): a plane nobody claimed, or one under
##   something the panel shows over the scene (a presence code), goes off;
## - a player's reader thread makes its buffers (`newPlaneBuffer`) and shows
##   each frame when it is due (`presentPlane`).
##
## Everything the two share is plain values under `planesLock`; the device's
## ioctls are made under it too. Tests swap the device for one in memory
## (`setPlaneSinkForTest`), which records what would have been shown.

import std/[locks, math, os, strutils]

const
  MaxPlanes* = 4
    ## Overlay planes a runtime uses at most: a Camera wall's four.
  DrmFormatYuv420* = 0x32315559'u32 ## fourcc('Y', 'U', '1', '2'): three planes, 4:2:0
  DrmFormatNv12* = 0x3231564e'u32   ## fourcc('N', 'V', '1', '2'): Y, then U and V interleaved, 4:2:0

type
  PlaneRect* = object
    ## Where a picture goes on the CRTC (`x` .. `w`, in its pixels), and which
    ## part of the frame it shows (`srcX` .. `srcH`, in the frame's pixels).
    x*, y*, w*, h*: int
    srcX*, srcY*, srcW*, srcH*: float

  PlaneBuffer* = object
    ## One YUV420 frame's memory: `map` is where the reader writes it, `id` what
    ## `presentPlane` shows (a framebuffer id on a device).
    id*: uint32
    handle*: uint32
    map*: ptr UncheckedArray[byte]
    size*: int
    width*, height*: int ## the frame's
    pitch*: int          ## of the Y plane; the U and V planes' is half
    uOffset*, vOffset*: int
    interleaved*: bool   ## NV12: U and V in pairs from `uOffset`, rows of `pitch`
    imported*: bool      ## another device's memory (importPlaneBuffer), `dmabuf` its own
    dmabuf*: cint

  ImportLayout* = object
    ## A decoder's frame as AddFB2 takes it (importLayout).
    ok*: bool
    fourcc*: uint32      ## DRM's, which is V4L2's for these two
    width*, height*: int ## the framebuffer's: the picture's corner to its far edge, made even
    planes*: int
    pitches*, offsets*: array[3, int]
    size*: int           ## the buffer's bytes

  PlaneSink* = object
    ## The device, or a test's stand-in. Plain procs: no closure, nothing a
    ## thread holds of another's.
    newBuffer*: proc (width, height: int, buffer: var PlaneBuffer): bool {.nimcall, gcsafe, raises: [].}
    freeBuffer*: proc (buffer: PlaneBuffer) {.nimcall, gcsafe, raises: [].}
    show*: proc (plane: int, buffer: uint32, rect: PlaneRect): bool {.nimcall, gcsafe, raises: [].}
    hide*: proc (plane: int) {.nimcall, gcsafe, raises: [].}
    importBuffer*: proc (dmabuf: cint, layout: ImportLayout, buffer: var PlaneBuffer): bool {.nimcall, gcsafe,
      raises: [].}
      ## Another device's buffer (a decoder's frame, a dma-buf) as a framebuffer
      ## a plane shows, nothing copied; nil where there is none.
    freeImported*: proc (buffer: PlaneBuffer) {.nimcall, gcsafe, raises: [].}

  PlaneState = object
    used: bool        ## a player has it
    owner: pointer    ## ... which (its shared state): a closed player's reader shows nothing on it
    encoded: bool     ## its colour encoding is set for this player
    claimed: bool     ## a render pass said where, since the last settle
    allowed: bool     ## settled: it may be on the glass
    rect: PlaneRect   ## where, last said
    shownRect: PlaneRect
    buffer: uint32    ## what is on it, 0 for nothing
    keep: bool        ## settled before the push: it may show after it

var
  planesLock: Lock
  planesProbed: bool
  planesOk: bool
  planesWhy: array[200, char]
  planesWhyLen: int
  planeCount: int
  planeIds: array[MaxPlanes, uint32]
  planes: array[MaxPlanes, PlaneState]
  sink: PlaneSink
  sinkSet: bool
  modeWidth, modeHeight: int
  cursorShown: bool
  cursorX, cursorY, cursorW, cursorH: int ## the mouse cursor's box on the panel (planesCursor)
initLock(planesLock)

proc setWhy(text: string) =
  let n = min(text.len, planesWhy.len)
  for i in 0 ..< n:
    planesWhy[i] = text[i]
  planesWhyLen = n

proc planesWhyNot*(): string =
  ## Why videos are not on planes here ("" where they can be).
  {.cast(gcsafe).}:
    withLock planesLock:
      result = newString(planesWhyLen)
      for i in 0 ..< planesWhyLen:
        result[i] = planesWhy[i]

# ------------------------------------------------------------ pure parts

proc yuv420Layout*(width, height, pitch: int): tuple[size, uOffset, vOffset, chromaPitch: int] =
  ## A three-plane 4:2:0 frame in one block: Y rows of `pitch`, then U and V
  ## rows of half that (the chroma of an odd size rounds up).
  let
    ch = (height + 1) div 2
    cp = (pitch + 1) div 2
  (pitch * height + 2 * cp * ch, pitch * height, pitch * height + cp * ch, cp)

proc yuv420Bytes*(width, height: int): int =
  ## What ffmpeg writes for one `-pix_fmt yuv420p` frame: rows packed.
  width * height + 2 * ((width + 1) div 2) * ((height + 1) div 2)

proc planeRect*(boxX, boxY, boxW, boxH: int, fit: int, frameW, frameH, srcW, srcH: int): PlaneRect =
  ## Where a `srcW` x `srcH` frame goes for a box at (`boxX`, `boxY`) of
  ## `boxW` x `boxH` (the `<img>`'s, in panel pixels). `fit`: 0 cover, 1
  ## contain, 2 fill (VideoFit's order). Contain puts the picture's own size
  ## (`frameW` x `frameH`, args.frameSize) in the box's middle; cover fills
  ## the box with the frame's middle; fill stretches it.
  result.srcW = srcW.float
  result.srcH = srcH.float
  case fit
  of 1:
    result.x = boxX + (boxW - frameW) div 2
    result.y = boxY + (boxH - frameH) div 2
    result.w = frameW
    result.h = frameH
  of 0:
    result.x = boxX
    result.y = boxY
    result.w = boxW
    result.h = boxH
    if srcW > 0 and srcH > 0 and boxW > 0 and boxH > 0:
      let scale = max(boxW.float / srcW.float, boxH.float / srcH.float)
      result.srcW = min(boxW.float / scale, srcW.float)
      result.srcH = min(boxH.float / scale, srcH.float)
      result.srcX = (srcW.float - result.srcW) / 2
      result.srcY = (srcH.float - result.srcH) / 2
  else:
    result.x = boxX
    result.y = boxY
    result.w = boxW
    result.h = boxH

proc clipped*(rect: PlaneRect, x, y, w, h: int): PlaneRect =
  ## `rect` cut to the `w` x `h` rectangle at (`x`, `y`) (the canvas it is
  ## drawn in: a window's, the panel's), its source cut in proportion, so a
  ## plane never shows outside what its video was drawn in. Empty (`w` 0)
  ## when nothing of it is inside.
  if rect.w <= 0 or rect.h <= 0:
    return PlaneRect()
  let
    x0 = max(rect.x, x)
    y0 = max(rect.y, y)
    x1 = min(rect.x + rect.w, x + w)
    y1 = min(rect.y + rect.h, y + h)
  if x1 <= x0 or y1 <= y0:
    return PlaneRect()
  let
    sx = rect.srcW / rect.w.float
    sy = rect.srcH / rect.h.float
  PlaneRect(x: x0, y: y0, w: x1 - x0, h: y1 - y0,
    srcX: rect.srcX + float(x0 - rect.x) * sx, srcY: rect.srcY + float(y0 - rect.y) * sy,
    srcW: float(x1 - x0) * sx, srcH: float(y1 - y0) * sy)

proc overlaps*(ax, ay, aw, ah, bx, by, bw, bh: int): bool =
  ## Two rectangles share a pixel.
  aw > 0 and ah > 0 and bw > 0 and bh > 0 and ax < bx + bw and bx < ax + aw and ay < by + bh and by < ay + ah

proc holeOnPanel*(x, y, w, h: float32, scale: float32, viewX, viewY, viewW, viewH: int):
    tuple[ok: bool, x, y, w, h: int] =
  ## An `<img>`'s box laid out in a UI's pixels (`x` .. `h`) on the panel: the
  ## UI drawn `scale` times bigger (render scale, `regionScale`) into a canvas
  ## of `viewW` x `viewH` whose corner is at (`viewX`, `viewY`) on the panel (a
  ## layout's hole, a window). Not ok when any of it is outside that canvas.
  let
    left = int(round(x * scale))
    top = int(round(y * scale))
    right = int(round((x + w) * scale))
    bottom = int(round((y + h) * scale))
  if left < 0 or top < 0 or right > viewW or bottom > viewH or right <= left or bottom <= top:
    return
  (true, viewX + left, viewY + top, right - left, bottom - top)

proc fits*(rect: PlaneRect, width, height: int): bool =
  ## Inside a `width` x `height` mode, and something to show.
  rect.w > 0 and rect.h > 0 and rect.x >= 0 and rect.y >= 0 and rect.x + rect.w <= width and
    rect.y + rect.h <= height and rect.srcW >= 1 and rect.srcH >= 1

proc importLayout*(fourcc: uint32, codedWidth, codedHeight, bytesperline, sizeimage: int,
    visible: tuple[x, y, width, height: int]): ImportLayout =
  ## A V4L2 decoder's frame (one buffer: `codedWidth` x `codedHeight`, rows
  ## of `bytesperline`, `sizeimage` bytes) as a framebuffer, nothing copied.
  ## NV12: the Y rows for the coded height (1088 for 1080p), then U and V
  ## interleaved in rows as long, half as many. YU12: Y, then U and V each in
  ## rows half as long. The framebuffer ends where the `visible` picture does
  ## (1920x1080 of 1920x1088), so a source rectangle can never show the
  ## padding; a picture whose corner is not the buffer's is reached by
  ## `atVisible`. Not ok for another format or a buffer smaller than it says.
  let bpl = bytesperline
  let rows = codedHeight
  let chromaRows = (rows + 1) div 2
  var need = 0
  case fourcc
  of DrmFormatNv12:
    result.planes = 2
    result.pitches = [bpl, bpl, 0]
    result.offsets = [0, bpl * rows, 0]
    need = bpl * rows + bpl * chromaRows
  of DrmFormatYuv420:
    let c = bpl div 2
    result.planes = 3
    result.pitches = [bpl, c, c]
    result.offsets = [0, bpl * rows, bpl * rows + c * chromaRows]
    need = bpl * rows + 2 * c * chromaRows
  else:
    return
  result.fourcc = fourcc
  result.size = sizeimage
  let right = min(visible.x + visible.width, codedWidth)
  let bottom = min(visible.y + visible.height, codedHeight)
  result.width = right - right mod 2
  result.height = bottom - bottom mod 2
  result.ok = bpl >= codedWidth and codedWidth > 0 and rows > 0 and need <= sizeimage and
    visible.x >= 0 and visible.y >= 0 and result.width - visible.x >= 2 and result.height - visible.y >= 2

proc atVisible*(rect: PlaneRect, x, y: int): PlaneRect =
  ## `rect`'s source (in the picture, as planeRect and clipped had it) in a
  ## decoder's frame whose picture starts at (`x`, `y`).
  result = rect
  result.srcX = rect.srcX + x.float
  result.srcY = rect.srcY + y.float

type PlaneHold* = object
  ## A decoder's frames on their way to a plane (video/player.nim's
  ## zero-copy launch): the one on the glass and the one waiting for its
  ## time, by the decoder's buffer index, -1 for none. Each goes back to the
  ## decoder only once the plane has moved off it.
  shown*: int
  waiting*: int

proc initPlaneHold*(): PlaneHold = PlaneHold(shown: -1, waiting: -1)

proc wait*(hold: var PlaneHold, index: int): int =
  ## A decoded frame waits for its time: the one that waited before, never
  ## shown (late), goes back now; -1 for none.
  result = hold.waiting
  hold.waiting = index

proc flipped*(hold: var PlaneHold): int =
  ## The waiting frame is on the glass (its flip done): the one it replaced
  ## goes back now; -1 for none.
  result = hold.shown
  hold.shown = hold.waiting
  hold.waiting = -1

proc drop*(hold: var PlaneHold): int =
  ## The waiting frame goes back unseen (late, or the launch ends); -1 for none.
  result = hold.waiting
  hold.waiting = -1

type PlaneStep* = enum
  psWait   ## not due yet
  psShow   ## on the glass now
  psResync ## ... and the clock starts again at it: it is `resync` seconds behind
  psDrop   ## back to the decoder unseen: it is a frame late and a newer one is decoded

proc planeStep*(due, now, frameTime, resync: float, newerReady: bool): PlaneStep =
  ## What the presenter does with the frame waiting for its time `due`
  ## (monotonic seconds). A late frame is shown, unless the decoder has a
  ## newer one already (it is ahead: nothing is lost). Behind by `resync`
  ## seconds, the clock comes to the frames.
  let late = now - due
  if late < -0.003: psWait
  elif late > frameTime and newerReady: psDrop
  elif late > resync: psResync
  else: psShow

proc yuvToRgb*(y, u, v: int): tuple[r, g, b: int] =
  ## BT.601, limited range: what a decoder makes of SD and most HD video
  ## without a colour description. Integer, as the panel's 565 needs no more.
  let
    c = 298 * (y - 16)
    d = u - 128
    e = v - 128
  (clamp((c + 409 * e + 128) shr 8, 0, 255),
   clamp((c - 100 * d - 208 * e + 128) shr 8, 0, 255),
   clamp((c + 516 * d + 128) shr 8, 0, 255))

# ------------------------------------------------------------- the device

when defined(linux):
  import std/posix

  type
    DrmVersion {.pure.} = object
      major, minor, patch: cint
      nameLen: csize_t
      name: cstring
      dateLen: csize_t
      date: cstring
      descLen: csize_t
      desc: cstring
    DrmClientCap {.pure.} = object
      capability, value: uint64
    DrmCardRes {.pure.} = object
      fbIdPtr, crtcIdPtr, connectorIdPtr, encoderIdPtr: uint64
      countFbs, countCrtcs, countConnectors, countEncoders: uint32
      minWidth, maxWidth, minHeight, maxHeight: uint32
    DrmModeInfo {.pure.} = object
      clock: uint32
      hdisplay, hsyncStart, hsyncEnd, htotal, hskew: uint16
      vdisplay, vsyncStart, vsyncEnd, vtotal, vscan: uint16
      vrefresh, flags, kind: uint32
      name: array[32, char]
    DrmCrtc {.pure.} = object
      setConnectorsPtr: uint64
      countConnectors, crtcId, fbId, x, y, gammaSize, modeValid: uint32
      mode: DrmModeInfo
    DrmPlaneRes {.pure.} = object
      planeIdPtr: uint64
      countPlanes: uint32
    DrmGetPlane {.pure.} = object
      planeId, crtcId, fbId, possibleCrtcs, gammaSize, countFormatTypes: uint32
      formatTypePtr: uint64
    DrmSetPlane {.pure.} = object
      planeId, crtcId, fbId, flags: uint32
      crtcX, crtcY: int32
      crtcW, crtcH: uint32
      srcX, srcY, srcH, srcW: uint32 # the kernel's order: h before w
    DrmFbCmd2 {.pure.} = object
      fbId, width, height, pixelFormat, flags: uint32
      handles, pitches, offsets: array[4, uint32]
      modifier: array[4, uint64]
    DrmObjProps {.pure.} = object
      propsPtr, propValuesPtr: uint64
      countProps, objId, objType: uint32
    DrmGetProperty {.pure.} = object
      valuesPtr, enumBlobPtr: uint64
      propId, flags: uint32
      name: array[32, char]
      countValues, countEnumBlobs: uint32
    DrmPropertyEnum {.pure.} = object
      value: uint64
      name: array[32, char]
    DrmSetProperty {.pure.} = object
      value: uint64
      propId, objId, objType: uint32
    DrmCreateDumb {.pure.} = object
      height, width, bpp, flags, handle, pitch: uint32
      size: uint64
    DrmMapDumb {.pure.} = object
      handle, pad: uint32
      offset: uint64
    DrmDestroyDumb {.pure.} = object
      handle: uint32
    DrmGetEncoder {.pure.} = object
      encoderId, encoderType, crtcId, possibleCrtcs, possibleClones: uint32
    DrmPrimeHandle {.pure.} = object
      handle, flags: uint32
      fd: int32
    DrmGemClose {.pure.} = object
      handle, pad: uint32

  const
    IocNone = 0
    IocWrite = 1
    IocRead = 2
    DrmObjectPlane = 0xeeeeeeee'u32
    DrmClientCapUniversalPlanes = 2'u64
    DrmModeEncoderDpi = 8'u32

  func drmIoc(dir, nr, size: int): culong =
    culong((dir shl 30) or (size shl 16) or (ord('d') shl 8) or nr)

  const
    DrmIoctlVersion* = drmIoc(IocRead or IocWrite, 0x00, sizeof(DrmVersion))
    DrmIoctlSetClientCap* = drmIoc(IocWrite, 0x0d, sizeof(DrmClientCap))
    DrmIoctlSetMaster* = drmIoc(IocNone, 0x1e, 0)
    DrmIoctlModeGetResources* = drmIoc(IocRead or IocWrite, 0xA0, sizeof(DrmCardRes))
    DrmIoctlModeGetCrtc* = drmIoc(IocRead or IocWrite, 0xA1, sizeof(DrmCrtc))
    DrmIoctlModeGetEncoder* = drmIoc(IocRead or IocWrite, 0xA6, sizeof(DrmGetEncoder))
    DrmIoctlPrimeFdToHandle* = drmIoc(IocRead or IocWrite, 0x2e, sizeof(DrmPrimeHandle))
    DrmIoctlGemClose* = drmIoc(IocWrite, 0x09, sizeof(DrmGemClose))
    DrmIoctlModeGetProperty* = drmIoc(IocRead or IocWrite, 0xAA, sizeof(DrmGetProperty))
    DrmIoctlModeRmFb* = drmIoc(IocRead or IocWrite, 0xAF, sizeof(cuint))
    DrmIoctlModeCreateDumb* = drmIoc(IocRead or IocWrite, 0xB2, sizeof(DrmCreateDumb))
    DrmIoctlModeMapDumb* = drmIoc(IocRead or IocWrite, 0xB3, sizeof(DrmMapDumb))
    DrmIoctlModeDestroyDumb* = drmIoc(IocRead or IocWrite, 0xB4, sizeof(DrmDestroyDumb))
    DrmIoctlModeGetPlaneResources* = drmIoc(IocRead or IocWrite, 0xB5, sizeof(DrmPlaneRes))
    DrmIoctlModeGetPlane* = drmIoc(IocRead or IocWrite, 0xB6, sizeof(DrmGetPlane))
    DrmIoctlModeSetPlane* = drmIoc(IocRead or IocWrite, 0xB7, sizeof(DrmSetPlane))
    DrmIoctlModeAddFb2* = drmIoc(IocRead or IocWrite, 0xB8, sizeof(DrmFbCmd2))
    DrmIoctlModeObjGetProperties* = drmIoc(IocRead or IocWrite, 0xB9, sizeof(DrmObjProps))
    DrmIoctlModeObjSetProperty* = drmIoc(IocRead or IocWrite, 0xBA, sizeof(DrmSetProperty))

  proc c_ioctl(fd: cint, request: culong): cint {.importc: "ioctl", header: "<sys/ioctl.h>", varargs.}

  proc drm(fd: cint, request: culong, arg: pointer): bool {.raises: [].} =
    ## One ioctl, again while a signal interrupts it.
    while true:
      if c_ioctl(fd, request, arg) == 0:
        return true
      let err = errno
      if err != EINTR and err != EAGAIN:
        return false

  var drmFd: cint = -1
  var crtcId: uint32

  proc cardDriver(fd: cint): string =
    var name: array[64, char]
    var v = DrmVersion(nameLen: csize_t(name.len - 1), name: cast[cstring](addr name[0]))
    if not drm(fd, DrmIoctlVersion, addr v):
      return ""
    $cast[cstring](addr name[0])

  proc propertyName(fd: cint, id: uint32): string =
    var p = DrmGetProperty(propId: id)
    if not drm(fd, DrmIoctlModeGetProperty, addr p):
      return ""
    $cast[cstring](addr p.name[0])

  proc planeProperty(fd: cint, plane: uint32, wanted: string, value: var uint64, id: var uint32): bool =
    ## A plane's property by name: its id and value.
    var q = DrmObjProps(objId: plane, objType: DrmObjectPlane)
    if not drm(fd, DrmIoctlModeObjGetProperties, addr q) or q.countProps == 0:
      return false
    var ids = newSeq[uint32](q.countProps)
    var values = newSeq[uint64](q.countProps)
    q.propsPtr = cast[uint64](addr ids[0])
    q.propValuesPtr = cast[uint64](addr values[0])
    if not drm(fd, DrmIoctlModeObjGetProperties, addr q):
      return false
    for i in 0 ..< min(int(q.countProps), ids.len):
      if propertyName(fd, ids[i]) == wanted:
        value = values[i]
        id = ids[i]
        return true

  proc enumValue(fd: cint, prop: uint32, wanted: string, value: var uint64): bool =
    ## An enum property's value called `wanted` ("ITU-R BT.709 YCbCr").
    var p = DrmGetProperty(propId: prop)
    if not drm(fd, DrmIoctlModeGetProperty, addr p) or p.countEnumBlobs == 0:
      return false
    var enums = newSeq[DrmPropertyEnum](p.countEnumBlobs)
    var values = newSeq[uint64](max(int(p.countValues), 1))
    p.enumBlobPtr = cast[uint64](addr enums[0])
    p.valuesPtr = cast[uint64](addr values[0])
    if not drm(fd, DrmIoctlModeGetProperty, addr p):
      return false
    for e in enums:
      if $cast[cstring](unsafeAddr e.name[0]) == wanted:
        value = e.value
        return true

  proc probeDevice(width, height: int): string =
    ## Opens the vc4 DRM device behind /dev/fb0 as its master and finds the
    ## CRTC the fbdev emulation drives and its overlay planes that take
    ## YUV420. "" when all is there, else why not. Under planesLock.
    let fbName = try: readFile("/sys/class/graphics/fb0/name").strip() except CatchableError: ""
    if fbName != "vc4drmfb":
      return "the panel is not a vc4 KMS output (/dev/fb0 is " & (if fbName.len > 0: fbName else: "missing") & ")"
    var fd: cint = -1
    for path in ["/dev/dri/card0", "/dev/dri/card1", "/dev/dri/card2", "/dev/dri/card3"]:
      let f = posix.open(path.cstring, O_RDWR or O_CLOEXEC)
      if f < 0:
        continue
      if cardDriver(f) == "vc4":
        fd = f
        break
      discard posix.close(f)
    if fd < 0:
      return "no vc4 DRM device"
    # The first to open it is its master; ask to be sure (another program
    # that drives the display, a desktop, has it).
    if not drm(fd, DrmIoctlSetMaster, nil):
      discard posix.close(fd)
      return "another program drives the display (DRM master)"
    var cap = DrmClientCap(capability: DrmClientCapUniversalPlanes, value: 1)
    if not drm(fd, DrmIoctlSetClientCap, addr cap):
      discard posix.close(fd)
      return "the DRM device lists no planes (universal planes)"
    var res: DrmCardRes
    if not drm(fd, DrmIoctlModeGetResources, addr res) or res.countCrtcs == 0:
      discard posix.close(fd)
      return "no CRTC"
    var crtcs = newSeq[uint32](res.countCrtcs)
    var encoders = newSeq[uint32](max(int(res.countEncoders), 1))
    res = DrmCardRes(crtcIdPtr: cast[uint64](addr crtcs[0]), countCrtcs: uint32(crtcs.len),
      encoderIdPtr: cast[uint64](addr encoders[0]), countEncoders: res.countEncoders)
    if not drm(fd, DrmIoctlModeGetResources, addr res):
      discard posix.close(fd)
      return "no CRTC"
    var crtcIndex = -1
    for i, id in crtcs:
      var c = DrmCrtc(crtcId: id)
      if drm(fd, DrmIoctlModeGetCrtc, addr c) and c.modeValid != 0 and c.fbId != 0 and
          int(c.mode.hdisplay) == width and int(c.mode.vdisplay) == height:
        crtcIndex = i
        crtcId = id
        modeWidth = int(c.mode.hdisplay)
        modeHeight = int(c.mode.vdisplay)
        break
    if crtcIndex < 0:
      discard posix.close(fd)
      return "no CRTC shows a " & $width & "x" & $height & " picture"
    # Only a DPI panel (a HyperPixel): the one output whose planes were seen
    # right on the glass (2026-11-25). An HDMI screen, a 4K one, a DSI panel
    # keep the canvas until one is.
    var dpi = false
    for i in 0 ..< min(int(res.countEncoders), encoders.len):
      var e = DrmGetEncoder(encoderId: encoders[i])
      if drm(fd, DrmIoctlModeGetEncoder, addr e) and e.crtcId == crtcId and e.encoderType == DrmModeEncoderDpi:
        dpi = true
    if not dpi:
      discard posix.close(fd)
      return "the panel is not a DPI one (planes are verified there only)"
    var pr: DrmPlaneRes
    if not drm(fd, DrmIoctlModeGetPlaneResources, addr pr) or pr.countPlanes == 0:
      discard posix.close(fd)
      return "no planes"
    var ids = newSeq[uint32](pr.countPlanes)
    pr = DrmPlaneRes(planeIdPtr: cast[uint64](addr ids[0]), countPlanes: uint32(ids.len))
    if not drm(fd, DrmIoctlModeGetPlaneResources, addr pr):
      discard posix.close(fd)
      return "no planes"
    planeCount = 0
    for id in ids:
      if planeCount == MaxPlanes:
        break
      var p = DrmGetPlane(planeId: id)
      if not drm(fd, DrmIoctlModeGetPlane, addr p) or (p.possibleCrtcs and (1'u32 shl crtcIndex)) == 0 or
          p.countFormatTypes == 0:
        continue
      var formats = newSeq[uint32](p.countFormatTypes)
      p.formatTypePtr = cast[uint64](addr formats[0])
      if not drm(fd, DrmIoctlModeGetPlane, addr p) or DrmFormatYuv420 notin formats:
        continue
      var kind: uint64
      var kindId: uint32
      if not planeProperty(fd, id, "type", kind, kindId) or kind != 0: # 0: an overlay
        continue
      planeIds[planeCount] = id
      inc planeCount
    if planeCount == 0:
      discard posix.close(fd)
      return "no overlay plane takes YUV420 on that CRTC"
    drmFd = fd
    ""

  proc deviceNewBuffer(width, height: int, buffer: var PlaneBuffer): bool {.nimcall, gcsafe, raises: [].} =
    {.cast(gcsafe).}:
      let fd = drmFd
    if fd < 0 or width <= 0 or height <= 0:
      return false
    var create = DrmCreateDumb(width: uint32(width), height: uint32(height + (height + 1) div 2), bpp: 8)
    if not drm(fd, DrmIoctlModeCreateDumb, addr create):
      return false
    let (size, u, v, cp) = yuv420Layout(width, height, int(create.pitch))
    var map = DrmMapDumb(handle: create.handle)
    if int(create.size) < size or not drm(fd, DrmIoctlModeMapDumb, addr map):
      var d = DrmDestroyDumb(handle: create.handle)
      discard drm(fd, DrmIoctlModeDestroyDumb, addr d)
      return false
    let mem = mmap(nil, int(create.size), PROT_READ or PROT_WRITE, MAP_SHARED, fd, Off(map.offset))
    if mem == MAP_FAILED:
      var d = DrmDestroyDumb(handle: create.handle)
      discard drm(fd, DrmIoctlModeDestroyDumb, addr d)
      return false
    var fb = DrmFbCmd2(width: uint32(width), height: uint32(height), pixelFormat: DrmFormatYuv420)
    fb.handles = [create.handle, create.handle, create.handle, 0]
    fb.pitches = [create.pitch, uint32(cp), uint32(cp), 0]
    fb.offsets = [0'u32, uint32(u), uint32(v), 0]
    if not drm(fd, DrmIoctlModeAddFb2, addr fb):
      discard munmap(mem, int(create.size))
      var d = DrmDestroyDumb(handle: create.handle)
      discard drm(fd, DrmIoctlModeDestroyDumb, addr d)
      return false
    buffer = PlaneBuffer(id: fb.fbId, handle: create.handle, map: cast[ptr UncheckedArray[byte]](mem),
      size: int(create.size), width: width, height: height, pitch: int(create.pitch), uOffset: u, vOffset: v)
    true

  proc deviceFreeBuffer(buffer: PlaneBuffer) {.nimcall, gcsafe, raises: [].} =
    {.cast(gcsafe).}:
      let fd = drmFd
    if fd < 0:
      return
    # Removing a framebuffer a plane shows turns the plane off.
    var fbId = cuint(buffer.id)
    discard drm(fd, DrmIoctlModeRmFb, addr fbId)
    if not buffer.map.isNil:
      discard munmap(buffer.map, buffer.size)
    var d = DrmDestroyDumb(handle: buffer.handle)
    discard drm(fd, DrmIoctlModeDestroyDumb, addr d)

  proc deviceImport(dmabuf: cint, layout: ImportLayout, buffer: var PlaneBuffer): bool {.nimcall, gcsafe,
      raises: [].} =
    ## A dma-buf (a decoder's frame) as a framebuffer: its GEM handle in this
    ## device (PRIME), AddFB2 with the decoder's format, strides and offsets,
    ## and a read-only mapping for the canvas's copy (yuvInto).
    {.cast(gcsafe).}:
      let fd = drmFd
    if fd < 0 or dmabuf < 0 or not layout.ok:
      return false
    var prime = DrmPrimeHandle(fd: int32(dmabuf))
    if not drm(fd, DrmIoctlPrimeFdToHandle, addr prime):
      return false
    var fb = DrmFbCmd2(width: uint32(layout.width), height: uint32(layout.height), pixelFormat: layout.fourcc)
    for i in 0 ..< layout.planes:
      fb.handles[i] = prime.handle
      fb.pitches[i] = uint32(layout.pitches[i])
      fb.offsets[i] = uint32(layout.offsets[i])
    if not drm(fd, DrmIoctlModeAddFb2, addr fb):
      var c = DrmGemClose(handle: prime.handle)
      discard drm(fd, DrmIoctlGemClose, addr c)
      return false
    # Its own handle on the dma-buf (the decoder closes its own when it
    # closes, and a frame may stay on the glass past that: a seek's, a
    # pause's), and a mapping for the canvas's copy.
    let own = dup(dmabuf)
    let map = if own < 0: MAP_FAILED else: mmap(nil, layout.size, PROT_READ, MAP_SHARED, own, 0)
    buffer = PlaneBuffer(id: fb.fbId, handle: prime.handle, width: layout.width, height: layout.height,
      pitch: layout.pitches[0], uOffset: layout.offsets[1], vOffset: layout.offsets[2],
      interleaved: layout.fourcc == DrmFormatNv12, imported: true, dmabuf: own, size: layout.size,
      map: (if map == MAP_FAILED: nil else: cast[ptr UncheckedArray[byte]](map)))
    true

  proc deviceFreeImported(buffer: PlaneBuffer) {.nimcall, gcsafe, raises: [].} =
    {.cast(gcsafe).}:
      let fd = drmFd
    if fd < 0:
      return
    var fbId = cuint(buffer.id)
    discard drm(fd, DrmIoctlModeRmFb, addr fbId)
    if not buffer.map.isNil:
      discard munmap(buffer.map, buffer.size)
    if buffer.dmabuf >= 0:
      discard posix.close(buffer.dmabuf)
    var c = DrmGemClose(handle: buffer.handle)
    discard drm(fd, DrmIoctlGemClose, addr c)

  type DmaBufSync {.pure.} = object
    flags: uint64

  const
    DmaBufSyncRead = 1'u64
    DmaBufSyncEnd = 4'u64
    DmaBufIoctlSync* = culong((IocWrite shl 30) or (sizeof(DmaBufSync) shl 16) or (ord('b') shl 8) or 0)

  proc deviceSyncRead(dmabuf: cint, start: bool) =
    var sync = DmaBufSync(flags: DmaBufSyncRead or (if start: 0'u64 else: DmaBufSyncEnd))
    discard drm(dmabuf, DmaBufIoctlSync, addr sync)

  proc fixed(v: float): uint32 = uint32(max(v, 0.0) * 65536.0 + 0.5)

  proc deviceShow(plane: int, buffer: uint32, rect: PlaneRect): bool {.nimcall, gcsafe, raises: [].} =
    ## The legacy SetPlane: the kernel's atomic helper, which returns once the
    ## new buffer is on the glass (the vblank), so the one it replaced is free.
    {.cast(gcsafe).}:
      var s = DrmSetPlane(planeId: planeIds[plane], crtcId: crtcId, fbId: buffer,
        crtcX: int32(rect.x), crtcY: int32(rect.y), crtcW: uint32(rect.w), crtcH: uint32(rect.h),
        srcX: fixed(rect.srcX), srcY: fixed(rect.srcY), srcW: fixed(rect.srcW), srcH: fixed(rect.srcH))
      drm(drmFd, DrmIoctlModeSetPlane, addr s)

  proc deviceHide(plane: int) {.nimcall, gcsafe, raises: [].} =
    {.cast(gcsafe).}:
      var s = DrmSetPlane(planeId: planeIds[plane], crtcId: crtcId, fbId: 0)
      discard drm(drmFd, DrmIoctlModeSetPlane, addr s)

  proc setColorEncoding(plane: int, hd: bool) =
    ## BT.709 for HD, BT.601 else, limited range: what a decoder's output
    ## without a colour description is. Under planesLock.
    var value: uint64
    var id: uint32
    if planeProperty(drmFd, planeIds[plane], "COLOR_ENCODING", value, id):
      var wanted: uint64
      if enumValue(drmFd, id, if hd: "ITU-R BT.709 YCbCr" else: "ITU-R BT.601 YCbCr", wanted) and
          wanted != value:
        var s = DrmSetProperty(value: wanted, propId: id, objId: planeIds[plane], objType: DrmObjectPlane)
        discard drm(drmFd, DrmIoctlModeObjSetProperty, addr s)

proc planesReady*(width, height: int): bool =
  ## Whether videos can go on planes over a `width` x `height` panel. Probed
  ## once a runtime (render thread); FRAMEOS_VIDEO_PLANES=0 turns it off.
  {.cast(gcsafe).}:
    withLock planesLock:
      if planesProbed:
        return planesOk and (sinkSet or (modeWidth == width and modeHeight == height))
      planesProbed = true
      if sinkSet:
        planesOk = true
        return true
      if getEnv("FRAMEOS_VIDEO_PLANES") == "0":
        setWhy("FRAMEOS_VIDEO_PLANES=0")
        return false
      when defined(linux):
        let why = probeDevice(width, height)
        if why.len > 0:
          setWhy(why)
          return false
        sink = PlaneSink(newBuffer: deviceNewBuffer, freeBuffer: deviceFreeBuffer, show: deviceShow,
          hide: deviceHide, importBuffer: deviceImport, freeImported: deviceFreeImported)
        planesOk = true
        result = true
      else:
        setWhy("not Linux")

proc planesInUse*(): bool =
  {.cast(gcsafe).}:
    withLock planesLock:
      for i in 0 ..< MaxPlanes:
        if planes[i].used:
          return true

proc acquirePlane*(owner: pointer): int =
  ## A free plane for a player (`owner`: its shared state), -1 for none
  ## (render thread).
  {.cast(gcsafe).}:
    withLock planesLock:
      if not planesOk:
        return -1
      let count = if sinkSet: MaxPlanes else: planeCount
      for i in 0 ..< count:
        if not planes[i].used:
          planes[i] = PlaneState(used: true, owner: owner)
          return i
  -1

proc releasePlane*(plane: int) =
  ## The player is done with it: off the glass and free.
  if plane < 0 or plane >= MaxPlanes:
    return
  {.cast(gcsafe).}:
    withLock planesLock:
      if planes[plane].used and planes[plane].buffer != 0:
        sink.hide(plane)
      planes[plane] = PlaneState()

proc claimPlane*(plane: int, rect: PlaneRect, hd = false) =
  ## A render pass draws this player's video at `rect` (render thread).
  if plane < 0 or plane >= MaxPlanes:
    return
  {.cast(gcsafe).}:
    withLock planesLock:
      if planes[plane].used:
        planes[plane].claimed = true
        planes[plane].rect = rect
        when defined(linux):
          if not sinkSet and not planes[plane].encoded:
            setColorEncoding(plane, hd)
            planes[plane].encoded = true

proc underCursor(rect: PlaneRect): bool =
  ## Under planesLock.
  cursorShown and overlaps(rect.x, rect.y, rect.w, rect.h, cursorX, cursorY, cursorW, cursorH)

proc settlePlanesBefore*(allowed: bool) =
  ## Before a render pass goes to the panel (runner.nim): a plane no video
  ## claimed in it, every plane while the panel shows something over the
  ## scene (`allowed` false: a presence code, a QR, a colour correction a
  ## plane would not get), one under the mouse cursor and one that moved go
  ## off now, so no frame of a plane is ever on the glass over what the new
  ## picture puts there.
  {.cast(gcsafe).}:
    withLock planesLock:
      for i in 0 ..< MaxPlanes:
        template p: untyped = planes[i]
        if not p.used:
          continue
        p.keep = allowed and p.claimed and not underCursor(p.rect)
        p.claimed = false
        if not p.keep or (p.buffer != 0 and p.rect != p.shownRect):
          if p.buffer != 0:
            sink.hide(i)
            p.buffer = 0
          p.allowed = false

proc settlePlanesAfter*() =
  ## After the pass is on the panel: the planes kept may show again, where
  ## their videos were drawn (their readers put up the next frame).
  {.cast(gcsafe).}:
    withLock planesLock:
      for i in 0 ..< MaxPlanes:
        template p: untyped = planes[i]
        if p.used:
          p.allowed = p.keep
          p.keep = false

proc settlePlanes*(allowed: bool) =
  ## Both, for a pass with nothing to push between (tests).
  settlePlanesBefore(allowed)
  settlePlanesAfter()

proc planesCursor*(shown: bool, x, y, w, h: int): bool =
  ## Where the mouse cursor is on the panel (cursor_panel.nim draws it into
  ## /dev/fb0, under every plane): a plane under it goes off now, so the
  ## cursor never disappears behind a video. True when one did: its video
  ## goes to the canvas at the next render (js_video.nim videoSpots), which
  ## the caller asks for.
  {.cast(gcsafe).}:
    withLock planesLock:
      cursorShown = shown
      cursorX = x
      cursorY = y
      cursorW = w
      cursorH = h
      for i in 0 ..< MaxPlanes:
        template p: untyped = planes[i]
        if p.used and p.allowed and underCursor(p.rect):
          if p.buffer != 0:
            sink.hide(i)
            p.buffer = 0
          p.allowed = false
          result = true

proc cursorOver*(x, y, w, h: int): bool =
  ## The mouse cursor is on this rectangle of the panel (a video there stays
  ## in the canvas).
  {.cast(gcsafe).}:
    withLock planesLock:
      result = cursorShown and overlaps(x, y, w, h, cursorX, cursorY, cursorW, cursorH)

proc hidePlanes*() =
  ## Every video plane off now: the loading mark is going on the panel
  ## (loading_mark_panel.nim), which a plane would cover. Each comes back
  ## after the next pass that draws its video.
  {.cast(gcsafe).}:
    withLock planesLock:
      for i in 0 ..< MaxPlanes:
        if planes[i].used:
          if planes[i].buffer != 0:
            sink.hide(i)
            planes[i].buffer = 0
          planes[i].allowed = false
          planes[i].claimed = false

proc presentPlane*(plane: int, owner: pointer, buffer: uint32, onGlass: var bool): bool =
  ## The reader's frame on the glass now. False when it cannot be (the plane
  ## is not allowed there now, or the device said no); `onGlass` whether the
  ## plane may show at all, so a reader holds its frame while it may not.
  onGlass = false
  if plane < 0 or plane >= MaxPlanes:
    return false
  {.cast(gcsafe).}:
    withLock planesLock:
      template p: untyped = planes[plane]
      if not p.used or p.owner != owner or not p.allowed:
        return false
      onGlass = true
      if sink.show(plane, buffer, p.rect):
        p.buffer = buffer
        p.shownRect = p.rect
        return true

proc planeOnGlass*(plane: int, owner: pointer): bool =
  ## The player's plane shows its frame now (a paused video keeps it there).
  if plane < 0 or plane >= MaxPlanes:
    return false
  {.cast(gcsafe).}:
    withLock planesLock:
      result = planes[plane].used and planes[plane].owner == owner and planes[plane].allowed and
        planes[plane].buffer != 0

proc newPlaneBuffer*(width, height: int, buffer: var PlaneBuffer): bool =
  {.cast(gcsafe).}:
    var make: proc (width, height: int, buffer: var PlaneBuffer): bool {.nimcall, gcsafe, raises: [].}
    withLock planesLock:
      make = sink.newBuffer
  if make.isNil: false else: make(width, height, buffer)

proc freePlaneBuffer*(buffer: PlaneBuffer) =
  ## A buffer of newPlaneBuffer's or importPlaneBuffer's let go: off the
  ## glass first if a plane shows it (a device's RMFB would turn it off anyway).
  {.cast(gcsafe).}:
    withLock planesLock:
      for i in 0 ..< MaxPlanes:
        if planes[i].buffer == buffer.id and buffer.id != 0:
          sink.hide(i)
          planes[i].buffer = 0
      if buffer.imported:
        if not sink.freeImported.isNil:
          sink.freeImported(buffer)
      elif not sink.freeBuffer.isNil:
        sink.freeBuffer(buffer)

proc importPlaneBuffer*(dmabuf: cint, layout: ImportLayout, buffer: var PlaneBuffer): bool =
  ## A decoder's frame (a dma-buf) as something a plane shows, nothing copied
  ## (video/player.nim's zero-copy launch), freed by freePlaneBuffer. False
  ## where the device would not.
  {.cast(gcsafe).}:
    var make: proc (dmabuf: cint, layout: ImportLayout, buffer: var PlaneBuffer): bool {.nimcall, gcsafe,
      raises: [].}
    withLock planesLock:
      make = sink.importBuffer
  if make.isNil or not layout.ok: false else: make(dmabuf, layout, buffer)

proc readingFrame*(buffer: PlaneBuffer, start: bool) =
  ## Around the CPU's read of an imported frame (the canvas's copy, yuvInto):
  ## the CPU's caches as the decoder left the memory (DMA_BUF_IOCTL_SYNC).
  when defined(linux):
    if buffer.imported and buffer.dmabuf >= 0:
      deviceSyncRead(buffer.dmabuf, start)

proc setPlaneSinkForTest*(value: PlaneSink) =
  ## Tests: planes in memory (a nil `show` turns them off again).
  {.cast(gcsafe).}:
    withLock planesLock:
      sink = value
      sinkSet = not value.show.isNil
      planesProbed = false
      planesOk = false
      planesWhyLen = 0
      cursorShown = false
      for i in 0 ..< MaxPlanes:
        planes[i] = PlaneState()
