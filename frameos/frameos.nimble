import std/os

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
requires "https://github.com/FrameOS/pixie#075da8d7293a842364ad7f829feeba2eddca2e47"
requires "mummy >= 0.4.7"
requires "linuxfb >= 0.1.0"
requires "QRgen >= 3.1.0"
requires "jsony >= 1.1.5"

before build:
  exec "nimble assets"
  if not dirExists("quickjs"):
    exec "nimble build_quickjs --silent"

task assets, "Create assets":
  exec "python tools/prepare_assets.py"

task relock, "Regenerate nimble.lock":
  # nimble 0.20.1's lock-update path writes an empty lock for this package
  # (commit-pinned URL dependency); always regenerate from scratch instead.
  rmFile("nimble.lock")
  exec "nimble lock"

task build_quickjs, "Build QuickJS":
  if dirExists("quickjs"):
    echo "QuickJS directory already exists, skipping download and build."
    return
  echo "Downloading prebuilt QuickJS if available..."
  exec "python tools/install_prebuilt_quickjs.py || true"
  if dirExists("quickjs"):
    echo "Using prebuilt QuickJS."
    return
  echo "Downloading and building QuickJS from source..."
  exec "curl -L -o quickjs.tar.xz https://bellard.org/quickjs/quickjs-2026-06-04.tar.xz"
  exec "echo 'b376e839b322978313d929fd20663b11ba58b75df5a46c126dd19ea2fa70ad2a  quickjs.tar.xz' | sha256sum -c -"
  exec "tar -xf quickjs.tar.xz"
  exec "rm quickjs.tar.xz"
  exec "mv quickjs-2026-06-04 quickjs"
  exec "cd quickjs && make"

task test, "Run tests":
  exec "testament pattern './src/**/tests/*.nim' --lineTrace:on"
  exec "testament pattern './src/**/**/tests/*.nim' --lineTrace:on"
  exec "testament pattern './src/**/**/**/tests/*.nim' --lineTrace:on"
