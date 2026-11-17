## utils/zip_entry: a member of a ZIP read by name, stored or deflated, a
## slice at a time, and what it refuses.

import std/[os, strutils, times, unittest]
import zippy
import ../zip_entry

proc le16(n: int): string =
  result = newString(2)
  result[0] = char(n and 0xFF)
  result[1] = char((n shr 8) and 0xFF)

proc le32(n: int64): string =
  result = newString(4)
  for i in 0 .. 3:
    result[i] = char((n shr (8 * i)) and 0xFF)

type Member = tuple[name, data: string, deflate: bool]

proc makeZip(members: openArray[Member], comment = ""): string =
  ## A ZIP as an EPUB writer makes one: local headers, the data, the central
  ## directory and its end record. CRCs are zero: the reader never checks them.
  var central = ""
  for m in members:
    let body = if m.deflate: compress(m.data, BestCompression, dfDeflate) else: m.data
    let offset = result.len
    result.add le32(0x04034b50) & le16(20) & le16(0) & le16(if m.deflate: 8 else: 0) &
      le16(0) & le16(0) & le32(0) & le32(body.len) & le32(m.data.len) &
      le16(m.name.len) & le16(0) & m.name & body
    central.add le32(0x02014b50) & le16(20) & le16(20) & le16(0) & le16(if m.deflate: 8 else: 0) &
      le16(0) & le16(0) & le32(0) & le32(body.len) & le32(m.data.len) &
      le16(m.name.len) & le16(0) & le16(0) & le16(0) & le16(0) & le32(0) & le32(offset) & m.name
  let cdOffset = result.len
  result.add central
  result.add le32(0x06054b50) & le16(0) & le16(0) & le16(members.len) & le16(members.len) &
    le32(central.len) & le32(cdOffset) & le16(comment.len) & comment

let dir = getTempDir() / "frameos-zip-entry-" & $epochTime().int
createDir(dir)

var chapter = ""
for i in 0 ..< 4000:
  chapter.add "<p>Paragraph " & $i & ": the quick brown fox jumps over the lazy dog. Grüße, ½ — “quotes”.</p>\n"

let book = dir / "book.epub"
writeFile(book, makeZip([
  (name: "mimetype", data: "application/epub+zip", deflate: false),
  (name: "META-INF/container.xml", data: "<container><rootfile full-path=\"OEBPS/content.opf\"/></container>", deflate: true),
  (name: "OEBPS/chapter 1.xhtml", data: chapter, deflate: true),
], comment = "made by a test"))

suite "zip_entry":
  test "reads a stored member and a deflated one whole":
    check readZipEntry(book, "mimetype", 0, 1000) == "application/epub+zip"
    check readZipEntry(book, "META-INF/container.xml", 0, 1000).contains("OEBPS/content.opf")
    check zipEntrySize(book, "OEBPS/chapter 1.xhtml") == chapter.len
    check readZipEntry(book, "OEBPS/chapter 1.xhtml", 0, chapter.len) == chapter

  test "reads a slice anywhere in a deflated member, past the inflate window":
    for (offset, length) in [(0, 10), (5, 100), (40_000, 1000), (200_000, 70_000), (chapter.len - 7, 100)]:
      let got = readZipEntry(book, "OEBPS/chapter 1.xhtml", offset, length)
      check got == chapter[offset ..< min(chapter.len, offset + length)]
    check readZipEntry(book, "OEBPS/chapter 1.xhtml", chapter.len + 5, 10) == ""
    check readZipEntry(book, "mimetype", 12, 3) == "epu"

  test "refuses what it cannot read, in words":
    expect ZipEntryError:
      discard readZipEntry(book, "OEBPS/missing.xhtml", 0, 10)
    writeFile(dir / "notes.txt", "not a zip at all, just text that is long enough")
    expect ZipEntryError:
      discard readZipEntry(dir / "notes.txt", "mimetype", 0, 10)
    # Cut off before the end record: no directory to find.
    let whole = readFile(book)
    writeFile(dir / "cut.epub", whole[0 ..< whole.len div 2])
    expect ZipEntryError:
      discard readZipEntry(dir / "cut.epub", "mimetype", 0, 10)
    # A member whose data is damaged fails, never returns garbage.
    var broken = whole
    let at = broken.find("OEBPS/chapter 1.xhtml") + "OEBPS/chapter 1.xhtml".len + 10
    for i in at ..< at + 40: broken[i] = char(0xFF)
    writeFile(dir / "broken.epub", broken)
    var failed = false
    try:
      let got = readZipEntry(dir / "broken.epub", "OEBPS/chapter 1.xhtml", 0, chapter.len)
      failed = got != chapter
    except ZipEntryError:
      failed = true
    check failed

removeDir(dir)
