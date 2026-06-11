# import chrono
import json
import os
import times
import frameos/types
import frameos/channels
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

proc handleSchedule*(self: Scheduler, dt: DateTime) =
  # do everything except sleeping or looping
  let matched = self.schedule.events.filter(proc(ev: ScheduledEvent): bool =
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
    sendEvent(ev.event, ev.payload)

proc minuteKey(dt: DateTime): int64 =
  dt.toTime().toUnix() div 60

proc start*(self: Scheduler) =
  # NTP step corrections (routine on RTC-less Pis) can replay or repeat a
  # wall-clock minute. Track the last fired minute so events never fire twice;
  # a step backwards of more than two minutes is accepted as a clock
  # correction and scheduling resumes from the new time.
  var lastFiredMinute = int64.low
  while true:
    let dt = now()
    let minute = minuteKey(dt)
    if minute > lastFiredMinute or minute < lastFiredMinute - 2:
      self.handleSchedule(dt)
      lastFiredMinute = minute
    # Sleep until next minute
    let now2 = now()
    if now2.minute == dt.minute:
      let secondsToSleep = 60 - now2.second
      sleep(secondsToSleep * 1000)
    else:
      sleep(200) # the clock moved mid-iteration; re-check soon without spinning

proc createThreadRunner(frameOS: FrameOS) {.thread.} =
  var scheduler = Scheduler(
    frameConfig: frameOS.frameConfig,
    logger: frameOS.logger,
    schedule: frameOS.frameConfig.schedule
  )
  scheduler.start()

proc startScheduler*(frameOS: FrameOS) =
  createThread(thread, createThreadRunner, frameOS)
