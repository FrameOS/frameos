# Package

version       = "0.1.0"
author        = "Marius Andra"
description   = "An operating system for single function displays."
license       = "AGPL"
srcDir        = "src"
binDir        = "build"
bin           = @["frameos"]


# Dependencies

requires "chrono >= 0.3.1"
requires "checksums >= 0.2.1"
requires "nim >= 2.2.4"
requires "pixie >= 5.0.7"
requires "jester >= 0.6.0"
requires "linuxfb >= 0.1.0"
requires "psutil >= 0.6.0"
requires "ws >= 0.5.0"
requires "QRgen >= 3.1.0"
requires "jsony >= 1.1.5"

taskRequires "assets", "nimassets >= 0.2.4"

before build:
  exec "cd frontend && npm install"
  exec "cd frontend && npm run build"
  exec "nimble assets"
  if not dirExists("quickjs"):
    exec "nimble build_quickjs --silent"

task assets, "Create assets":
  exec "mkdir -p src/assets"
  exec "python tools/generate_apps_asset_nim.py --source-dir . --output src/assets/apps.nim"
  exec "~/.nimble/bin/nimassets -d=assets/compiled/web -o=src/assets/web.nim"
  exec "~/.nimble/bin/nimassets -d=assets/compiled/frame_web -o=src/assets/frame_web.nim"
  exec "~/.nimble/bin/nimassets -f=assets/compiled/fonts/Ubuntu-Regular.ttf -o=src/assets/fonts.nim"

task build_quickjs, "Build QuickJS":
  echo "Downloading and building QuickJS..."
  if dirExists("quickjs"):
    echo "QuickJS directory already exists, skipping download and build."
    return
  exec "curl -L -o quickjs.tar.xz https://bellard.org/quickjs/quickjs-2025-04-26.tar.xz"
  exec "echo '2f20074c25166ef6f781f381c50d57b502cb85d470d639abccebbef7954c83bf  quickjs.tar.xz' | sha256sum -c -"
  exec "tar -xf quickjs.tar.xz"
  exec "rm quickjs.tar.xz"
  exec "mv quickjs-2025-04-26 quickjs"
  exec "cd quickjs && make"

task test, "Run tests":
  exec "testament pattern './src/**/tests/*.nim' --lineTrace:on"
  exec "testament pattern './src/**/**/tests/*.nim' --lineTrace:on"
  exec "testament pattern './src/**/**/**/tests/*.nim' --lineTrace:on"
