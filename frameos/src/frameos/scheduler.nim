import chrono
import json
import frameos/hal/clock
import times
import strformat, strutils
import frameos/types
import frameos/channels
import frameos/utils/local_time
import sequtils

var thread: Thread[FrameOS]

# Returns the weekday as 1=Monday..7=Sunday
proc weekdayMonSun(dt: DateTime): int =
  return dt.weekday.ord + 1

# Checks if `ScheduledEvent`'s weekday matches today
proc weekdayMatches(eventWeekday: int, dt: DateTime): bool =
  # 0 = every day
  # 1..7 = mon..sun
  # 8 = every weekday (Mon-Fri)
  # 9 = every weekend (Sat-Sun)
  let today = weekdayMonSun(dt) # 1..7
  case eventWeekday
  of 0:
    return true # runs every day
  of 1..7:
    return eventWeekday == today
  of 8:
    # Monday=1..Friday=5
    return today >= 1 and today <= 5
  of 9:
    # Saturday=6..Sunday=7
    return today >= 6 and today <= 7
  else:
    # If for some reason out of range, just ignore
    return false

proc nextDueDescription*(schedule: FrameSchedule, dt: DateTime): string =
  ## "Mon 01:02 reboot" for the entry that fires soonest after `dt`; "" when
  ## there is none. Weekday sets (0/8/9) resolve to the next matching day.
  var best = -1
  var bestEvent = ""
  let nowMinutes = dt.hour * 60 + dt.minute
  for ev in schedule.events:
    for dayOffset in 0 .. 7:
      let candidate = dt + initDuration(days = dayOffset)
      if not weekdayMatches(ev.weekday, candidate):
        continue
      let minutes = ev.hour * 60 + ev.minute
      if dayOffset == 0 and minutes <= nowMinutes:
        continue
      let total = dayOffset * 24 * 60 + minutes
      if best < 0 or total < best:
        best = total
        bestEvent = &"{candidate.format(\"ddd\")} {ev.hour:02}:{ev.minute:02} {ev.event}"
      break
  bestEvent

proc logScheduleSummary*(self: Scheduler, dt: DateTime) =
  ## On start and after every schedule change: how many entries there are and
  ## which one is next, in the frame's zone — so "did it schedule?" has an
  ## answer in the logs before the entry fires.
  let schedule = self.frameConfig.schedule
  let count = if schedule == nil: 0 else: schedule.events.len
  var payload = %*{
    "event": "scheduler:loaded",
    "entries": count,
    "timeZone": self.frameConfig.timeZone,
    "localTime": dt.format("yyyy-MM-dd HH:mm"),
  }
  if count > 0:
    payload["nextDue"] = %nextDueDescription(schedule, dt)
  log(payload)

proc handleSchedule*(self: Scheduler, dt: DateTime) =
  # do everything except sleeping or looping
  # Read through the config every minute: a reload swaps the schedule object
  # under us (config.nim updateFrameConfigFrom), and a stale copy would keep
  # firing yesterday's events.
  let schedule = self.frameConfig.schedule
  if schedule == nil:
    return
  let matched = schedule.events.filter(proc(ev: ScheduledEvent): bool =
    ev.minute == dt.minute and ev.hour == dt.hour and weekdayMatches(ev.weekday, dt)
  )

  if self.frameConfig.debug and len(matched) > 0:
    log(%*{
      "event": "scheduler:debug",
      "hour": dt.hour,
      "minute": dt.minute,
      "weekday": ord(dt.weekday),
      "matched": len(matched)
    })

  for ev in matched:
    log(%*{
      "event": "scheduler:fire",
      "id": ev.id,
      "action": ev.event,
      "localTime": dt.format("yyyy-MM-dd HH:mm"),
      "timeZone": self.frameConfig.timeZone,
      "payload": ev.payload,
    })
    sendEvent(ev.event, ev.payload)

proc minuteKey(dt: DateTime): int64 =
  dt.toTime().toUnix() div 60

proc start*(self: Scheduler) =
  # NTP step corrections (routine on RTC-less Pis) can replay or repeat a
  # wall-clock minute. Track the last fired minute so events never fire twice;
  # a step backwards of more than two minutes is accepted as a clock
  # correction and scheduling resumes from the new time.
  var lastFiredMinute = int64.low
  var lastSchedule: FrameSchedule = nil
  while true:
    let dt = frameLocalNow(self.frameConfig.timeZone)
    # A config reload swaps the schedule object; say what the new one holds.
    if self.frameConfig.schedule != lastSchedule:
      lastSchedule = self.frameConfig.schedule
      self.logScheduleSummary(dt)
    let minute = minuteKey(dt)
    if minute > lastFiredMinute or minute < lastFiredMinute - 2:
      self.handleSchedule(dt)
      lastFiredMinute = minute
    # Sleep until next minute
    let now2 = frameLocalNow(self.frameConfig.timeZone)
    if now2.minute == dt.minute:
      let secondsToSleep = 60 - now2.second
      sleepMs(secondsToSleep * 1000)
    else:
      sleepMs(200) # the clock moved mid-iteration; re-check soon without spinning

proc createThreadRunner(frameOS: FrameOS) {.thread.} =
  var scheduler = Scheduler(
    frameConfig: frameOS.frameConfig,
    logger: frameOS.logger,
  )
  scheduler.start()

proc startScheduler*(frameOS: FrameOS) =
  createThread(thread, createThreadRunner, frameOS)
