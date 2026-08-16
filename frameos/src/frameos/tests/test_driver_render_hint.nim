import std/[options, unittest]
import ../driver_render_hint

suite "driver render hints":
  setup:
    clearNextRenderSeconds()
    clearEarlierRenderRequest()

  test "host to driver: the next render distance round-trips":
    check nextRenderSeconds().isNone
    setNextRenderSeconds(12.5)
    check nextRenderSeconds() == some(12.5)
    clearNextRenderSeconds()
    check nextRenderSeconds().isNone

  test "host to driver: a negative distance means no hint":
    setNextRenderSeconds(-1.0)
    check nextRenderSeconds().isNone

  test "driver to host: a request is read once":
    check takeEarlierRenderRequest().isNone
    requestEarlierRender(2.0)
    check takeEarlierRenderRequest() == some(2.0)
    # Reading clears it: the request stands for one pass, and a driver that is
    # still not ready asks again from its next render.
    check takeEarlierRenderRequest().isNone

  test "driver to host: several drivers collapse to the earliest":
    requestEarlierRender(30.0)
    requestEarlierRender(4.0)
    requestEarlierRender(19.0)
    check takeEarlierRenderRequest() == some(4.0)

  test "driver to host: -1 and NaN are 'nothing to ask for'":
    # -1 is what the ABI returns for a driver with no request, and what a
    # missing/garbage `.so` symbol degrades to; NaN is what an uninitialised
    # float reads as. Neither may become a wake-up.
    requestEarlierRender(-1.0)
    check takeEarlierRenderRequest().isNone
    requestEarlierRender(NaN)
    check takeEarlierRenderRequest().isNone
    # ...and neither may swallow a real request made in the same pass.
    requestEarlierRender(-1.0)
    requestEarlierRender(3.0)
    check takeEarlierRenderRequest() == some(3.0)

  test "driver to host: zero is a legitimate request":
    # The runner clamps it to DRIVER_RETRY_MIN_SECONDS; the hint layer does not
    # second-guess the driver.
    requestEarlierRender(0.0)
    check takeEarlierRenderRequest() == some(0.0)

  test "the two directions do not interfere":
    setNextRenderSeconds(60.0)
    requestEarlierRender(1.0)
    check nextRenderSeconds() == some(60.0)
    clearNextRenderSeconds()
    check takeEarlierRenderRequest() == some(1.0)
