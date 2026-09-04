## How long the last display-driver render took, shared from the runner (and
## the boot screen) to whoever paces itself by it. The animated status screen
## is the consumer: a Pi that needs 400 ms to push a 1080p frame through
## /dev/fb0 must not be asked for ten of them a second.

import std/locks

var statsLock: Lock
initLock(statsLock)
var driverRenderSeconds = 0.0

proc noteDriverRenderSeconds*(seconds: float) {.gcsafe.} =
  {.gcsafe.}:
    withLock statsLock:
      driverRenderSeconds = max(seconds, 0.0)

proc lastDriverRenderSeconds*(): float {.gcsafe.} =
  ## 0.0 until a driver has rendered once.
  {.gcsafe.}:
    withLock statsLock:
      result = driverRenderSeconds

proc pacedRenderInterval*(sceneSeconds: float, driverSeconds: float,
    dutyCycle = 0.2, minSeconds = 0.1, maxSeconds = 1.0): float =
  ## Seconds to wait between animation frames so that drawing + pushing a
  ## frame takes at most `dutyCycle` of the time: a fast board animates
  ## smoothly, a slow one steps — neither pegs its CPU showing a logo. The
  ## ceiling is one step a second: a Zero 2 W pushing 1080p (~0.65 s a
  ## frame) spends most of one of its four cores on the logo rather than
  ## stepping every three seconds, which reads as broken.
  let cost = max(sceneSeconds, 0.0) + max(driverSeconds, 0.0)
  clamp(cost / dutyCycle, minSeconds, maxSeconds)
