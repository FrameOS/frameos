import std/options

var
  hasNextRenderSeconds {.threadvar.}: bool
  nextRenderSecondsValue {.threadvar.}: float

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
