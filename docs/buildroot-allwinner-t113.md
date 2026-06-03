# Buildroot Allwinner T113-S3/S4 Target

## Status

FrameOS has an experimental Buildroot target for Allwinner T113-S3 and T113-S4 compatible devices. The platform slug is wired into the backend SD-card image builder and the frontend platform selector as:

- `allwinner-t113-s3`

The frontend shows one option: `Allwinner T113-S3/S4 compatible`. There is no separate `allwinner-t113-s4` platform value; S4-compatible boards use the S3 target until a board-specific device tree or U-Boot configuration proves otherwise.

## Image Layout

The generated SD image uses the same FrameOS partition model as the Raspberry Pi Buildroot target, with a sunxi-specific bootloader placement:

1. Hidden SPL/U-Boot payload at 8 KiB: `u-boot-sunxi-with-spl.bin`
2. `BOOT` FAT partition with `zImage`, the board DTB, and `extlinux/extlinux.conf`
3. root filesystem ext4 partition
4. `FRAMEOS` ext4 partition mounted at `/srv/frameos`
5. `ASSETS` FAT partition mounted at `/srv/assets`

The boot command uses U-Boot extlinux and points Linux at `/dev/mmcblk0p2`, because the visible BOOT partition is first and the root filesystem is second.

## Buildroot Baseline

The target is based on Buildroot `2025.02.13`, which includes:

- `configs/mangopi_mq1rdw2_defconfig`
- Linux `6.6.5`
- U-Boot `2024.01-rc4`
- `sun8i-t113s-mangopi-mq-r-t113.dtb`
- RTL8723DS package support for the MangoPi MQ-R WiFi module

FrameOS overlays the baseline with systemd, NetworkManager, Dropbear, ImageMagick, FFmpeg, timezone data, FrameOS runtime files, the FrameOS agent, and the SD-card setup payload.

## Compatibility Notes

Expected to work:

- ARMv7 hard-float FrameOS and agent binaries (`debian-bookworm-armhf` cross target)
- SD-card boot on MangoPi MQ-R compatible T113-S3 hardware
- Ethernet DHCP where exposed as `eth0`
- NetworkManager-based WiFi when the board uses supported RTL8723DS wiring/firmware
- FrameOS setup payload from the BOOT partition
- `/srv/frameos` and `/srv/assets` persistent partitions

Needs device validation:

- T113-S4 boot and memory initialization on the specific devboard
- The devboard's exact device tree, especially display, SPI, GPIO, USB host/OTG, and WiFi wiring
- UART console. The upstream board uses `ttyS3` at 115200 baud.
- FrameOS e-paper GPIO/SPI pin mapping. Existing display drivers still assume Raspberry Pi-style defaults unless the driver/runtime configuration is adjusted.
- LCD/RGB panel support. The baseline enables sunxi DRM pieces, but panel timings and connectors are board-specific.

## Building The Cached Base Image

Build the reusable base image locally:

```bash
python tools/buildroot-images/buildroot_images.py --platform allwinner-t113-s3 build
```

Upload/publish the base image with the same CLI flow used for the Pi target:

```bash
python tools/buildroot-images/buildroot_images.py --platform allwinner-t113-s3 upload --yes
```

The remote manifest only needs the S3 base image while S3 and S4 remain compatible.

The backend SD-card download flow first tries to resolve cached base images by platform from `tools/buildroot-images/manifest.json` locally or from the archive manifest remotely. If no cached base image exists yet for the selected platform, the worker falls back to a full local Buildroot build and still produces the frame-specific SD image.

## UI Flow

When adding a frame with "Download SD card", pick `Allwinner T113-S3/S4 compatible`. The selected platform is stored in `frame.buildroot.platform` as `allwinner-t113-s3`. SD-card generation then:

1. Builds FrameOS and the agent for `armhf`.
2. Downloads the matching cached Buildroot base image for the selected platform, or builds one locally if no cache entry exists.
3. Replaces the BOOT, FRAMEOS, and ASSETS payloads with frame-specific content when using a cached base image.
4. Returns a compressed `.img.gz` download.

## Current Gaps

- No board-specific T113-S4 DTS is included.
- No touchscreen/camera/audio connector configuration has been added.
- No visual/display validation has been run on physical hardware.
- No cached Allwinner base image is present in the checked-in manifest until the build/upload flow is run; first use may be slow because it can fall back to a full local Buildroot build.
- WiFi credentials are written for NetworkManager. Boards using a different WiFi module may need firmware/package changes.
