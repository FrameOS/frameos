# The scene settings

*Written 2026-10-29. What is left is in `docs/forms-todo.md`.*

Swipe down from the top of a touch screen and the frame shows the settings
of the scene showing: its public fields as a form, to change on the frame
itself and save. Cancel, the same swipe, one up from the bottom or one in
from the left (the frame's `back`) goes back as it was.

| Piece | Where |
|---|---|
| The event that opens it, `sceneSettings` | `docs/events-contract.json` (a `scene-command`), resolved by `frameos/src/frameos/event_loop.nim` |
| The scene, `system/sceneSettings` (the contract's `scenes.settings`) | `frameos/src/system/sceneSettings/scene.nim`, one module for every host |
| The fields, the keyboard on the screen, the list that scrolls | the JSX layer's (`docs/jsx-ui.md` "Fields and the keyboard", "Scrolling and clipping") |
| The default bindings | `TOUCH_EDGE_SWIPES` in `fos_board.c` (the SenseCAP Indicator, the reTerminal E1003), `EMBEDDED_TOUCH_EDGE_SWIPES` and the SPA's `NewFrame.tsx`, every HyperPixel's `frameos/device_event_map.nim` |
| "Button actions" | `frontend/src/utils/frameEventMap.ts` (the action "Scene settings"); the cloud contract's `event_map` rule allows the emit |

## Opening and closing it

`sceneSettings` is a scene command the dispatcher resolves on every host,
as it resolves `sceneSwitcher`:

- From any scene, it selects `system/sceneSettings` with `state.from`, the
  scene showing, and with what the panel shows of it, read off the scene
  before the switch: `state.fields`, its public fields (name, label, type,
  options, placeholder, secret), and `state.values`, their values now. An
  ESP32 holds one scene: the one under the panel is let go while it shows,
  so the panel carries everything it needs.
- While the panel shows, `sceneSettings` selects `state.from` again, nothing
  saved. So the same swipe opens and closes it, and the panel's Cancel, a
  key with the role `back` and its idle timeout (five minutes without a
  touch or a key) dispatch it to go back.
- The frame's `back` (a swipe in from the left edge on every touch preset,
  docs/events.md) is Cancel too, as a phone's back is: with a field's
  keyboard up it puts the keyboard away first (`ui/events.nim`
  `dismissKeyboard`; a held key's accents, if those are up, before that), and
  the next one closes the panel. `forward` does nothing here.
- `sceneSwitcher` while the panel shows goes back the same way, and
  `sceneSettings` while the switcher shows goes back to the scene: a swipe
  from the other edge closes either built-in scene, so the frame never stacks
  one over the other.

Who may say it (`origins`) is the switcher's list: the frame's event map, a
scene, a schedule, the HTTP API with the frame access key or an admin
session, the preview and the runtime. Not a driver (a key is bound through
the event map), and not the cloud, which has no verb for it.

## The frame page

A gear left of Save opens the frame's own settings: **Frame settings**, where
Cancel becomes Back and the gear stays lit. Back, the gear again, a key with
the role `back` and the frame's `back` (once any keyboard is away) go back to
the scene's form with its edits kept; the swipe that opened the panel closes
it from either page. The panel opens on the scene's form, off Wi-Fi or on a
scene without fields too, and on the frame page only when no scene is showing
(an ESP32 with nothing installed opens it from its status screen).

The page is built in the scene (`frameos/src/system/sceneSettings/scene.nim`)
from facts the host hands over, so every host shows the same words. Three
hooks in the scene module, set by the host's runtime:

| Hook | What |
|---|---|
| `frameSettingsRead` | on every render: nil when the host offers no page (the preview, a round panel) or the frame's control plane turned it off (below); else `wifi` (`state`: connected, connecting, notFound, auth, hotspot, unset, off; `ssid`, `hotspot`, `rssi`, `ip`, `networks` in range, `scanning`, `password`: one is saved; absent: no Wi-Fi to set here), `rotate`, `renderScale`, `managedBy`, `version`, `actions` (device commands besides Render again and Reboot: `restart` on a Pi), `note` (what the last Save could not do) |
| `frameSettingsApply` | Save: what changed, `wifiSsid` with `wifiPassword`, `rotate`, `renderScale` |
| `frameSettingsAction` | `open` and `close` as the page comes and goes, `scan` |

| Host | Where | Wi-Fi | Rotation and scale | Restart |
|---|---|---|---|---|
| ESP32 | `main/fos_frame_settings.c`, through `embedded_runtime.nim` | the station's (`fos_wifi.c`); 64 names by name, case ignored | NVS; the scale live, a rotation restarts | is a reboot: the page shows Reboot alone |
| Linux | `frameos/frame_settings_linux.nim`, installed by `frameos.nim` | the portal's code (NetworkManager or wpa_supplicant), on a thread of its own; a frame on its hotspot lets it go for the join and raises it again on a failure | `persistFrameApiUpdate`, then a reload or a restart, as a cloud push | Restart FrameOS |

What the page holds, top to bottom:

- **A card**: Wi-Fi (connected to what, can't find it, wrong password?,
  connecting, the setup hotspot), signal, address, what the last Save could
  not do, who manages the frame, the version.
- **Wi-Fi network**: a select box of the networks in range, the saved one first
  when it is not among them, and "Other network…" for a hidden one (an input
  to type its name). "Scan for networks" sits right under it; a scan runs when
  the page opens off Wi-Fi (an ESP32) or on a scan older than 30 s (Linux).
- **Password**: never shown. On an ESP32 an empty one keeps the saved
  password for the same network and means an open network for another; a
  Linux runtime holds no password (NetworkManager or the supplicant does), so
  there an empty one is an open network.
- **Rotation** and **Scale** (Automatic with what that is on this panel, then
  0.25x to 4x, `RENDER_SCALE_STEPS`; below 1 everything is drawn smaller). The scale is the frame's: a scene with its
  own (`settings.renderScale`, a `renderScale` field) keeps it.
- **Render again**, **Restart FrameOS** (where the host lists it) and
  **Reboot**. Restart and Reboot ask for a second tap ("Tap again to
  reboot", red); anything else in between asks again. They send the
  contract's device commands from the origin `panel`
  (`docs/events-contract.json`), so every host runs the restart and reboot it
  runs for a schedule.

Save applies what changed and stays: a join, a drop or a scan result draws the
page again (the ESP32 while `fos_scenes_settings_shown`, a Linux frame between
`open` and `close`). A value picked again as it was is no change. A rotation
restarts the frame on an ESP32.

**Turned off by the control plane.** The frame's `frame_settings_on_screen`
(frame.json `frameSettingsOnScreen`, on unless the owner turns it off in the
frame's settings, on both planes) decides whether the gear shows. Off, the panel
is the scene's form alone; the scene's settings themselves go with the swipe's
event map rule ("Button actions"). So that a frame whose Wi-Fi broke while it
was off can still be fixed at the frame, the device has the last word:

- a Pi: a file named `frameos-settings-unlock` on the boot partition (`/boot` or
  `/boot/firmware`), while it is there (`frame_settings_lock.nim`);
- an ESP32: `set settings_unlock 1` on the USB console, until `set
  settings_unlock 0`.

### What a control plane learns

- **Wi-Fi: nothing.** A network set here is the device's alone, as the
  console's and the setup portal's are. Neither plane is told the network's
  name and no password leaves the frame. A backend learns the address alone,
  from an ESP32's commands pull (`ip`), so it can follow a frame that joined
  another network without a reboot: `frame_host` moves under the bootup's rule
  (the claim must be the address the request came from, a hostname stays;
  `backend/app/utils/embedded_report.py`).
- **Rotation and scale: the plane adopts them**, so the next deploy keeps what
  the person at the frame chose:
  - The cloud's settings mirror follows `hardware.rotate` and
    `hardware.renderScale` in every hello and `state`, unless a `set_settings`
    is still on its way (`settingsWithReported` in `frames.ts`, the hub's
    `followReportedSettings`). An ESP32 sends a `state` after a scale change
    (`fos_cloud_request_state`); a Pi's hub client sends one when its config's
    rotation or scale moved.
  - A backend takes them from the frame's log line `{"event":
    "settings:frame", "origin": "panel", "rotate": 90, "renderScale": 1.5}`
    onto the row and the deploy baseline, so the drawer offers nothing to
    deploy for them (`backend/app/utils/frame_settings_adopt.py`).
- **Flashing an ESP32 again** erases its network, and the browser flasher sends
  the plane's stored one (the backend's Network settings).

**Flash** on the ESP32-S3: the PR that made the page says what it cost. The
host writes its facts as text, not with cJSON, and the page's words live once,
in the scene: keep it that lean.

## Saving

**Save** is `setCurrentScene {sceneId: from, state: values}`, from the
origin `scene`. Every host already applies a switch's `state` to the scene's
public fields (`interpreter.nim` `applyPublicStateFromPayload`): the Linux
runner to the scene it kept in memory, the ESP32 and the preview once the
scene is loaded again, before its `open`. A field that persists (`persist:
"disk"`) saves itself as it does for any change; the others last as long as
the scene does.

Every public field is sent, changed or not: on an ESP32 the scene comes back
from its defaults and what it persisted, so a value set from the outside
before the panel opened (a schedule's `setSceneState`, the cloud's) would
otherwise be lost. A value goes back as the scene's state holds it: a
number for `integer` and `float` (a text that is no number is not sent, and
the scene keeps what it had), a boolean for `boolean`, the text for the
rest (a `json` field's text the scene parses).

## The form

Drawn from a tree built in Nim with the JSX layout (no QuickJS), like the
switcher: a header with Cancel, the scene's name (the host's scene list,
`sceneSwitcherListing`) and Save; under it the fields in a list that scrolls
(`overflow-y-auto`), one row each:

| Field type | Row |
|---|---|
| any with `options` (select) | a select box (`docs/jsx-ui.md`): its list opens over the panel and scrolls |
| `boolean` | a switch beside the label; a tap anywhere on the row flips it |
| `text`, `json` | a `<textarea>` |
| `integer`, `float` | an `<input type="number">`: the keyboard opens on its number pad |
| `secret: true` | an `<input type="password">` |
| `string`, `color` (its hex), `date`, `font`, `path`, any other | an `<input>` |
| `node`, `scene`, `image` | left out: what they hold is not text |

A tap on a field brings up the keyboard on the screen under the form,
which scrolls to keep the field in sight (`docs/jsx-ui.md`). A fast panel
gets a dark form that shows presses; e-paper black on white, no press shown
(a key is a refresh there) and a scroll shown when the finger lifts.

A scene with no field to show says so: "This scene has no settings."

**A round panel** (`frameos/panel_shape.nim` `panelIsRound`: the HyperPixel
2.1" Round) keeps the form inside its circle, `RoundInset` (12 px) in from
the rim, as the switcher does: the scene's name in the top arc, Cancel and
Save centred under it, and the list as wide as the circle is where the list
ends (as far below the centre as it starts above it). With the keyboard up
it sits on the circle's lower half (`docs/jsx-ui.md`), the name makes way
for the buttons, and the list ends above the keys. `test_scene.nim` checks
every hit region and every pixel drawn, the keyboard down and up. No ESP32
board is round: the firmware carries the rectangular form alone.

## The scene

Built into the runtime, not installed, exactly as the switcher: in no scene
list, never pushed, never persisted (no `scene.json` on Linux, no
`last_scene` or `pending_scene` on an ESP32, `fos_scenes.c`
`is_built_in_scene`), its state in memory only. Closed, it lets its form's
input state go (`forgetUiTarget`): opened again, no field has the keyboard
and the list is at its top. `isBuiltInScene` names both built-in scenes for
every host; `single_scene_host.nim` picks the export by id, and the Linux
runner registers it with the system scenes (`system/scenes.nim`).

## Flash

What it costs on the ESP32-S3 image is in the PR that added it, measured
against the forms layer it stands on.
