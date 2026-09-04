import unittest
import options
import std/times
import std/json
import std/os
import ../scheduler
import ../utils/local_time
import ../types
import ../logger
import ../channels
import lib/tz

suite "Scheduler Tests (Various Time Configurations)":

  # Helper to clean out the eventChannel for a fresh start each test
  proc clearEventChannel() =
    var done = false
    while not done:
      let (success, _) = eventChannel.tryRecv()
      done = not success

  # Helper to retrieve any triggered events from eventChannel
  proc drainEvents(): seq[(Option[SceneId], string, JsonNode)] =
    result = @[]
    while true:
      let (success, item) = eventChannel.tryRecv()
      if not success: break
      result.add item

  test "weekday=0 triggers every day":
    var config = new(FrameConfig)
    config.debug = false
    config.schedule = FrameSchedule(events: @[
      ScheduledEvent(
        id: "everydayEvent",
        minute: 0,
        hour: 12,
        weekday: 0, # runs every day
      event: "evtEveryDay",
      payload: %*{"info": "Runs daily at 12:00"}
    )
    ])
    let logger = newLogger(config)
    var scheduler = Scheduler(
      frameConfig: config,
      logger: logger,
    )

    # We'll test multiple days: Sunday (weekday=7) -> Monday (1) -> Wednesday (3)
    for dayOffset in [1, 2, 3, 4, 5, 6, 7]: # arbitrary sample
      clearEventChannel()
      let fakeDate = dateTime(2023, mJan, dayOffset, 12, 0, 0)
      scheduler.handleSchedule(fakeDate)
      let triggered = drainEvents()
      check triggered.len == 1
      check triggered[0][1] == "evtEveryDay"

  test "weekday=1 triggers Monday only; skip Sunday":
    var config = new(FrameConfig)
    config.debug = false
    config.schedule = FrameSchedule(events: @[
      ScheduledEvent(
        id: "mondayEvent",
        minute: 0,
        hour: 9,
        weekday: 1, # Monday only
      event: "evtMonday",
      payload: %*{}
    )
    ])
    let logger = newLogger(config)
    var scheduler = Scheduler(
      frameConfig: config,
      logger: logger,
    )

    clearEventChannel()
    # Sunday: day=1 -> 2023-01-01 was a Sunday
    let sundayDate = dateTime(2023, mJan, 1, 9, 0, 0)
    scheduler.handleSchedule(sundayDate)
    let triggeredSun = drainEvents()
    check triggeredSun.len == 0 # shouldn't trigger

    clearEventChannel()
    # Monday: day=2 -> 2023-01-02 was a Monday
    let mondayDate = dateTime(2023, mJan, 2, 9, 0, 0)
    scheduler.handleSchedule(mondayDate)
    let triggeredMon = drainEvents()
    check triggeredMon.len == 1
    check triggeredMon[0][1] == "evtMonday"

  test "weekday=7 triggers Sunday only":
    var config = new(FrameConfig)
    config.debug = false
    config.schedule = FrameSchedule(events: @[
      ScheduledEvent(
        id: "sundayEvent",
        minute: 30,
        hour: 10,
        weekday: 7, # Sunday
      event: "evtSunday",
      payload: %*{}
    )
    ])
    let logger = newLogger(config)
    var scheduler = Scheduler(
      frameConfig: config,
      logger: logger,
    )

    # Sunday test
    clearEventChannel()
    let sunday = dateTime(2023, mJan, 1, 10, 30, 0) # Sunday at 10:30
    scheduler.handleSchedule(sunday)
    let triggersSun = drainEvents()
    check triggersSun.len == 1
    check triggersSun[0][1] == "evtSunday"

    # Monday test
    clearEventChannel()
    let monday = dateTime(2023, mJan, 2, 10, 30, 0) # Monday
    scheduler.handleSchedule(monday)
    check drainEvents().len == 0

  test "weekday=8 triggers Monday–Friday only":
    var config = new(FrameConfig)
    config.schedule = FrameSchedule(events: @[
      ScheduledEvent(
        id: "weekdayEvent",
        minute: 15,
        hour: 8,
        weekday: 8, # Monday–Friday
      event: "evtWeekday",
      payload: %*{}
    )
    ])
    let logger = newLogger(config)
    var scheduler = Scheduler(
      frameConfig: config,
      logger: logger,
    )

    # Monday 8:15 => triggers
    clearEventChannel()
    let mon = dateTime(2023, mJan, 2, 8, 15, 0) # Monday
    scheduler.handleSchedule(mon)
    check drainEvents().len == 1

    # Saturday 8:15 => no triggers
    clearEventChannel()
    let sat = dateTime(2023, mJan, 7, 8, 15, 0) # Saturday
    scheduler.handleSchedule(sat)
    check drainEvents().len == 0

  test "weekday=9 triggers only on weekends (Sat=6, Sun=7)":
    var config = new(FrameConfig)
    config.schedule = FrameSchedule(events: @[
      ScheduledEvent(
        id: "weekendEvent",
        minute: 0,
        hour: 20,
        weekday: 9, # Sat or Sun
      event: "evtWeekend",
      payload: %*{}
    )
    ])
    let logger = newLogger(config)
    var scheduler = Scheduler(
      frameConfig: config,
      logger: logger,
    )

    # Saturday 20:00 => triggers
    clearEventChannel()
    let sat = dateTime(2023, mJan, 7, 20, 0, 0) # Saturday
    scheduler.handleSchedule(sat)
    check drainEvents().len == 1

    # Sunday 20:00 => triggers
    clearEventChannel()
    let sun = dateTime(2023, mJan, 1, 20, 0, 0) # Sunday
    scheduler.handleSchedule(sun)
    check drainEvents().len == 1

    # Monday => no trigger
    clearEventChannel()
    let mon = dateTime(2023, mJan, 2, 20, 0, 0)
    scheduler.handleSchedule(mon)
    check drainEvents().len == 0

  test "hour mismatch => no event triggered":
    var config = new(FrameConfig)
    config.schedule = FrameSchedule(events: @[
      ScheduledEvent(
        id: "hourMismatch",
        minute: 30,
        hour: 10, # triggers only at 10:30
      weekday: 0, # every day
      event: "evtHourly",
      payload: %*{}
    )
    ])
    let logger = newLogger(config)
    var scheduler = Scheduler(
      frameConfig: config,
      logger: logger,
    )

    clearEventChannel()
    let dt = dateTime(2023, mJan, 5, 9, 30, 0) # 9:30 instead of 10:30
    scheduler.handleSchedule(dt)
    check drainEvents().len == 0

  test "minute mismatch => no event triggered":
    var config = new(FrameConfig)
    config.schedule = FrameSchedule(events: @[
      ScheduledEvent(
        id: "minuteMismatch",
        minute: 0,
        hour: 12,
        weekday: 0, # runs daily at 12:00
      event: "evtOnTheHour",
      payload: %*{}
    )
    ])
    let logger = newLogger(config)
    var scheduler = Scheduler(
      frameConfig: config,
      logger: logger,
    )

    clearEventChannel()
    # 12:01 => minute mismatch
    let dt = dateTime(2023, mJan, 5, 12, 1, 0)
    scheduler.handleSchedule(dt)
    check drainEvents().len == 0

  test "multiple events in one schedule triggered":
    var config = new(FrameConfig)
    config.schedule = FrameSchedule(events: @[
      ScheduledEvent(
        id: "multi1",
        minute: 0,
        hour: 12,
        weekday: 0,
        event: "evt1",
        payload: %*{"data": 1}
      ),
      ScheduledEvent(
        id: "multi2",
        minute: 0,
        hour: 12,
        weekday: 0,
        event: "evt2",
        payload: %*{"data": 2}
      )
    ])
    let logger = newLogger(config)
    var scheduler = Scheduler(
      frameConfig: config,
      logger: logger,
    )

    clearEventChannel()
    let dt = dateTime(2023, mJan, 5, 12, 0, 0)
    scheduler.handleSchedule(dt)
    let triggered = drainEvents()
    check triggered.len == 2
    check triggered[0][1] in ["evt1", "evt2"]
    check triggered[1][1] in ["evt1", "evt2"]
    check triggered[0][1] != triggered[1][1]

  test "midnight edge case (hour=0, minute=0)":
    var config = new(FrameConfig)
    config.schedule = FrameSchedule(events: @[
      ScheduledEvent(
        id: "midnightEvent",
        minute: 0,
        hour: 0, # triggers at 00:00
      weekday: 0, # everyday
      event: "evtMidnight",
      payload: %*{}
    )
    ])
    let logger = newLogger(config)
    var scheduler = Scheduler(
      frameConfig: config,
      logger: logger,
    )

    clearEventChannel()
    let dt = dateTime(2023, mJan, 1, 0, 0, 0)
    scheduler.handleSchedule(dt)
    let events = drainEvents()
    check events.len == 1
    check events[0][1] == "evtMidnight"

  test "a scheduled reboot persists its minute and the marker is honoured only briefly":
    # 2026-09-04, Wood7.3: the board was back inside the minute a scheduled
    # reboot fired in and rebooted again. The marker survives the process.
    let dir = getTempDir() / ("frameos-sched-marker-" & $epochTime().int64)
    createDir(dir)
    let previousPath = schedulerFiredMarkerPath
    schedulerFiredMarkerPath = dir / "scheduler-last-fired"
    try:
      var config = new(FrameConfig)
      config.debug = false
      config.schedule = FrameSchedule(events: @[
        ScheduledEvent(id: "nightly", minute: 2, hour: 1, weekday: 0, event: "reboot", payload: %*{}),
        ScheduledEvent(id: "scene", minute: 2, hour: 1, weekday: 0, event: "setCurrentScene",
          payload: %*{"sceneId": "x"}),
      ])
      let logger = newLogger(config)
      var scheduler = Scheduler(frameConfig: config, logger: logger)
      clearEventChannel()
      let fired = dateTime(2026, mSep, 4, 1, 2, 30)
      scheduler.handleSchedule(fired)
      check drainEvents().len == 2
      check fileExists(schedulerFiredMarkerPath)
      let minute = fired.toTime().toUnix() div 60
      check readFile(schedulerFiredMarkerPath) == $minute
      # The new process starts in the same minute: that minute is done.
      check resumeLastFiredMinute(minute) == minute
      check resumeLastFiredMinute(minute + 3) == minute
      # Long after, or before (clock stepped back): a fresh start.
      check resumeLastFiredMinute(minute + 4) == int64.low
      check resumeLastFiredMinute(minute - 1) == int64.low
      # A scene-only minute writes no marker.
      removeFile(schedulerFiredMarkerPath)
      config.schedule = FrameSchedule(events: @[
        ScheduledEvent(id: "scene", minute: 5, hour: 1, weekday: 0, event: "setCurrentScene",
          payload: %*{"sceneId": "x"}),
      ])
      clearEventChannel()
      scheduler.handleSchedule(dateTime(2026, mSep, 4, 1, 5, 0))
      check drainEvents().len == 1
      check not fileExists(schedulerFiredMarkerPath)
      # No marker at all: never fired.
      check resumeLastFiredMinute(minute) == int64.low
    finally:
      schedulerFiredMarkerPath = previousPath
      removeDir(dir)

