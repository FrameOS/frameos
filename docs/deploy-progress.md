# Deploy progress

How far a deploy, update, restart or reboot of a frame has come, from the
click to the first render on the new code — on every frame type, on both
control planes.

- **Contract:** [`docs/deploy-progress-contract.json`](deploy-progress-contract.json)
  (stages, kinds, signals, stale windows). Edit it, then run
  `python3 frameos/tools/generate_deploy_progress_contract.py`.
- **Corpus:** [`docs/deploy-progress-fixtures.json`](deploy-progress-fixtures.json).
  Three runners replay it: `backend/app/utils/tests/test_deploy_progress.py`,
  `cloud/apps/auth-web/src/test/deploy-progress-fixtures.test.ts`, and (stale
  and percent sections) `cloud/apps/auth-web/src/test/shared-spa/deploy-progress.test.tsx`.
- **Folds:** `backend/app/utils/deploy_progress.py` and
  `cloud/apps/auth-web/src/lib/deploy-progress.ts` (the hub imports it).
  Same functions, same names: `start`, `advance`, `fold`, `fold_log`,
  `fold_command`, `finish`, `fail`, `is_stale`, `percent`.
- **Reader:** `frameDeployProgress` in `frontend/src/decorators/frame.tsx`,
  drawn by `frontend/src/components/DeployProgressBar.tsx`.

## What the user sees

While a record is running and not stale:

- the frames list row draws the bar in place of "last seen just now";
- the dashboard status line draws it in place of "ready - last seen …";
- the deploy tile next to the frame's name spins and its tooltip names the
  stage;
- a deploy toast started in this tab fills its bar from the same record.
  The sidebar's "Update all" starts no toasts: its rows already draw the
  bars, and only a failure gets one.

A finished record shows "deployed" (or "restarted", "rebooted", "upgraded",
"firmware updated") for `record.doneShownSeconds`, a failed one shows
"failed: <why>" for `record.errorShownSeconds`, then the row is back to its
usual text.

## The record

One per frame, on the frame row as `deploy_progress` (backend column
`frame.deploy_progress`, cloud column `frames.deploy_progress`), served by
every frame GET and every `update_frame` broadcast. The next deploy replaces
it. It is telemetry, not configuration: `deploy_snapshot` drops it, so it is
never a pending change.

```json
{
  "id": "deploy:12:1760300000000:3",
  "kind": "linux_full",
  "stage": "installing",
  "status": "running",
  "detail": "frameos setup on the new release",
  "progress": null,
  "version": null,
  "error": null,
  "started_at": "2026-10-12T12:00:00+00:00",
  "at": "2026-10-12T12:03:10+00:00"
}
```

- `id`: the browser's task id when the deploy came from a deploy button (the
  toast follows the bar by it), the command id on the cloud, a uuid otherwise.
- `stage`: one of the kind's stages, or `done`.
- `progress`: `{current, total}` bytes while the device reports them.
- `at`: the last change. Nothing ever expires a record; a reader compares
  `at` with the stage's `staleAfterSeconds` and stops believing it. A
  `waiting` stage stays believable while the frame's own `next_wake_at` (plus
  `record.wakeGraceSeconds`) is ahead: a sleeping ESP32 takes the deploy on
  its next wake, hours later.

## How a record moves

Two ways, and only forward along the kind's stage list:

1. **The control plane's own step** (`advance`): the backend task reached
   "building", the hub wrote the verb to the socket. A step the record is
   already past is ignored, so a worker that finishes after the device came
   back cannot move the bar backwards.
2. **An observed signal** (`fold`): a device log line, a command-queue state
   change, the hub's session events. The current stage's `on` table names
   the signals that move it and where to; anything else is ignored. That is
   what keeps the previous runtime's last `render:done`, or a late ack of an
   older push, from finishing a deploy that has not happened yet.

`holdOn` signals refresh `at` (and `progress`) without leaving the stage: the
ESP32's `ota:<plane> progress` lines every 512 KB keep a long download fresh.

### Signals

