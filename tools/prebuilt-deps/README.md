# Prebuilt dependency builder

These scripts produce Nim, QuickJS and lgpio builds for the Raspberry Pi OS
variants we care about. They run each build inside a Debian container matching
one of the following releases and architectures:

- Raspberry Pi OS (Debian **buster**)
- Raspberry Pi OS (Debian **bookworm**)
- Raspberry Pi OS (Debian **trixie** preview)
- **armhf** (32‑bit ARMv7) and **arm64** (AArch64)

## Requirements

- Docker with BuildKit/buildx enabled (the default Docker Desktop and modern
  Linux daemons already ship with it). QEMU/binfmt support is needed to build
  the arm targets from x86 hosts – install it once via
  `docker run --rm --privileged tonistiigi/binfmt --install all`.

## Usage

```bash
# From the repository root
./tools/prebuilt-deps/build.sh          # builds all 6 combos
./tools/prebuilt-deps/build.sh pios-bookworm-arm64  # single target
```

The script drops results under `build/prebuilt-deps/<target>/` where `<target>`
looks like `pios-bookworm-armhf`. Each folder contains:

```
metadata.json
nim/bin/*
nim/lib/*
quickjs/include/quickjs/*.h
quickjs/lib/libquickjs.a
lgpio/include/*.h
lgpio/lib/*
nim/.build-info
quickjs/.build-info
lgpio/.build-info
```

You can upload the entire folder as a tarball to your cache server.

Each dependency (Nim, QuickJS, lgpio) is built by its own Dockerfile. When you
rerun the builder it reuses any dependency whose `.build-info` marker matches
the requested versions/platform so you only rebuild the missing pieces. Delete a
component directory (e.g. `rm -rf build/prebuilt-deps/pios-bookworm-arm64/nim`)
or the entire target folder to force a rebuild.

### Custom versions

Override the versions with environment variables when invoking the script:

```bash
NIM_VERSION=2.2.4 QUICKJS_VERSION=2025-04-26 \
LGPIO_VERSION=v0.2.2 ./tools/prebuilt-deps/build.sh
```

`LGPIO_REPO` can also be overridden to point to a fork.
