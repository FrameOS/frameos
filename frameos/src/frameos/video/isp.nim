## The VideoCore's ISP (bcm2835-codec-isp) scaling and converting a
## decoder's frames (video/v4l2_decoder.nim): each decoded frame goes in as
## the decoder's own dma-buf, no copy, and comes out at the size it is drawn
## at in the canvas's pixel format (RGB565, RGBA, or YUV420 whose luma is a
## grey canvas's). The CPU only copies the result into the player's ring:
## reading the VideoCore's frames, which it sees uncached, and scaling them
## is what ffmpeg's way cost a Pi Zero (157 ms of a 1080p frame, 8 here;
## docs/video.md "Hardware").
##
## The ISP keeps a source crop's size but drops its corner (2026-11-24): it
## crops to the picture in the decoder's frames (1920x1080 of 1920x1088),
## and a cover's middle is taken as the result is copied (args.nim ispSize).
## A new set of frames (the decoder's source change) needs a new ISP: its
## buffers' sizes stay with the open device. Linux only.

import frameos/video/v4l2
import frameos/video/v4l2_decoder
import frameos/video/args

type
  IspPicture* = object
    index*: int
    data*: ptr UncheckedArray[byte]
    bytesperline*: int

  IspSink* = object
    fd*: cint
    device: string
    pictures: seq[Mapped]
    output*: PlaneFormat   ## what comes out
    generation*: int       ## the decoder configuration it takes frames of
    held: seq[DecodedFrame] ## frames the ISP has, by its input slot
    inFlight*: int

proc ispFourcc*(pixels: VideoPixels): uint32 =
  case pixels
  of vpRgb565: FourccRgb565
  of vpRgba: FourccRgba32
  of vpGray: FourccYuv420 # its first plane is the luma: a grey canvas's bytes

proc close*(isp: var IspSink) =
  if isp.fd < 0:
    return
  streamOff(isp.fd, BufTypeOutput)
  streamOff(isp.fd, BufTypeCapture)
  unmapBuffers(isp.pictures)
  closeDevice(isp.fd)
  isp.fd = -1
  isp.held.setLen(0)
  isp.inFlight = 0

proc openIsp*(device: string, input: DecodedFormat, pixels: VideoPixels, width, height: int,
    pictureBuffers = 3): IspSink =
  ## An ISP taking `input`'s frames and making `width` x `height` pictures of
  ## `pixels`. Raises V4l2Unsupported where it would not (a stride it rounds,
  ## a size or format it changes).
  result.fd = -1
  result.device = device
  result.fd = openDevice(device, "isp")
  try:
    let inFormat = setFormat(result.fd, BufTypeOutput, input.fourcc, input.width, input.height,
      input.bytesperline, "isp output VIDIOC_S_FMT")
    if inFormat.bytesperline != input.bytesperline or inFormat.sizeimage > input.sizeimage:
      raise newException(V4l2Unsupported, "the ISP reads " & $input.width & "x" & $input.height & " frames with a " &
        $inFormat.bytesperline & " byte stride, the decoder writes " & $input.bytesperline)
    let v = input.visible
    let crop = setCrop(result.fd, BufTypeOutput, v.x, v.y, v.width, v.height)
    if crop.width != v.width or crop.height != v.height or crop.x != v.x or crop.y != v.y:
      raise newException(V4l2Unsupported, "the ISP crops to " & $crop.width & "x" & $crop.height & " at " &
        $crop.x & "," & $crop.y & ", not the picture's " & $v.width & "x" & $v.height & " at " & $v.x & "," & $v.y)
    let code = ispFourcc(pixels)
    result.output = setFormat(result.fd, BufTypeCapture, code, width, height, 0, "isp capture VIDIOC_S_FMT")
    if result.output.fourcc != code or result.output.width != width or result.output.height != height:
      raise newException(V4l2Unsupported, "the ISP makes " & $result.output.width & "x" & $result.output.height &
        " " & fourccText(result.output.fourcc) & ", not " & $width & "x" & $height & " " & fourccText(code))
    discard requestBuffers(result.fd, BufTypeOutput, MemoryDmabuf, input.buffers, "isp output VIDIOC_REQBUFS")
    result.held.setLen(input.buffers)
    let count = requestBuffers(result.fd, BufTypeCapture, MemoryMmap, pictureBuffers, "isp capture VIDIOC_REQBUFS")
    result.pictures = mapBuffers(result.fd, BufTypeCapture, count)
    for i in 0 ..< count:
      queueBuffer(result.fd, BufTypeCapture, MemoryMmap, i, 0, result.pictures[i].length, -1, "isp capture VIDIOC_QBUF")
    streamOn(result.fd, BufTypeOutput, "isp output VIDIOC_STREAMON")
    streamOn(result.fd, BufTypeCapture, "isp capture VIDIOC_STREAMON")
    result.generation = input.generation
  except V4l2Error as e:
    result.close()
    raise e

proc submit*(isp: var IspSink, frame: DecodedFrame, input: DecodedFormat) =
  ## A decoded frame in, as the decoder's dma-buf (the ISP's input slot is the
  ## decoder's buffer index: as many slots as the decoder has buffers).
  queueBuffer(isp.fd, BufTypeOutput, MemoryDmabuf, frame.index, frame.bytesused, input.sizeimage, frame.dmabuf,
    "isp output VIDIOC_QBUF")
  isp.held[frame.index] = frame
  inc isp.inFlight

proc readFrame*(isp: var IspSink, frame: var DecodedFrame): bool =
  ## A decoded frame the ISP is done with: the decoder's again.
  var index, used: int
  var flags: uint32
  if dequeueBuffer(isp.fd, BufTypeOutput, MemoryDmabuf, index, used, flags, "isp output VIDIOC_DQBUF") != dqBuffer:
    return false
  frame = isp.held[index]
  true

proc nextPicture*(isp: var IspSink, picture: var IspPicture): bool =
  var index, used: int
  var flags: uint32
  if dequeueBuffer(isp.fd, BufTypeCapture, MemoryMmap, index, used, flags, "isp capture VIDIOC_DQBUF") != dqBuffer:
    return false
  dec isp.inFlight
  picture = IspPicture(index: index, data: isp.pictures[index].data, bytesperline: isp.output.bytesperline)
  true

proc requeue*(isp: var IspSink, picture: IspPicture) =
  queueBuffer(isp.fd, BufTypeCapture, MemoryMmap, picture.index, 0, isp.pictures[picture.index].length, -1,
    "isp capture VIDIOC_QBUF")

proc copyPicture*(picture: IspPicture, pixels: VideoPixels, x, y, width, height: int,
    dst: ptr UncheckedArray[byte]) =
  ## `width` x `height` of the picture from (`x`, `y`) into `dst`, rows packed
  ## (the ring's frame): one copy of a row, read once from memory the CPU
  ## sees uncached. A grey canvas takes the luma (the first plane).
  let
    bpp = bytesPerPixel(pixels)
    row = width * bpp
  for r in 0 ..< height:
    copyMem(addr dst[r * row], addr picture.data[(y + r) * picture.bytesperline + x * bpp], row)
