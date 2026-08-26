## The frame's wall clock: an epoch expressed in the configured time zone,
## via chrono and the tz tables lib/tz loads at startup. Kept apart from
## utils/time.nim, which the display-driver shared libraries also compile —
## they have no business carrying chrono.

import std/[strutils, times]
import chrono

proc frameLocalTime*(timeZone: string, epoch: float): DateTime =
  ## `epoch` as the wall clock of the frame's configured zone, not the
  ## process's. The two used to be assumed equal — but `frameos setup` is what
  ## writes /etc/localtime, and a cloud-provisioned or cloud-retimed frame
  ## changes frame.json without it, so the process stayed on UTC and a "01:02"
  ## schedule entry fired at 03:02 CEST. Only the calendar fields are
  ## meaningful (hour, minute, weekday); the DateTime is tagged UTC whatever
  ## the zone, so format it, never convert it.
  let zone = timeZone.strip()
  if zone.len == 0 or zone == "UTC":
    return if zone == "UTC": epoch.fromUnixFloat().utc() else: epoch.fromUnixFloat().local()
  try:
    # chrono reads the loaded tz tables (lib/tz, loaded once at startup and
    # only ever replaced under its own lock), hence the cast.
    {.cast(gcsafe).}:
      let cal = epoch.Timestamp.calendar(zone)
      if findTimeZone(zone).valid:
        return dateTime(cal.year, times.Month(cal.month), cal.day, cal.hour, cal.minute, cal.second, zone = utc())
  except CatchableError:
    discard
  # Unknown zone (or no tz data, as on the embedded build): the process clock.
  epoch.fromUnixFloat().local()

proc frameLocalNow*(timeZone: string): DateTime =
  frameLocalTime(timeZone, epochTime())
