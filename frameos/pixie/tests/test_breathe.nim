## renderBreathe: a host hook pixie calls from its long loops (common.nim), so
## an ESP32 render of tens of seconds lets its core's idle task run.
import pixie

var calls = 0
proc counting() {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    inc calls

block:
  renderBreathe = counting
  let image = newImage(200, 120)
  image.fillPath(
    """M 10 10 C 80 0 120 100 190 110 L 20 110 Z""",
    rgba(255, 0, 0, 255)
  )
  doAssert calls >= 50, "a fill calls it about once a scanline: " & $calls
  let fillCalls = calls
  let other = newImage(150, 90)
  other.fill(rgba(0, 0, 255, 128))
  image.draw(other, translate(vec2(5, 7)))
  doAssert calls > fillCalls, "a blit calls it once a row"
  let blitCalls = calls
  image.drawResampled(other, 0, 0, 180, 100)
  doAssert calls > blitCalls, "a resample calls it once a row"
  renderBreathe = nil
  let before = calls
  image.fillPath("M 0 0 L 50 0 L 50 50 Z", rgba(0, 255, 0, 255))
  doAssert calls == before, "nil: nothing is called"
  echo "renderBreathe: ok (", calls, " calls)"
