# Prebuilt dependency builder

These scripts produce the prebuilt component set for each supported cross target:

- `nim`
- `quickjs`
- `lgpio`
- the generic `frameos` runtime binary
- every compiled driver plugin as its own `.so` component

The target list comes from `backend/bin/cross`, which currently covers:

- Debian **bookworm**: `armhf`, `arm64`, `amd64`
- Debian **trixie**: `armhf`, `arm64`, `amd64`
- Ubuntu **22.04**: `arm64`, `amd64`
- Ubuntu **24.04**: `arm64`, `amd64`

## Requirements

- Docker with BuildKit/buildx enabled (the default Docker Desktop and modern
  Linux daemons already ship with it). QEMU/binfmt support is needed to build
  the arm targets from x86 hosts – install it once via
  `docker run --rm --privileged tonistiigi/binfmt --install all`.

## Usage

```bash
# From the repository root
./tools/prebuilt-deps/build.sh          # builds every supported combo
./tools/prebuilt-deps/build.sh debian-bookworm-arm64  # Raspberry Pi OS example
./tools/prebuilt-deps/build.sh ubuntu-24.04-amd64   # Ubuntu example
```

The script drops results under `build/prebuilt-deps/<target>/` where `<target>`
looks like `debian-bookworm-armhf` or `ubuntu-24.04-amd64`. Each folder contains
versioned component directories so you can keep several revisions side-by-side,
for example:

```
metadata.json
nim-2.2.4/bin/*
nim-2.2.4/lib/*
quickjs-2025-04-26/include/quickjs/*.h
quickjs-2025-04-26/lib/libquickjs.a
lgpio-v0.2.2/include/*.h
lgpio-v0.2.2/lib/*
frameos-f04c53a0e275/frameos
driver_frameBuffer-f04c53a0e275/frameBuffer.so
driver_evdev-f04c53a0e275/evdev.so
driver_waveshare_EPD_2in13_V3-f04c53a0e275/waveshare_EPD_2in13_V3.so
nim-2.2.4/.build-info
quickjs-2025-04-26/.build-info
lgpio-v0.2.2/.build-info
frameos-f04c53a0e275/.build-info
driver_frameBuffer-f04c53a0e275/.build-info
```

You can upload the entire folder as a tarball to your cache server.

`nim`, `quickjs`, and `lgpio` are built by their own Dockerfiles. The generic
`frameos` runtime and compiled driver plugins are then cross-compiled with
`backend/bin/cross`, reusing the freshly built `quickjs` and `lgpio`
components from the same target folder.

The cross-compiled staging outputs now live under
`build/prebuilt-cross/<frameos-release>/<target>/`, where `<frameos-release>`
comes from the numeric `frameos` version in `versions.json` (the part before
the `+hash`). Each target folder contains the compiled runtime, driver
libraries, a `metadata.json`, and a `manifest.json` with MD5 checksums for the
files in that target tree. The release folder also gets its own aggregate
`manifest.json`.

When you rerun the builder it reuses any component whose `.build-info` marker
matches the requested source/dependency versions and platform, so you only
rebuild the missing pieces. Delete an individual component directory or the
entire target folder to force a rebuild.

### Custom versions

Override the versions with environment variables when invoking the script:

```bash
NIM_VERSION=2.2.4 QUICKJS_VERSION=2025-04-26 \
LGPIO_VERSION=v0.2.2 FRAMEOS_VERSION=my-build-id \
./tools/prebuilt-deps/build.sh
```

`LGPIO_REPO` can also be overridden to point to a fork.
If `FRAMEOS_VERSION` is not set, the script uses the current git revision
(with a `-dirty` suffix when the working tree has local changes) for build
markers and component directories, while `build/prebuilt-cross/` is nested
under the base `frameos` release from `versions.json`.

## Cloudflare R2 sync helper

Use `tools/prebuilt-deps/r2_sync.py` to mirror the build outputs to the
`frameos-archive` Cloudflare R2 bucket. The helper uses the same target
matrix as `build.sh`, uploads each component directory as its own `tar.gz`
archive, and stores the resulting component map in `prebuilt-deps/manifest.json`
so the latest set for each target can be discovered and downloaded
automatically.

### Prerequisites

- Python with `boto3` installed (e.g. `pip install boto3`).
- Cloudflare R2 credentials exported via the standard S3 variables:

  ```bash
  export R2_ACCESS_KEY_ID=...
  export R2_SECRET_ACCESS_KEY=...
  export R2_ACCOUNT_ID=...         # or set R2_ENDPOINT explicitly
  export R2_BUCKET=frameos-archive # optional, defaults to this repo name
  ```

  The script also honours `R2_PREFIX` (defaults to `prebuilt-deps`) and
  `R2_REGION` (defaults to `auto`).

  If you prefer not to export the variables globally you can place them in a
  `.env` file (ignored by git) at the repository root or inside
  `tools/prebuilt-deps/`. The helper automatically loads the first `.env` it
  finds, or you can point at a custom path via `R2_ENV_FILE=/path/to/.env`.

### Commands

```bash
# List everything referenced by the manifest
python tools/prebuilt-deps/r2_sync.py list

# Download the latest artifacts for all known targets into build/prebuilt-deps
python tools/prebuilt-deps/r2_sync.py download

# Upload whatever you have built locally (matching build/prebuilt-deps/*)
python tools/prebuilt-deps/r2_sync.py upload

# End-to-end sync: download, rebuild missing targets, upload archives
python tools/prebuilt-deps/r2_sync.py sync
```

Each command accepts `--targets debian-bookworm-armhf ...` to restrict the
set of targets, along with knobs such as `--force` (download/upload even
when the current metadata already matches) and `--skip-build` (download
only).

## End-to-end package verification

Once a target has been built locally under `build/prebuilt-deps/<target>/`,
you can verify that a packaged runtime actually boots, renders, and uploads
its PNG output over HTTP:

```bash
python3 tools/prebuilt-deps/verify_package_e2e.py \
  --target debian-bookworm-arm64 \
  --scene-mode compiled
```

The verifier:

- assembles a real package directory containing the prebuilt `frameos`
  binary and `httpUpload.so`
- optionally cross-compiles a tiny `render/color` scene plugin for the same
  target (`--scene-mode compiled`)
- starts a local HTTP capture server
- builds a thin Docker runtime image on top of the target base image so the
  required shared libraries are present
- runs the package inside a matching Docker container
- asserts that FrameOS uploads an `image/png` with the expected dimensions
  and solid-color pixels

Use `--scene-mode interpreted` to skip the compiled-scene step and validate
just the prebuilt runtime plus driver package. Add `--keep-temp` if you want
to inspect the assembled package and temporary build tree afterwards.
