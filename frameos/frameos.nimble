# Package

version       = "0.1.0"
author        = "Marius Andra"
description   = "A new awesome nimble package"
license       = "Apache-2.0"
srcDir        = "src"
binDir        = "build"
bin           = @["frameos"]  


# Dependencies

requires "nim >= 2.0.0"
requires "pixie >= 5.0.6"
requires "jester >= 0.6.0"
requires "linuxfb >= 0.1.0"
requires "psutil >= 0.6.0"
requires "ws >= 0.5.0"
requires "qrgen >= 3.1.0"

taskRequires "assets", "nimassets >= 0.2.4"

task assets, "Create assets":
  exec "mkdir -p src/assets"
  exec "~/.nimble/bin/nimassets -d=assets/web -o=src/assets/web.nim"
  exec "~/.nimble/bin/nimassets -d=assets/fonts -o=src/assets/fonts.nim"

before build:
  exec "nimble assets"

task test, "Run tests":
  exec "testament pattern './src/**/tests/*.nim'"
