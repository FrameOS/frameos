## The VideoCore's H.264 decoder (bcm2835-codec-decode) driven by the
## player, not ffmpeg: access units in (video/annexb.nim), decoded frames out
## as dma-bufs another device takes without a copy, given back when it is
## done with them. What takes them is not this module's business: the ISP
## (video/isp.nim) scales and converts them; a display plane could show them.
##
## The stateful decoder's protocol (Linux's "Memory-to-memory Stateful Video
## Decoder Interface"), as the VideoCore keeps it (2026-11-24):
## - The output queue (coded) is told the stream's size and gets mapped
##   buffers, one access unit each.
## - The capture queue (decoded) must stream before the decoder starts: it
##   is set up at once from what the decoder says, and again on its
##   source-change event (the real size: 1920x1088, a 1920x1080 picture).
## - Frames come in NV12, whose stride the ISP takes as the decoder writes it
##   (its YUV420's it rounds up: a 480 px wide video's frames would be too
##   small for it).
## - The end: the decoder is told to stop, and its last frame comes with
##   V4L2_BUF_FLAG_LAST.
## Linux only.

import std/posix
import frameos/video/v4l2

export v4l2

type
  DecodedFormat* = object
    ## The decoder's frames since its last (re)configuration.
    fourcc*: uint32
    width*, height*: int    ## the frame's (1920x1088)
    bytesperline*: int
    sizeimage*: int
    visible*: tuple[x, y, width, height: int] ## the picture in it (1920x1080)
    buffers*: int
    generation*: int        ## one more at each (re)configuration

  DecodedFrame* = object
    index*: int             ## the buffer, given back with `release`
    dmabuf*: cint           ## the buffer as a dma-buf (the decoder's: never closed by the taker)
    bytesused*: int
    generation*: int        ## the configuration it is of: a stale one is not given back

  V4l2Decoder* = object
    fd*: cint
    coded: seq[Mapped]     ## the output queue's buffers
    free: seq[int]         ## ... the ones to fill
    outputOn: bool
    captureOn: bool
    dmabufs: seq[cint]
    format*: DecodedFormat
    extra: int              ## capture buffers beyond the decoder's minimum (for the taker)
    draining*: bool
    ended*: bool            ## its last frame came
    fed*: int               ## access units given
    decoded*: int           ## frames out

proc closeCapture(d: var V4l2Decoder) =
  if d.captureOn:
    streamOff(d.fd, BufTypeCapture)
    d.captureOn = false
  for fd in d.dmabufs:
    discard posix.close(fd)
  d.dmabufs.setLen(0)
  try:
    discard requestBuffers(d.fd, BufTypeCapture, MemoryMmap, 0)
  except V4l2Error:
    discard

proc setUpCapture(d: var V4l2Decoder) =
  ## The capture queue from what the decoder says now: NV12 frames, exported.
  d.closeCapture()
  let now = getFormat(d.fd, BufTypeCapture, "decoder capture VIDIOC_G_FMT")
  let f = setFormat(d.fd, BufTypeCapture, FourccNv12, now.width, now.height, 0, "decoder capture VIDIOC_S_FMT")
  if f.fourcc != FourccNv12:
    raise newException(V4l2Unsupported, "the decoder gives no NV12 frames")
  let count = requestBuffers(d.fd, BufTypeCapture, MemoryMmap, minCaptureBuffers(d.fd) + d.extra,
    "decoder capture VIDIOC_REQBUFS")
  for i in 0 ..< count:
    d.dmabufs.add exportBuffer(d.fd, BufTypeCapture, i)
    queueBuffer(d.fd, BufTypeCapture, MemoryMmap, i, 0, f.sizeimage)
  streamOn(d.fd, BufTypeCapture, "decoder capture VIDIOC_STREAMON")
  d.captureOn = true
  d.format = DecodedFormat(fourcc: f.fourcc, width: f.width, height: f.height, bytesperline: f.bytesperline,
    sizeimage: f.sizeimage, visible: visibleRect(d.fd, f.width, f.height), buffers: count,
    generation: d.format.generation + 1)

proc close*(d: var V4l2Decoder) =
  if d.fd < 0:
    return
  if d.outputOn:
    streamOff(d.fd, BufTypeOutput)
    d.outputOn = false
  d.closeCapture()
  unmapBuffers(d.coded)
  try:
    discard requestBuffers(d.fd, BufTypeOutput, MemoryMmap, 0)
  except V4l2Error:
    discard
  closeDevice(d.fd)
  d.fd = -1

