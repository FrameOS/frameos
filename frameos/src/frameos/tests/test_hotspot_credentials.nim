## The setup hotspot's name and password (hotspot_credentials.nim).

import std/[json, os, strutils, unittest]

import ../hotspot_credentials

let statePath = getTempDir() / "frameos-test-hotspot" / "hotspot.json"

proc freshState() =
  removeFile(statePath)
  useHotspotStatePathForTest(statePath)

suite "hotspot credentials":
  setup:
    freshState()

  teardown:
    removeDir(statePath.parentDir)

  test "a frame with a screen makes up a name and password when they are blank":
    for (ssid, password) in [("", ""), ("  ", "")]:
      freshState()
      let made = resolveHotspotCredentials("framebuffer", ssid, password)
      check made.ssid.startsWith("FrameOS-Setup-")
      check made.ssid.len == "FrameOS-Setup-".len + 4
      check made.password.len == 10
      for c in made.password:
        check c notin "01ilo"

  test "the made-up pair is kept in state/ and read back, also after a restart":
    let first = resolveHotspotCredentials("pimoroni.inky_impression_13", "", "")
    check resolveHotspotCredentials("pimoroni.inky_impression_13", "", "") == first
    let stored = parseJson(readFile(statePath))
    check stored["ssid"].getStr() == first.ssid
    check stored["password"].getStr() == first.password
    # A restart: nothing cached, the file is the source.
    useHotspotStatePathForTest(statePath)
    check resolveHotspotCredentials("pimoroni.inky_impression_13", "", "") == first

  test "frames do not share a made-up pair":
    let first = resolveHotspotCredentials("framebuffer", "", "")
    freshState()
    check resolveHotspotCredentials("framebuffer", "", "") != first

  test "whatever is set is used as it is, the old defaults included, field by field":
    check resolveHotspotCredentials("framebuffer", "FrameOS-Setup", "frame1234") == ("FrameOS-Setup", "frame1234")
    check resolveHotspotCredentials("framebuffer", "Kitchen", "hunter2hunter2") == ("Kitchen", "hunter2hunter2")
    check not fileExists(statePath)
    let made = resolveHotspotCredentials("framebuffer", "", "")
    check resolveHotspotCredentials("framebuffer", "Kitchen", "") == ("Kitchen", made.password)
    check resolveHotspotCredentials("framebuffer", "", "hunter2hunter2") == (made.ssid, "hunter2hunter2")

  test "a frame without a screen uses FrameOS-Setup / frame1234 for what is blank, and writes nothing":
    for device in ["", "web_only", "http.upload"]:
      check resolveHotspotCredentials(device, "", "") == ("FrameOS-Setup", "frame1234")
      check resolveHotspotCredentials(device, "Kitchen", "") == ("Kitchen", "frame1234")
      check resolveHotspotCredentials(device, "Kitchen", "hunter2hunter2") == ("Kitchen", "hunter2hunter2")
    check not fileExists(statePath)

  test "a broken state file is replaced":
    createDir(statePath.parentDir)
    writeFile(statePath, "{not json")
    useHotspotStatePathForTest(statePath)
    let made = resolveHotspotCredentials("framebuffer", "", "")
    check made.password.len == 10
    check parseJson(readFile(statePath))["password"].getStr() == made.password
