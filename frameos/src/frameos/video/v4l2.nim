## A V4L2 memory-to-memory device in the multi-planar API, as the
## VideoCore's codec offers its decoder and ISP (bcm2835-codec: single-plane
## buffers in it). The structs and the ioctl numbers come from
## <linux/videodev2.h> (their sizes are the target's: a 32-bit Pi's time
## fields). Each call raises a `V4l2Error` that says what failed and why,
## in ffmpeg's words where it has them ("... VIDIOC_REQBUFS failed: Cannot
## allocate memory", which `hardwareBusy` reads). Linux only.
##
## Used by the decoder client (video/v4l2_decoder.nim) and the ISP
## (video/isp.nim), on one reader thread: plain values, no ref.

import std/[os, posix, strutils]

type
  V4l2Error* = object of CatchableError
  V4l2Unsupported* = object of V4l2Error
    ## The device would not do it for this video (a format, a size): no
    ## fault of the hardware's.

const
  BufTypeCapture* = 9'u32   ## V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE
  BufTypeOutput* = 10'u32   ## V4L2_BUF_TYPE_VIDEO_OUTPUT_MPLANE
  MemoryMmap* = 1'u32
  MemoryDmabuf* = 4'u32
  CapM2mMplane = 0x00004000'u32
  CapStreaming = 0x04000000'u32
  EventEos* = 2'u32
  EventSourceChange* = 5'u32
  BufFlagError* = 0x00000040'u32
  BufFlagLast* = 0x00100000'u32
  DecCmdStop = 1'u32
  SelTgtCrop = 0'u32
  SelTgtCompose = 0x0100'u32
  CidMinBuffersForCapture = 0x00980927'u32

proc fourcc*(code: string): uint32 =
  ## "NV12" as V4L2 writes it.
  for i in 0 ..< 4:
    result = result or (uint32(ord(code[i])) shl (8 * i))

proc fourccText*(value: uint32): string =
  for i in 0 ..< 4:
    result.add char((value shr (8 * i)) and 0xff)

const
  FourccH264* = fourcc("H264")
  FourccNv12* = fourcc("NV12")
  FourccYuv420* = fourcc("YU12")
  FourccRgb565* = fourcc("RGBP")  ## little-endian 5-6-5: pixie's 565
  FourccRgba32* = fourcc("AB24")  ## r, g, b, a bytes: pixie's RGBX (the ISP writes alpha 255)

