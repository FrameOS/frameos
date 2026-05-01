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
./scripts/docker-t113-s3-buildroot.sh
```

This is the preferred entry point, including on macOS. It builds and runs a
Linux container with the Buildroot host dependencies, Nim, Python dependencies,
Node.js, and pnpm, then invokes the normal Buildroot scripts inside the
container. The wrapper configures Buildroot with this external tree and writes
output to `build/buildroot-t113-s3` by default. The SD card image is expected
at:

```text
build/buildroot-t113-s3/images/sdcard.img
```

To include a prebuilt FrameOS runtime binary in the image:

```bash
FRAMEOS_RUNTIME_BINARY=/path/to/frameos \
  ./scripts/docker-t113-s3-buildroot.sh
```

If `FRAMEOS_RUNTIME_BINARY` is omitted, the image still builds the base OS and
FrameOS service files, but the service exits until `/usr/bin/frameos` is
installed.

To build the runtime and include it in the image in one wrapper run:

```bash
FRAMEOS_BUILD_RUNTIME=1 ./scripts/docker-t113-s3-buildroot.sh
```

The wrapper copies the generated SD card image and checksum to
`build/frameos-t113-s3-image/`.

To run the full local artifact path in Docker, including inspection and
compression:

```bash
FRAMEOS_BUILD_RUNTIME=1 \
  FRAMEOS_INSPECT_ARTIFACTS=1 \
  FRAMEOS_PACKAGE_IMAGE=1 \
  IMAGE_NAME=frameos-t113-s3-nowifi-glibc-runtime \
  FRAMEOS_WIFI_VARIANT=none \
  ./scripts/docker-t113-s3-buildroot.sh
```

To create a compressed image artifact suitable for download or release upload:

```bash
./scripts/package-t113-s3-image.sh
```

This writes `frameos-t113-s3-sdcard.img.xz`, a checksum file, and a manifest
next to the copied `sdcard.img`. Override `IMAGE_ARTIFACTS_DIR`, `PACKAGE_DIR`,
or `IMAGE_NAME` when packaging variant-specific images.

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

The lower-level scripts still work on a Linux host with all Buildroot
dependencies installed, but they are intended mainly for debugging inside the
container. Use `FRAMEOS_T113_S3_DOCKER_BUILD=0` to reuse an existing local
Docker image, or `FRAMEOS_T113_S3_DOCKER_PLATFORM=linux/amd64` to force a
specific Docker platform.

## Downloadable Images

The manual GitHub Actions workflow `T113-S3 Buildroot SD image` builds the same
Dockerized path and uploads the compressed SD card image, checksum, manifest,
and metadata as an Actions artifact. It exposes inputs for `wifi_variant`,
`buildroot_ref`, `artifact_name`, and artifact retention.

For first bring-up, use `wifi_variant=none` unless the target Wi-Fi module has
already been validated. Download the `*.img.xz` artifact, verify it with the
matching `*.sha256` file, decompress it, then write the raw `*.img` to a
microSD card with a normal block-image writer.

## Board Customization Points

- `FRAMEOS_WIFI_VARIANT=none` is the default. Use
  `FRAMEOS_WIFI_VARIANT=rtl8723ds` or `FRAMEOS_WIFI_VARIANT=rtl8189fs` for the
  seed MangoPi-style Wi-Fi fragments, or point it at a custom Buildroot config
  fragment.
- `FRAMEOS_CONFIG_FRAGMENTS="/path/to/one.config /path/to/two.config"` appends
  extra Buildroot fragments for custom boards.
- `board/mangopi/mq-dual/rootfs_overlay/etc/default/frameos` controls FrameOS
  runtime environment variables, including GPIO line numbers and SPI bus
  selection for the Waveshare e-paper driver.
- `board/mangopi/mq-dual/wifi/` contains seed Buildroot fragments for common
  MangoPi Wi-Fi modules. Treat them as starting points and verify package names
  against the Buildroot version in use.
- `board/mangopi/mq-dual/post-build.sh` appends the `wlan0` ifupdown stanza and
  keeps `/etc/wpa_supplicant.conf` only when the final Buildroot config enables
  `wpa_supplicant`.
- `board/mangopi/mq-dual/patches/` is wired through `BR2_GLOBAL_PATCH_DIR`.
  Put custom-board Linux or U-Boot patches under package subdirectories such as
  `patches/linux/` or `patches/uboot/`.

## First Hardware Bring-Up Checklist

- Confirm serial output on UART3 at 115200 baud.
- Confirm `/dev/gpiochip0` and `/dev/spidev0.0` match the custom board wiring,
  or update `/etc/default/frameos`.
- Confirm the exact Waveshare 7.3 inch Spectra SKU uses the `EPD_7in3e` driver.
- Confirm Wi-Fi module choice and firmware/driver package.
- For Wi-Fi variants, replace `/etc/wpa_supplicant.conf` placeholders before
  expecting Wi-Fi DHCP.
