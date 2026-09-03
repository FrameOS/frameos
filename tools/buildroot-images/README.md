# Buildroot Base Images

FrameOS Buildroot SD images are assembled from a cached base image plus current
per-frame BOOT payloads, FRAMEOS, and ASSETS partition images. The slow Buildroot
base image is built manually in CI or locally, uploaded to the `frameos-archive`
R2 bucket, and referenced by this manifest.

## Platforms

Every supported board is described by one entry in the platform registry,
`backend/app/tasks/buildroot_platforms.py`: Buildroot defconfig, binary
cross-compile target, extra Buildroot config, boot config, and Wi-Fi firmware
quirks all live there. Currently enabled:

| Platform | Bits | Defconfig | Binary target |
| --- | --- | --- | --- |
| `raspberry-pi-32` | 32 | `raspberrypi0w_defconfig` | `debian-bookworm-armv6` |
| `raspberry-pi-64` | 64 | `raspberrypizero2w_64_defconfig` | `debian-bookworm-arm64` |
| `raspberry-pi-5` | 64 | `raspberrypi5_defconfig` | `debian-bookworm-arm64` |

`raspberry-pi-64` is one unified image for the Zero 2 W, Pi 3, and Pi 4/400
(one bcm2711 kernel, all DTBs, both `start.elf`/`start4.elf` firmware sets;
the GPU bootloader picks per model). The Zero 2 W used to be its own
`raspberry-pi-zero-2-w` platform before folding in here; that key survives
as an alias. `raspberry-pi-5` covers every BCM2712 board with a DTB in the
pinned kernel: Pi 5 (C0 + D0) and CM5 on either carrier (Pi 500 / CM5 Lite
DTS files postdate the pin and join on the next Buildroot bump).

`raspberry-pi-32` is one unified image for every ARMv6 board (Pi Zero,
Zero W, Pi 1 A/A+/B/B+, CM1): they all boot the same `bcmrpi` kernel and
`start.elf` firmware, so the image just ships every `bcm2708-*.dtb` and the
GPU bootloader picks per model. It was published as `raspberry-pi-zero-w`
before the DTB list was widened; that key survives as an alias. ARMv6 is
hard-float and Debian has no ARMv6 port, so the FrameOS and Remote binaries
are cross-compiled with the Bootlin `armv6-eabihf` toolchain inside an amd64
container (`backend/bin/cross` target `debian-bookworm-armv6`); the Debian
armhf packages only provide headers and link-time stubs, and at runtime
binaries resolve against the ARMv6 Buildroot rootfs libraries. Never ship
`armhf` (ARMv7) binaries to an ARMv6 board — they SIGILL on its ARM1176
core.

Base images for 32-bit ARM platforms are best built on x86_64 hosts, where the
prebuilt Bootlin rootfs toolchain applies; on other hosts Buildroot silently
falls back to building the toolchain from source (slower, same result).

Registered but not yet implemented (`enabled=False`, see TODOs in the
registry): `luckfox-pico` (Rockchip RV1103/RV1106) and `allwinner-t113`
(T113-S3/S4). Both are ARMv7 and can reuse the `debian-bookworm-armhf` binary
target, but need their own defconfig/BR2_EXTERNAL tree and a non-Raspberry-Pi
boot layout in the post-image flow.

The `manifest.json` in this directory holds one entry per platform; `upload`
replaces only the entry for the platform being uploaded.

## CI publishing

Use the manual GitHub workflow `.github/workflows/buildroot-base-image.yml` for
the preferred base-image publishing path. From the branch that should receive the
manifest commit:

```bash
gh workflow run buildroot-base-image.yml --ref your-branch

# Build the unified 32-bit ARMv6 base image (Pi Zero / Zero W / 1):
gh workflow run buildroot-base-image.yml --ref your-branch -f platform=raspberry-pi-32

# Build every platform in parallel (one matrix job per platform, each on its
# default runner). This is the default when no platform is passed:
gh workflow run buildroot-base-image.yml --ref your-branch -f platform=all

# Use a custom runner label, for example a larger ARM runner:
gh workflow run buildroot-base-image.yml --ref your-branch -f runner_label=your-arm-runner-label
```

The workflow picks the platform's default runner (`ubuntu-24.04-arm` for the
64-bit platforms, x86_64 `ubuntu-24.04` for 32-bit ARM platforms so the prebuilt
Bootlin toolchain applies) and can be dispatched with a custom runner label
when a larger/self-hosted runner is available. It builds the base image,
uploads it to R2, and verifies the refreshed manifest.

The manifest is then mirrored back into git by a single `commit-manifest` job
that waits for every platform to finish, so a `platform=all` run produces **one**
commit naming all the platforms it published — not one commit per platform
racing to push the same file. `platform=all` is the default; the manifest keeps
one entry per platform. If one platform fails, the others are still committed
and the run is marked failed.

