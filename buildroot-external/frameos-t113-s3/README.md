# FrameOS T113-S3 Buildroot External Tree

This is the initial Buildroot external tree for Allwinner T113-S3 boards based
on the MangoPi MQ Dual / MQ-R T113-S3 layout.

The baseline follows the upstream Buildroot MangoPi MQ1RDW2 support:

- ARM Cortex-A7, ARMv7 hard-float userspace.
- Mainline Linux with `sun8i-t113s-mangopi-mq-r-t113.dtb`.
- Mainline U-Boot with `mangopi_mq_r_defconfig`.
- UART3 (`ttyS3`) as the serial console.
- A single ext4 root filesystem partition in `sdcard.img`.

## Host Requirements

- A Buildroot checkout new enough to include the MangoPi MQ1RDW2/T113-S3
  support, or a checkout with equivalent package and board support backported.
- `make`, a working C toolchain for the host, and normal Buildroot host
  dependencies.

The helper below checks common Buildroot host tools, then clones or checks an
external Buildroot checkout. It defaults to Buildroot `2026.02.1`, which has
the config merge script and the Realtek Wi-Fi package entries used by the
T113-S3 wrappers.

```bash
./scripts/bootstrap-t113-s3-buildroot.sh
```

## Build

From the FrameOS repository root:

```bash
BUILDROOT_DIR=/path/to/buildroot ./scripts/build-t113-s3-image.sh
```

The wrapper configures Buildroot with this external tree and writes output to
`build/buildroot-t113-s3` by default. The SD card image is expected at:

```text
build/buildroot-t113-s3/images/sdcard.img
```

To include a prebuilt FrameOS runtime binary in the image:

```bash
FRAMEOS_RUNTIME_BINARY=/path/to/frameos \
  BUILDROOT_DIR=/path/to/buildroot \
  ./scripts/build-t113-s3-image.sh
```

If `FRAMEOS_RUNTIME_BINARY` is omitted, the image still builds the base OS and
FrameOS service files, but the service exits until `/usr/bin/frameos` is
installed.

To build the runtime and include it in the image in one wrapper run:

```bash
FRAMEOS_BUILD_RUNTIME=1 BUILDROOT_DIR=/path/to/buildroot ./scripts/build-t113-s3-image.sh
```

The wrapper copies the generated SD card image and checksum to
`build/frameos-t113-s3-image/`.

After a build, inspect the host artifacts and target root filesystem:

```bash
./scripts/inspect-t113-s3-build.sh
```

This checks for the copied image/checksum, U-Boot, DTB, FrameOS service files,
runtime libraries, CA certificates, and an ARM `frameos` ELF binary.

To build the FrameOS runtime with the Buildroot target toolchain and sysroot:

```bash
BUILDROOT_DIR=/path/to/buildroot ./scripts/build-t113-s3-frameos.sh
```

This first ensures the Buildroot toolchain, `frameos-quickjs`, `frameos-lgpio`,
and OpenSSL staging files exist, then generates FrameOS C sources and compiles
them with the Buildroot target compiler. The binary is written to
`build/frameos-t113-s3/frameos`.

## Board Customization Points

- `FRAMEOS_WIFI_VARIANT=rtl8723ds` is the default. Use
  `FRAMEOS_WIFI_VARIANT=rtl8189fs` for MangoPi-style RTL8189F/RTL8189FS
  hardware, `FRAMEOS_WIFI_VARIANT=none` for no Wi-Fi driver fragment, or point
  it at a custom Buildroot config fragment.
- `FRAMEOS_CONFIG_FRAGMENTS="/path/to/one.config /path/to/two.config"` appends
  extra Buildroot fragments for custom boards.
- `board/mangopi/mq-dual/rootfs_overlay/etc/default/frameos` controls FrameOS
  runtime environment variables, including GPIO line numbers and SPI bus
  selection for the Waveshare e-paper driver.
- `board/mangopi/mq-dual/wifi/` contains seed Buildroot fragments for common
  MangoPi Wi-Fi modules. Treat them as starting points and verify package names
  against the Buildroot version in use.
- DTS changes for a custom board should be added as kernel patches under this
  external tree and referenced with `BR2_GLOBAL_PATCH_DIR`.

## First Hardware Bring-Up Checklist

- Confirm serial output on UART3 at 115200 baud.
- Confirm `/dev/gpiochip0` and `/dev/spidev0.0` match the custom board wiring,
  or update `/etc/default/frameos`.
- Confirm the exact Waveshare 7.3 inch Spectra SKU uses the `EPD_7in3e` driver.
- Confirm Wi-Fi module choice and firmware/driver package.
- Replace `/etc/wpa_supplicant.conf` placeholders before expecting Wi-Fi DHCP.
