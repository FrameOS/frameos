# Prebuilt dependency builder

These scripts produce Nim, QuickJS and lgpio builds for the Raspberry Pi OS and
Ubuntu LTS variants we care about. They run each build inside a container
matching one of the following releases and architectures:

- Raspberry Pi OS (Debian **buster**, **bookworm**, **trixie** preview)
- Ubuntu **22.04** LTS (Jammy Jellyfish)
- Ubuntu **24.04** LTS (Noble Numbat)
- **armhf** (32‑bit ARMv7), **arm64** (AArch64) and **amd64** (x86_64)

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
looks like `debian-bookworm-armhf` or `ubuntu-24.04-amd64`. Each folder contains versioned component
directories so you can keep several revisions side-by-side, e.g.:

```
metadata.json
nim-2.2.4/bin/*
nim-2.2.4/lib/*
quickjs-2025-04-26/include/quickjs/*.h
quickjs-2025-04-26/lib/libquickjs.a
lgpio-v0.2.2/include/*.h
lgpio-v0.2.2/lib/*
nim-2.2.4/.build-info
quickjs-2025-04-26/.build-info
lgpio-v0.2.2/.build-info
```

You can upload the entire folder as a tarball to your cache server.

Each dependency (Nim, QuickJS, lgpio) is built by its own Dockerfile. When you
rerun the builder it reuses any dependency whose `.build-info` marker matches
the requested versions/platform so you only rebuild the missing pieces. Delete a
component directory (e.g. `rm -rf build/prebuilt-deps/debian-bookworm-arm64/nim`
or `build/prebuilt-deps/ubuntu-22.04-amd64/nim`) or the entire target folder to
force a rebuild.

### Custom versions

Override the versions with environment variables when invoking the script:

```bash
NIM_VERSION=2.2.4 QUICKJS_VERSION=2025-04-26 \
LGPIO_VERSION=v0.2.2 ./tools/prebuilt-deps/build.sh
```

`LGPIO_REPO` can also be overridden to point to a fork.

## Cloudflare R2 sync helper

Use `tools/prebuilt-deps/r2_sync.py` to mirror the build outputs to the
`frameos-archive` Cloudflare R2 bucket. The helper uses the same target
matrix as `build.sh`, bundles each target folder as a `tar.gz` archive and
stores it under `prebuilt-deps/<target>/<versions>/` alongside a
`metadata.json`. A manifest file (`prebuilt-deps/manifest.json`) keeps
track of every target so the script can discover and download the latest
builds automatically. Each manifest entry is shaped like:

```json
{
  "target": "ubuntu-24.04-arm64",
  "updated_at": "2025-11-17T21:39:25.921016+00:00",
  "components": [
    {
      "name": "nim",
      "versions": [
        {
          "version": "2.2.4",
          "md5sum": "fa4e489a0f4ca97e111142cc1485eca0-3",
          "path": "prebuilt-deps/ubuntu-24.04-arm64/nim-2.2.4.tar.gz"
        }
      ]
    }
  ]
}
```

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
