# T113-S3 Buildroot Port TODO

## Scope

Build a repeatable FrameOS target for Allwinner T113-S3 boards, starting from
MangoPi MQ Dual v1.6-style hardware and the TQT113-S3 dev board, with a path to
custom board variants. The first deliverable is a host-side system that can:

- cross compile the FrameOS Nim runtime for T113-S3 Linux userspace;
- build QuickJS and lgpio for the same ARMv7 hard-float target;
- produce a bootable SD card image with FrameOS installed and preconfigured;
- keep board-specific choices, especially Wi-Fi and GPIO/SPI pin mapping, in
  replaceable Buildroot config fragments or board overlays.

## Current Assumptions

- T113-S3 is a dual-core Cortex-A7 SoC with 128 MB DDR3 in the S3 package.
- Mainline Linux and U-Boot are viable baselines for the MangoPi MQ-R / T113-S3
  family, but Wi-Fi support depends on the exact module and may need out-of-tree
  drivers.
- The initial CPU target should be 32-bit ARMv7 hard-float, not arm64.
- The Waveshare 7.3 inch Spectra e-ink panel will need SPI/GPIO access from the
  FrameOS runtime, so the target image must include the right kernel interfaces,
  lgpio runtime support, and a stable pin mapping.
- The repo already has FrameOS cross-compilation and prebuilt dependency
  machinery for Debian/Ubuntu targets; Buildroot support should extend that
  machinery instead of bypassing it.

## References To Verify

- MangoPi MQ page: T113-S3 option, MQ Dual v1.6 schematic, RTL8189F/RTL8723
  firmware images, and board connector layout.
- linux-sunxi T113-S3 and MangoPi MQ-R pages: mainline kernel/U-Boot support,
  `sun8i-t113s-mangopi-mq-r-t113.dtb`, debug UART choice, and Wi-Fi caveats.
- TQT113-S3 dev board documentation: boot media, debug UART, PMIC/storage
  wiring, and whether the vendor BSP carries required board-specific patches.
- Waveshare 7.3 inch Spectra panel documentation: exact controller, SPI mode,
  reset/DC/busy pins, supply sequencing, and whether existing FrameOS Waveshare
  drivers already cover it.

## Milestones

1. Add a Buildroot external tree skeleton for `frameos-t113-s3`, including board
   files, rootfs overlay, post-build/post-image hooks, and a documented wrapper
   command.
2. Add a minimal T113-S3 Buildroot defconfig that builds an ARMv7 hard-float
   Linux image with U-Boot, kernel, SSH, networking tools, SPI/GPIO userspace
   support, QuickJS, lgpio, and FrameOS service integration.
3. Extend the existing prebuilt dependency target matrix so QuickJS and lgpio can
   be built and resolved for the Buildroot/T113-S3 userspace target.
4. Add a FrameOS binary build target that uses the Buildroot sysroot/toolchain
   rather than a Debian container image.
5. Produce an SD card image artifact and document how to write it to a card,
   boot it, find it on the network, and point it at a FrameOS backend.
6. Add customization examples for at least two Wi-Fi module variants, starting
   with the MangoPi RTL8189F and RTL8723DS references.
7. Validate on real hardware, then capture the verified kernel/U-Boot versions,
   pin mappings, boot logs, and panel refresh behavior.

## Success Criteria

- `frameos` can be cross compiled on an x86_64 Linux host for T113-S3 without
  building on the board.
- The Buildroot output contains a deterministic root filesystem with FrameOS,
  QuickJS, lgpio, a system service, and required runtime assets.
- The SD card image boots to serial console and starts FrameOS automatically on a
  MangoPi-compatible T113-S3 board.
- The image exposes a predictable first-boot network path: DHCP Ethernet when
  available and configurable Wi-Fi for module-specific variants.
- The Waveshare 7.3 inch Spectra panel can be initialized and refreshed from
  FrameOS using the documented SPI/GPIO mapping.
- Hardware-specific deltas for the custom board are captured as defconfig
  fragments, DTS patches/overlays, or board overlay files, not hard-coded in the
  generic FrameOS runtime.

## Open Questions

- Which exact Waveshare 7.3 inch Spectra SKU/controller is being used?
- Which Wi-Fi module will be populated on the custom board first?
- Will the custom board boot only from microSD, or should NAND/eMMC images be in
  scope?
- Should the first downloadable image be produced by local scripts only, or also
  published through the existing FrameOS archive workflow?
- Is a mainline-only kernel acceptable for first bring-up, or should the vendor
  Tina Linux 5.4/5.10 BSP remain a fallback for panel or Wi-Fi support?

## Immediate Next Steps

- Run a full Buildroot package/image build from a clean checkout and capture any
  missing host dependencies, kernel/U-Boot package failures, or Wi-Fi driver
  build issues.
- Add kernel/DTS customization points once the exact custom-board SPI, GPIO,
  UART, power, and Wi-Fi wiring is fixed.
- Validate the generated `frameos` binary inside the Buildroot root filesystem
  with the new inspection script and, if needed, target emulation before first
  board boot.
- Capture first-boot serial logs from the TQT113-S3 dev board and MangoPi-style
  board.

## Progress

- Added an initial `buildroot-external/frameos-t113-s3` tree with a MangoPi
  MQ Dual / MQ-R style defconfig, rootfs overlay, FrameOS init script, genimage
  config, and seed Wi-Fi fragments.
- Added Buildroot package recipes to stage QuickJS and lgpio for the T113-S3
  target sysroot.
- Added `scripts/build-t113-s3-image.sh` as the first local wrapper around a
  separately checked out Buildroot tree.
- Made the Waveshare e-paper C shim accept FrameOS/Buildroot systems and read
  GPIO/SPI settings from environment variables so custom board pin mappings can
  be changed without rebuilding FrameOS.
- Added `buildroot-t113-s3-armhf` metadata to the FrameOS cross-target list and
  prebuilt dependency target matrix. It is intentionally excluded from the
  GitHub Actions binary-build matrix until the Buildroot sysroot/toolchain path
  is implemented.
- Added tests for T113-S3 target listing and Buildroot prebuilt dependency
  target resolution.
- Added `backend/bin/cross generate` for producing generated C sources without
  invoking the Docker cross compiler, plus `scripts/build-t113-s3-frameos.sh`
  to compile those sources with the Buildroot target compiler and staging
  sysroot.
- Added target OpenSSL and CA certificates to the T113-S3 Buildroot defconfig so
  the FrameOS runtime has the expected TLS link/runtime dependencies.
- Added Wi-Fi/custom Buildroot config fragment selection to the local wrappers
  through `FRAMEOS_WIFI_VARIANT` and `FRAMEOS_CONFIG_FRAGMENTS`.
- Added `FRAMEOS_BUILD_RUNTIME=1` support to the image wrapper so one command
  can compile the Buildroot-sysroot FrameOS runtime, install it into the rootfs,
  and copy `sdcard.img` plus checksum into `build/frameos-t113-s3-image/`.
- Added `scripts/inspect-t113-s3-build.sh` to check the Buildroot image,
  copied checksum, rootfs FrameOS service/runtime files, key shared libraries,
  CA certificates, and ARM ELF metadata before flashing an SD card.