Repository secrets required by the upload step:

```bash
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_ACCOUNT_ID    # or R2_ENDPOINT
```

## Commands

```bash
# Build the reusable base image for the current FrameOS version.
python tools/buildroot-images/buildroot_images.py --platform raspberry-pi-64 build

# Force a clean rebuild of the selected cached /build/output entry.
python tools/buildroot-images/buildroot_images.py --platform raspberry-pi-64 build --clean-output-cache

# Upload it to R2 and update buildroot-images/manifest.json in the bucket.
python tools/buildroot-images/buildroot_images.py --platform raspberry-pi-64 upload --yes

# Compose a release-ready image from downloaded precompiled release artifacts.
python tools/buildroot-images/buildroot_images.py --platform raspberry-pi-64 \
  release-image --prebuilt-cross-dir release-assets --release-assets-dir release-assets

# Refresh the checked-in local manifest from R2.
python tools/buildroot-images/buildroot_images.py download --force

# Inspect remote entries.
python tools/buildroot-images/buildroot_images.py list

# Print the enabled platform matrix (used by CI).
python tools/buildroot-images/buildroot_images.py platforms
```

All commands accept `--platform raspberry-pi-32` for the unified 32-bit image;
`release-image` derives `--target` from the platform when omitted.

The helper reads R2 credentials from the environment or a `.env` file:

```bash
export R2_ACCOUNT_ID=...
export R2_ACCESS_KEY_ID=...
export R2_SECRET_ACCESS_KEY=...
export R2_BUCKET=frameos-archive
```

## Runtime Flow

The web UI no longer runs Buildroot. When a Buildroot frame requests an SD card
image, the backend builds the FrameOS binary and Remote, downloads the matching
cached base image from `https://archive.frameos.net/buildroot-images/manifest.json`,
then patches the BOOT partition with per-frame setup files and replaces only the
`FRAMEOS` and `ASSETS` partitions.

### Privilege separation

Generic images run `frameos.service` as the unprivileged **`frameos`** user
(uid/gid 990) and put the few root actions behind the privileged door — a
`.path` unit watching `/srv/frameos/privileged/queue` that starts a root
oneshot running `frameos privileged-worker`. `docs/buildroot-privileges.md` §4
is the reference; the moving parts here are:

- `render_buildroot_frameos_service(uses_network_manager, user=...)` renders
  `frameos/frameos.service` plus, for a non-root user,
  `frameos/frameos.service.unprivileged`. **The device renders the same unit
  from the same two files** (`renderBuildrootFrameosService` in
  `frameos/src/frameos/buildroot_privileges.nim`); if the two ever disagree,
  every upgrade tries to rewrite the read-only rootfs.
- `buildroot_frameos_service_user_for_platform` picks the user:
  `frameos` for generic images on NetworkManager platforms, `root` for
  `raspberry-pi-32` (the runtime drives wpa_supplicant itself) and for
  backend-personalized images (the backend deploys into them as root).
- The user is created three ways, all agreeing on uid 990:
  `BR2_ROOTFS_USERS_TABLES` for new base builds,
  `backend/app/tasks/buildroot_user_merge.py` (embedded into `patch-root.sh`)
  for images composed from an older cached base, and `frameos setup` on a
  frame upgrading from a root-only release.
- `render_frameos_partition_ownership_commands` stamps the `/srv/frameos`
  layout onto the finished ext4 with `debugfs sif`: root owns the code
  (`releases/<r>/frameos`, `drivers/`, `scenes/`, and `vendor/`), shared
  writable directory roots are root-owned and sticky (`1770`), result files
  are root-owned and group-readable, and each release directory is sticky
  (`1775`) so the runtime can add its data files but cannot replace root's
  binary or code-loading directories.

Generic release images also ship **no FrameOS Remote** — no
`/srv/frameos/remote`, no unit. A self-hosted backend that adopts the card
installs its own copy on its first deploy.

The base rootfs contains first-boot setup plumbing and mount configuration. The
setup payload is written to the BOOT partition as `frameos-setup.json`, and the
first-boot setup service runs
`/srv/frameos/current/frameos setup --with-setup=/boot/frameos-setup.json`. Other
per-frame boot files include WiFi credentials, hostname, and authorized SSH keys.

Secret handling on the FAT boot partition:

- After a successful first boot the consumed `frameos-setup.json` is
  **overwritten with zeros and deleted** (best effort on FAT). It used to be
  renamed to `setup-done-<timestamp>.json`, which left WiFi credentials and
  access keys readable on the boot partition; that rename no longer happens.
  The persistent `/boot/frameos-setup-reset.log` keeps the debugging trail.
