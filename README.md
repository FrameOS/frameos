# FrameOS

FrameOS is an **operating system for single function smart frames**. 

It's meant to be deployed on a Raspberry Pi, and can be used with a variety of e-ink and traditional displays. It's designed for both screens that update **60 seconds per frame**, and for screens that update **60 frames per second**.

Think smart home calendars, meeting room displays, thermostats, industrial dashboards, public advertisement screens, and more.

To get started:

1. Install the [FrameOS controller](https://frameos.net/installation/controller), a dockerized python app, which is used to deploy apps onto individual frames via SSH.

2. Read the [device hardware guide](https://frameos.net/devices/) for your screen type. Typically you'll just need to connect the display to a Raspberry Pi, install the OS, and make sure it's reachable over the network. 

3. Once connected, deploy our prebuilt [apps](https://frameos.net/apps/), or code your own directly inside the controller.

4. Finally, for a professional look, 3d print a case around your frame.

![](https://frameos.net/assets/images/walkthrough-c32e7b67dd9a6f14ebef743755b0fc8e.gif)



## Supported platforms

We support all the most common e-ink displays out there.

- Pimoroni e-ink frames
- Waveshare e-ink
- Framebuffer HDMI output
- Web server kiosk mode

[See the full list here!](https://frameos.net/devices/)

![](https://frameos.net/assets/images/1-frames-d127cdd40eaec7b65932a78a7a2034ae.jpg)

## FrameOS controller

The FrameOS controller is where you set up your frames. You can run it continuously on a server, or locally on your computer when needed. You'll just miss out on log aggregation if the controller is offline. The frames run independently.

Read more in [the documentation](https://frameos.net/installation/controller).

### Docker quickstart

```bash
# running the latest release
SECRET_KEY=$(openssl rand -base64 32)
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
```
