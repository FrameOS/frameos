# Automatic updates

Every frame installs FrameOS updates by itself, unless its owner turned that
off. Not every frame takes a release the moment it is published: a release
rolls out in stages, a frame may have to pass through a stepping stone, and a
release can be blocked or paused for everyone, or for one kind of board. What
a frame may install is decided by ONE rule from ONE manifest, and the rule is
asked by whoever manages the frame: its control plane, or the frame itself
when it has none.

- The manifest: [`docs/update-manifest.json`](update-manifest.json).
- The rule: `backend/app/utils/update_decision.py`, its ports
  `cloud/apps/auth-web/src/lib/update-decision.ts` and
  `frameos/src/frameos/update_decision.nim`, pinned by
  [`docs/update-decision-fixtures.json`](update-decision-fixtures.json)
  (runners: `backend/app/utils/tests/test_update_decision.py`,
  `cloud/apps/auth-web/src/lib/update-decision.test.ts`,
  `frameos/src/frameos/tests/test_update_decision.nim`). Change the three and
  the corpus together. An ESP32 never runs the rule: it asks.

## The manifest

```json
{
  "version": 1,
  "paused": null,
  "defaultRollout": [
    { "afterHours": 0, "percent": 10 },
    { "afterHours": 24, "percent": 25 },
    { "afterHours": 48, "percent": 50 },
    { "afterHours": 96, "percent": 100 }
  ],
  "releases": [
    { "version": "2026.11.13", "at": "2026-11-20T08:49:48Z" },
    { "version": "2026.11.14", "at": "2026-11-21T09:00:00Z",
      "blockedTargets": { "esp32/esp32-c3-*": "boot loop on the C3, fixed in .15" } },
    { "version": "2026.12.1", "at": "2026-12-01T09:00:00Z", "steppingStone": true }
  ]
}
```

| Field | Meaning |
|---|---|
| `paused` | A reason, or null. While set, no frame installs anything, not even when its owner asks. The kill switch. |
| `defaultRollout` | The stages of a release that names none: `afterHours` after its `at`, `percent` of frames may have it. The largest percent whose time has come counts. |
| `releases[].version` | `YYYY.M.N`, the release tag without its `v`. Listed once each, oldest first (the backend suite checks). |
| `at` | When its rollout starts. A release whose `at` is in the future, or missing, is not out yet (`scheduled`). |
| `rollout` | Its own stages. `[{"afterHours": 0, "percent": 100}]` is everyone at once; `[]` is everyone too. |
| `pausedAt` | The rollout stays at the percent it had reached then. Frames that have it keep it; nobody else gets it. |
| `blocked` | A reason: offered to no frame. Frames below it skip it and take the newest release under it they may have. |
| `blockedTargets` | `{"<pattern>": reason}`: blocked for the frames whose target matches. |
| `targets` | Allow-list of patterns: the release does not exist for any other target (not even as "latest"). |
| `minFrom` | The oldest version that may install it directly. A frame below it installs the newest release it can reach first. |
| `steppingStone` | `true`: every newer release has this one as its `minFrom` (at least). The way to make a migration run on every frame. |
| `channels` | Default `["stable", "early"]`. `["early"]` is a release only early frames see. |

A pattern is `<platform>/<target>`, exact or ending in `*`: `esp32/esp32-c3-*`,
`linux/*`, `linux/debian-buster-armv6`, `pico/*`. Platforms are `linux` (a Pi or
any Linux frame; the target is the release slug `detectUpgradeTarget` names,
e.g. `debian-bookworm-arm64`), `esp32` (the target is the OTA layout
`fos_ota_platform()` names, e.g. `esp32-s3-generic`, `esp32-s3-16mb`) and
`pico`.

### Where it lives, and who serves it

The manifest is a file in this repository, changed by pull request like code,
and read from `main`:

    https://raw.githubusercontent.com/FrameOS/frameos/main/docs/update-manifest.json

**Primary: GitHub.** Every frame already trusts GitHub for the release itself
(the archive, the image, the signature), a self-hosted backend already talks
to `api.github.com` and nothing else of ours, and a standalone Pi already asks
GitHub for the latest release. Reading the manifest from the same host adds no
new party to anyone's network and keeps a self-hosted install independent of
FrameOS Cloud. A merge to `main` is how a release is blocked (raw.github's
cache is about five minutes).

**Fallback: the cloud's mirror**, `GET https://cloud.frameos.net/api/updates/manifest`,
which serves the last copy it read from GitHub. A backend and a standalone Pi
ask it when GitHub does not answer. With neither, nothing is installed
automatically this round (fail closed: no manifest, no automatic update). An
owner's manual update still works the way it always has.

