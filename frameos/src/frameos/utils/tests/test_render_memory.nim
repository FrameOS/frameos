## When a frame lets go of the JS interpreters it keeps between renders
## (utils/memory.nim): a decode short of memory releases them first, and so
## does an image allocation that does not fit; a render's start and an SVG
## frame never do, and after a render that decoded nothing they stay down to
## KeepInterpretersBytes of headroom.

import ../memory

var released = 0
proc fakeRelease(): bool {.nimcall, raises: [].} =
  inc released
  true
renderMemoryReleaseHook = fakeRelease

block:
  # Short of memory (1.5 MB of headroom, under RenderMemoryShortBytes): a
  # render's start and its SVG frames leave the interpreters be, and they
  # stay after a render that decoded nothing.
  availableRenderBytesOverride = 1536 * 1024
  refreshDecodeBudget(forDecode = false)
  refreshDecodeBudgetInto(forDecode = false)
  doAssert released == 0
  doAssert keepIdleInterpreters()

block:
  # A decode, still short: they go first, and the render that decoded
  # settles with the higher floor; the next render, decoding nothing, keeps.
  refreshDecodeBudget()
  doAssert released == 1
  doAssert not keepIdleInterpreters()
  doAssert keepIdleInterpreters()
  refreshDecodeBudgetInto()
  doAssert released == 2
  doAssert not keepIdleInterpreters()

block:
  # Under KeepInterpretersBytes they go even after a render that decoded nothing.
  availableRenderBytesOverride = 512 * 1024
  doAssert not keepIdleInterpreters()

block:
  # Plenty of memory: a decode releases nothing, and they stay after it.
  availableRenderBytesOverride = 3 * 1024 * 1024
  refreshDecodeBudget()
  doAssert released == 2
  doAssert keepIdleInterpreters()

block:
  # An image allocation that does not fit releases them before it is refused.
  availableRenderBytesOverride = 1024 * 1024
  ensureRenderAllocation(512 * 1024, "a small image")
  doAssert released == 2
  var refused = false
  try:
    ensureRenderAllocation(2 * 1024 * 1024, "a big image")
  except CatchableError:
    refused = true
  doAssert refused and released == 3
  doAssert releaseRenderMemory() and released == 4

echo "render memory ok"