| Signal | Who sends it | Where |
| --- | --- | --- |
| `bootup` | Linux runtime at start; ESP32 firmware when online. On the cloud the device's `hello` is the same signal. | `frameos/src/frameos/frameos.nim`, `embedded/esp32/main/main.c`; hub `activateDeviceSession` |
| `reload` | Linux runtime re-reading frame.json and scenes | `runner.nim` `rcReload` |
| `render:done` | every runtime after a render. The first one after a boot or a reload is always logged, even while fast-render logging is paused (`RunnerThread.announceNextRender`). On the cloud the device's `render` announce is the same signal. | `runner.nim`, `fos_client.c`; hub `handleRender` |
| `ota:waiting` … `ota:error` | ESP32 `ota:<plane>` lines (`waiting`, `downloading`, `progress`, `verified`, `up-to-date` / `skipped` / `downgrade-refused`, `error` / `gave-up`) | `embedded/esp32/main/fos_ota.c` |
| `upgrade:downloading` … `upgrade:error` | Linux runtime's `cloud:upgrade` lines from upgrade-status.json | `frameos/src/frameos/upgrade.nim` |
| `command:<state>:<type>` | the command queue: `sent` (hub wrote it), `acked`, `failed` | backend `api/embedded_commands.py`; hub `drainCommands`, `handleAck` |
| `commands:settled` | backend: every row of an ESP32 deploy is acked (the pull reported the ETags the backend serves) | backend `_record_deploy_if_settled` |
| `scene_ack` | cloud: the device says the set the record's own `set_scenes` pushed is live (matched by that command's checksum) | hub `handleSceneAck` |

## Per frame type

The stage list of each kind is in the contract; this is which frame gets
which kind, and what moves each stage. "Plane" stages are the control plane's
own steps; everything in brackets is a signal.

### Linux frames with a shell (Raspberry Pi OS, Buildroot with SSH or the FrameOS Remote) — backend

**Full deploy** (`linux_full`, `POST /frames/{id}/deploy`):

| Stage | Moved by |
| --- | --- |
| queued | the route, before the job is enqueued |
| connecting | plane: the plan's SSH / Remote probe |
| building | plane: precompiled release fetch, cross compile or on-device build |
| uploading | plane: dependencies, release directory, binary, scenes, vendor files |
| installing | plane: FrameOS stopped, `frameos setup`, fonts, cleanup |
| restarting | plane: `systemctl restart` or `reboot` issued; [bootup] → rendering |
| booting | plane: the job ended before the device was back; [bootup] → rendering |
| rendering | [render:done] → done |

**Fast deploy** (`linux_fast`, `POST /frames/{id}/fast_deploy`, also
`set_next_scene`): queued → connecting → uploading (frame.json, scenes) →
installing (`frameos setup`) → reloading (`/reload`, or a restart for TLS, or
a reboot setup asked for; [reload] or [bootup] → rendering) → booting →
rendering ([render:done] → done).

