# The boot partition: what lives there and why

The first partition of a FrameOS SD image (label `BOOT`, FAT32, mounted at
`/boot`) is the only part of the image every computer can read and write —
macOS, Windows, Linux, a browser flash tool. FrameOS therefore uses it for
three jobs:

1. **Raspberry Pi firmware configuration** (`config.txt`, `cmdline.txt`).
2. **One-time provisioning**: personalization the frame consumes on first
   boot and then destroys.
3. **Diagnostics you can read by pulling the card**: two log files that
   answer "what happened at boot" without a serial cable or SSH.

The partition is mounted root-only (`umask=077`) because until first boot it
carries secrets (Wi-Fi credentials, the root password, cloud claim tokens).

## File reference

### Firmware configuration (persistent)

| File | What it is |
| --- | --- |
| `config.txt` | Raspberry Pi firmware config. FrameOS display driver setup appends what the panel needs (e.g. `dtoverlay=spi0-0cs` for manual dual-CS e-ink panels) and enables the memory cgroup marker line's counterpart below. Edits are made in place and require a reboot. |
| `cmdline.txt` | Kernel command line (single line!). FrameOS setup adds `cgroup_enable=memory` so the memory clamps in `frameos.service` work. |

### Provisioning (consumed on first boot, then destroyed)

The first-boot service (`frameos-firstboot-setup.service` running
`frameos-setup-reset.sh`) processes these. Secret-bearing files are
**shredded, never renamed**: overwritten with zeros first, then removed, so
no `setup-done-*.json` copies of credentials linger on the card.

| File | What it is |
| --- | --- |
| `frameos-setup.bin` | The setup blob. Release images ship it as a fixed-size placeholder at a contiguous offset so personalization tools (backend, cloud, in-browser flasher) can patch credentials into a downloaded image **in place** without rebuilding it. On first boot it is unpacked into the individual files below, then shredded. |
| `frameos-setup.json` | The full frame configuration (`frame.json` payload plus scenes). Applied by the setup run, then shredded. If setup fails it is left in place so the next boot retries. |
| `frameos-cloud.txt` | Cloud personalization (claim token, provider URL). Release images carry a comment-only placeholder; if it contains no real keys it is left alone, otherwise it is consumed and shredded. |
| `frameos-hostname` | Installed to `/etc/hostname`, then removed. |
| `frameos-wifi.nmconnection` | Wi-Fi credentials as a NetworkManager keyfile. Installed into the NetworkManager state directory; on platforms without NetworkManager (armv6 / Pi Zero W) the credentials are additionally mirrored into `/srv/frameos/state/wpa_supplicant/wpa_supplicant-wlan0.conf`, because nothing on those images reads a keyfile. Shredded after install. |
| `frameos-authorized_keys` | SSH keys for root. Installed, then shredded. |
| `frameos-root-password` | Root password for `chpasswd`. Installed, then shredded. |

### Diagnostics (written by the frame, safe to share)

| File | What it is |
| --- | --- |
| `frameos-setup-reset.log` | Everything the first-boot setup printed, **appended** across runs (a retry after a failure adds a second block). This is the log to read when provisioning itself misbehaves. |
| `frameos-postboot-2min.log` | A **bounded snapshot, not a full log** — the name says so on purpose. Written by `frameos-postboot-log.service` twice per boot: a small marker as soon as multi-user boot is underway, then the full snapshot once uptime reaches two minutes. Contents: service states (`frameos`, `frameos-remote`, `wpa_supplicant`, `NetworkManager`), a network snapshot (`ip addr`/`ip route`/`iw`, `wpa_cli status`, running network daemons, the wpa_supplicant config **with secrets redacted**), size-capped journal tails for the FrameOS units and the whole boot, and the tail of the newest frameos file log. It answers "did frameos start, what did it log, and what does the network look like" from any laptop with an SD reader. |

## Space and SD-card wear

`frameos-postboot-2min.log` is assembled in tmpfs and copied to the FAT
partition in a single write per snapshot (two writes per boot, ~256 KB
ceiling, overwritten in place every boot). It cannot grow unbounded and adds
no steady-state write load. `frameos-setup-reset.log` only grows when the
first-boot service actually runs, which is once per provisioning.

## Where the full logs are

The boot partition never carries complete logs. Persistent frameos logs live
on the ext4 data partition at `/srv/frameos/logs/frameos-<date>.log`
(buildroot images set `logToFile` by default because their journald storage
is volatile). The journal itself is in RAM and lost on power-off — which is
exactly why the post-boot snapshot copies its tail to `/boot`.

## Debugging workflow

1. Frame misbehaves → power off, pull the SD card, put it in any computer.
2. Read `frameos-postboot-2min.log` first: it tells you whether frameos
   started, what it logged, and the state of Wi-Fi/hotspot at two minutes.
3. Read `frameos-setup-reset.log` if the problem looks like provisioning
   (wrong hostname, Wi-Fi never configured, setup errors).
4. If you need history beyond the snapshot, mount the ext4 partition
   (Linux) and read `/srv/frameos/logs/`.
