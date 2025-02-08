import unittest
import std/times
import std/json

# Import what we need from FrameOS
import ../scheduler # Where Scheduler is defined
import ../types # FrameOS types
import ../logger # For log, etc.
import ../channels # For eventChannel

# We assume you refactored scheduler to define:
#   proc handleSchedule*(self: Scheduler, dt: DateTime)

suite "Scheduler Tests":

  # Helper to clear the eventChannel before each test
  proc clearEventChannel() =
    var done = false
    while not done:
      let (success, _) = eventChannel.tryRecv()
      done = not success

  test "Scheduler triggers expected event exactly at 12:00 Monday":
    ## 1. Setup a test config
    var config = new(FrameConfig)
    config.debug = false
    config.schedule = FrameSchedule(events: @[
      # Let's schedule an event for exactly 12:00 Monday
      ScheduledEvent(id: "test1",
                     minute: 0,
                     hour: 12,
                     weekday: 1, # Monday
        event: "someEvent",
        payload: %*{"hello": "world"})
    ])

    ## 2. Create a dummy logger & scheduler
    let logger = newLogger(config)
    var scheduler = Scheduler(
      frameConfig: config,
      logger: logger,
      schedule: config.schedule
    )

    clearEventChannel() # Make sure there's nothing pending in the channel

    ## 3. Provide a fake Monday 12:00 date
    # Monday is 1..7 => dt.weekday = DayOfWeek.monday => weekdayMonSun(dt)=1
    let fakeDate = dateTime(2023, mJan, 2, 12, 0, 0) # Suppose Jan 2, 2023 is a Monday

    # We call handleSchedule to process that time
    scheduler.handleSchedule(fakeDate)

    ## 4. Check that the expected event was sent
    var gotEvent = false
    var gotPayload = %*{}
    while true:
      let (success, (maybeScene, eventName, payload)) = eventChannel.tryRecv()
      if not success:
        break
      if eventName == "someEvent":
        gotEvent = true
        gotPayload = payload

    check gotEvent
    check gotPayload == %*{"hello": "world"}


  test "Scheduler does not trigger event if weekday mismatch":
    # Reuse the same config & scheduler logic
    var config = new(FrameConfig)
    config.debug = false
    config.schedule = FrameSchedule(events: @[
      ScheduledEvent(id: "test2",
                     minute: 0,
                     hour: 12,
                     weekday: 1, # Monday only
      event: "mismatchEvent",
      payload: %*{})
    ])
    let logger = newLogger(config)
    var scheduler = Scheduler(
      frameConfig: config,
      logger: logger,
      schedule: config.schedule
    )

    clearEventChannel()

    # Provide a fake date that is e.g. Sunday
    let fakeDate = dateTime(2023, mJan, 1, 12, 0, 0) # Sunday is weekdayMonSun=7
    scheduler.handleSchedule(fakeDate)

    # Verify no event was triggered
    var triggered = false
    while true:
      let (success, _) = eventChannel.tryRecv()
      if not success:
        break
      triggered = true

    check not triggered
