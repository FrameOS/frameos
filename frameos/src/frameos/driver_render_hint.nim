## Render-timing hints between the host runtime and the panel drivers.
##
## Two directions, both thread-local, both read on the render thread:
##
## * **host → driver** (`setNextRenderSeconds` / `nextRenderSeconds`): how long
##   until the next scheduled pass. Set around every `drivers.render` call, so
##   a driver can pick between a cheap partial refresh and a full one.
## * **driver → host** (`requestEarlierRender` / `takeEarlierRenderRequest`):
##   "call me back sooner than that". A driver that cannot draw yet — the
##   framebuffer waiting for a KMS modeset is the live example — is otherwise
##   re-probed only when the next render comes round, which on an hour-long
##   interval means an hour of blank panel after a boot that was seconds from
##   working.
##
## A driver `.so` carries its own copy of these variables, because it carries
## its own ORC runtime (`frameos/driver_abi`), so a request written inside the
## library does not simply appear in the host. The generated library exports
## `frameos_driver_earlier_render_seconds`; the host polls it after each render
## and folds the answer into its own copy through `requestEarlierRender`.
## Statically linked drivers share the host's copy and skip the round trip.
## Only a float ever crosses the boundary.
##
## The request is *advisory*, and it asks for a DRIVER callback — not a render.
## The runner takes the earliest one asked for since the last pass, clamps it to
## a floor so a driver cannot spin the loop, and then, during its sleep, calls
## the driver again with the frame it already has. The scene's own schedule is
## untouched.
##
## That distinction is the whole design. Re-rendering the scene to satisfy a
## driver runs its apps — HTTP fetches, image generation — to produce a frame
## the driver was already handed, and a panel that never appears would pay that
## every backoff step forever. Ask for a callback; the pixels are already
## drawn.

import std/options

var
  hasNextRenderSeconds {.threadvar.}: bool
  nextRenderSecondsValue {.threadvar.}: float
  hasEarlierRenderRequest {.threadvar.}: bool
  earlierRenderRequestValue {.threadvar.}: float

proc setNextRenderSeconds*(seconds: float) =
  if seconds < 0:
    hasNextRenderSeconds = false
    nextRenderSecondsValue = 0
  else:
    hasNextRenderSeconds = true
    nextRenderSecondsValue = seconds

proc clearNextRenderSeconds*() =
  hasNextRenderSeconds = false
  nextRenderSecondsValue = 0

proc nextRenderSeconds*(): Option[float] =
  if hasNextRenderSeconds:
    some(nextRenderSecondsValue)
  else:
    none(float)

proc requestEarlierRender*(seconds: float) =
  ## Ask for another render pass in `seconds`. Negative values and NaN mean
  ## "no request" — that is what the ABI's `-1` return arrives as, and what a
  ## driver that has nothing to ask for sends. Several requests in one pass
  ## collapse to the earliest: two drivers waiting on different hardware both
  ## get served by the sooner of the two wake-ups.
  if seconds < 0 or seconds != seconds:
    return
  if not hasEarlierRenderRequest or seconds < earlierRenderRequestValue:
    hasEarlierRenderRequest = true
    earlierRenderRequestValue = seconds

proc takeEarlierRenderRequest*(): Option[float] =
  ## Read and clear. A request stands for exactly one pass; a driver that is
  ## still not ready asks again from its next render.
  if hasEarlierRenderRequest:
    result = some(earlierRenderRequestValue)
  else:
    result = none(float)
  hasEarlierRenderRequest = false
  earlierRenderRequestValue = 0

proc clearEarlierRenderRequest*() =
  hasEarlierRenderRequest = false
  earlierRenderRequestValue = 0

# ---------------------------------------------------------------------------
# driver → host: the display geometry a driver found out AFTER init.
#
# The framebuffer driver on a Pi 5 may see /dev/fb0 register only after boot;
# its render-time probe then knows the real mode, and the host's FrameConfig
# (and frame.json, via frameos/display_detect) should follow. Same transport
# as the earlier-render request: the driver writes into ITS copy of this
# module, the generated library exports `frameos_driver_detected_display_size`
# (width << 32 | height, 0 for "nothing new"), the host polls it after each
# render and folds it in with `reportDetectedDisplaySize`. Two ints cross the
# boundary; no ref is kept on either side (frameos/driver_abi).

var
  hasDetectedDisplaySize {.threadvar.}: bool
  detectedDisplayWidth {.threadvar.}: int
  detectedDisplayHeight {.threadvar.}: int

proc reportDetectedDisplaySize*(width, height: int) =
  if width <= 0 or height <= 0:
    return
  hasDetectedDisplaySize = true
  detectedDisplayWidth = width
  detectedDisplayHeight = height

proc takeDetectedDisplaySize*(): Option[(int, int)] =
  ## The last reported geometry, cleared on read.
  if not hasDetectedDisplaySize:
    return none((int, int))
  hasDetectedDisplaySize = false
  some((detectedDisplayWidth, detectedDisplayHeight))

proc packDetectedDisplaySize*(): uint64 =
  ## `takeDetectedDisplaySize` as the single integer that crosses the `.so`
  ## boundary: width in the high 32 bits, height in the low, 0 when nothing.
  let size = takeDetectedDisplaySize()
  if size.isNone:
    return 0
  (size.get()[0].uint64 shl 32) or (size.get()[1].uint64 and 0xFFFFFFFF'u64)

proc unpackDetectedDisplaySize*(packed: uint64): Option[(int, int)] =
  if packed == 0:
    return none((int, int))
  some(((packed shr 32).int, (packed and 0xFFFFFFFF'u64).int))
