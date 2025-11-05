# Luckfox Pico Pro/Max notes

This directory contains assets that are specific to the Luckfox Pico Pro/Max
boards built around Rockchip's RV1106 SoC.  At the moment it only provides a
simple root filesystem overlay with a message of the day, but it will be
expanded with bootloader configuration and kernel fragments as the port
matures.

When customising the board support consider adding:

- `linux.fragment` – kernel configuration fragment for the vendor kernel.
- `uboot.fragment` – U-Boot configuration fragment, if required.
- `post-build.sh` / `post-image.sh` – hooks to adjust the output artifacts.
- Additional files under `rootfs_overlay/` for system configuration.

The Buildroot manual has a dedicated chapter on creating board support packages
that is a good reference when fleshing this out.
