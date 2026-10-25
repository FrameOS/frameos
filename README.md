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

The activation hook creates a local `.venv`, installs `backend/requirements.txt`, runs `pnpm install --frozen-lockfile` for the workspace, and installs the Nim dependencies for `frameos/` and `frameos/remote/`.

If you want Redis managed by Flox as well, start it with:

```bash
flox services start redis
```



## Supported platforms

Supported are all the most common e-ink displays out there, on a Raspberry Pi or an
[ESP32-S3](https://frameos.net/guide/esp32).

- Pimoroni e-ink frames
- Waveshare e-ink
- Seeed Studio reTerminal e-paper displays
- Framebuffer HDMI output
- Web server kiosk mode

[See the full list here!](https://frameos.net/devices/)

### Seeed Studio reTerminal

FrameOS supports Seeed Studio's reTerminal ePaper displays out of the box. Each one has a hardware
preset: pick it, flash the frame from the browser, and scenes render on the device itself.

- reTerminal E1003 - 10.3" 16-level grayscale, touch ([Seeed wiki](https://wiki.seeedstudio.com/getting_started_with_reterminal_e1003/))
- [reTerminal E1004](https://frameos.net/devices/seeed-reterminal-e1004) - 13.3" Spectra 6 color ([buy](https://www.seeedstudio.com/reTerminal-E1004-p-6692.html?sensecap_affiliate=NK0JMuC&referring_service=link))
- [reTerminal E1002](https://frameos.net/devices/seeed-reterminal-e1002) - 7.3" Spectra 6 color ([buy](https://www.seeedstudio.com/reTerminal-E1002-p-6533.html?sensecap_affiliate=NK0JMuC&referring_service=link))
- [reTerminal E1001](https://frameos.net/devices/seeed-reterminal-e1001) - 7.5" black/white ([buy](https://www.seeedstudio.com/reTerminal-E1001-p-6534.html?sensecap_affiliate=NK0JMuC&referring_service=link))
- [reTerminal Sticky](https://frameos.net/devices/seeed-reterminal-sticky) - 3.97" black/white ([buy](https://www.seeedstudio.com/reTerminal-Sticky-p-6861.html?sensecap_affiliate=NK0JMuC&referring_service=link))
- [XIAO ePaper Display Board EE04](https://frameos.net/devices/seeed-xiao-epaper-ee04) and [EE05](https://frameos.net/devices/seeed-xiao-epaper-ee05) - bring your own panel
  ([buy EE04](https://www.seeedstudio.com/XIAO-ePaper-Display-Board-EE04-p-6560.html?sensecap_affiliate=NK0JMuC&referring_service=link),
  [buy EE05](https://www.seeedstudio.com/XIAO-ePaper-Display-Board-EE05-p-6755.html?sensecap_affiliate=NK0JMuC&referring_service=link))

The [Seeed Studio buying guide](https://frameos.net/devices/seeed-buying-guide) covers the whole
lineup.

### Waveshare

Nearly a hundred Waveshare e-Paper panels have native drivers, on a Raspberry Pi or wired to an
ESP32-S3. Waveshare's ready-made frames work out of the box:

- [ESP32-S3 PhotoPainter](https://frameos.net/devices/waveshare-esp32-s3-photopainter) - 7.3" Spectra 6 color ([buy](https://www.waveshare.com/esp32-s3-photopainter.htm?aff_id=79380))
- [ESP32-S3 ePaper 13.3E6](https://frameos.net/devices/waveshare-esp32-s3-epaper-13in3e6) - 13.3" Spectra 6 color ([buy](https://www.waveshare.com/esp32-s3-epaper-13.3e6.htm?aff_id=79380))
- [RPi Zero PhotoPainter](https://frameos.net/devices/waveshare-rpi-zero-photopainter-7in3e) - 7.3" Spectra 6 color, on a Raspberry Pi Zero ([buy](https://www.waveshare.com/photopainter-b.htm?aff_id=79380))

And panels to build into a frame of your own:

- [13.3" (E)](https://frameos.net/devices/waveshare-epd-13in3e) - Spectra 6 color ([buy](https://www.waveshare.com/13.3inch-e-paper-hat-plus-e.htm?sku=29355&aff_id=79380))
- [7.3" (E)](https://frameos.net/devices/waveshare-epd-7in3e) - Spectra 6 color ([buy](https://www.waveshare.com/7.3inch-e-paper-hat-e.htm?sku=27875&aff_id=79380))
- [4" (E)](https://frameos.net/devices/waveshare-epd-4in0e) - Spectra 6 color ([buy](https://www.waveshare.com/4inch-e-paper-hat-plus-e.htm?sku=27367&aff_id=79380))
- [7.5"](https://frameos.net/devices/waveshare-7.5inch-800x480-epaper) - black/white ([buy](https://www.waveshare.com/7.5inch-e-Paper-HAT.htm?aff_id=79380))
- [10.3"](https://frameos.net/devices/waveshare-epd-10in3) - 16-level grayscale, Raspberry Pi only ([buy](https://www.waveshare.com/10.3inch-e-Paper-HAT.htm?aff_id=79380))

The [Waveshare buying guide](https://frameos.net/devices/waveshare-other-displays) lists what's
tested on real hardware and what to know before buying.

### Pimoroni

Pimoroni's boards plug straight onto a Raspberry Pi's header, no wiring:

- [Inky Impression 13.3"](https://frameos.net/devices/pimoroni-inky-impression-13-2025),
  [7.3"](https://frameos.net/devices/pimoroni-inky-impression-7-2025) and
  [4"](https://frameos.net/devices/pimoroni-inky-impression-4-2025) - Spectra 6 color, plus the
  older 7-color models
- [Inky pHAT](https://frameos.net/devices/pimoroni-inky-phat-black) and
  [Inky wHAT](https://frameos.net/devices/pimoroni-inky-what-black) - small black/white and
  three-color panels
- [HyperPixel 4.0](https://frameos.net/devices/pimoroni-hyperpixel-4-touch),
  [4.0 Square](https://frameos.net/devices/pimoroni-hyperpixel-4-square-touch) and
  [2.1 Round](https://frameos.net/devices/pimoroni-hyperpixel-2.1inch-round-480x480-lcd) - touch LCDs
- [Inky Frame](https://frameos.net/devices/pimoroni-inky-frame-7-3-spectra) - all-in-one
  Pico W frames, run as thin clients that the backend renders for

## FrameOS backend

The FrameOS backend is where you set up your frames. You can run it continuously on a server, or locally on your computer when needed. You'll just miss out on log aggregation if the backend is offline. The frames run independently.

Read more in [the documentation](https://frameos.net/guide/backend).

**Scripts and AI agents.** The backend serves a Model Context Protocol server
at `POST /api/mcp` and accepts personal API tokens (`fb_api_…`) wherever a
login is, so Claude Code or any MCP client can list frames, install and edit
scenes, read logs and screenshots, and push settings. Mint a token under
Settings → API tokens and MCP; `docs/mcp.md` has the details.

**Compiled scenes are deprecated.** FrameOS ships as released binaries and a
deploy never compiles anything. A scene still on the legacy _compiled_ path
(Nim code nodes or Nim app sources) does not run on that binary: convert it to
an interpreted scene at
[scenes.frameos.net/nim-converter](https://scenes.frameos.net/nim-converter)
(or in the editor, or with the CLI in `cloud/packages/scene-convert`; see
`docs/nim-to-js-conversion.md`). Until then such a scene still forces the
old whole-frame source build on every deploy — `docs/legacy-source-builds.md`
— which stays until it is deleted: not before December 2026, and possibly
much later or never (the gate is in `docs/convergence-todo.md`, item 1).

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

# SD card image generation works in the default container without Docker privileges.
# Deploys install released binaries and never compile, so the plain container above
# is all a normal install needs. The variant below additionally hands the backend the
# Docker socket for the deprecated per-frame source build (docs/legacy-source-builds.md).
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

### Database

The backend stores everything in SQLite (`./db/frameos.db` in the volume above) and needs nothing else. SQLite is the only supported database — `DATABASE_URL` exists because the backend uses SQLAlchemy, but no other engine is tested or shipped with a driver.

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
- `FRAMEOS_BUILDROOT_FRAMEOS_PARTITION_SIZE`: `/srv/frameos` ext4 partition size (default `1G`)
- `FRAMEOS_BUILDROOT_ASSETS_PARTITION_SIZE`: `/srv/assets` FAT32 partition size (default `512M`)

Buildroot-specific output cache keys include the resolved cache image, so changing image configuration invalidates stale output directories automatically.

Generated SD images use separate partitions for boot, root, FrameOS runtime data, and assets:

- `p1`: FAT32 boot partition
- `p2`: ext4 root filesystem
- `p3`: ext4 `/srv/frameos`
- `p4`: FAT32 `/srv/assets`

On first boot, Buildroot images expand themselves to fit the target SD card
before `/srv/frameos` and `/srv/assets` are mounted. The root partition stays at
the image size, `p3` grows to 2 GiB on cards 4 GiB and larger, and `p4` is
recreated to fill the remaining space. On cards smaller than 4 GiB, `p3` stays
at 1 GiB and `p4` still takes the rest.

Example:

```bash
export FRAMEOS_BUILDROOT_IMAGE_REPO=frameos/frameos-buildroot
export FRAMEOS_BUILDROOT_IMAGE_TAG=latest
export FRAMEOS_BUILDROOT_FORCE_LOCAL_BUILD=1
```

The corresponding GitHub workflow is `.github/workflows/frameos-buildroot.yml` and triggers on pushes to `main` when `backend/tools/buildroot.Dockerfile` changes. It writes `buildroot-images.json` with digest data used by runtime image resolution.
