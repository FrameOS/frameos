import std/[os, unittest]
import pixie
import ../spool
import ../utils/image
import ../utils/memory

# The image side's disk tier (docs/value-pipeline.md): an image spilled to a
# file as raw premultiplied RGBX rows, and materialized back byte for byte.
# The tier's promise is exactness — the file is the image a memory cache would
# have held — so these pin the roundtrip (owner and strided view alike), the
# ownership of the file, and that every failure mode answers nil instead of
# raising or lying.

const ScratchDir = "tmp/image-spool-tests"

# The spill probe creates only the leaf directory (the on-device assets root
# is the SD mount and always exists); give the tests theirs deterministically.
createDir(ScratchDir)

proc patterned(width, height: int): Image =
  ## Every pixel distinct, so a stride bug cannot cancel out.
  result = newImage(width, height)
  for y in 0 ..< height:
    for x in 0 ..< width:
      result.data[result.dataIndex(x, y)] =
        rgbx(uint8(x * 16 + 1), uint8(y * 16 + 2), uint8((x + y) * 8 + 3), 255)

suite "image spool roundtrip":
  test "an owner spills and materializes byte for byte":
    let source = patterned(8, 6)
    let spool = spillImageToSpool(source, "owner.rgbx", ScratchDir)
    check not spool.isNil
    check spool.width == 8 and spool.height == 6
    check getFileSize(spool.path()) == 8 * 6 * 4
    let back = materializeImageSpool(spool)
    check not back.isNil
    for y in 0 ..< 6:
      for x in 0 ..< 8:
        check back.data[back.dataIndex(x, y)] ==
          source.data[source.dataIndex(x, y)]

  test "a view spills exactly its own rectangle":
    # Inside a render/split cell the live canvas is a view; a cached producer
    # under one hands the cache a strided rectangle. The file must hold that
    # rectangle's rows and nothing of the buffer around them.
    let owner = patterned(8, 6)
    let cell = owner.view(2, 1, 4, 3)
    let spool = spillImageToSpool(cell, "view.rgbx", ScratchDir)
    check not spool.isNil
    check spool.width == 4 and spool.height == 3
    check getFileSize(spool.path()) == 4 * 3 * 4
    let back = materializeImageSpool(spool)
    check not back.isNil
    for y in 0 ..< 3:
      for x in 0 ..< 4:
        check back.data[back.dataIndex(x, y)] ==
          owner.data[owner.dataIndex(x + 2, y + 1)]

suite "image spool ownership and failure":
  test "the file belongs to the spool and leaves with it":
    var spool = spillImageToSpool(patterned(4, 4), "owned.rgbx", ScratchDir)
    check not spool.isNil
    let path = spool.path()
    check fileExists(path)
    spool = nil
    GC_fullCollect()
    check not fileExists(path)

  test "a truncated file materializes as nil, never as a wrong image":
    let spool = spillImageToSpool(patterned(4, 4), "trunc.rgbx", ScratchDir)
    check not spool.isNil
    writeFile(spool.path(), "not enough bytes")
    check materializeImageSpool(spool).isNil

  test "a vanished file materializes as nil":
    let spool = spillImageToSpool(patterned(4, 4), "gone.rgbx", ScratchDir)
    check not spool.isNil
    removeFile(spool.path())
    check materializeImageSpool(spool).isNil

  test "materializing refuses an allocation that will not fit":
    # The floor read must not be the thing that OOMs the device; past the
    # live-memory budget the honest answer is "miss", not an allocation.
    let spool = spillImageToSpool(patterned(8, 8), "budget.rgbx", ScratchDir)
    check not spool.isNil
    availableRenderBytesOverride = 16
    check materializeImageSpool(spool).isNil
    availableRenderBytesOverride = 0
    check not materializeImageSpool(spool).isNil

  test "nowhere to write answers nil and nothing raises":
    check spillImageToSpool(nil, "nil.rgbx", ScratchDir).isNil