**The decision service: `GET https://cloud.frameos.net/api/updates/next`** runs
the rule for anyone who asks (`platform`, `target`, `version`, `key`,
`channel`, `manual`) and answers the decision below. A standalone ESP32 asks
its OTA-shaped sibling, `GET /api/updates/firmware` (see the ESP32 flow).

`FRAMEOS_UPDATE_MANIFEST_URL` points a backend, the cloud or a Pi runtime at
another manifest (a test server, a fork).

**The release workflow appends each release** (`tools/update_manifest.py add`,
run by the "Create GitHub Release" job of `.github/workflows/docker-publish-multi.yml`
right after the release and its assets exist), with no `rollout` of its own,
so it follows `defaultRollout` from the moment it was published. A release
is therefore never offered before its files are on GitHub.

## The decision

Input: the manifest and `{current, platform, target, frameKey, channel,
manual, now, maxVersion}`.

1. The releases this frame can see: a parseable version, under `maxVersion`
   (a ceiling: a backend can install only its own FrameOS on a Pi), its
   channel in `channels`, its target in `targets`. The newest is `latest`.
2. `current` does not parse (`dev`, `unknown`, empty): **unknown_version**,
   nothing. A dev build is never updated automatically.
3. `latest` is no newer than `current`: **up_to_date**.
4. `paused`: **paused**, nothing.
5. Each newer release, newest first, is **held** if it is
   - `blocked`, or blocked for this target: `blocked`;
   - not out yet (`at` in the future or missing): `scheduled`;
   - not `manual`, not the `early` channel, and this frame's cohort bucket is
     not under its rollout: `rollout`;
   - `current` is below its `minFrom` (or the newest stepping stone under it): `needs`.
6. The first release that is not held is the answer: **latest** when it is the
   latest; **stepping_stone** when the latest needs a release first;
   **held_back** when the latest is held for any other reason. None:
   **held**, nothing. `held` says why the latest is not the answer
   (`{version, why, detail}`).

The answer:

```json
{ "version": "2026.12.2", "reason": "held_back", "latest": "2026.12.3",
  "held": { "version": "2026.12.3", "why": "rollout", "detail": "rolling out to 10% of frames; this one is in a later stage" } }
```

`manual` is an owner pressing Update: it skips the rollout and nothing else.
A blocked release stays blocked, a stepping stone is still installed first,
and `paused` holds manual updates too.

### Cohorts

