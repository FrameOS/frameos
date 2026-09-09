## The wall clock as the apps see it. `frameNow()` is `times.now()` on every
## frame; the e2e snapshot harness (e2e/makesnapshots.py) pins it with
## FRAMEOS_E2E_FIXED_EPOCH so a clock face or a calendar's "today" renders
## the same bytes on every run. The pinned instant is read in UTC so the
## runner's zone does not leak into the snapshot either.

import std/times

when defined(frameosEmbedded):
  proc frameNow*(): DateTime = now()
else:
  import std/[os, strutils]

  proc fixedEpoch(): int64 =
    ## 0 when the clock is not pinned.
    let raw = getEnv("FRAMEOS_E2E_FIXED_EPOCH").strip()
    if raw.len == 0:
      return 0
    try:
      result = parseBiggestInt(raw)
    except ValueError:
      result = 0

  proc frameNow*(): DateTime =
    let fixed = fixedEpoch()
    if fixed > 0:
      return fromUnix(fixed).utc()
    now()
