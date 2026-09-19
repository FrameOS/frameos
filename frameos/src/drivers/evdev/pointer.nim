## Pointer arithmetic for the evdev driver, kept apart from libevdev so it is
## testable on a machine without it.

const PointerRange* = 32767
  ## The host's contract for a `mouseMove` payload (frameos/runner scales it
  ## to the panel): 0..32767 on both axes, whatever the device reports.

proc scalePointerAxis*(value, minimum, maximum: int): int =
  ## USB digitizers already report 0..32767. A kernel touchscreen reports its
  ## own range — 0..479 on a HyperPixel 4.0 — which, read as the former, lands
  ## every touch in the top-left corner. An axis that declares no usable range
  ## passes through untouched, which is what this driver always did.
  if maximum <= minimum:
    return value
  let clamped = max(minimum, min(maximum, value))
  int((clamped - minimum).int64 * PointerRange div (maximum - minimum).int64)
