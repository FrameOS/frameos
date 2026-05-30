# Buildroot Base Images

FrameOS Buildroot SD images are assembled from a cached base image plus current
per-frame BOOT payloads, FRAMEOS, and ASSETS partition images. The slow Buildroot
base image is built manually in CI or locally, uploaded to the `frameos-archive`
R2 bucket, and referenced by this manifest.

## Commands

```bash
# Build the reusable base image for the current FrameOS version.
python tools/buildroot-images/buildroot_images.py build \
  --platform raspberry-pi-zero-2-w

# Upload it to R2 and update buildroot-images/manifest.json in the bucket.
python tools/buildroot-images/buildroot_images.py upload \
  --platform raspberry-pi-zero-2-w \
  --yes

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

Add future hardware targets by adding a platform alias/target in
`backend/app/tasks/buildroot_image.py`, extending the CLI defaults, then building
and uploading another manifest entry. The partition layout must stay:

1. FAT boot
2. ext4 root
3. ext4 `FRAMEOS`
4. FAT `ASSETS`