- `/boot` is mounted `umask=077` (root-only). Everything touching it at
  runtime already runs as root.
- The same first-boot service also watches `/boot/frameos-cloud.txt`, the
  cloud-enrollment personalization file (see `docs/cloud-frames.md`,
  "Provisioning"). When it contains at least one recognized key
  (`cloud_url`, `claim_token`, `name`, `wifi_ssid`, `wifi_password`,
  `device`/`width`/`height`/`rotate`/`vcom`/`upload_url`, `root_password`,
  `time_zone`), the script installs the optional WiFi credentials as a
  NetworkManager keyfile, writes
  `/srv/frameos/current/state/cloud_enroll_pending.json` (0600) with
  `{"claim_token", "provider_url", "name"?, "time_zone"?}` for the FrameOS
  runtime to enroll with (which then writes name + timeZone into
  `frame.json`), sets `/etc/hostname` from the slugified `name`, and shreds
  the personalization file the same way. A
  `wifi_ssid` without a `wifi_password` is an open network: the keyfile then
  carries no `[wifi-security]` section at all (`key-mgmt=wpa-psk` with an
  empty `psk=` yields a connection NetworkManager can never activate). On
  images without `python3` (busybox-only), double quotes, backslashes, and
  control characters are stripped from `frameos-cloud.txt` values when
  writing that JSON — avoid them in names and WiFi credentials there.
- The file is only shredded once its secrets have actually been consumed:
  a successful enrollment (the claim token is single-use) or a written WiFi
  keyfile. If neither happened — e.g. a valid `cloud_url` next to a
  misspelled `claim_tokn=` — the script warns and keeps the file, because it
  is the user's only copy of what they typed. `/boot` is mounted root-only
  (`umask=077`), so keeping it cannot leak the contents.
- A `frameos-cloud.txt` with **no recognized keys** is treated as "not
  personalized": no enrollment state, file left untouched, exit 0. Release
  images rely on this — they ship the file as an all-comments 4096-byte
  placeholder (first line `# FRAMEOS-CLOUD-CONFIG-V1`, generated by
  `app.tasks.setup_json_reset.render_cloud_config_placeholder`, padded with
  lines of 79 `#` characters) so the provider's in-browser download flow can
  patch real `KEY=value` content into the image in place. The first-boot
  unit keeps firing on every boot while the file exists, so the script
  checks *before* doing anything whether the file holds any `KEY=value`
  line: an untouched placeholder with no `frameos-setup.json` next to it
  exits immediately, without remounting `/` read-write, without appending to
  `/boot/frameos-setup-reset.log`, and without reinstalling
  `/boot/frameos-hostname` or `/boot/frameos-wifi.nmconnection` over `/etc`.
  If the file has `KEY=value` lines but none of them is a recognized key
  (a typo'd manual edit), the script warns loudly on every boot, does
  **not** shred, and does not enroll, so the user can fix the key names and
  reboot.

SD image composition re-stamps the current first-boot script, service unit,
and `/etc/fstab` into the root partition, so images composed from older cached
base images pick up these behaviors without a base image rebuild.

On first boot from a larger SD card, the base rootfs also runs
`frameos-expand-sd-card.service` before `/srv/frameos` and `/srv/assets` are
mounted. It keeps the root partition unchanged, resizes the ext4 `FRAMEOS`
partition in place, and recreates the FAT `ASSETS` filesystem with the remaining
space. Cards smaller than 4 GiB keep `FRAMEOS` at 1 GiB; larger cards use 2 GiB
for `FRAMEOS`. The shipped `ASSETS` partition is expected to be empty or
disposable.

Release images are composed after all precompiled release binaries have been
built. They use the cached base image plus the platform's precompiled
FrameOS binary (the Remote binary in the artifact is ignored — see
"Privilege separation" above), ship without WiFi credentials, and keep
`wifiHotspot=bootOnly` so the board starts the `FrameOS-Setup` hotspot when it
cannot reach the network. The first-boot setup service is present but dormant:
`frameos-setup.json` (self-hosted personalization) is absent, and
`frameos-cloud.txt` ships as the 4096-byte all-comments placeholder described
above, ignored on boot until it is personalized — edited manually after
flashing, or patched byte-in-place into the downloaded image by a provider's
in-browser flow. The boot-partition patch step copies the placeholder into
the BOOT FAT before any other file so its clusters stay contiguous (the
in-place patcher rewrites the 4096-byte region inside the raw image without
touching FAT metadata). Backend-personalized (self-hosted) images never carry
the placeholder: the boot patch deletes any stale `frameos-cloud.txt`, since
those frames are backend-managed.

Release images exist only for platforms that have a published base image in
the manifest. To enable a platform's release images (`raspberry-pi-32`,
`raspberry-pi-64`, `raspberry-pi-5`, …), first run the manual base-image
workflow for it once
(`gh workflow run buildroot-base-image.yml --ref <branch> -f platform=<key>`);
release composition picks the platform up from the manifest after that.

