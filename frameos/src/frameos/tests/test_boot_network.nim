import std/unittest

import ../boot_network

suite "boot network plan":
  test "an e-paper frame waits for the check, and raises its hotspot when it fails":
    let plan = bootNetworkPlan("waveshare.EPD_7in3e", true, false, "bootOnly", true)
    check plan.waits
    check not plan.behind
    check plan.hotspot

  test "an HDMI screen waits too: it may have no input to set up on":
    let plan = bootNetworkPlan("framebuffer", true, false, "bootOnly", true)
    check plan.waits
    check plan.hotspot

  test "a touch screen draws first, checks behind its scene and raises no hotspot":
    for device in ["pimoroni.hyperpixel4", "pimoroni.hyperpixel4_touch", "pimoroni.hyperpixel4sq_touch",
                   "pimoroni.hyperpixel2r"]:
      let plan = bootNetworkPlan(device, true, false, "bootOnly", true)
      check not plan.waits
      check plan.behind
      check not plan.hotspot

  test "a touch screen whose frame page is off keeps its hotspot, behind its scene":
    let plan = bootNetworkPlan("pimoroni.hyperpixel4_touch", true, false, "bootOnly", false)
    check not plan.waits
    check plan.behind
    check plan.hotspot

  test "networkCheckOnTouch makes a touch screen wait like every other frame":
    let plan = bootNetworkPlan("pimoroni.hyperpixel4_touch", true, true, "bootOnly", true)
    check plan.waits
    check not plan.behind
    check plan.hotspot

  test "a boot hotspot alone still checks; nothing to check is nothing to do":
    let hotspotOnly = bootNetworkPlan("waveshare.EPD_7in3e", false, false, "bootOnly", true)
    check hotspotOnly.waits
    check hotspotOnly.hotspot
    let touchHotspotOnly = bootNetworkPlan("pimoroni.hyperpixel4", false, false, "bootOnly", true)
    check touchHotspotOnly.behind
    check not touchHotspotOnly.hotspot
    let nothing = bootNetworkPlan("pimoroni.hyperpixel4", false, false, "disabled", true)
    check not nothing.waits
    check not nothing.behind
    check not nothing.hotspot
    let nothingPaper = bootNetworkPlan("waveshare.EPD_7in3e", false, true, "disabled", true)
    check not nothingPaper.waits
    check not nothingPaper.behind

  test "a check without the hotspot: behind on touch, waited for elsewhere":
    check bootNetworkPlan("pimoroni.hyperpixel4", true, false, "disabled", true) ==
      BootNetworkPlan(behind: true)
    check bootNetworkPlan("waveshare.EPD_7in3e", true, false, "disabled", true) ==
      BootNetworkPlan(waits: true)
