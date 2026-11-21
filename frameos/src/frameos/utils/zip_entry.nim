## One member of a ZIP file read without unpacking the archive: an EPUB's
## chapter, the manifest inside an .odt or a .zip on the card. The central
## directory at the end of the file says where the member is; a stored member
## is read as it is, a deflated one is inflated a window at a time
## (pixie/inflatestream, the PNG decoder's inflater, already in every image)
## and only the bytes asked for are kept, so a chapter of any size costs its
## slice plus a fixed ~64 KB. Inflating stops once the slice is full.
##
## Costs on an ESP32's flash, where an open is a lookup by name and a seek in
## a big file walks its index: one open a call, the member read front to back
## with no seek between its chunks, the end record looked for in the last
## 4 KB before the last 64 KB, and the last archive's directory kept (by path
## and size) so a book's next chapter does not read it again. Measured on a
## reTerminal Sticky's SPIFFS.
##
## ZIP64 archives, encryption and methods other than stored and deflate are
## refused: an EPUB is none of them.

import pixie/common
import pixie/inflatestream
import frameos/utils/file_slice

type
  ZipEntryError* = object of CatchableError
  ZipEntryTooBig* = object of ZipEntryError
    ## The slice asked for is over the caller's limit; `size` is its length.
    size*: int64

  ZipMember* = object
    name*: string
    meth: int
    flags: int
    compressedSize*: int64
    size*: int64
    localOffset: int64

  ZipSource* = object
    ## Where a ZIP's bytes are: an open file, or a block in memory (a scene
    ## package an ESP32 read off its slot, docs/scene-packages.md) that the
    ## caller keeps alive while the source is used.
    file*: File
    data*: ptr UncheckedArray[char]
    size*: int64

  ZipDirectory = object
    path: string
    fileSize: int64
    members: seq[ZipMember]

const
  EocdSignature = 0x06054b50'i64
  CentralSignature = 0x02014b50'i64
  LocalSignature = 0x04034b50'i64
  ## The end record is 22 bytes plus a comment of at most 65535; almost every
  ## archive has none, so the last 4 KB are read first.
  EocdSearchBytes = 22 + 65535
  EocdFirstLook = 4096
  ## A central directory bigger than this is not a book (an EPUB's is a few
  ## KB a hundred members).
  MaxCentralDirectoryBytes = 8 * 1024 * 1024

var lastDirectory {.threadvar.}: ZipDirectory

proc fail(message: string) {.noreturn.} =
  raise newException(ZipEntryError, message)

proc le16(s: string, i: int): int =
  s[i].uint8.int or (s[i + 1].uint8.int shl 8)

proc le32(s: string, i: int): int64 =
  s[i].uint8.int64 or (s[i + 1].uint8.int64 shl 8) or
    (s[i + 2].uint8.int64 shl 16) or (s[i + 3].uint8.int64 shl 24)

