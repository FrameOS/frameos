# Buildroot Raspberry Pi Zero 2 W Target

## Status

FrameOS has a Buildroot target for Raspberry Pi Zero 2 W devices. The platform slug is wired into the backend SD-card image builder and the frontend platform selector as:

- `raspberry-pi-zero-2-w`

The frontend shows this as `Raspberry Pi Zero 2 W`. This is the established Buildroot target and is the reference implementation for the newer Allwinner T113 target.

## Image Layout

The generated SD image uses the FrameOS partition model with Raspberry Pi firmware boot files in the first FAT partition:

1. `BOOT` FAT partition with Raspberry Pi firmware files, `config.txt`, `cmdline.txt`, kernel, and device trees
2. root filesystem ext4 partition
3. `FRAMEOS` ext4 partition mounted at `/srv/frameos`
4. `ASSETS` FAT partition mounted at `/srv/assets`

Unlike sunxi boards, there is no hidden SPL/U-Boot payload. The Raspberry Pi firmware loads the configured kernel from the BOOT partition.

## Buildroot Baseline

The target is based on Buildroot `2025.02.13`, using:

- `configs/raspberrypizero2w_64_defconfig`
- Raspberry Pi firmware boot flow
- ARM64 FrameOS and agent binaries (`debian-bookworm-arm64`)
- Broadcom/Cypress SDIO WiFi firmware packages for Raspberry Pi boards

FrameOS overlays the baseline with systemd, NetworkManager, Dropbear, ImageMagick, FFmpeg, timezone data, FrameOS runtime files, the FrameOS agent, and the SD-card setup payload.

## Boot Customization

The post-image step adjusts the Buildroot Raspberry Pi firmware output before `genimage` assembles the SD image:

- Ensures `cmdline.txt` contains `console=tty1`.
- Ensures `cmdline.txt` contains `fbcon=logo-count:1`.
- Normalizes Raspberry Pi GPU memory settings and applies `gpu_mem=32`.
- Copies Raspberry Pi firmware files, DTBs, and the configured kernel into the BOOT partition.

Frame-specific image composition can later patch the BOOT partition without rebuilding the full base image. It merges `config.txt` and `firmware/config.txt`, including GPU memory overrides, and copies setup/network/SSH payload files into BOOT.

## Compatibility Notes

Tested and works:

- SD-card boot on Raspberry Pi Zero 2 W
- ARM64 FrameOS and agent binaries
- HDMI framebuffer output with a small firmware GPU memory reserve
- NetworkManager-based WiFi using the Pi SDIO firmware packages
- Dropbear SSH after setup
- FrameOS setup payload from the BOOT partition
- `/srv/frameos` and `/srv/assets` persistent partitions

Needs device validation when hardware changes:

- Nonstandard displays and hats, especially SPI/e-paper pin mappings
- USB gadgets, USB Ethernet adapters, and nonstandard network paths
- Bluetooth-specific behavior, if needed by a deployment
- Any custom `config.txt` overlays required by attached hardware

## Building The Cached Base Image

Build the reusable base image locally:

```bash
python tools/buildroot-images/buildroot_images.py --platform raspberry-pi-zero-2-w build
```

Upload/publish the base image:

```bash
python tools/buildroot-images/buildroot_images.py --platform raspberry-pi-zero-2-w upload --yes
```

The backend SD-card download flow first tries to resolve cached base images by platform from `tools/buildroot-images/manifest.json` locally or from the archive manifest remotely. If no cached base image exists yet for the selected platform, the worker falls back to a full local Buildroot build and still produces the frame-specific SD image.

## UI Flow

When adding a frame with "Download SD card", pick `Raspberry Pi Zero 2 W`. The selected platform is stored in `frame.buildroot.platform` as `raspberry-pi-zero-2-w`. SD-card generation then:

1. Builds FrameOS and the agent for `aarch64`.
2. Downloads the matching cached Buildroot base image for the selected platform, or builds one locally if no cache entry exists.
3. Replaces the BOOT, FRAMEOS, and ASSETS payloads with frame-specific content when using a cached base image.
4. Returns a compressed `.img.gz` download.

## Current Gaps

- Physical validation still depends on the exact display, hat, and GPIO/SPI wiring used by a frame.
- The default boot configuration is intentionally minimal; custom hardware may require additional `config.txt` overlays.
- No separate Pi Zero 2 W variants are modeled for carrier boards or hats.
