# T113-S3 Board Patches

This directory is wired into the defconfig through `BR2_GLOBAL_PATCH_DIR`.
Use it for board-specific source patches that should be applied by Buildroot
without changing the generic FrameOS runtime.

Expected layout:

```text
patches/
  linux/
    0001-arm-dts-add-custom-frameos-t113-board.patch
  uboot/
    0001-configs-adjust-custom-frameos-t113-boot.patch
```

Keep patches generated with `git format-patch` where possible. For the custom
MangoPi-derived board, DTS patches should capture the verified SPI bus, GPIO
line names, panel power/reset/DC/busy wiring, UART, storage, and Wi-Fi module
differences from `sun8i-t113s-mangopi-mq-r-t113.dts`.