Add future hardware targets by adding a `BuildrootPlatform` entry in
`backend/app/tasks/buildroot_platforms.py` (plus, for a new CPU target, a
`TargetDefinition` in `backend/bin/cross` and a toolchain entry in
`backend/app/utils/cross_toolchain_packages.py`), then building and uploading
another manifest entry. Non-Raspberry-Pi families additionally need their own
post-build/post-image flow in `backend/app/tasks/buildroot_image.py` — the
Raspberry-Pi-only spots raise `NotImplementedError` with TODOs. The partition
layout must stay:

1. FAT boot
2. ext4 root
3. ext4 `FRAMEOS`
4. FAT `ASSETS`

## Buildroot Helper Container

There are two separate caches involved in Buildroot SD image generation:

1. The R2 base image cache stores the slow Buildroot root filesystem and
   partition layout.
2. The FrameOS runtime image stores the composition tools needed to patch the
   cached base image into a frame-specific SD image. Older or local development
   environments can still fall back to the Docker helper image.

The helper image is built from `backend/tools/buildroot.Dockerfile` and defaults
to:

```text
frameos/frameos-buildroot:debian_bookworm-2025.02.13-latest
```

The main `frameos/frameos` Docker image preinstalls the SD image composition
tools `genimage`, `dosfstools` (`mkfs.vfat`), `e2fsprogs`, and `mtools`
(`mcopy`, `mlabel`), so cached-base SD images do not require a mounted Docker
socket or privileged container mode. If those host tools are missing, the
backend falls back to the helper image, which preinstalls the same tools plus
the Buildroot host dependencies.

The backend resolves the helper image in `backend/app/tasks/buildroot_image.py`.
The main environment knobs are:

```bash
FRAMEOS_BUILDROOT_IMAGE_REPO=frameos/frameos-buildroot
FRAMEOS_BUILDROOT_IMAGE_TAG=latest
FRAMEOS_BUILDROOT_IMAGE=...              # optional full image override
FRAMEOS_BUILDROOT_DOCKER_IMAGE=debian:bookworm
FRAMEOS_BUILDROOT_VERSION=2025.02.13
FRAMEOS_BUILDROOT_FORCE_LOCAL_BUILD=1    # ignore remote cache and build locally
FRAMEOS_BUILDROOT_SKIP_PULL=1            # do not pull from Docker Hub
```

The manual base-image helper keeps three local caches by default:

```text
build/buildroot-images/cache         # Buildroot download cache mounted at /cache
build/buildroot-images/cache/ccache  # Buildroot compiler cache, capped at 10 GiB
build/buildroot-images/source-cache  # extracted Buildroot source mounted at /build/buildroot
build/buildroot-images/output-cache  # keyed /build/output cache for repeated local builds
```

The output cache key includes the generated Buildroot config, kernel fragment,
post-build scripts, overlay, boot logo, Buildroot version, helper image, and
bootstrap script version. Re-running the same base build can therefore copy the
cached `sdcard.img`; changing those inputs selects a new output cache entry. Use
`--no-output-cache` to force ephemeral output or `--clean-output-cache` to delete
the selected entry before rebuilding.

Each base build writes timing details into the generated metadata:

```text
phase_timings     # apt install, source preparation, Buildroot make, image copy, etc.
package_timings   # top package directories by stamp-file elapsed time
```

When using the prebuilt helper image directly, pass `--skip-apt-install` or set
`FRAMEOS_BUILDROOT_SKIP_APT_INSTALL=1` to avoid the container apt step.

To verify a local or pulled helper image has the required composition tools:

```bash
docker run --rm frameos/frameos-buildroot:debian_bookworm-2025.02.13-latest \
  sh -lc 'command -v genimage && command -v mkfs.vfat && command -v mcopy && command -v mlabel'
```

The preferred publishing path is the GitHub workflow
`.github/workflows/frameos-buildroot.yml`, which runs when
`backend/tools/buildroot.Dockerfile` changes on `main` and uses repository
secrets to push to Docker Hub.

Manual publishing requires Docker Hub write access:

```bash
docker buildx create --name frameos-publish --driver docker-container --use

docker buildx build \
  --builder frameos-publish \
  --platform linux/amd64,linux/arm64/v8,linux/arm/v7 \
  --build-arg BASE_IMAGE=debian:bookworm \
  --build-arg BUILDROOT_VERSION=2025.02.13 \
  --tag frameos/frameos-buildroot:debian_bookworm-2025.02.13-latest \
  --push \
  -f backend/tools/buildroot.Dockerfile .
```
