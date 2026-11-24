## H.264 access units out of an Annex B stream (what `ffmpeg -c:v copy -bsf:v
## h264_mp4toannexb -f h264` writes), one picture at a time for a V4L2
## decoder (video/v4l2_decoder.nim): the VideoCore's takes a buffer as a
## whole picture. Pure: bytes in, byte ranges out.
##
## A new access unit starts (H.264 7.4.1.2.3) at an access unit delimiter,
## a sequence or picture parameter set, an SEI or NAL types 14 to 18 after
## the last picture's slices, or at a slice whose first_mb_in_slice is 0 (its
## first bit after the NAL header is 1).

type
  AnnexBSplitter* = object
    buf*: seq[byte]
    len*: int          ## bytes of `buf` in use
    start: int         ## where the access unit being gathered starts
    scan: int          ## where to look for the next start code
    hasPicture: bool   ## the access unit being gathered has a slice

proc compact(sp: var AnnexBSplitter) =
  ## Drops what was taken already.
  if sp.start > 0:
    let keep = sp.len - sp.start
    if keep > 0:
      moveMem(addr sp.buf[0], addr sp.buf[sp.start], keep)
    sp.len = keep
    sp.scan -= sp.start
    sp.start = 0

proc room*(sp: var AnnexBSplitter, wanted: int): ptr UncheckedArray[byte] =
  ## Space for `wanted` more bytes at the end (`added` says how many came).
  sp.compact()
  if sp.buf.len - sp.len < wanted:
    sp.buf.setLen(max(sp.buf.len * 2, sp.len + wanted))
  cast[ptr UncheckedArray[byte]](addr sp.buf[sp.len])

proc added*(sp: var AnnexBSplitter, count: int) =
  sp.len += count

proc add*(sp: var AnnexBSplitter, data: openArray[byte]) =
  if data.len == 0: return
  let dst = sp.room(data.len)
  copyMem(dst, unsafeAddr data[0], data.len)
  sp.added(data.len)

proc startCodeAt(sp: AnnexBSplitter, i: int): bool {.inline.} =
  i + 3 <= sp.len and sp.buf[i] == 0 and sp.buf[i + 1] == 0 and sp.buf[i + 2] == 1

proc nextUnit*(sp: var AnnexBSplitter, first, last: var int, eof = false): bool =
  ## The next whole access unit as `buf[first ..< last]`: true when there is
  ## one (the next unit's start seen, or the stream ended: `eof`). The range
  ## is good until the next `room` / `add`.
  var i = sp.scan
  # A start code is looked at once its NAL header and the byte after it are
  # in (first_mb_in_slice's first bit).
  while i + 5 <= sp.len:
    if not sp.startCodeAt(i):
      inc i
      continue
    let nal = i + 3
    let kind = int(sp.buf[nal] and 0x1f)
    let picture = kind >= 1 and kind <= 5
    var boundary = false
    if sp.hasPicture:
      if kind in {6, 7, 8, 9} or (kind >= 14 and kind <= 18):
        boundary = true
      elif picture and (sp.buf[nal + 1] and 0x80) != 0:
        boundary = true # first_mb_in_slice == 0: a new picture
    if boundary:
      # A four-byte start code's leading zero belongs to the next unit.
      let cut = if i > sp.start and sp.buf[i - 1] == 0: i - 1 else: i
      first = sp.start
      last = cut
      sp.start = cut
      sp.scan = i + 3
      sp.hasPicture = picture
      return true
    if picture:
      sp.hasPicture = true
    i = nal
  sp.scan = i
  if eof and sp.start < sp.len:
    first = sp.start
    last = sp.len
    sp.start = sp.len
    sp.scan = sp.len
    sp.hasPicture = false
    return true
  false

proc pending*(sp: AnnexBSplitter): int =
  ## Bytes not handed out yet.
  sp.len - sp.start
