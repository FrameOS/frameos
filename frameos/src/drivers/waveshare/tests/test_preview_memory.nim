import std/[options, posix, strformat, strutils, unittest]

import drivers/waveshare/preview
from drivers/waveshare/color import ColorOption

const
  PanelWidth = 1872
  PanelHeight = 1404
  MiB = 1024'i64 * 1024'i64

type
  MemorySample = object
    data: int64
    virtual: int64
    swap: int64

proc processMemorySample(): Option[MemorySample] =
  var
    sample: MemorySample
    hasData = false
    hasVirtual = false
    hasSwap = false

  try:
    for line in readFile("/proc/" & $getpid() & "/status").splitLines():
      let parts = line.splitWhitespace()
      if parts.len < 2:
        continue

      if line.startsWith("VmData:"):
        let bytes = parseBiggestInt(parts[1]).int64 * 1024
        sample.data = bytes
        hasData = true
      elif line.startsWith("VmSize:"):
        let bytes = parseBiggestInt(parts[1]).int64 * 1024
        sample.virtual = bytes
        hasVirtual = true
      elif line.startsWith("VmSwap:"):
        let bytes = parseBiggestInt(parts[1]).int64 * 1024
        sample.swap = bytes
        hasSwap = true
  except CatchableError:
    return none(MemorySample)

  if hasData and hasVirtual and hasSwap:
    some(sample)
  else:
    none(MemorySample)

proc makeGrayPixels(): seq[uint8] =
  result = newSeq[uint8](PanelWidth * PanelHeight)
  for index in 0 ..< result.len:
    result[index] = (index mod 16).uint8

proc assertMemoryGrowthBelow(
  name: string,
  iterations: int,
  maxDataGrowth: int64,
  maxVirtualGrowth: int64,
  maxSwapGrowth: int64,
  operation: proc(): int
) =
  GC_fullCollect()
  let before = processMemorySample()
  if before.isNone:
    checkpoint name & ": /proc process memory fields unavailable"
    check true
    return

  var totalBytes = 0
  for _ in 0 ..< iterations:
    totalBytes += operation()

  GC_fullCollect()
  let after = processMemorySample()
  check after.isSome
  if after.isNone:
    return

  let
    start = before.get()
    finish = after.get()
    dataGrowth = finish.data - start.data
    virtualGrowth = finish.virtual - start.virtual
    swapGrowth = finish.swap - start.swap

  checkpoint &"{name}: data={dataGrowth}, virtual={virtualGrowth}, swap={swapGrowth}, bytes={totalBytes}"
  check dataGrowth <= maxDataGrowth
  check virtualGrowth <= maxVirtualGrowth
  check swapGrowth <= maxSwapGrowth

suite "waveshare preview memory":
  setup:
    resetPreviewCacheForTest()

  teardown:
    resetPreviewCacheForTest()

  test "cached sixteen gray preview polling does not grow process memory":
    let pixels = makeGrayPixels()
    setLastGrayImage(pixels, 15)

    let first = toCachedPreviewPng(ColorOption.SixteenGray, PanelWidth, PanelHeight, 0, "horizontal")
    check first.len > 0

    assertMemoryGrowthBelow(
      "cached sixteen gray preview polling",
      iterations = 1000,
      maxDataGrowth = 2 * MiB,
      maxVirtualGrowth = 2 * MiB,
      maxSwapGrowth = MiB,
      operation = proc(): int =
        toCachedPreviewPng(ColorOption.SixteenGray, PanelWidth, PanelHeight, 0, "horizontal").len
    )

  test "repeated sixteen gray preview encodes do not grow process memory linearly":
    let pixels = makeGrayPixels()

    setLastGrayImage(pixels, 15)
    discard toCachedPreviewPng(ColorOption.SixteenGray, PanelWidth, PanelHeight, 0, "horizontal")
    setLastGrayImage(pixels, 15)
    discard toCachedPreviewPng(ColorOption.SixteenGray, PanelWidth, PanelHeight, 0, "horizontal")

    assertMemoryGrowthBelow(
      "uncached sixteen gray preview encodes",
      iterations = 8,
      maxDataGrowth = 64 * MiB,
      maxVirtualGrowth = 64 * MiB,
      maxSwapGrowth = 16 * MiB,
      operation = proc(): int =
        setLastGrayImage(pixels, 15)
        toCachedPreviewPng(ColorOption.SixteenGray, PanelWidth, PanelHeight, 0, "horizontal").len
    )
