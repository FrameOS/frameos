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
requires "https://github.com/FrameOS/pixie#28a9cc32e013b4d7dd72c830f4a25008cb7259d4"
requires "mummy >= 0.4.7"
requires "linuxfb >= 0.1.0"
requires "QRgen >= 3.1.0"
requires "jsony >= 1.1.5"
requires "ws >= 0.5.0"
# zippy is imported directly (config.nim, scenes, logger); pin the floor here
# too: 0.10.16's gzip uncompress divides by zero on 32-bit targets
# (gzip.nim `dst.len mod (1 shl 32)`), which crashed every armv6/armhf build
# at startup while decompressing the embedded frame_web assets.
requires "zippy >= 0.10.19"

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
  # quickts: upstream QuickJS plus native TypeScript/JSX parsing
  # (https://github.com/FrameOS/quickts). Keep the version and checksum in
  # step with tools/install_prebuilt_quickjs.py, tools/build_wasm.sh,
  # tools/prebuilt-deps/build.sh, the root Dockerfile and
  # backend/app/tasks/frame_deploy_helpers.py.
  echo "Downloading and building quickts (QuickJS + TypeScript) from source..."
  exec "curl -L -o quickjs.tar.xz https://archive.frameos.net/source/vendor/quickjs-2026-06-04-quickts.1.tar.xz"
  exec "echo '94a94f5229ead78f585280b5d41c7b45ab5c53eaf3500e493a5da05f32030e9f  quickjs.tar.xz' | sha256sum -c -"
  exec "tar -xf quickjs.tar.xz"
  exec "rm quickjs.tar.xz"
  exec "mv quickjs-2026-06-04-quickts.1 quickjs"
  exec "cd quickjs && make"

task test, "Run tests":
  exec "testament pattern './src/**/tests/*.nim' --lineTrace:on"
  exec "testament pattern './src/**/**/tests/*.nim' --lineTrace:on"
  exec "testament pattern './src/**/**/**/tests/*.nim' --lineTrace:on"
