import std/unittest

import ../waveshare
import frameos/types

suite "waveshare device setup":
  test "setup delegates to the generated variant module":
    let spec = setup(FrameConfig(device: "waveshare.EPD_2in13_V3"))
    check not spec.isNil
    check spec.spiMode == dsmEnable
    check spec.ensureBootConfigLines.len == 0
    check spec.removeBootConfigLines.len == 0