suite "Scheduler time zone":
  # 2026-08-21 23:02 UTC = 2026-08-22 01:02 CEST (Europe/Brussels, DST).
  const epoch = 1787353320.0

  test "the frame's zone decides the wall clock, not the process zone":
    initTimeZone()
    let brussels = frameLocalTime("Europe/Brussels", epoch)
    check brussels.hour == 1
    check brussels.minute == 2
    check brussels.monthday == 22
    check brussels.weekday == dSat
    let utcTime = frameLocalTime("UTC", epoch)
    check utcTime.hour == 23
    check utcTime.monthday == 21
    let tokyo = frameLocalTime("Asia/Tokyo", epoch)
    check tokyo.hour == 8
    check tokyo.monthday == 22

  test "an unknown zone falls back to the process clock":
    let fallback = frameLocalTime("Mars/Olympus", epoch)
    check fallback == epoch.fromUnixFloat().local()

  test "a 01:02 reboot entry fires at 01:02 Brussels time":
    var config = new(FrameConfig)
    config.timeZone = "Europe/Brussels"
    config.schedule = FrameSchedule(events: @[
      ScheduledEvent(id: "nightly", minute: 2, hour: 1, weekday: 0, event: "reboot", payload: %*{})
    ])
    let scheduler = Scheduler(frameConfig: config, logger: newLogger(config))
    while eventChannel.tryRecv()[0]: discard
    scheduler.handleSchedule(frameLocalTime(config.timeZone, epoch))
    let (fired, item) = eventChannel.tryRecv()
    check fired
    check item[1] == "reboot"
    # The same instant read as UTC (23:02) must not fire it.
    scheduler.handleSchedule(frameLocalTime("UTC", epoch))
    check not eventChannel.tryRecv()[0]

  test "a schedule entry cannot fire uploadScenes":
    # Schedules are data from frame.json, the backend or the cloud; the
    # runner's uploadScenes replaces every installed scene with no origin
    # stamp, so a schedule must not be a way around the push-path guards.
    var config = new(FrameConfig)
    config.timeZone = "Europe/Brussels"
    config.schedule = FrameSchedule(events: @[
      ScheduledEvent(id: "smuggle", minute: 2, hour: 1, weekday: 0, event: "uploadScenes",
                     payload: %*{"scenes": []}),
      ScheduledEvent(id: "nightly", minute: 2, hour: 1, weekday: 0, event: "reboot", payload: %*{})
    ])
    let scheduler = Scheduler(frameConfig: config, logger: newLogger(config))
    while eventChannel.tryRecv()[0]: discard
    scheduler.handleSchedule(frameLocalTime(config.timeZone, epoch))
    let (fired, item) = eventChannel.tryRecv()
    check fired
    check item[1] == "reboot"
    check not eventChannel.tryRecv()[0]

  test "next due entry is described in the frame's zone":
    let schedule = FrameSchedule(events: @[
      ScheduledEvent(id: "a", minute: 2, hour: 1, weekday: 0, event: "reboot", payload: %*{}),
      ScheduledEvent(id: "b", minute: 30, hour: 7, weekday: 8, event: "render", payload: %*{}),
    ])
    # Saturday 01:02 → the weekday-only 07:30 is Monday; the daily 01:02 is tomorrow.
    let sat = frameLocalTime("Europe/Brussels", epoch)
    check nextDueDescription(schedule, sat) == "Sun 01:02 reboot"
    check nextDueDescription(FrameSchedule(events: @[schedule.events[1]]), sat) == "Mon 07:30 render"
    check nextDueDescription(FrameSchedule(events: @[]), sat) == ""
