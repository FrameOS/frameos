# FrameOS

**The operating system for smart frames.** Turn a Raspberry Pi or an ESP32-S3 and
any display, e-ink, LCD or HDMI, into a calendar, dashboard or art frame that runs
itself. Everything renders on the device, whether the screen updates once a minute
or sixty times a second.

Think smart home calendars, meeting room displays, photo frames, word clocks,
thermostats, industrial dashboards and public signage.

![A scene being built in the FrameOS editor, with a live preview](https://frameos.net/images/editor/live-preview.png)

## How it works

- **Scenes** are what a frame shows: a graph of nodes (data sources, images,
  text, layouts, logic) with optional TypeScript apps, built in a browser editor
  or by the built-in AI chat, and installed from the
  [scene store](https://scenes.frameos.net). Scenes are plain JSON and run in the
  frame's own interpreted runtime.
- **The runtime** is a single Nim binary (Raspberry Pi and other Linux boards) or
  a signed ESP32-S3 firmware. It renders scenes on the device, drives the display,
  handles schedules, buttons and touch, and keeps running when the control plane is
  offline.
- **A control plane** manages the frames: either the self-hosted
  [FrameOS backend](https://frameos.net/guide/backend) (a Docker image or Home
  Assistant add-on that deploys over SSH, with no account required) or
  [FrameOS Cloud](https://cloud.frameos.net), which manages frames directly over
  an outbound-only connection. Both flash the same release images and push the
  same scenes; the frames do not depend on either to keep rendering.

## Get started

1. Pick a [supported device](https://frameos.net/devices/) and follow its hardware
   page. A Raspberry Pi needs the display connected and the OS installed; an
   ESP32-S3 board is flashed from the browser.
2. Install the [FrameOS backend](https://frameos.net/guide/backend) (one command,
   see below), or sign in to [FrameOS Cloud](https://cloud.frameos.net).
3. Add the frame, install a scene from the store or build your own in the editor.
4. Print a [case](https://frameos.net/cases/) for it.

The full documentation is at [frameos.net/guide](https://frameos.net/guide/).
Questions and show-and-tell go to [Discord](https://discord.gg/9dT9y7EzUw).

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

The backend is the self-hosted control plane. Run it on a server, a NAS, or on
your computer when you need it: the frames keep rendering while it is offline,
you only miss log collection in the meantime. It stores everything in SQLite and
needs nothing else.

### Quick install

On a Mac or Debian/Ubuntu Linux:

```bash
bash <(curl -fsSL https://frameos.net/install.sh)
```

### Docker

```bash
# run the latest release
SECRET_KEY=$(openssl rand -base64 32)
mkdir -p db
docker run -d -p 8989:8989 \
    -v ./db:/app/db \
    --name frameos \
    --restart always \
    -e SECRET_KEY="$SECRET_KEY" \
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
```

Or with the checked-in `docker-compose.yml`: `docker compose up -d`. Deploys
install released binaries and SD card images are generated inside the container,
so the plain container is all a normal install needs.

### Home Assistant

Run the backend as the [Home Assistant add-on](https://github.com/FrameOS/frameos-home-assistant-addon)
or point a standalone one at Home Assistant under **Settings → Home Assistant**:
every frame becomes a device with its live image, status and scene sensors (the
scene's settings as attributes), a scene selector, a display switch and refresh
/ next / previous / restart / reboot buttons, and frame events reach the event
bus as `frameos_event`. Automations show a scene with parameters through one
MQTT command. `docs/home-assistant.md` has the entities, the MQTT topics
and the command format for automations.

### HTTPS for frames

Frames talk to the backend on port 8989 (logs, assets, scene state). To serve
that port over TLS without a reverse proxy, hand the container a certificate
and key with `FRAMEOS_SSL_CERTFILE` / `FRAMEOS_SSL_KEYFILE` (for example a
`/certs` mount). A configured certificate that cannot be read stops the
container with the reason in the log. New frames are then prefilled with an
`https://` server address; existing frames need their **Server scheme** set to
https in frame settings and a deploy. Frames verify the certificate against the
public CA bundle (Let's Encrypt works, a self-signed one does not), so the
frames must reach the backend by the name on the certificate. The Home
Assistant add-on has the same switch as its `ssl` / `certfile` / `keyfile`
options.

```bash
docker run -d -p 8989:8989 \
    -v ./db:/app/db \
    -v /etc/letsencrypt/live/frames.example.com:/certs:ro \
    -e FRAMEOS_SSL_CERTFILE=/certs/fullchain.pem \
    -e FRAMEOS_SSL_KEYFILE=/certs/privkey.pem \
    -e SECRET_KEY="$SECRET_KEY" \
    frameos/frameos
```

### Database

The backend stores everything in SQLite (`./db/frameos.db` in the volume above) and needs nothing else. SQLite is the only supported database — `DATABASE_URL` exists because the backend uses SQLAlchemy, but no other engine is tested or shipped with a driver.

### Scripts and AI agents

The backend serves a Model Context Protocol server at `POST /api/mcp` and accepts
personal API tokens (`fb_api_…`) wherever a login is, so Claude Code or any MCP
client can list frames, install and edit scenes, read logs and screenshots, and
push settings. Mint a token under **Settings → API tokens and MCP**;
[`docs/mcp.md`](docs/mcp.md) has the details. FrameOS Cloud has the same tools.

### Legacy compiled scenes

FrameOS ships as released binaries and a deploy never compiles anything. A scene
still on the old *compiled* path (Nim code nodes or Nim app sources) does not run
on that binary: convert it to an interpreted scene at
[scenes.frameos.net/nim-converter](https://scenes.frameos.net/nim-converter), in
the editor, or with the CLI in `cloud/packages/scene-convert`
([`docs/nim-to-js-conversion.md`](docs/nim-to-js-conversion.md)). Until it is
converted, such a scene forces the old whole-frame source build on every deploy,
which needs the privileged Docker setup described in
[`docs/legacy-source-builds.md`](docs/legacy-source-builds.md).

## This repository

- `backend/` and `frontend/`: the self-hosted backend (FastAPI, SQLite) and the
  web UI (React, kea).
- `cloud/` and `cloud-frontend/`: FrameOS Cloud and the scene store (Next.js,
  Postgres). You never need these to use FrameOS; see [`cloud/README.md`](cloud/README.md).
- `frameos/`: the Nim runtime that runs on the frames, with the drivers and the
  repo apps under `frameos/repo/apps`.
- `embedded/esp32/`: the ESP32-S3 firmware (ESP-IDF plus the Nim runtime
  compiled to C). `embedded/pico/`: the Pico W thin client for the Pimoroni Inky
  Frames, which the backend renders for.
- `docs/`: the contracts and design notes shared by all of the above.
- `e2e/`: the scene snapshot, Playwright and deploy test suites.

Everything is licensed AGPL-3.0; the device protocols are documented so that
anyone can reimplement them (see `NOTICE`).

## Developing locally

The repo ships a checked-in [Flox](https://flox.dev) environment. `flox activate`
installs the Python, pnpm and Nim toolchains and the repo-local dependencies, and
`pnpm dev` starts every service in `mprocs`:

```bash
flox activate
pnpm dev
```

[`CONTRIBUTING.md`](CONTRIBUTING.md) walks through the individual services, tests
and the on-device runtime; [`AGENTS.md`](AGENTS.md) is the map of the codebase.

## Build infrastructure

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