proc openDecoder*(device: string, width, height: int, codedBuffers = 6, codedSize = 0,
    extraFrames = 3): V4l2Decoder =
  ## An H.264 decoder for a `width` x `height` stream. `codedSize`: a coded
  ## buffer's bytes (an access unit's at most), the decoder's own when 0.
  ## `extraFrames`: decoded frames the taker may hold beyond what the decoder
  ## needs for itself.
  result.fd = -1
  result.fd = openDevice(device, "decoder")
  result.extra = extraFrames
  try:
    discard setFormat(result.fd, BufTypeOutput, FourccH264, width, height, 0, "decoder output VIDIOC_S_FMT",
      sizeimage = codedSize)
    let count = requestBuffers(result.fd, BufTypeOutput, MemoryMmap, codedBuffers, "decoder output VIDIOC_REQBUFS")
    result.coded = mapBuffers(result.fd, BufTypeOutput, count)
    for i in 0 ..< count:
      result.free.add i
    subscribe(result.fd, EventSourceChange)
    subscribe(result.fd, EventEos)
  except V4l2Error as e:
    result.close()
    raise e

proc reclaim(d: var V4l2Decoder) =
  ## Coded buffers the decoder is done with.
  var index, used: int
  var flags: uint32
  while d.outputOn and dequeueBuffer(d.fd, BufTypeOutput, MemoryMmap, index, used, flags,
      "decoder output VIDIOC_DQBUF") == dqBuffer:
    d.free.add index

proc started*(d: V4l2Decoder): bool =
  ## It has an access unit, and both its queues stream.
  d.outputOn and d.captureOn

proc canFeed*(d: var V4l2Decoder): bool =
  d.reclaim()
  d.free.len > 0 and not d.draining

proc feed*(d: var V4l2Decoder, data: ptr UncheckedArray[byte], length: int) =
  ## One access unit (canFeed first). The first starts the decoder: its
  ## capture queue from the size it was told, until it says otherwise.
  let i = d.free.pop()
  let buffer = d.coded[i]
  if length > buffer.length:
    raise newException(V4l2Error, "an access unit of " & $length & " bytes is more than the decoder's " &
      $buffer.length & " byte buffer")
  copyMem(buffer.data, data, length)
  queueBuffer(d.fd, BufTypeOutput, MemoryMmap, i, length, buffer.length, -1, "decoder output VIDIOC_QBUF")
  inc d.fed
  if not d.outputOn:
    streamOn(d.fd, BufTypeOutput, "decoder output VIDIOC_STREAMON")
    d.outputOn = true
    d.setUpCapture()

proc drain*(d: var V4l2Decoder) =
  ## No more access units: the frames still in the decoder come out, the
  ## last one marked.
  if d.draining:
    return
  d.draining = true
  if d.outputOn:
    decoderStop(d.fd)
  else:
    d.ended = true

proc reconfigured*(d: var V4l2Decoder): bool =
  ## Handles the decoder's events: true when its frames changed (a source
  ## change: the capture queue is set up anew, frames of the last
  ## configuration are gone and their taker sets itself up again).
  while true:
    let event = nextEvent(d.fd)
    if event < 0:
      return
    if uint32(event) == EventSourceChange and d.outputOn:
      d.setUpCapture()
      result = true

proc nextFrame*(d: var V4l2Decoder, frame: var DecodedFrame): bool =
  ## A decoded frame for the taker, false when none is ready. The last one
  ## (a drain's end) sets `ended`.
  if not d.captureOn:
    return false
  while true:
    var index, used: int
    var flags: uint32
    case dequeueBuffer(d.fd, BufTypeCapture, MemoryMmap, index, used, flags, "decoder capture VIDIOC_DQBUF")
    of dqNone:
      return false
    of dqEnded:
      d.ended = true
      return false
    of dqBuffer:
      if (flags and BufFlagLast) != 0:
        d.ended = true
      if used == 0 or (flags and BufFlagError) != 0:
        if not d.ended:
          queueBuffer(d.fd, BufTypeCapture, MemoryMmap, index, 0, d.format.sizeimage)
          continue
        return false
      inc d.decoded
      frame = DecodedFrame(index: index, dmabuf: d.dmabufs[index], bytesused: used,
        generation: d.format.generation)
      return true

proc release*(d: var V4l2Decoder, frame: DecodedFrame) =
  ## The taker is done with `frame`: the decoder may write it again.
  if frame.generation != d.format.generation or not d.captureOn or d.ended:
    return
  queueBuffer(d.fd, BufTypeCapture, MemoryMmap, frame.index, 0, d.format.sizeimage, -1,
    "decoder capture VIDIOC_QBUF")
