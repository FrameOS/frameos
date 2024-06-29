import chrono
import system

proc initTimeZone*() =
  # TODO: allow users to only load the timezones and years that matter
  const tzData = staticRead("../../assets/tz/tzdata.json")
  loadTzData(tzData)
