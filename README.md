# FrameOS

FrameOS is an **operating system for single function smart frames**. 

It's meant to be deployed on a Raspberry Pi, and can be used with a variety of e-ink and traditional displays. It's designed for both screens that update **60 seconds per frame**, and for screens that update **60 frames per second**.

Think smart home calendars, meeting room displays, thermostats, industrial dashboards, public advertisement screens, and more.

To get started:

1. Install the [FrameOS backend](https://frameos.net/guide/backend), a dockerized python app, which is used to deploy apps onto individual frames via SSH.

2. Read the [device hardware guide](https://frameos.net/devices/) for your screen type. Typically you'll just need to connect the display to a Raspberry Pi, install the OS, and make sure it's reachable over the network. 

3. Once connected, deploy our prebuilt scenes, or code your own directly inside the backend.

4. Finally, for a professional look, 3d print a case around your frame.

![](https://frameos.net/assets/images/walkthrough-c32e7b67dd9a6f14ebef743755b0fc8e.gif)

## Development with Flox

If you use [Flox](https://flox.dev), this repo now ships a checked-in environment. Running `flox activate` bootstraps the core toolchains and installs the repo-local development dependencies for Python, pnpm, and Nim.

```bash
flox activate
pnpm dev
```

The activation hook creates a local `.venv`, installs `backend/requirements.txt`, runs `pnpm install --frozen-lockfile` for the workspace, and installs the Nim dependencies for `frameos/` and `frameos/agent/`.

If you want Redis managed by Flox as well, start it with:

```bash
flox services start redis
```



## Supported platforms

Supported are all the most common e-ink displays out there.

- Pimoroni e-ink frames
- Waveshare e-ink
- Framebuffer HDMI output
- Web server kiosk mode

[See the full list here!](https://frameos.net/devices/)

## FrameOS backend

The FrameOS backend is where you set up your frames. You can run it continuously on a server, or locally on your computer when needed. You'll just miss out on log aggregation if the backend is offline. The frames run independently.

Read more in [the documentation](https://frameos.net/guide/backend).

### Quick install

The easiest way to install the FrameOS backend on a Mac or Debian/Ubuntu Linux is to run the following installation script:

```bash
bash <(curl -fsSL https://frameos.net/install.sh)
```

### Running via Docker manually

```bash
# running the latest release
SECRET_KEY=$(openssl rand -base64 32)
mkdir -p db
docker run -d -p 8989:8989 \
    -v ./db:/app/db \ 
    --name frameos \
    --restart always \
    -e SECRET_KEY="$SECRET_KEY" \
    frameos/frameos

# If you want to speed up your builds with cross-compilation, you must enable privileged mode.
# This lets FrameOS spin up docker containers for the various build environments.
# Alernatively, skip this, and configure a remote build server, or build on devices directly.
SECRET_KEY=$(openssl rand -base64 32)
mkdir -p db
mkdir -p /tmp/frameos-cross
docker run -d -p 8989:8989 \
    -v ./db:/app/db \
    -v /tmp/frameos-cross:/tmp/frameos-cross \
    -v /var/run/docker.sock:/var/run/docker.sock \
    --privileged \
    --name frameos \
    --restart always \
    -e SECRET_KEY="$SECRET_KEY" \
    -e TMPDIR=/tmp/frameos-cross \
    frameos/frameos

# update daily to the latest release
docker run -d \
    --name watchtower \
    -v /var/run/docker.sock:/var/run/docker.sock \
    containrrr/watchtower \
    --interval 86400 \
    frameos

# one time update
docker run \
    -v /var/run/docker.sock:/var/run/docker.sock \
    containrrr/watchtower \
    --run-once \
    frameos

# running a local dev build via docker
SECRET_KEY=$(openssl rand -base64 32)
docker build -t frameos .
docker run -d -p 8989:8989 \
    -v ./db:/app/db \
    -v /tmp/frameos-cross:/tmp/frameos-cross \
    -v /var/run/docker.sock:/var/run/docker.sock \
    --privileged \
    --name frameos \
    --restart always \
    -e SECRET_KEY="$SECRET_KEY" \
    -e TMPDIR=/tmp/frameos-cross \
    frameos
```

### Cross-toolchain build container images

Cross-compilation uses prebuilt toolchain containers from Docker Hub at `frameos/frameos-cross-toolchain` when possible, which avoids rebuilding the toolchain image for every target.

The workflow `.github/workflows/frameos-cross-toolchain.yml` builds and publishes these images.

The image name is resolved as:

- `{repo}:{base}_{version}-{platform}-{tag}`
- `base` is the Linux distro (`debian`, `ubuntu`, ...)
- `version` is the distro version (for example `bookworm` or `26.04`)
- `platform` is the docker platform with `/` replaced by `_` (for example `linux_amd64`, `linux_arm64`, `linux_arm_v7`)
- `tag` defaults to `latest`

You can override the default behavior with environment variables:

- `FRAMEOS_CROSS_TOOLCHAIN_IMAGE`: full Docker image override (can be a Python format template using `slug`, `base`, `platform`, and `tag`)
- `FRAMEOS_CROSS_TOOLCHAIN_IMAGE_REPO`: image repository (default `frameos/frameos-cross-toolchain`)
- `FRAMEOS_CROSS_TOOLCHAIN_IMAGE_TAG`: image tag used by the default resolver (default `latest`)
- `FRAMEOS_CROSS_TOOLCHAIN_FORCE_LOCAL_BUILD=1`: force rebuilding the toolchain image locally, even if a remote tag exists
- `FRAMEOS_CROSS_TOOLCHAIN_SKIP_PULL=1`: skip pulling remote images and only use local/locally built images

Example for local iteration on a new toolchain image:

```bash
export FRAMEOS_CROSS_TOOLCHAIN_IMAGE=frameos/frameos-cross-toolchain:debian_trixie-linux_arm_v7-my-wip
export FRAMEOS_CROSS_TOOLCHAIN_FORCE_LOCAL_BUILD=1
```

### Buildroot image cache

Buildroot SD image generation supports a cached Buildroot image with dependency packages preinstalled and the Buildroot tarball preloaded at `/frameos-buildroot`.

You can control the cached image with:

- `FRAMEOS_BUILDROOT_IMAGE`: optional full image name override (supports `{slug}`, `{base}`, `{version}`, and `{tag}` placeholders)
- `FRAMEOS_BUILDROOT_IMAGE_REPO`: image repository (default `frameos/frameos-buildroot`)
- `FRAMEOS_BUILDROOT_IMAGE_TAG`: image tag (default `latest`)
- `FRAMEOS_BUILDROOT_FORCE_LOCAL_BUILD=1`: force rebuilding the Buildroot image locally
- `FRAMEOS_BUILDROOT_SKIP_PULL=1`: skip pulling cached images from the registry
- `FRAMEOS_BUILDROOT_DOCKER_IMAGE`: base image used when building `frameos-buildroot` (default `debian:bookworm`)
- `FRAMEOS_BUILDROOT_IMAGES_DIGESTS_PATH`: path to the digest manifest (default `buildroot-images.json` in repo root)
- `FRAMEOS_BUILDROOT_FRAMEOS_PARTITION_SIZE`: `/srv/frameos` ext4 partition size (default `512M`)
- `FRAMEOS_BUILDROOT_ASSETS_PARTITION_SIZE`: `/srv/assets` FAT32 partition size (default `512M`)

Buildroot-specific output cache keys include the resolved cache image, so changing image configuration invalidates stale output directories automatically.

Generated SD images use separate partitions for boot, root, FrameOS runtime data, and assets:

- `p1`: FAT32 boot partition
- `p2`: ext4 root filesystem
- `p3`: ext4 `/srv/frameos`
- `p4`: FAT32 `/srv/assets`

Example:

```bash
export FRAMEOS_BUILDROOT_IMAGE_REPO=frameos/frameos-buildroot
export FRAMEOS_BUILDROOT_IMAGE_TAG=latest
export FRAMEOS_BUILDROOT_FORCE_LOCAL_BUILD=1
```

The corresponding GitHub workflow is `.github/workflows/frameos-buildroot.yml` and triggers on pushes to `main` when `backend/tools/buildroot.Dockerfile` changes. It writes `buildroot-images.json` with digest data used by runtime image resolution.
