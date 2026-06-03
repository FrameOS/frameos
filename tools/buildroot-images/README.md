# Buildroot Base Images

FrameOS Buildroot SD images are assembled from a cached base image plus current
per-frame BOOT payloads, FRAMEOS, and ASSETS partition images. The slow Buildroot
base image is built manually in CI or locally, uploaded to the `frameos-archive`
R2 bucket, and referenced by this manifest.

## Commands

```bash
# Build the reusable base image for the current FrameOS version.
python tools/buildroot-images/buildroot_images.py --platform raspberry-pi-zero-2-w build

# Upload it to R2 and update buildroot-images/manifest.json in the bucket.
python tools/buildroot-images/buildroot_images.py --platform raspberry-pi-zero-2-w upload --yes

# Compose a release-ready image from downloaded precompiled release artifacts.
python tools/buildroot-images/buildroot_images.py --platform raspberry-pi-zero-2-w \
  release-image --prebuilt-cross-dir release-assets --release-assets-dir release-assets

# Refresh the checked-in local manifest from R2.
python tools/buildroot-images/buildroot_images.py download --force

# Inspect remote entries.
python tools/buildroot-images/buildroot_images.py list
```

The helper reads R2 credentials from the environment or a `.env` file:

```bash
export R2_ACCOUNT_ID=...
export R2_ACCESS_KEY_ID=...
export R2_SECRET_ACCESS_KEY=...
export R2_BUCKET=frameos-archive
```

## Runtime Flow

The web UI no longer runs Buildroot. When a Buildroot frame requests an SD card
image, the backend builds the FrameOS binary and agent, downloads the matching
cached base image from `https://archive.frameos.net/buildroot-images/manifest.json`,
then patches the BOOT partition with per-frame setup files and replaces only the
`FRAMEOS` and `ASSETS` partitions.

The base rootfs contains first-boot setup plumbing and mount configuration. The
setup payload is written to the BOOT partition as `frameos-setup.json`, and the
first-boot setup service runs
`/srv/frameos/current/frameos setup --with-setup=/boot/frameos-setup.json`. Other
per-frame boot files include WiFi credentials, hostname, and authorized SSH keys.

Release images are composed after all precompiled release binaries have been
built. They use the cached base image plus the Debian Bookworm ARM64 precompiled
FrameOS/agent artifacts, ship without WiFi credentials, and keep
`wifiHotspot=bootOnly` so a Pi Zero 2 W starts the setup hotspot when it cannot
reach the network. The first-boot setup service is present but dormant until a
future SD card builder copies `frameos-setup.json` to the BOOT partition.

Add future hardware targets by adding a platform alias/target in
`backend/app/tasks/buildroot_image.py`, extending the CLI defaults, then building
and uploading another manifest entry. The partition layout must stay:

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
  --platform linux/amd64,linux/arm64 \
  --build-arg BASE_IMAGE=debian:bookworm \
  --build-arg BUILDROOT_VERSION=2025.02.13 \
  --tag frameos/frameos-buildroot:debian_bookworm-2025.02.13-latest \
  --push \
  -f backend/tools/buildroot.Dockerfile .
```