A frame's place in a release's rollout is
`int(sha256("<frameKey>/<version>")[0:8], 16) % 10000`, and it is in when that
is under `floor(percent * 100 + 0.5)`. Deterministic, so a frame asked twice
gets the same answer; salted by the version, so the first tenth of one release
is not the first tenth of the next (no frame is everyone's guinea pig). A frame
without a key waits for 100%. The keys:

| Frame | `frameKey` |
|---|---|
| Cloud frame | `cloud:<frame uuid>` |
| Backend frame | `backend:<sha256(SECRET_KEY)[:12]>:<frame id>`, so frame 1 of every backend is not one cohort |
| Standalone Pi | `device:<the device's Ed25519 public key>` (`cloud/identity.nim`), else `host:<hostname>` |
| Standalone ESP32 | `esp32:<sha256 of the station MAC, 16 hex>` (the MAC itself never leaves the board) |

`channel` is `stable` for every frame today; `early` (skips the rollout, sees
early-only releases) is there for a future setting and for testing.

## Blocking a release, setting a stepping stone

- **Something is wrong with 2026.12.3:** add `"blocked": "why"` to its entry
  and merge. Frames that have not installed it stop being offered it within
  minutes; frames below it take the newest release under it. A frame that
  already has it keeps it (the rule never offers a downgrade, and every device
  refuses one). Ship the fix as the next release.
- **Only on one board:** `"blockedTargets": {"esp32/esp32-c3-*": "why"}`.
- **Stop and think:** `"pausedAt": "<now>"` freezes that release's rollout at
  the percent it reached; top-level `"paused": "why"` stops every update.
- **A migration every frame must run:** `"steppingStone": true` on the release
  that carries it. A frame two releases behind installs it first, boots it
  (the migration runs), and takes the next one on its next check.
- **A release that cannot be reached from old versions directly:**
  `"minFrom": "2026.12.1"` on it.
- **Go faster or slower:** a `rollout` of its own on the release.

## Default on; the owner can turn it off

| Where | Setting | Default |
|---|---|---|
| Backend | frame column `auto_update` (Settings, "Install updates automatically") | on |
| Cloud | the frame's settings mirror `auto_update` (same switch, `set_settings` key in `docs/cloud-frames-contract.json`) | on |
| Pi | frame.json `autoUpdate` | on |
| ESP32 | NVS `auto_update` (`set auto_update 0` on the USB console; `set_settings`) | on |

A plane decides for the frames it manages from its own copy; the device's copy
is what a frame with no plane goes by, and what it keeps if it leaves one. On
the cloud the switch is stored even for firmware too old to take the key (the
plane honours it all the same); it is pushed to the device from 2026.11.14.

Turning it off stops automatic updates only. The owner's Update button (and the
console's `ota`, and `frameos upgrade`) still installs the newest release the
rule allows a manual update.

### When

- A plane nudges its frames from a sweep every hour, between **02:00 and 05:00
  in the frame's time zone** (UTC when it has none), at most once per frame per
  20 hours, never while a deploy, update, restart or reboot is in flight
  (`deploy_progress`). A frame that is asleep or offline then gets the nudge
  from the queue when it next connects.
- A standalone Pi looks every ten minutes, reads the manifest at most every
  six hours, and installs only in the same window and not within 15 minutes of
  someone touching it (pointer, key or button).
- An awake backend-managed ESP32 also checks on its own every 24 hours (the
  firmware's periodic task, older than this); that check is answered by the
  same rule, at whatever hour it comes.

## Per frame type

### Pi (or any Linux frame) under a backend

1. **Trigger:** the worker's hourly `auto_update_frames` cron
   (`backend/app/tasks/auto_update.py`).
2. **Asks:** itself: the manifest (GitHub, then the cloud mirror), the rule
   with `current` = the version the frame last deployed or reported,
   `maxVersion` = the backend's own FrameOS version (the backend deploys its
   own runtime and must not leave a frame running a newer one). The backend
   keeps no release slug for a Pi, so the target is empty: a `linux/*` block
   stops a backend Pi, a block on one slug (`linux/debian-buster-armv6`) does
   not (the frame's own upgrade still refuses a release with no archive for
   its target).
3. **Installs:** a runtime from 2026.11.14 on is asked through its admin API to
   upgrade itself to exactly that version (`POST /api/upgrade
   {"version": "…"}`: the signed release, carrying frame.json over, nothing
   else deployed). An older runtime the backend can reach over SSH gets the
   ordinary deploy. An older shell-less runtime is asked to upgrade (to
   GitHub's latest) only when that is what the rule answered.
4. **Reports:** the deploy-progress record, kind `upgrade` (or `deploy`), moved
   by the frame's `cloud:upgrade` lines, its bootup and first render — the bar
   the workspace already draws.
5. **Failure:** the runtime's upgrade verifies the signature before it touches
   anything and switches `current` only once the release is staged; a failed
   upgrade writes `failed` into its status file and the record goes `error`.
   The sweep tries again after 20 hours.

### Pi under the cloud

1. **Trigger:** the frame hub's hourly sweep (`cloud/apps/frame-hub/src/auto-update.ts`).
2. **Asks:** itself: the rule (TS port) with `current` = the frame's reported
   version, `frameKey` = `cloud:<uuid>`, `target` = the release slug the hello
   reports (`hardware.upgradeTarget`, from 2026.11.14; empty before, when only
   `linux/*` patterns match). A frame a self-hosted backend owns is that
   backend's to update, never the sweep's.
3. **Installs:** it enqueues `notify_update_available` with `{"version": "…",
   "auto": true}`. A runtime from 2026.11.14 on upgrades to exactly that
   version (`scheduleFrameOSUpgrade(version)`: the release by tag from GitHub,
   minisign-verified against the key in the binary, never a downgrade). An
   older runtime ignores the payload and upgrades to GitHub's latest, so the
   sweep nudges one only when the rule's answer IS the latest.
4. **Reports:** `enqueueFrameCommand` starts the deploy-progress record (kind
   `upgrade`); `cloud:upgrade` lines and the hello move it.
5. **Failure:** as under a backend; the nudge is retried after 20 hours.

### Standalone Pi (no plane)

1. **Trigger:** the runtime's auto-updater thread (`frameos/src/frameos/auto_updater.nim`):
   ten minutes after boot, then every ten minutes, reading the manifest at
   most every six hours (an hour after a failed read): a fixed six-hour clock
   could step over the 02:00-05:00 window every night. It acts only when the
   frame has no backend (`serverHost` and `serverApiKey` both empty), is not
   cloud-managed (the link state's mode), and frame.json `autoUpdate` is not
   false, each read afresh on every pass.
2. **Asks:** the manifest from GitHub (then the cloud mirror), and the Nim port
   of the rule with `target` = `detectUpgradeTarget()`.
3. **Installs:** inside the window and with nobody at the frame:
   `scheduleFrameOSUpgrade(version)`, the same detached `frameos upgrade
   --version …` the admin page runs.
4. **Reports:** `autoupdate:check` log lines (status `none` / `installing` /
   `error`, the reason, latest, version and held), then the
   upgrade's own `cloud:upgrade` lines and `upgrade-status.json`, which the
   frame's admin page shows.
5. **Failure:** the upgrade refuses an unsigned or mismatched archive before it
   changes anything; a failure is in the status file and the next manifest
   read (six hours on) tries again.

### ESP32 under a backend

1. **Trigger:** the backend's hourly sweep queues the firmware update
   (`request_embedded_firmware_update`, what "Update firmware" does) for a
   board the rule answers; a deep sleeper takes it on its next wake. An awake
   board also checks on its own every 24 hours.
2. **Asks:** the board asks its backend's `/embedded/ota/manifest`, which now
   answers by the rule (`current` = the version the board reports,
   `frameKey` = the backend key, `manual` = the owner pressed Update in the
   last 30 minutes), and for a periodic check of a board whose owner turned
   automatic updates off, answers the board's own version (the firmware then
   logs `ota:backend up-to-date`). The answer also carries `update`, `reason`,
   `latest` and `held` for a person reading it. A board whose version the
   backend does not know gets today's answer (the latest) for a manual check
   and nothing for an automatic one.
3. **Installs:** the signed release OTA, unchanged: the image streams into the
   inactive slot, is BLAKE2b-hashed and minisign-verified against the key in
   the firmware, and only then is the boot slot switched.
4. **Reports:** deploy progress kind `firmware`, moved by the `ota:backend` lines
   and the hello after the reboot.
5. **Failure:** a new image boots "pending verify" and marks itself valid only
   after its first successful render; otherwise the next reset rolls back to
   the previous slot. Three failures on one version stop the board's retries
   until a newer release or a power cycle.

### ESP32 under the cloud

1. **Trigger:** the hub's sweep enqueues `notify_update_available` with
   `{"version", "auto": true}` (the firmware ignores the payload). The hello
   does not name the board's OTA layout, so the sweep decides for
   `<chip>-generic` (or `hardware.otaPlatform` if a board ever reports one);
   the manifest route below is asked with the real layout and has the last
   word.
2. **Asks:** the board fetches `/api/frames/{id}/firmware/manifest`, which now
   answers by the rule: `manual` unless the newest `notify_update_available`
   was the sweep's (`auto: true`); a board whose switch is off is answered its
   own version for an automatic nudge.
3. **Installs / reports / failure:** as under a backend, with `ota:cloud` lines.

### Standalone ESP32 (no plane)

1. **Trigger:** the firmware's periodic task (24 hours after boot, and every
   24 hours) when the board has neither a backend nor a cloud enrollment and
   NVS `auto_update` is not 0; `ota` on the USB console asks as a manual update.
2. **Asks:** `GET https://cloud.frameos.net/api/updates/firmware?platform=<layout>&version=<running>&key=<cohort key>`
   (the board's `cloud_url` when one is set; `&manual=1` from the console and
   the settings page; no credential, https only; progress as `ota:standalone`
   lines). The cloud runs the rule and answers the OTA
   manifest the firmware already reads (`{platform, version, size, minisig,
   downloadUrl}`), or the board's own version when there is nothing to install.
   The image comes from `/api/updates/firmware/download`, the release's
   `-app.bin` streamed from GitHub (the board's HTTP client pins the address it
   checked, so it cannot follow GitHub's redirect to its CDN).
3. **Installs / failure:** the same signed OTA and rollback. The cloud is only
   the messenger: the image is verified on the board against the release key.
4. **Not covered:** a standalone board that deep-sleeps is not awake for 24
   hours, so it does not check by itself; `ota` on its console updates it.

### Pico W / Pico 2 W

**Not covered, by hardware.** A Pico has no OTA: its firmware is a `.uf2`
dropped onto the BOOTSEL drive by hand (`embedded/pico/README.md`), and it is a
thin client whose scenes run on its backend, so a new FrameOS reaches it
through the backend's own update. A Pico OTA would need an A/B layout in its
2 MB (Pico W) / 4 MB (Pico 2 W) flash and a bootloader that swaps, neither of
which exists. The rule already accepts `pico/*` patterns for the day it does.

### Virtual frames

Nothing to update: the plane renders them with the runtime it ships.
