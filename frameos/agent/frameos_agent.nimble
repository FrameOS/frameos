# Package

version       = "0.1.0"
author        = "Marius Andra"
description   = "FrameOS agent"
license       = "AGPL"
srcDir        = "src"
binDir        = "build"
bin           = @["frameos_agent"]


# Dependencies

requires "nim >= 2.0.0"
requires "ws >= 0.5.0"
requires "jsony >= 1.1.5"
requires "nimcrypto >= 0.6.0"
requires "checksums >= 0.2.1"
requires "zippy >= 0.10.16"