when defined(linux):
  const videodev = "<linux/videodev2.h>"

  type
    V4l2Capability {.importc: "struct v4l2_capability", header: videodev.} = object
      capabilities: uint32
      device_caps: uint32

    V4l2PlanePixFormat {.importc: "struct v4l2_plane_pix_format", header: videodev.} = object
      sizeimage: uint32
      bytesperline: uint32

    V4l2PixFormatMplane {.importc: "struct v4l2_pix_format_mplane", header: videodev.} = object
      width: uint32
      height: uint32
      pixelformat: uint32
      field: uint32
      plane_fmt: array[8, V4l2PlanePixFormat]
      num_planes: uint8

    V4l2FormatUnion {.union.} = object
      pix_mp: V4l2PixFormatMplane

    V4l2Format {.importc: "struct v4l2_format", header: videodev.} = object
      `type`: uint32
      fmt: V4l2FormatUnion

    V4l2RequestBuffers {.importc: "struct v4l2_requestbuffers", header: videodev.} = object
      count: uint32
      `type`: uint32
      memory: uint32

    V4l2PlaneM {.union.} = object
      mem_offset: uint32
      fd: int32

    V4l2Plane {.importc: "struct v4l2_plane", header: videodev.} = object
      bytesused: uint32
      length: uint32
      m: V4l2PlaneM
      data_offset: uint32

    V4l2BufferM {.union.} = object
      planes: ptr V4l2Plane

    V4l2Buffer {.importc: "struct v4l2_buffer", header: videodev.} = object
      index: uint32
      `type`: uint32
      bytesused: uint32
      flags: uint32
      field: uint32
      memory: uint32
      m: V4l2BufferM
      length: uint32

    V4l2ExportBuffer {.importc: "struct v4l2_exportbuffer", header: videodev.} = object
      `type`: uint32
      index: uint32
      plane: uint32
      flags: uint32
      fd: int32

    V4l2EventSubscription {.importc: "struct v4l2_event_subscription", header: videodev.} = object
      `type`: uint32
      id: uint32
      flags: uint32

    V4l2Event {.importc: "struct v4l2_event", header: videodev.} = object
      `type`: uint32

    V4l2DecoderCmd {.importc: "struct v4l2_decoder_cmd", header: videodev.} = object
      cmd: uint32
      flags: uint32

    V4l2Rect {.importc: "struct v4l2_rect", header: videodev.} = object
      left: int32
      top: int32
      width: uint32
      height: uint32

    V4l2Selection {.importc: "struct v4l2_selection", header: videodev.} = object
      `type`: uint32
      target: uint32
      flags: uint32
      r: V4l2Rect

    V4l2Control {.importc: "struct v4l2_control", header: videodev.} = object
      id: uint32
      value: int32

  var
    VIDIOC_QUERYCAP {.importc, header: videodev.}: culong
    VIDIOC_S_FMT {.importc, header: videodev.}: culong
    VIDIOC_G_FMT {.importc, header: videodev.}: culong
    VIDIOC_TRY_FMT {.importc, header: videodev.}: culong
    VIDIOC_REQBUFS {.importc, header: videodev.}: culong
    VIDIOC_QUERYBUF {.importc, header: videodev.}: culong
    VIDIOC_QBUF {.importc, header: videodev.}: culong
    VIDIOC_DQBUF {.importc, header: videodev.}: culong
    VIDIOC_EXPBUF {.importc, header: videodev.}: culong
    VIDIOC_STREAMON {.importc, header: videodev.}: culong
    VIDIOC_STREAMOFF {.importc, header: videodev.}: culong
    VIDIOC_SUBSCRIBE_EVENT {.importc, header: videodev.}: culong
    VIDIOC_DQEVENT {.importc, header: videodev.}: culong
    VIDIOC_DECODER_CMD {.importc, header: videodev.}: culong
    VIDIOC_G_SELECTION {.importc, header: videodev.}: culong
    VIDIOC_S_SELECTION {.importc, header: videodev.}: culong
    VIDIOC_G_CTRL {.importc, header: videodev.}: culong

  proc c_ioctl(fd: cint, request: culong): cint {.importc: "ioctl", header: "<sys/ioctl.h>", varargs.}

  type
    PlaneFormat* = object
      ## A queue's format: one plane.
      fourcc*: uint32
      width*, height*: int
      bytesperline*: int
      sizeimage*: int

    Mapped* = object
      ## A buffer mapped into this process (MMAP).
      data*: ptr UncheckedArray[byte]
      length*: int

    Dequeued* = enum
      dqNone    ## nothing ready (EAGAIN)
      dqBuffer  ## a buffer: index, bytesused, flags
      dqEnded   ## the queue is past its last buffer (EPIPE after a drain)

  proc fail(what: string, unsupported = false) {.noreturn.} =
    let message = what & " failed: " & osErrorMsg(osLastError())
    if unsupported:
      raise newException(V4l2Unsupported, message)
    raise newException(V4l2Error, message)

  proc xioctl(fd: cint, request: culong, arg: pointer): cint =
    while true:
      result = c_ioctl(fd, request, arg)
      if result == 0 or errno != EINTR:
        return

  proc openDevice*(path, role: string): cint =
    ## `role` names it in errors ("decoder", "isp"). Non-blocking: every wait is
    ## a poll of the caller's.
    result = posix.open(path.cstring, O_RDWR or O_NONBLOCK or O_CLOEXEC)
    if result < 0:
      fail(role & " open " & path)
    var cap: V4l2Capability
    if xioctl(result, VIDIOC_QUERYCAP, addr cap) != 0:
      discard posix.close(result)
      fail(role & " VIDIOC_QUERYCAP")
    if (cap.device_caps and CapM2mMplane) == 0 or (cap.device_caps and CapStreaming) == 0:
      discard posix.close(result)
      raise newException(V4l2Unsupported, role & " " & path & " is no multi-planar mem2mem device")

  proc closeDevice*(fd: cint) =
    if fd >= 0:
      discard posix.close(fd)

  proc readFormat(f: V4l2Format): PlaneFormat =
    result.fourcc = f.fmt.pix_mp.pixelformat
    result.width = int(f.fmt.pix_mp.width)
    result.height = int(f.fmt.pix_mp.height)
    result.bytesperline = int(f.fmt.pix_mp.plane_fmt[0].bytesperline)
    result.sizeimage = int(f.fmt.pix_mp.plane_fmt[0].sizeimage)

  proc formatRequest(kind, code: uint32, width, height, bytesperline: int, sizeimage = 0): V4l2Format =
    result.`type` = kind
    result.fmt.pix_mp.pixelformat = code
    result.fmt.pix_mp.width = uint32(width)
    result.fmt.pix_mp.height = uint32(height)
    result.fmt.pix_mp.num_planes = 1
    result.fmt.pix_mp.plane_fmt[0].bytesperline = uint32(bytesperline)
    result.fmt.pix_mp.plane_fmt[0].sizeimage = uint32(sizeimage)

  proc setFormat*(fd: cint, kind, code: uint32, width, height: int, bytesperline = 0,
      what = "VIDIOC_S_FMT", sizeimage = 0): PlaneFormat =
    ## What the device made of it (it rounds sizes and strides). `sizeimage`:
    ## a coded queue's buffer size.
    var f = formatRequest(kind, code, width, height, bytesperline, sizeimage)
    if xioctl(fd, VIDIOC_S_FMT, addr f) != 0:
      fail(what, unsupported = errno == EINVAL)
    readFormat(f)

  proc tryFormat*(fd: cint, kind, code: uint32, width, height: int, bytesperline = 0): PlaneFormat =
    var f = formatRequest(kind, code, width, height, bytesperline)
    if xioctl(fd, VIDIOC_TRY_FMT, addr f) != 0:
      fail("VIDIOC_TRY_FMT", unsupported = true)
    readFormat(f)

  proc getFormat*(fd: cint, kind: uint32, what = "VIDIOC_G_FMT"): PlaneFormat =
    var f: V4l2Format
    f.`type` = kind
    if xioctl(fd, VIDIOC_G_FMT, addr f) != 0:
      fail(what)
    readFormat(f)

  proc requestBuffers*(fd: cint, kind, memory: uint32, count: int, what = "VIDIOC_REQBUFS"): int =
    ## The buffers the device made (it may make more or fewer); 0 frees them.
    var r: V4l2RequestBuffers
    r.count = uint32(count)
    r.`type` = kind
    r.memory = memory
    if xioctl(fd, VIDIOC_REQBUFS, addr r) != 0:
      fail(what)
    int(r.count)

  proc mapBuffers*(fd: cint, kind: uint32, count: int): seq[Mapped] =
    for i in 0 ..< count:
      var plane: V4l2Plane
      var b: V4l2Buffer
      b.index = uint32(i)
      b.`type` = kind
      b.memory = MemoryMmap
      b.m.planes = addr plane
      b.length = 1
      if xioctl(fd, VIDIOC_QUERYBUF, addr b) != 0:
        for m in result:
          discard munmap(m.data, m.length)
        fail("VIDIOC_QUERYBUF")
      let p = mmap(nil, int(plane.length), PROT_READ or PROT_WRITE, MAP_SHARED, fd, Off(plane.m.mem_offset))
      if p == MAP_FAILED:
        for m in result:
          discard munmap(m.data, m.length)
        fail("mmap of a buffer")
      result.add Mapped(data: cast[ptr UncheckedArray[byte]](p), length: int(plane.length))

  proc unmapBuffers*(buffers: var seq[Mapped]) =
    for m in buffers:
      if not m.data.isNil:
        discard munmap(m.data, m.length)
    buffers.setLen(0)

  proc queueBuffer*(fd: cint, kind, memory: uint32, index, bytesused, length: int, dmabuf: cint = -1,
      what = "VIDIOC_QBUF") =
    var plane: V4l2Plane
    var b: V4l2Buffer
    b.index = uint32(index)
    b.`type` = kind
    b.memory = memory
    b.m.planes = addr plane
    b.length = 1
    plane.bytesused = uint32(bytesused)
    plane.length = uint32(length)
    if memory == MemoryDmabuf:
      plane.m.fd = int32(dmabuf)
    if xioctl(fd, VIDIOC_QBUF, addr b) != 0:
      fail(what)

  proc dequeueBuffer*(fd: cint, kind, memory: uint32, index, bytesused: var int, flags: var uint32,
      what = "VIDIOC_DQBUF"): Dequeued =
    var plane: V4l2Plane
    var b: V4l2Buffer
    b.`type` = kind
    b.memory = memory
    b.m.planes = addr plane
    b.length = 1
    if xioctl(fd, VIDIOC_DQBUF, addr b) != 0:
      if errno == EAGAIN:
        return dqNone
      if errno == EPIPE:
        return dqEnded
      fail(what)
    index = int(b.index)
    bytesused = int(plane.bytesused)
    flags = b.flags
    dqBuffer

  proc exportBuffer*(fd: cint, kind: uint32, index: int): cint =
    ## The buffer as a dma-buf another device imports (VIDIOC_EXPBUF).
    var e: V4l2ExportBuffer
    e.`type` = kind
    e.index = uint32(index)
    e.plane = 0
    e.flags = uint32(O_RDWR or O_CLOEXEC)
    if xioctl(fd, VIDIOC_EXPBUF, addr e) != 0:
      fail("VIDIOC_EXPBUF")
    cint(e.fd)

  proc streamOn*(fd: cint, kind: uint32, what = "VIDIOC_STREAMON") =
    var t = cint(kind)
    if xioctl(fd, VIDIOC_STREAMON, addr t) != 0:
      fail(what)

  proc streamOff*(fd: cint, kind: uint32) =
    ## Never raises: a teardown.
    var t = cint(kind)
    discard xioctl(fd, VIDIOC_STREAMOFF, addr t)

  proc subscribe*(fd: cint, event: uint32) =
    var s: V4l2EventSubscription
    s.`type` = event
    if xioctl(fd, VIDIOC_SUBSCRIBE_EVENT, addr s) != 0:
      fail("VIDIOC_SUBSCRIBE_EVENT")

  proc nextEvent*(fd: cint): int =
    ## The next event's type, -1 when there is none.
    var e: V4l2Event
    if xioctl(fd, VIDIOC_DQEVENT, addr e) != 0:
      return -1
    int(e.`type`)

  proc decoderStop*(fd: cint) =
    ## The decoder drains: its last frame comes with V4L2_BUF_FLAG_LAST.
    var c: V4l2DecoderCmd
    c.cmd = DecCmdStop
    if xioctl(fd, VIDIOC_DECODER_CMD, addr c) != 0:
      fail("VIDIOC_DECODER_CMD stop")

  proc visibleRect*(fd: cint, width, height: int): tuple[x, y, width, height: int] =
    ## The picture in a decoder's frames (its compose rectangle: 1920x1080 of
    ## a 1920x1088 frame); the whole frame when it does not say.
    var s: V4l2Selection
    s.`type` = BufTypeCapture
    s.target = SelTgtCompose
    if xioctl(fd, VIDIOC_G_SELECTION, addr s) == 0 and s.r.width > 0 and s.r.height > 0:
      return (int(s.r.left), int(s.r.top), int(s.r.width), int(s.r.height))
    (0, 0, width, height)

  proc setCrop*(fd: cint, kind: uint32, x, y, width, height: int): tuple[x, y, width, height: int] =
    ## What of a queue's frames a device reads (an ISP's source crop); what it
    ## took (the VideoCore's ISP keeps the size and drops the corner).
    var s: V4l2Selection
    s.`type` = kind
    s.target = SelTgtCrop
    s.r.left = int32(x)
    s.r.top = int32(y)
    s.r.width = uint32(width)
    s.r.height = uint32(height)
    if xioctl(fd, VIDIOC_S_SELECTION, addr s) != 0:
      fail("VIDIOC_S_SELECTION crop", unsupported = true)
    (int(s.r.left), int(s.r.top), int(s.r.width), int(s.r.height))

  proc minCaptureBuffers*(fd: cint): int =
    ## What a decoder needs on its capture queue (V4L2_CID_MIN_BUFFERS_FOR_CAPTURE), 1 when it does not say.
    var c: V4l2Control
    c.id = CidMinBuffersForCapture
    if xioctl(fd, VIDIOC_G_CTRL, addr c) == 0 and c.value > 0:
      return int(c.value)
    1

proc codecDevices*(sysDir = "/sys/class/video4linux"): tuple[decoder, isp: string] =
  ## The VideoCore's decoder and ISP by their names ("bcm2835-codec-decode",
  ## "bcm2835-codec-isp"; not "bcm2835-isp", the camera's), as /dev paths:
  ## never by number, which changes with what else is there.
  try:
    for dir in walkDirs(sysDir / "video*"):
      var name = ""
      try:
        name = readFile(dir / "name").strip()
      except IOError, OSError:
        continue
      let device = "/dev" / dir.extractFilename()
      if name == "bcm2835-codec-decode" and result.decoder.len == 0:
        result.decoder = device
      elif name == "bcm2835-codec-isp" and result.isp.len == 0:
        result.isp = device
  except OSError:
    discard
