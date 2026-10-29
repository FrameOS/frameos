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
requires "https://github.com/FrameOS/pixie#930bee304df0bfd73849f73a64c4d5c20ef2e3c5"
# FrameOS/mummy: upstream mummy plus TLS listeners (OpenSSL inside the epoll
# loop), listeners added/removed while serving, and Request.secure. HTTPS on
# Linux frames terminates here; see docs/native-https.md.
requires "https://github.com/FrameOS/mummy#020dfe59fd112bef4b711684c41fe9f678f56889"
requires "linuxfb >= 0.1.0"
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

# quickts: upstream QuickJS plus native TypeScript/JSX parsing
# (https://github.com/FrameOS/quickts). Keep the version and checksum in step
# with tools/install_prebuilt_quickjs.py, tools/build_wasm.sh,
# tools/prebuilt-deps/build.sh, the root Dockerfile and
# backend/app/tasks/frame_deploy_helpers.py.
const
  QuickjsVersion = "2026-06-04-quickts.2"
  QuickjsSha256 = "9d6435424992bd710b28b67e6de10fac57813da8b37ce26913c78343c83d463e"

task build_quickjs, "Build QuickJS":
  if dirExists("quickjs"):
    let have = if fileExists("quickjs/VERSION"): readFile("quickjs/VERSION").strip() else: ""
    if have == QuickjsVersion:
      echo "QuickJS " & QuickjsVersion & " is already in quickjs/, skipping download and build."
      return
    # Not removed here: in a worktree quickjs/ is often a link to another
    # checkout's.
    echo "quickjs/ holds QuickJS " & (if have.len > 0: have else: "of no known version") &
      ", this checkout pins " & QuickjsVersion & ": remove quickjs/ and run nimble build_quickjs again."
    quit(1)
  echo "Downloading prebuilt QuickJS if available..."
  exec "python tools/install_prebuilt_quickjs.py || true"
  if dirExists("quickjs"):
    echo "Using prebuilt QuickJS."
    return
  echo "Downloading and building quickts (QuickJS + TypeScript) from source..."
  exec "curl -L -o quickjs.tar.xz https://archive.frameos.net/source/vendor/quickjs-" & QuickjsVersion & ".tar.xz"
  exec "echo '" & QuickjsSha256 & "  quickjs.tar.xz' | sha256sum -c -"
  exec "tar -xf quickjs.tar.xz"
  exec "rm quickjs.tar.xz"
  exec "mv quickjs-" & QuickjsVersion & " quickjs"
  exec "cd quickjs && make"

task test, "Run tests":
  exec "testament pattern './src/**/tests/*.nim' --lineTrace:on"
  exec "testament pattern './src/**/**/tests/*.nim' --lineTrace:on"
  exec "testament pattern './src/**/**/**/tests/*.nim' --lineTrace:on"
