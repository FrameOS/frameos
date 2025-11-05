# FrameOS Buildroot integration

This directory contains helper scripts and an external Buildroot tree for
producing firmware images and cross-toolchains for FrameOS devices.  The initial
focus is the Luckfox Pico Pro/Max boards which are based on the Rockchip
RV1106, but the layout allows additional targets to be added over time.

## Layout

```
buildroot/
├── Makefile                # Helper entry point for invoking Buildroot
├── README.md               # This document
├── .gitignore              # Ignores large build artifacts
├── external/
│   ├── Config.in           # Hook for FrameOS-specific Kconfig options
│   ├── external.desc       # Declares the external tree metadata
│   ├── external.mk         # Hook for FrameOS-specific packages
│   ├── configs/
│   │   └── frameos_luckfox_rv1106_defconfig
│   └── board/
│       └── luckfox/pico_pro_max/
│           ├── README.md
│           └── rootfs_overlay/
│               └── etc/motd
```

`frameos_luckfox_rv1106_defconfig` is a good starting point for the Luckfox
Pico Pro/Max devices.  Additional defconfigs can be added to the `configs/`
directory as more targets are supported.

## Usage

All commands should be executed from this directory:

```bash
cd frameos/buildroot
make help                     # List helper targets
make download                 # Fetch the Buildroot release archive
make extract                  # Extract Buildroot under ./sources
make frameos_luckfox_rv1106_defconfig  # Initialise the Buildroot output tree
make build                    # Build a full root filesystem image
```

The helper makefile downloads Buildroot into `./sources/` and keeps build
artifacts under `./output/`.  The Buildroot download cache is shared via
`./dl/` so subsequent builds are much faster.

### Building just the toolchain

Buildroot can produce a cross-toolchain or SDK without assembling the entire
root filesystem:

```bash
make toolchain   # Cross-compiler that can be used directly
make sdk         # relocatable SDK archive (host tools + sysroot)
```

Both targets still honour the selected defconfig.

### Customising the build

The makefile exposes several variables that can be overridden on the command
line:

- `BUILDROOT_VERSION` – Buildroot release to download (default `2024.02.2`).
- `BUILDROOT_SITE` – Mirror URL used for downloads.
- `OUTPUT_DIR` – Location of the Buildroot output directory.
- `TARGET` – Name of the defconfig to build (e.g. `frameos_luckfox_rv1106`).

For example, to experiment with a different Buildroot release:

```bash
make BUILDROOT_VERSION=2023.11 build
```

### Adding new targets

1. Create a new defconfig in `external/configs/` (e.g.
   `frameos_allwinner_t113_defconfig`).
2. Add any board-specific overlays under `external/board/<vendor>/<board>/`.
3. Override the `TARGET` variable when building, or create a small wrapper
   target in the makefile if the configuration will be used often.

## Host requirements

The helper scripts use standard Unix tooling (`curl`, `tar`, `make`).  On macOS
and most Linux distributions these are already present.  Ensure you have the
Buildroot host dependencies installed as described in the official Buildroot
manual.

