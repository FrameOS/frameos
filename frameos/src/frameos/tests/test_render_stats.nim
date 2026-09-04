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
    # A slower one: 100 ms + 60 ms -> a frame every 0.8 s (20% duty).
    check abs(pacedRenderInterval(0.1, 0.06) - 0.8) < 1e-9
    # A slow one is capped at a step a second (a Zero 2 W pushing 1080p
    # costs ~0.65 s a frame; 20% duty would mean a 3 s step, which reads
    # as broken), so the screen still moves.
    check abs(pacedRenderInterval(0.2, 0.2) - 1.0) < 1e-9
    check pacedRenderInterval(5.0, 5.0) == 1.0
    # Duty cycle is a parameter.
    check abs(pacedRenderInterval(0.1, 0.0, dutyCycle = 0.5) - 0.2) < 1e-9
