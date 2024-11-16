# Package

version       = "0.1.0"
author        = "Marius Andra"
description   = "FrameOS agent"
license       = "Apache-2.0"
srcDir        = "src"
binDir        = "build"
bin           = @["agent"]  


# Dependencies

requires "chrono >= 0.3.1"
requires "checksums >= 0.2.1"
requires "nim >= 2.0.0"
requires "jester >= 0.6.0"
requires "psutil >= 0.6.0"
requires "ws >= 0.5.0"

task test, "Run tests":
  exec "testament pattern './src/tests/*.nim' --lineTrace:on"
