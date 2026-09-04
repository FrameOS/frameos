# Buildroot frames: who runs as what, and what FrameOS Remote is doing there

Two questions, audited together on 2026-08-16 because they share an answer:

1. Someone who takes over your FrameOS Cloud account should not thereby get a
   shell on your LAN or the ability to install software. How close is that to
   true today, and what is left?
2. Does a Buildroot frame need FrameOS Remote at all? Self-hosted backends do.
   Cloud-managed frames?

**No code changed for the original audit.** What follows is the state of the
tree and what the choices cost. §1–§3 are the audit as written on 2026-08-16;
**§4 describes the implementation in PR #415** (the `frameos` user, the
privileged door, no Remote on generic images) and is the part to read for how
a Buildroot frame will work after that PR lands.

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

*(Since 2026-08-29 generic images ship without the remote entirely — see §4.
The reasoning below is what led there.)*

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

---

## 4. Implementation (PR #415)

The §3 split is implemented for the two NetworkManager platforms
(`raspberry-pi-64`, `raspberry-pi-5`). This section is the reference for how
it works; §1–§3 above are left as the audit that motivated it.

### The service

Generic Buildroot images — standalone and FrameOS Cloud frames, the ones that
only ever install signed releases — run `frameos.service` as the **`frameos`**
user (uid/gid 990, fixed, `/bin/false`). The unit is rendered from
`frameos/frameos.service` with `frameos/frameos.service.unprivileged` spliced in:
`NoNewPrivileges`, `ProtectSystem=strict` (+ `ReadWritePaths=/srv/frameos
/srv/assets`), `ProtectHome`, `PrivateTmp`, `ProtectKernelModules/Logs`,
`ProtectControlGroups`, `RestrictSUIDSGID`, `RestrictRealtime`,
`RestrictNamespaces`, `LockPersonality`, `SystemCallArchitectures=native`,
`RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`, and a bounding
set of exactly `CAP_SYS_TTY_CONFIG` (the framebuffer driver's `KDSETMODE`).
`SupplementaryGroups=video input` covers the nodes udev already groups;
an `ExecStartPre=+` step (root) hands `/dev/spidev*`, `/dev/gpiochip*`,
`/dev/i2c-*`, `/dev/vchiq`, `/dev/fb*`, `/dev/tty0-1` and the two sysfs
knobs the driver pokes (`fbcon/cursor_blink`, `fb0/blank`) to the service
group, and makes sure the door's directories exist with the right owners.
`60-frameos-devices.rules` does the same through udev for the future.

Two renderers produce that unit and must stay byte-identical, or an upgrade
would rewrite the read-only rootfs on every run:
`render_buildroot_frameos_service` (`backend/app/tasks/buildroot_image.py`)
at image-compose time, and `renderBuildrootFrameosService`
(`frameos/src/frameos/buildroot_privileges.nim`) in `frameos setup` on the
device. Both read the same two template files.

**Who stays root.** `buildrootServiceUser` (Nim) /
`buildroot_frameos_service_user_for_platform` (Python) decide:

- `raspberry-pi-32` (no NetworkManager): root. `network/supplicant.nim`
  drives wpa_supplicant, hostapd, udhcpc and dnsmasq itself, from the
  runtime — a root network daemon by nature. Moving that orchestration behind
  the door is the remaining §3 work.
- Backend-personalized images (`serverHost` set, or `agent.agentEnabled`):
  root. The self-hosted backend deploys unsigned custom builds over SSH /
  Remote as root and writes release directories as root; a `frameos`
  runtime could not open its own `frame.json` there. Its own trust model.
- `FRAMEOS_BUILDROOT_SERVICE_USER` overrides both, for recovery over a
  console.

### The door

`frameos/src/frameos/privileged.nim` is the whole contract. The runtime writes
one JSON file per request into `/srv/frameos/privileged/queue/` (`root:frameos
1770`); `frameos-privileged.path` (`PathExistsGlob=…/*.json`) starts
`frameos-privileged.service`, a root oneshot running
`/srv/frameos/current/frameos privileged-worker`
(`frameos/src/frameos/privileged_worker.nim`), which drains the queue, executes,
writes `results/<id>.json` and exits after 3 s of quiet. A request is an
**enum verb plus validated arguments** — never a command string, never a
path outside `/srv/frameos/staging`:

| Verb | Arguments | Does |
| --- | --- | --- |
| `reboot` | `delaySeconds` 0–300 | `systemctl reboot` after the delay |
| `apply-driver-setup` | `rebootIfRequired` | `setupFrameOSDrivers` in-process as root (fixed driver setup from root-owned libraries) |
| `install-release` | `archive` (under `/srv/frameos/staging`, no symlinks), `signature` (minisig text), `version` | requires a strictly newer three-part version, copies the archive to a root-owned dir, **re-verifies the minisign signature against the key in this binary**, requires its sole top-level directory to match that version and this device target, then unpacks, activates, runs setup, and restarts or reboots |
| `set-hostname` | `hostname` (sanitized again on the root side) | `/etc/hostname`, `/boot/frameos-hostname`, `hostname` |
| `sync-clock` | — | `systemctl restart systemd-timesyncd` / `ntpd -gq` / `sntp` |
| `nm-device-status`, `nm-wifi-list`, `nm-connections` (`active`) | — | fixed `nmcli` queries |
| `nm-radio-on` | — | `rfkill unblock wifi`, `nmcli radio wifi on` |
| `nm-hotspot-start` (`device`, `ssid`, `psk`), `nm-hotspot-stop` | SSID 1–32 bytes no control chars; PSK 8–63 printable or 64 hex | the add / modify / up sequence for `frameos-hotspot`, as argv, never through a shell |
| `nm-wifi-connect` (`ssid`, `psk`, `device`) | as above; `psk` may be empty (open network) | `nmcli device wifi connect …` for `frameos-wifi` |

Unknown keys are refused, oversized or unparsable request files are deleted
and answered with an error, and a request the worker never picks up is
withdrawn by the client after its timeout. `requestPrivileged` and
`privilegedDoorAvailable` are the only two calls the rest of the runtime
uses (`device_setup.nim` for reboots, `portal.nim` for everything network,
`upgrade.nim` for the install); when the process is root the door reports
itself absent and the old in-process paths run unchanged, so Raspberry Pi OS
installs and root Buildroot frames behave exactly as before.

The broader `apply-setup`, standalone connection-forget, and device-managed
verbs were removed because no runtime call site needed them. Wi-Fi PSKs are
redacted from the worker journal before an `nmcli` argv is logged.

**Why root may execute `/srv/frameos/current/frameos` at all.** The
`frameos` user cannot replace it: `/srv/frameos` and `releases/` are
`root:root 0755`, each release directory is `root:frameos 1775` (sticky —
the runtime may add `frame.json`, scene payloads and its session salt, but
cannot unlink root's `frameos` binary or `drivers/`), and `current` is a
root-owned symlink in a root-owned directory. Only `install-release` writes
there, and only after the signature check on a root-owned copy. The privileged
worker's `LD_LIBRARY_PATH` includes only the pre-created, root-owned `drivers/`
directory plus system libraries; runtime-writable `scenes/` is deliberately
absent. The layout is
stamped by the image composer (`render_frameos_partition_ownership_commands`,
via `debugfs sif` on the finished ext4), by `PARTITION_POST_BUILD_SCRIPT` for
base images, and by `buildrootOwnershipScript` in `frameos setup` /
`install-release` on the device.

Every verb runs as root, and the two that write under `/srv/frameos`
(`install-release`, `apply-driver-setup`) leave root-owned files in the
runtime's own directories — `state/upgrade-status.json` above all, which the
unprivileged runtime rewrites on the *next* upgrade. The worker therefore
re-applies the ownership layout after those two verbs; without it the failure
would surface one upgrade later, as an EACCES on a status file. Shared
writable directory roots remain `root:frameos 1770` (sticky), and result files
remain root-owned `0640`; all root-side writes there use randomized
same-directory temporary files and atomic rename, so the runtime cannot
pre-plant a symlink at a predictable temporary path.

**Root never follows the runtime's links.** Everything the runtime can write
is also somewhere it can plant a symlink or a hard link, and root touching
either is the whole game: a `scenes.json.gz` that is really a symlink to the
NetworkManager keyfile would, copied forward by an upgrade and handed back,
give the runtime the Wi-Fi PSK; a hard link to root's `frameos` binary under
a runtime-looking name would, chowned to the runtime by the ownership sweep,
give it the binary root executes (that needs `fs.protected_hardlinks=0`, but
the layout does not get to assume the sysctl). So the ownership layout has
two halves. `buildrootOwnershipScript` (busybox sh) hands things to **root**
only, sets modes, and removes — never adopts — a `drivers/`, `scenes/` or
`vendor/` entry the runtime planted in the sticky release root
(`pruneRuntimePlantedCodeRoots`: a symlink or file is unlinked, a
runtime-owned directory is renamed aside, never walked). Handing files to
the **runtime** is `chownRuntimeTrees` in Nim: the walk is
descriptor-relative (`fdopendir` / `openat`, so a sub-directory the runtime
swaps for a symlink mid-walk is never entered), each entry is opened
`O_NOFOLLOW`, `fstat`ed on that descriptor, and `fchown`ed only if it is a
regular file with exactly one link or a directory; symlinks are chowned with
`AT_SYMLINK_NOFOLLOW`, never followed. Buildroot's busybox `find` has no
`-links` and its `stat` no `-c`, which is why this is not shell. Every file root reads back from the runtime goes through
`readFileNoFollow` / `copyFileNoFollow` (`utils/system.nim`) with the same
rules and a size cap: the queue request itself, the staged archive before
its root-side signature check, and the frame.json, scene payloads and session
salt an upgrade carries into the new release. A `*.json` queue entry that is
not a regular file (a symlink, a directory) would keep `PathExistsGlob` true
and restart the worker every few seconds; the worker deletes it.

### OTA and migration

`frameos upgrade` as the `frameos` user: check GitHub, download the archive
and its `.minisig` into `/srv/frameos/staging/<ts>/`, verify locally (for a
clear early failure), then `install-release`. The root side refuses a downgrade
and binds the signed archive to the claimed version and detected target via its
required top-level directory name; a valid older signed archive cannot be
relabeled as a newer release. The worker owns
`upgrade-status.json` from that point — the runtime that asked is restarted
(and its detached upgrade child with it) once the release is in place. The
`systemd-run` transient unit the root path uses is replaced by a plain
`nohup` child; it needs no privilege because the install is not its job.

A frame **upgraded from a root-only release** migrates on that upgrade: the
old runtime installs the new release as root and runs its `frameos setup`,
which renders the hardened unit, creates the user and group by appending
the fixed lines to `/etc/passwd`, `/etc/group` and `/etc/shadow` (refusing,
not duplicating, a taken id), installs and enables the door units and the
udev rule, and applies the ownership layout. The next start of
`frameos.service` is unprivileged. Freshly composed images carry the user
already: `patch-root.sh` merges it into the cached base's account files
(`backend/app/tasks/buildroot_user_merge.py`, embedded so it runs inside the
composer container), and base images built from now on get it from a
Buildroot users table (`BR2_ROOTFS_USERS_TABLES`).

### FrameOS Remote

Generic release images **do not ship it**: no `/srv/frameos/remote`, no
`frameos-remote.service`, and an upgrade only carries the remote forward
where one is installed. Nothing on a cloud or standalone frame ever talked
to it. Where it still runs — Raspberry Pi OS installs and backend-personalized
Buildroot images — its verb surface lost the interactive PTY
(`terminal_open` / `terminal_input` / `terminal_close`; the backend's
Terminal panel is SSH-only now) and the one-shot `file_write`. What remains
(`version`, `http`, `shell`, streamed `file_write_open/chunk/close`,
`file_read/md5/delete/mkdir/rename`, `assets_list`) is what a backend deploy
is built from; `shell` in particular is the deploy transport, and retiring it
means teaching the backend structured deploy verbs — a separate piece of
work, tracked in `docs/todo.md`. Streamed upload chunks are capped at 4 MiB and
their actual binary payload is checked against the declared remaining size
before copying.

### What was verified off-hardware

The permission model is not a design note; it was run. `mke2fs -d` builds a
FRAMEOS-shaped ext4 the way the composer does, the generated `debugfs sif`
commands are applied to it, and `e2fsck` passes: release directory
`root:frameos 1775`, `frameos` binary and `drivers/`/`scenes/`/`vendor/`
`root:root` untouched (and `0755`/`0644` — set explicitly by the sweep, not
inherited: the door worker unpacks under `UMask=0027`, and 2026.9.5 installed
through it left `drivers/*.so` `0640`, unreadable to the runtime that dlopens
them), `frame.json` `frameos 0600`, `state` and the other
runtime-writable roots `root:frameos 1770`, NetworkManager keyfiles `root 0600`
behind a `root 0700` directory, `privileged/queue` `root:frameos 1770`, and
`privileged/results` `root:frameos 2750` with root-owned `0640` results. The
filesystem passed `e2fsck`. The same layout, built by
`buildrootOwnershipScript` itself, was then exercised in a container with a
real uid 990: as `frameos` the runtime can queue a request, write its state,
logs and staged OTA, and write `frame.json` and scene payloads into its
release directory — and cannot replace or unlink the `frameos` binary, write
or add a driver `.so`, create a release directory, swap the `current`
symlink, delete a request root queued (the sticky bit), or read the Wi-Fi
PSK out of `state/NetworkManager/system-connections`. That last one closes
§1's finding (c).

The user-merge shell `patch-root.sh` embeds — the path that stamps the user
into images composed from an older cached base — was run against a real ext4
root partition through `debugfs`: it appends the three account lines (shadow
back at 0600), is a no-op on the second run, and aborts the compose loudly
when uid or gid 990 belongs to someone else.

The two unit renderers (Nim and Python) are covered for all four
user/NetworkManager combinations plus the door's units and the udev rule; the
rendered root and unprivileged services and both door units also pass
`systemd-analyze verify` under systemd 252.

A second review pass (2026-09-03) attacked the door from the runtime's side
and found the two link problems described under "Root never follows the
runtime's links": an upgrade used `copyFile` to carry the runtime's scene
payloads, salt and frame.json into the new release — following a symlink
the runtime owns, then chowning the copy back to it, which turned the next
OTA into a root file-read oracle (the Wi-Fi keyfile, `/etc/shadow`) — and the
ownership sweep's `chown` would have adopted a runtime-planted hard link to
root's binary wherever `protected_hardlinks` is off. Both are closed by the
no-follow readers and the descriptor-pinned Nim sweep, and the same pass
narrowed the sweep to the two verbs that write, made the worker delete
planted non-file queue entries, and re-verified `install-release`'s downgrade
refusal (it compares against the *worker binary's* compiled version, not
frame.json) and the archive-root name binding. The rewritten root-half
script was executed as root under the real busybox `sh` with a uid 990 user
that had planted a `scenes -> /etc` symlink and a plain-file `vendor` in the
sticky release root: both were removed and replaced by root's directories,
`/etc` untouched, every mode as listed above. The Nim sweep's refusals are
unit-tested with a genuine hard link and symlink
(`test_runtime_chown_is_pinned_and_refuses_hard_links`).

### Not yet verified on hardware

Everything above is covered by unit tests (`frameos/src/frameos/tests/
test_privileged.nim`, `backend/app/tasks/tests/test_buildroot_privileges.py`)
and the compose pipeline, but no panel has run under the unprivileged unit
yet. `docs/manual-testing-todo.md` lists what to watch: SPI panels
(Waveshare, Inky) and the Pi 5 framebuffer under `DevicePolicy`-free but
group-gated nodes, the hotspot / portal flow through the door, an OTA from a
root-only release, and the `frameos-privileged` journal.
