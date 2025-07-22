import unittest
import os, times, strutils
import ../logger
import ../config
import ../channels
import std/json

suite "Logger Tests":
  # We load your real config, but you can also stub or mock if you like.
  let testConfig = loadConfig()

  setup:
    # Before each test, clear out any leftover items in the log channel
    var done = false
    while not done:
      let (success, _) = logChannel.tryRecv()
      done = not success

    # Also remove any leftover test log files from previous runs
    if fileExists("test-logger.log"):
      try: removeFile("test-logger.log")
      except: discard

  test "logger is enabled by default":
    let logger = newLogger(testConfig)
    doAssert logger.enabled == true

  test "logger enable/disable toggles":
    let logger = newLogger(testConfig)
    # Should start enabled
    doAssert logger.enabled

    logger.disable()
    doAssert logger.enabled == false

    logger.enable()
    doAssert logger.enabled

  test "logger writes to file when enabled":
    # Override the logToFile to a known location.
    testConfig.logToFile = "test-logger.log"

    let logger = newLogger(testConfig)
    logger.log(%*{"event": "test1", "message": "Hello world"})

    # Wait for the logger thread to process and flush.
    sleep(500) # 0.5s; adjust if needed

    doAssert fileExists("test-logger.log"), "Expected log file to be created"

    let contents = readFile("test-logger.log")
    doAssert "Hello world" in contents,
      "Log file contents did not contain the expected message"

  test "logger does not write to file when disabled":
    # Fresh file
    testConfig.logToFile = "test-logger.log"
    let logger = newLogger(testConfig)

    # 1) Write one log message while enabled
    logger.log(%*{"event": "test-enabled", "count": 1})
    sleep(300)

    # 2) Disable and write a second log message
    logger.disable()
    logger.log(%*{"event": "test-disabled", "count": 2})
    sleep(500)

    # Check the log file
    doAssert fileExists("test-logger.log")
    let contents = readFile("test-logger.log")
    doAssert "test-enabled" in contents,
      "Expected first log message to appear in the file"
    doAssert not ("test-disabled" in contents),
      "Logger was disabled, so second log message should NOT appear in the file"

  test "logger does not queue messages when disabled":
    # We can test by toggling disabled before logging,
    # then re-enabling and seeing if the channel has zero items from the disabled period.
    testConfig.debug = false
    let logger = newLogger(testConfig)

    logger.disable()
    logger.log(%*{"event": "disabledTest", "message": "should not see"})
    sleep(300)

    # Re-enable and drain the channel
    logger.enable()

    var anyFromDisabled = false
    while true:
      let (success, item) = logChannel.tryRecv()
      if not success: break
      if item[1].hasKey("event") and item[1]["event"].getStr() == "disabledTest":
        anyFromDisabled = true
    doAssert not anyFromDisabled, "We found a log from the disabled period, which should not happen"
