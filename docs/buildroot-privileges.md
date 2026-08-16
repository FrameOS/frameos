# Buildroot frames: who runs as what, and what FrameOS Remote is doing there

Two questions, audited together on 2026-08-16 because they share an answer:

1. Someone who takes over your FrameOS Cloud account should not thereby get a
   shell on your LAN or the ability to install software. How close is that to
   true today, and what is left?
2. Does a Buildroot frame need FrameOS Remote at all? Self-hosted backends do.
   Cloud-managed frames?

**No code changed for this audit.** What follows is the state of the tree and
what the choices cost.

---

## 1. The privilege picture today

### What runs, as whom

| Process | User | Notes |
| --- | --- | --- |
| `frameos.service` | **root** | `render_buildroot_frameos_service` pins `user="root"`. Renders scenes, runs QuickJS apps, serves the local admin, talks to the cloud hub. |
| `frameos-remote.service` | **root** | `User=%I` in the unit; the installer instantiates it as root. Shell, PTY, arbitrary file read/write (see §2). |
| First-boot setup | **root** | Writes `/etc/systemd/system`, `/etc/fstab`, boot config, NetworkManager profiles. |

There is no FrameOS user, no group, no capability set. Every scene, every JS
app and every driver `.so` runs with `uid 0`.

### What is already load-bearing

Three things carry most of the weight today, and they are good:

- **`/` is read-only.** Buildroot frames boot with neither `ro` nor `rw` on the
  kernel command line and no `/` entry in fstab, so the kernel default wins.
  Every write to the root filesystem goes through an explicit remount
  (`withWritableMount` in `frameos/device_setup.nim`). "Install software"
  therefore means "remount, write, remount back" — not impossible for root, but
  not incidental either, and it does not survive as a silent side effect.
- **The cloud cannot express the dangerous settings.** `allowedFrameSettings`
  (`cloud/apps/auth-web/src/lib/frames.ts`) is eight keys plus five ESP32 power
  keys. `serverHost`, `serverApiKey`, the whole `agent` block, network config
  and credentials are absent, and the device enforces the same list again in
  `CLOUD_SETTINGS_ALLOWLIST` (`frameos/cloud/hub_client.nim`) and refuses the
  *whole* verb on an unknown key. `allowedFrameCommandTypes` has no shell verb
  and never has.
- **LAN access is default-deny with a presence ceremony.** A cloud-managed
  frame's HTTP client refuses private-network destinations unless
  `network.allowLocalNetworkAccess` is set, and that switch is deliberately not
  in the bulk config save: it needs a challenge, a six-digit code *read off the
  panel*, and a reply within three minutes (`frameos/local_access.nim`). The
  deny follows the *scene origin*, not the link, so demoting a frame does not
  lift it. Someone who cannot see the screen cannot turn it on.

So the headline of question 1 is largely already true. A stolen cloud account
gets: push scenes, push eight settings, reboot, restart, render, set schedule,
suggest an update. It does **not** get a shell, cannot reach 192.168.x.x from
the frame, and cannot install anything — OTA images are minisign-verified
against a pinned key on the device (`frameos/upgrade.nim`), so
`notify_update_available` can only ever suggest a genuine FrameOS release.

### What is actually left

**(a) Everything is root, so any escape is a full escape.** The blast radius of
a QuickJS sandbox escape, a pixie decoder bug or a malicious driver `.so` is the
whole device: rewrite `/boot`, add a systemd unit, read the Wi-Fi PSK out of
`/etc/NetworkManager/system-connections`. Nothing about the cloud protocol gets
you there, but nothing about the process model contains you either.

**(b) FrameOS Remote is enabled by default on images that have nothing to talk
to.** Details in §2 — this is the sharpest edge found.

**(c) The Wi-Fi PSK is readable by whatever gets code execution.** A consequence
of (a) rather than its own finding.

---

## 2. FrameOS Remote on Buildroot

### What it is

`frameos/remote/src/frameos_remote.nim`, 786 lines, one outbound WebSocket to
`ws(s)://{serverHost}:{serverPort}/ws/remote`, HMAC-SHA256 envelopes keyed by
`agent.agentSharedSecret`. Its command surface:

