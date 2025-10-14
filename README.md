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
mkdir db
docker run -d -p 8989:8989 -v ./db:/app/db --name frameos --restart always -e SECRET_KEY="$SECRET_KEY" frameos/frameos

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
docker run -d -p 8989:8989 -v ./db:/app/db --name frameos --restart always -e SECRET_KEY="$SECRET_KEY" frameos
```

## Building FrameOS driver libraries

FrameOS now loads hardware drivers at runtime from shared libraries. You can build the
current set of driver plugins directly from the `frameos/` workspace:

```bash
cd frameos
make drivers
```

The command above invokes `tools/build_drivers.py`, which discovers every `entry.nim`
module under `src/drivers/` and compiles it as a shared object in `build/drivers/`.

Use the helper to inspect the list of driver targets without compiling:

```bash
cd frameos
make drivers-list
```

For cross compilation you can pass the desired Nim flags through the script. For
example, to build ARM64 Linux libraries suitable for Raspberry Pi deployments:

```bash
cd frameos
python3 tools/build_drivers.py --os linux --cpu arm64
```

Use `--flag` to forward any additional options directly to `nim` if you need to
customize the build (for example `--flag=-d:release`). The script automatically
chooses the correct shared-library extension for the requested operating system and
places the results in `frameos/build/drivers/` ready for packaging alongside your
FrameOS binary.