**Upgrade** (`upgrade`, the drawer's device upgrade, `POST
/frames/{id}/device/upgrade`): queued → downloading ([upgrade:downloading]) →
verified ([upgrade:verified]) → rendering ([bootup]) → done ([render:done]).
[upgrade:up-to-date] ends it at once; [upgrade:error] fails it.

### Adopted Buildroot cards without a shell (admin API only) — backend

**Deploy** (`admin_push`, fast and full alike): queued → saving (service keys,
scenes and settings posted to `/api/frames/1`, the device's own Save). Then what the device's answer
says it did: `apply.runtime == "restart"` → booting ([bootup] → rendering),
`"reload"` → rendering, nothing to apply → done. rendering → done on
[render:done].

**Upgrade:** the `upgrade` kind above (labelled "Update FrameOS"), same signals (the card's runtime
writes the same `cloud:upgrade` lines).

### ESP32 frames — backend

**Full deploy** (`esp32_full`): queued → waiting (set_scenes + set_settings
rows and `notify_update_available` on the frame's queue) →
downloading ([command:acked:notify_update_available] or any [ota:*] line) →
verified ([ota:verified]) → receiving ([bootup] on the new release) →
rendering ([commands:settled]) → done ([render:done]).
The early-boot updater writes its `ota:backend` lines before log upload
exists, so a whole update can arrive as nothing but the [bootup]: every stage
from waiting on accepts it. [ota:up-to-date] goes to booting; [ota:error]
fails the record, after the [bootup] too: the first pass replays the
updater's verdict (`replayed: true`), so a failed download reads as [bootup]
on the old firmware, then [ota:error], and receiving / rendering listen for
it.

**Fast deploy** (`esp32_fast`): queued → waiting (rows queued, frame nudged)
→ receiving ([command:acked:set_scenes / set_settings]) → rendering
([commands:settled]) → done ([render:done]). Firmware before the command
queue (< 2026.10.5) gets the scenes over its own HTTP server: waiting is
skipped and receiving / rendering are plane steps.

**Firmware update only** (`firmware`, the OTA card's "Update over the air",
`POST /frames/{id}/embedded/firmware/ota`): queued → waiting (the frame is
asleep) → downloading → verified → rendering ([bootup]) → done
([render:done]). [ota:error] fails it in rendering as well: the early-boot
updater's verdict arrives after the [bootup] of the boot it ran in, and
before this a failed download sat in "first render" (frame 70, 2026-10-20),
or finished as done once the old firmware rendered. A connection
that drops mid-image is a `progress` line with a `retry` field, not an
[ota:error]: the device resumes it.

**USB** (`esp32_usb`): the browser flasher reports completion
(`/embedded/usb_deploy_complete`); the record starts at booting → rendering
([bootup]) → done ([render:done]).

### Virtual frames — backend

`virtual`: queued → rendering (the backend renders the scene itself) → done.

### Restart and reboot — every frame, both planes

`restart` / `reboot`: queued (route) → waiting (an ESP32 or cloud frame took
it onto its queue: [command:sent:…]) → restarting (plane step after the SSH
or admin command, or [command:acked:restart_runtime / reboot]) → booting →
rendering ([bootup]) → done ([render:done]). A render before the [bootup] is
the old runtime's and moves nothing.

### FrameOS Cloud — every device

Every record starts in `enqueueFrameCommand`, so the routes, the MCP tools and
the fleet update all get a bar.

| Verb | Kind |
| --- | --- |
| `set_scenes` (assign, install, update, preview push) | `cloud_scenes`: queued → sending ([command:sent]) → loading ([command:acked]) → rendering ([scene_ack] of this push's checksum) → done ([render:done] / the `render` announce) |
| `notify_update_available` on an ESP32 | `firmware` (as on the backend, with `ota:cloud` lines and the hello as [bootup]) |
| `notify_update_available` on a Linux frame | `upgrade` (`cloud:upgrade` lines, then the hello) |
| `restart_runtime`, `reboot` | `restart`, `reboot` |

The hub moves records with a compare-and-set on `(id, at)` and re-reads on a
lost race, so a "sent" and an "ack" landing together end where the stage
gating says, whichever wrote first.

## Not tracked

- `set_settings` and `set_schedule` on their own (no device-side end to wait
  for beyond the ack; they show in "Waiting for the frame").
- FrameOS Remote deploys and restarts: the Remote is not the runtime, and its
  own toasts cover it.
- A freshly built SD card's first boot: `buildroot.sdImage` already tracks it,
  and nothing happens until someone flashes the card.
- Pico W thin clients: they send no log lines.

## Adding a kind or a signal

1. Edit `docs/deploy-progress-contract.json` (a signal goes in `signals`, a
   stage in `stages` with its `staleAfterSeconds`, a kind lists its stages in
   order with their `on` / `holdOn` tables). The generator refuses unknown
   signals, unknown stages and transitions that move backwards.
2. `python3 frameos/tools/generate_deploy_progress_contract.py`. The backend
   suite runs `--check`.
3. Add cases to `docs/deploy-progress-fixtures.json`.
4. Start or advance it from both planes (a backend route or task; the cloud's
   `deployProgressKindForCommand` or the hub), or say in the PR why it is
   one-sided.