`version`, `http` (proxy to the frame's own HTTP port), **`shell`**,
**`terminal_open` / `terminal_input` / `terminal_close`** (a real PTY),
`file_read` / `file_write` / `file_write_open|chunk|close` / `file_delete` /
`file_mkdir` / `file_rename` / `file_md5`, `assets_list`.

It is the transport that makes a self-hosted backend work when SSH does not:
Buildroot's dropbear-less images, frames on a network the backend cannot reach
inbound, NAT. `deployWithAgent` uses it to ship a build. For a **backend-managed
Buildroot frame it is not optional in practice** — it is how deploys happen.

### What it is doing on a cloud frame

Published release images ship `frame.json` with (`tools/buildroot-images/buildroot_images.py`):

```json
"agent": { "agentEnabled": true, "agentRunCommands": true,
           "deployWithAgent": true, "agentSharedSecret": "" },
"serverHost": ""
```

`serverHost` is empty on purpose — a non-empty one blocks cloud enrollment. But
`agentEnabled` is `true`, so first-boot setup installs and enables
`frameos-remote.service` (`setupSystemdServices` in `frameos/setup.nim`), and
the unit then runs forever as root building the URL `ws://:8989/ws/remote`,
failing, and backing off. Forever.

Three observations, in order of how much they matter:

1. **It is not remotely reachable.** It dials out; it never listens. Nobody on
   the LAN or the internet can connect *to* it. This is the reason the finding
   is a hardening item and not an incident.
2. **The secret is the empty string, and that is what holds the door shut.**
   Authentication is `HMAC(agentSharedSecret, serverApiKey || data)`, and both
   halves are empty in a shipped image — which reads like "a root PTY with no
   secret to guess", and this document said so in its first version. It is
   wrong. `doHandshake` refuses before it sends anything when the secret is
   empty (*"agent.agentSharedSecret is empty, FrameOS Remote cannot connect"*,
   `frameos/remote/src/frameos_remote.nim`), so the agent never finishes a
   handshake, never reaches its receive loop, and never runs a command; every
   inbound command is then HMAC-verified against the same secret
   (`verifyEnvelope`) before it is dispatched. An empty secret is fail-closed.

   Which inverts the obvious remedy: minting a secret at first boot would turn
   an agent that connects to nobody into one that connects to whatever
   `serverHost` names — commands still unforgeable, but a dial-out where there
   was none. `ensure_buildroot_frame_defaults` mints a real 32-byte secret for
   frames created through a *backend*, which is the case where a secret is
   wanted, and that is the right place for it to stay.
3. **It is pure cost on a cloud frame.** A resident root process, a
   reconnect loop in the journal, ~2 MB of rootfs, and a `.so`-free but still
   non-trivial attack surface, in service of a control plane that by design does
   not exist for this frame.

### So: does Buildroot need it?

**Backend-managed Buildroot: yes.** Removing it means requiring SSH on images
that do not ship an SSH server, on networks the backend often cannot reach.
Not a trade worth making.

**Cloud-managed Buildroot: no.** The cloud has no shell verbs, has never had
any, and `docs/todo.md` records that as doctrine rather than a gap. Nothing in
the cloud path calls the remote.

The honest shape is therefore *not* "drop the remote" but "**stop enabling it
by default on images that have no backend**":

- Ship the release image with `agentEnabled: false`. A frame that later enrolls
  with a self-hosted backend gets the flag from that backend's deploy, which is
  exactly the moment it becomes useful.
- Leave `agentSharedSecret` empty on the generic image. It is the fail-closed
  state (observation 2); the backend mints one when it adopts the frame, which
  is when a secret has someone to share it with.
- Keep the binary in the image (the backend-adoption path needs it present, and
  the OTA archive carries it anyway).

Cost: a Buildroot frame flashed from a generic image and *then* adopted by a
backend needs one `systemctl enable` — which the backend's first deploy already
does, via `frameos setup`. So the cost looks like zero, and that is worth
verifying on hardware before believing it.

---

## 3. Making the user model less all-or-nothing

The prize is that a scene-runtime escape stops being root. The obstacle is that
FrameOS genuinely needs privilege — for narrow, enumerable things:

| Needs root | Where | Frequency |
| --- | --- | --- |
| Remount `/` rw, write `/etc/systemd/system`, `/boot/config.txt`, fstab | `device_setup.nim`, `setup.nim` | setup, OTA |
| Install/enable units, `daemon-reload` | `setup.nim` | setup, OTA |
| `reboot` | `device_setup.nim` | rare |
| NetworkManager / wpa_supplicant profiles, hotspot | `network/` | setup, portal |
| SPI/I²C/GPIO, framebuffer, `/dev/fb0`, evdev | drivers | every render |
| Bind :80/:443 | only with `https_proxy.enable` (off on Buildroot) | boot |

Everything else — rendering, QuickJS, HTTP, the cloud client, assets, logs — is
ordinary userspace work on `/srv`.

The split that fits:

1. **`frameos.service` drops to a `frameos` user.** Give it
   `AmbientCapabilities=CAP_NET_BIND_SERVICE`, group membership for `spi`,
   `i2c`, `gpio`, `video`, `input`, and ownership of `/srv/frameos`, `/srv/assets`
   and the state dir. Add the usual systemd hardening now that it is affordable:
   `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectKernelModules`,
   `PrivateDevices=no` (the panels need the device nodes) with an explicit
   `DeviceAllow` list.
2. **Privileged work moves behind one narrow door.** Not sudo with a wildcard —
   that is root with extra steps. Either:
   - a `frameos-setup.service` (`Type=oneshot`, root) triggered by a
     `.path` unit watching a request file the runtime writes, with the request
     being an *enum*, never a command string; or
   - a tiny setuid/`CAP_`-holding helper with the same enum interface.

   Verbs: `apply-setup`, `apply-network-profile`, `reboot`, `install-ota
   <staged-dir>`. The runtime composes none of them from user input.
3. **OTA stays smooth because it was already a two-phase thing.** Today
   `upgrade.nim` downloads, verifies the minisig, stages under
   `/srv/frameos/releases/<version>` and *then* does the privileged install.
   Only the last phase needs the door — the download and verification are
   already unprivileged work, and they are the slow, failure-prone part. The
   staged directory is written by the `frameos` user; the helper's job is
   `install`, `systemctl daemon-reload`, restart. Signature verification stays
   where it is, on the unprivileged side, because moving it into the helper
   would mean the helper trusting a path the runtime chose.
4. **Drivers are the awkward part** and should be measured before promising
   anything: HyperPixel/Inky reach GPIO and SPI directly, and 13.3E uses manual
   dual-CS. `gpio`/`spi` group membership plus udev rules covers the common
   case on a Pi; anything that pokes `/dev/mem` does not, and those drivers
   would have to stay behind the privileged door or lose support.

Sequencing that keeps each step verifiable: stop enabling Remote by default
(§2, days) → enumerate the privileged call sites
behind a single `privilegedCommand`-shaped chokepoint, which mostly exists
already → introduce the helper with `reboot` and `apply-setup` only → flip
`frameos.service` to the `frameos` user on one platform (`raspberry-pi-64`,
framebuffer device) and run the OTA path end to end → widen to the SPI panels
once the group/udev story is proven on hardware.

None of it is blocked on a decision; all of it is blocked on hardware time.
