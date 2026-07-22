# TODO: SD card images beyond the Pi Zero 2 W (Pi 3 / Pi 4 support)

Goal: ship a prebuilt Buildroot SD image that also boots on the Raspberry Pi 4B (and Pi 3),
ideally as **one unified 64-bit image** the way Raspberry Pi OS ships a single card:
kernel built from `bcm2711_defconfig` (supports BCM2710 + BCM2711), all DTBs on the boot
partition, and both firmware sets (`start.elf` + `start4.elf`) side by side so the GPU
bootloader picks the right one per model.

Verified starting point (2026-07-22):

- The released `raspberry-pi-zero-2-w` image's boot partition contains only
  `bcm2710-rpi-zero-2-w.dtb`, `start.elf`/`fixup.dat` and a `bcmrpi3`-kernel `Image` —
  it cannot boot a Pi 4B (needs `start4.elf`, `fixup4.dat`, `bcm2711-rpi-4-b.dtb`, and a
  kernel with BCM2711 support).
- Buildroot 2025.02.13 `raspberrypi4_64_defconfig` and `raspberrypizero2w_64_defconfig`
  use the **same kernel tarball**; they differ only in kernel defconfig (`bcm2711` vs
  `bcmrpi3`), `BR2_LINUX_KERNEL_INTREE_DTS_NAME`, rpi-firmware variant
  (`VARIANT_PI4` vs `VARIANT_PI` + `BOOTCODE_BIN`) and toolchain tuning.
- The FrameOS packaging step is already model-agnostic: it globs `${BINARIES_DIR}/*.dtb`
  and `rpi-firmware/*` onto the FAT partition, so it will carry whatever the config emits.
- The single hard gate is `backend/app/tasks/buildroot_image.py` —
  `normalize_buildroot_platform()` (L211) backed by scalar constants
  `SUPPORTED_BUILDROOT_PLATFORM` (L74) and `BUILDROOT_DEFCONFIG` (L151).

## Phase 1 — platform registry (behavior-preserving refactor) [DONE 2026-07-22]

`backend/app/tasks/buildroot_image.py`:

- [x] Add a `BuildrootPlatformSpec` dataclass: `id`, `label`, `aliases`, `defconfig`,
      `extra_buildroot_config_lines` (BR2_* overrides appended to the generated config),
      `boot_config_lines`, `include_pi4_firmware` (stage `start4.elf`/`fixup4.dat` in the
      post-image script). The brcmfmac43436 blob/symlink pass stays unconditional — the
      unified image needs it too, and it's inert on non-Zero-2-W boards.
- [x] `BUILDROOT_PLATFORMS` registry; first entry `raspberry-pi-zero-2-w` reproducing
      today's behavior byte-for-byte (same defconfig, `gpu_mem=32`, wifi patch on).
- [x] Generalize `normalize_buildroot_platform()` + add `buildroot_platform_spec()`;
      keep per-platform alias tables (today's `LEGACY_PLATFORM_ALIASES` move into the
      zero-2-w entry; empty string keeps defaulting to zero-2-w).
- [x] Thread the frame's platform through `BuildrootImageBuilder` instead of the module
      constants: image filename (L962), status payloads (L976, L1065), base-entry
      resolution (L780, L1008, L1159), defconfig in the build script (L1818) and the
      output cache key (L2719), boot-config default lines (L553, L2910 — the
      `POST_IMAGE_SCRIPT` f-string must become a function of the spec).
- [x] Keep `SUPPORTED_BUILDROOT_PLATFORM` / `BUILDROOT_DEFCONFIG` as aliases of the
      default spec for backward compatibility (`tools/buildroot-images/buildroot_images.py`
      and several tests import them).
- [x] Cache-key safety: the output cache key hashes the generated
      `frameos-buildroot.config` + defconfig string, so zero-2-w keys must stay identical
      after the refactor. Per-platform BR2 lines will naturally split caches for new
      platforms.
- [x] Update backend tests that assume single-platform normalize
      (`test_buildroot_image.py`, `test_buildroot_release_image.py`, `test_frames.py`,
      `test_log.py`, `test_websockets.py`).

## Phase 2 — the unified `raspberry-pi-64` platform

