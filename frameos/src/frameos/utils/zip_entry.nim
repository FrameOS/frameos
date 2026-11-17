## One member of a ZIP file read without unpacking the archive: an EPUB's
## chapter, the manifest inside an .odt or a .zip on the card. The central
## directory at the end of the file says where the member is; a stored member
## is read as it is, a deflated one is inflated a window at a time
## (pixie/inflatestream, the PNG decoder's inflater, already in every image)
## and only the bytes asked for are kept, so a chapter of any size costs its
## slice plus a fixed ~64 KB. Inflating stops once the slice is full.
##
## ZIP64 archives, encryption and methods other than stored and deflate are
## refused: an EPUB is none of them.

import pixie/common
import pixie/inflatestream

type
  ZipEntryError* = object of CatchableError

  ZipMember* = object
    name*: string
    meth: int
    flags: int
    compressedSize*: int64
    size*: int64
    localOffset: int64

const
  EocdSignature = 0x06054b50'i64
  CentralSignature = 0x02014b50'i64
  LocalSignature = 0x04034b50'i64
  ## The end record is 22 bytes plus a comment of at most 65535.
  EocdSearchBytes = 22 + 65535
  ## A central directory bigger than this is not a book (an EPUB's is a few
  ## KB a hundred members).
  MaxCentralDirectoryBytes = 8 * 1024 * 1024
  ReadChunkBytes = 16 * 1024

proc fail(message: string) {.noreturn.} =
  raise newException(ZipEntryError, message)

proc le16(s: string, i: int): int =
  s[i].uint8.int or (s[i + 1].uint8.int shl 8)

proc le32(s: string, i: int): int64 =
  s[i].uint8.int64 or (s[i + 1].uint8.int64 shl 8) or
    (s[i + 2].uint8.int64 shl 16) or (s[i + 3].uint8.int64 shl 24)

proc readAt(f: File, pos: int64, len: int): string =
  result = newString(len)
  if len == 0:
    return
  f.setFilePos(pos)
  let got = f.readBuffer(addr result[0], len)
  result.setLen(got)

proc zipMembers*(f: File): seq[ZipMember] =
  ## Every member the central directory lists, in its order.
  let fileSize = f.getFileSize()
  if fileSize < 22:
    fail("not a ZIP file")
  let tailLen = int(min(fileSize, EocdSearchBytes.int64))
  let tail = readAt(f, fileSize - tailLen, tailLen)
  var eocd = -1
  var i = tail.len - 22
  while i >= 0:
    if le32(tail, i) == EocdSignature:
      eocd = i
      break
    dec i
  if eocd < 0:
    fail("not a ZIP file")
  let count = le16(tail, eocd + 10)
  let cdSize = le32(tail, eocd + 12)
  let cdOffset = le32(tail, eocd + 16)
  if count == 0xFFFF or cdSize == 0xFFFFFFFF'i64 or cdOffset == 0xFFFFFFFF'i64:
    fail("ZIP64 archives are not supported")
  if cdSize > MaxCentralDirectoryBytes or cdOffset + cdSize > fileSize:
    fail("the ZIP's directory is damaged")
  let cd = readAt(f, cdOffset, cdSize.int)
  var p = 0
  while p + 46 <= cd.len and le32(cd, p) == CentralSignature:
    let nameLen = le16(cd, p + 28)
    let extraLen = le16(cd, p + 30)
    let commentLen = le16(cd, p + 32)
    if p + 46 + nameLen > cd.len:
      break
    result.add ZipMember(
      name: cd[p + 46 ..< p + 46 + nameLen],
      flags: le16(cd, p + 8),
      meth: le16(cd, p + 10),
      compressedSize: le32(cd, p + 20),
      size: le32(cd, p + 24),
      localOffset: le32(cd, p + 42))
    p += 46 + nameLen + extraLen + commentLen

proc findMember*(f: File, name: string): ZipMember =
  for member in zipMembers(f):
    if member.name == name:
      return member
  fail("no member called " & name)

proc readMember*(f: File, member: ZipMember, offset, maxBytes: int): string =
  ## Bytes offset ..< offset + maxBytes of the member (fewer at its end).
  if (member.flags and 1) != 0:
    fail(member.name & " is encrypted")
  if member.meth notin [0, 8]:
    fail(member.name & " uses compression method " & $member.meth)
  let header = readAt(f, member.localOffset, 30)
  if header.len < 30 or le32(header, 0) != LocalSignature:
    fail("the ZIP's member " & member.name & " is damaged")
  let dataStart = member.localOffset + 30 + le16(header, 26) + le16(header, 28)
  let fileSize = f.getFileSize()
  if dataStart + member.compressedSize > fileSize:
    fail("the ZIP's member " & member.name & " is cut short")
  let start = max(0, offset).int64
  if start >= member.size or maxBytes <= 0:
    return ""
  let wanted = int(min(maxBytes.int64, member.size - start))
  if member.meth == 0:
    return readAt(f, dataStart + start, wanted)

  var output = newStringOfCap(wanted)
  var seen = 0'i64 # inflated bytes so far, kept or not
  var left = member.compressedSize
  var pos = dataStart
  var chunk = newString(ReadChunkBytes)
  let pull = proc (): InflateSegment {.gcsafe, raises: [PixieError].} =
    if left <= 0:
      return InflateSegment(data: nil, len: 0)
    let take = int(min(left, ReadChunkBytes.int64))
    var got = 0
    try:
      f.setFilePos(pos)
      got = f.readBuffer(addr chunk[0], take)
    except IOError, OSError:
      raise newException(PixieError, "the ZIP could not be read")
    if got <= 0:
      return InflateSegment(data: nil, len: 0)
    pos += got
    left -= got
    InflateSegment(data: cast[ptr UncheckedArray[uint8]](addr chunk[0]), len: got)
  var full = false
  let onData = proc (data: openArray[uint8]) {.gcsafe, raises: [PixieError].} =
    let first = seen
    seen += data.len
    if seen > start:
      let from0 = int(max(0'i64, start - first))
      let take = min(data.len - from0, wanted - output.len)
      if take > 0:
        let at = output.len
        output.setLen(at + take)
        copyMem(addr output[at], unsafeAddr data[from0], take)
    if output.len >= wanted:
      full = true
      raise newException(PixieError, "enough")
  try:
    uncompressStreamDeflate(onData, pull)
  except PixieError as error:
    if not full:
      fail("the ZIP's member " & member.name & " could not be inflated: " & error.msg)
  output

proc readZipEntry*(path, name: string, offset, maxBytes: int): string =
  ## Bytes offset ..< offset + maxBytes of the member called name.
  var f: File
  if not f.open(path):
    fail("could not open " & path)
  defer: f.close()
  readMember(f, findMember(f, name), offset, maxBytes)

proc zipEntrySize*(path, name: string): int64 =
  ## The member's size inflated, as the directory says.
  var f: File
  if not f.open(path):
    fail("could not open " & path)
  defer: f.close()
  findMember(f, name).size
