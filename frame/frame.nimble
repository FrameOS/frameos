# Package

version       = "0.1.0"
author        = "Marius Andra"
description   = "A new awesome nimble package"
license       = "Apache-2.0"
srcDir        = "src"
bin           = @["frame"]


# Dependencies

requires "nim >= 2.0.0"
requires "pixie >= 5.0.6"
requires "jester >= 0.6.0"
requires "wiringpinim >= 0.1.0"
taskRequires "assets", "nimassets >= 0.2.4"

task assets, "Create assets":
  exec "~/.nimble/bin/nimassets -d=assets -o=src/assets.nim"

before build:
  exec "nimble assets"
  