- [x] Registry entry `raspberry-pi-64` (implemented; build + boot-test pending) ("Raspberry Pi Zero 2 W / 3 / 4, 64-bit"):
      base defconfig `raspberrypizero2w_64_defconfig` plus overrides:
      - `BR2_LINUX_KERNEL_DEFCONFIG="bcm2711"`
      - `BR2_LINUX_KERNEL_INTREE_DTS_NAME="broadcom/bcm2710-rpi-zero-2-w
        broadcom/bcm2710-rpi-3-b broadcom/bcm2710-rpi-3-b-plus
        broadcom/bcm2711-rpi-4-b broadcom/bcm2711-rpi-400"`
      (generic aarch64 Bootlin toolchain from the zero2w defconfig runs fine on
      Cortex-A72; keep `gpu_mem=32`.)
- [x] Stage Pi 4 GPU firmware (post-image snippet gated by `include_pi4_firmware`): rpi-firmware's `.mk` only installs the selected variant,
      but the downloaded package source contains all of them — add a per-platform
      post-image step that copies `start4.elf` + `fixup4.dat` from
      `/build/output/build/rpi-firmware-*/boot/` into `${BINARIES_DIR}/rpi-firmware/`
      before genimage packaging.
- [ ] WiFi firmware: keep the 43436 patch pass (Zero 2 W); Pi 3B/3B+/4 blobs
      (43430/43455) already come from `BR2_PACKAGE_BRCMFMAC_SDIO_FIRMWARE_RPI` — verify
      they land in the rootfs.
- [ ] Check the kernel trim fragment (`_write_kernel_config_fragment`) against
      `bcm2711_defconfig` — the disabled drivers are model-neutral, but confirm nothing
      Pi 4-critical (e.g. `xhci`, PCIe, genet ethernet) is trimmed.
- [ ] Verify `cmdline.txt`/`config.txt` from the zero2w board config work on Pi 4
      (`arm_64bit=1`, `kernel=Image`; firmware auto-selects the DTB by model).
- [ ] Build locally: `python tools/buildroot-images/buildroot_images.py
      --platform raspberry-pi-64 build`, then boot-test on real hardware:
      Zero 2 W, Pi 3B+, Pi 4B (HDMI + SPI e-ink + WiFi + SSH on each).

## Phase 3 — frontend

- [x] `frontend/src/devices.ts` — add the new platform(s) to
      `buildrootPlatforms`.
- [x] `frontend/src/scenes/workspace/FrameDeployPlanDrawer.tsx` — drop the
      hardcoded `?? 'raspberry-pi-zero-2-w'` fallback in favor of the registry default.
- [ ] `e2e/frontend-visual/tests/frame-install-flow.spec.ts` — update.

## Phase 4 — tools + CI

- [x] `tools/buildroot-images/buildroot_images.py` — validate `--platform` for all
      subcommands (today only `release-image` validates); take the defconfig recorded in
      metadata (L576) from the spec, not the module constant.
- [ ] `.github/workflows/buildroot-base-image.yml` — already parameterized by input;
      just document/dispatch the new platform to publish its base image to R2.
- [ ] `.github/workflows/docker-publish-multi.yml` (`build-buildroot-release-image`,
      L246/L257) — matrix over platforms, or switch the release asset to the unified
      image once it's boot-tested. Decide whether to keep shipping the zero-2-w-only
      asset for one release cycle (backward-compatible download URLs).
- [ ] `tools/buildroot-images/README.md` — update examples.

## Phase 5 — docs (frameos-docs repo)

- [ ] `content/docs/guide/raspberry.mdx` — "Option 1: prebuilt image (recommended)" is
      currently Zero 2 W-only; extend to Pi 3/4 once the unified image ships.
- [ ] `content/docs/guide/index.mdx` + device pages that mention the SD image.

## Open questions

- Pi 5 (BCM2712) is out of scope: needs `bcm2712` kernel defconfig / `kernel_2712.img`;
  revisit later.
- 32-bit boards (Pi 1/2/Zero W) stay on the "stock Raspberry Pi OS Lite" path.
- Whether `raspberry-pi-64` eventually *replaces* `raspberry-pi-zero-2-w` as the only
  released image (single CI build, single download) or ships alongside it.
