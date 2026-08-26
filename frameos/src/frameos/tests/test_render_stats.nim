import std/unittest
import ../render_stats

suite "render pacing":
  test "the driver time round-trips":
    noteDriverRenderSeconds(0.25)
    check lastDriverRenderSeconds() == 0.25
    noteDriverRenderSeconds(-1.0)
    check lastDriverRenderSeconds() == 0.0

  test "the interval keeps drawing to a fifth of the time, within bounds":
    # A fast board: 10 ms to draw + 10 ms to push -> floor of 100 ms.
    check pacedRenderInterval(0.01, 0.01) == 0.1
    # A slow one: 200 ms + 200 ms -> a frame every 2 s (20% duty).
    check abs(pacedRenderInterval(0.2, 0.2) - 2.0) < 1e-9
    # A hopeless one is capped, so the screen still moves.
    check pacedRenderInterval(5.0, 5.0) == 3.0
    # Duty cycle is a parameter.
    check abs(pacedRenderInterval(0.1, 0.0, dutyCycle = 0.5) - 0.2) < 1e-9