proc fileSource*(f: File, knownSize = -1'i64): ZipSource =
  ZipSource(file: f, size: if knownSize >= 0: knownSize else: f.getFileSize())

proc memorySource*(bytes: string): ZipSource =
  ## `bytes` as a ZIP: the string must outlive the source.
  ZipSource(data: if bytes.len > 0: cast[ptr UncheckedArray[char]](unsafeAddr bytes[0]) else: nil,
    size: bytes.len)

proc isZip*(bytes: openArray[char]): bool =
  ## Starts with a local file header: what a scene package's bytes do.
  bytes.len >= 4 and bytes[0] == 'P' and bytes[1] == 'K' and bytes[2] == '\x03' and bytes[3] == '\x04'

proc readAt(src: ZipSource, pos: int64, len: int): string =
  let len = int(max(0'i64, min(len.int64, src.size - pos)))
  result = newString(len)
  if len == 0:
    return
  if src.file.isNil:
    copyMem(addr result[0], addr src.data[pos], len)
    return
  src.file.setFilePos(pos)
  let got = src.file.readBuffer(addr result[0], len)
  result.setLen(got)

proc findEndRecord(src: ZipSource): (string, int) =
  ## The tail holding the end record, and where in it the record starts.
  for look in [EocdFirstLook, EocdSearchBytes]:
    let tailLen = int(min(src.size, look.int64))
    let tail = readAt(src, src.size - tailLen, tailLen)
    var i = tail.len - 22
    while i >= 0:
      if le32(tail, i) == EocdSignature:
        return (tail, i)
      dec i
    if tailLen.int64 == src.size:
      break
  fail("not a ZIP file")

proc readMembers(src: ZipSource): seq[ZipMember] =
  if src.size < 22:
    fail("not a ZIP file")
  let (tail, eocd) = findEndRecord(src)
  let count = le16(tail, eocd + 10)
  let cdSize = le32(tail, eocd + 12)
  let cdOffset = le32(tail, eocd + 16)
  if count == 0xFFFF or cdSize == 0xFFFFFFFF'i64 or cdOffset == 0xFFFFFFFF'i64:
    fail("ZIP64 archives are not supported")
  if cdSize > MaxCentralDirectoryBytes or cdOffset + cdSize > src.size:
    fail("the ZIP's directory is damaged")
  let cd = readAt(src, cdOffset, cdSize.int)
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

proc zipMembers*(src: ZipSource, path = ""): seq[ZipMember] =
  ## Every member the central directory lists, in its order. With a path, the
  ## last archive's directory is kept and used again while its size holds.
  if path.len > 0 and lastDirectory.path == path and lastDirectory.fileSize == src.size:
    return lastDirectory.members
  result = readMembers(src)
  if path.len > 0:
    lastDirectory = ZipDirectory(path: path, fileSize: src.size, members: result)

proc forgetZipDirectory*() =
  ## Drops the kept directory (a test that rewrites a file in place).
  lastDirectory = ZipDirectory()

proc findMember*(src: ZipSource, name: string, path = ""): ZipMember =
  for member in zipMembers(src, path):
    if member.name == name:
      return member
  fail("no member called " & name)

proc readMember*(src: ZipSource, member: ZipMember, offset, maxBytes: int): string =
  ## Bytes offset ..< offset + maxBytes of the member (fewer at its end).
  if (member.flags and 1) != 0:
    fail(member.name & " is encrypted")
  if member.meth notin [0, 8]:
    fail(member.name & " uses compression method " & $member.meth)
  let header = readAt(src, member.localOffset, 30)
  if header.len < 30 or le32(header, 0) != LocalSignature:
    fail("the ZIP's member " & member.name & " is damaged")
  let dataStart = member.localOffset + 30 + le16(header, 26) + le16(header, 28)
  if dataStart + member.compressedSize > src.size:
    fail("the ZIP's member " & member.name & " is cut short")
  let start = max(0, offset).int64
  if start >= member.size or maxBytes <= 0:
    return ""
  let wanted = int(min(maxBytes.int64, member.size - start))
  if member.meth == 0:
    return readAt(src, dataStart + start, wanted)

  var output = newStringOfCap(wanted)
  var seen = 0'i64 # inflated bytes so far, kept or not
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
    if src.file.isNil:
      # In memory: the member's bytes are one segment.
      var given = false
      let at = cast[ptr UncheckedArray[uint8]](addr src.data[dataStart])
      let length = member.compressedSize.int
      let pull = proc (): InflateSegment {.gcsafe, raises: [PixieError].} =
        if given: return InflateSegment(data: nil, len: 0)
        given = true
        InflateSegment(data: at, len: length)
      uncompressStreamDeflate(onData, pull)
    else:
      # One seek, then the member front to back (file_slice.nim).
      streamRange(src.file, dataStart, member.compressedSize, scDeflate, onData)
  except PixieError as error:
    if not full:
      fail("the ZIP's member " & member.name & " could not be inflated: " & error.msg)
  output

proc readWhole*(src: ZipSource, member: ZipMember): string =
  ## The whole member.
  readMember(src, member, 0, member.size.int)

proc readZipEntry*(path, name: string, offset, maxBytes: int, limit = high(int)): string =
  ## Bytes offset ..< offset + maxBytes of the member called name; a negative
  ## maxBytes reads to the member's end. One open of the file. Raises
  ## ZipEntryTooBig when the slice is over `limit`.
  var f: File
  if not f.open(path):
    fail("could not open " & path)
  defer: f.close()
  let src = fileSource(f)
  let member = findMember(src, name, path)
  let length =
    if maxBytes < 0: max(0'i64, member.size - max(0, offset).int64)
    else: min(maxBytes.int64, max(0'i64, member.size - max(0, offset).int64))
  if length > limit.int64:
    var error = newException(ZipEntryTooBig, name & " is " & $length & " bytes, over the " & $limit & " byte limit")
    error.size = length
    raise error
  readMember(src, member, offset, length.int)

proc zipEntrySize*(path, name: string): int64 =
  ## The member's size inflated, as the directory says.
  var f: File
  if not f.open(path):
    fail("could not open " & path)
  defer: f.close()
  findMember(fileSource(f), name, path).size
