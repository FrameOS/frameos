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

## The frame tab

On a host that has settings of its own, the panel has two tabs where the
scene's name was, **Scene** and **Frame** (drawn as a field's choices; the
scene's name heads its tab's list). Today that is the
ESP32 (`main/fos_frame_settings.c`); a Pi and the preview set no hook, and the
panel is the scene's alone, as before. The host speaks through three hooks
in the scene module, set by the host's runtime (`embedded_runtime.nim`):

| Hook | What |
|---|---|
| `frameSettingsRead` | on every render: `status` (label and text rows), `fields` and `values` (a scene field's shape; `select` makes one a select box whatever its options, and `other` adds a last option of that label that shows an input for a value of its own, with `otherPlaceholder`), `actions` (`{id, label}` buttons; `under` puts one right below the field of that name) |
| `frameSettingsApply` | the frame tab's Save: the fields changed there, by name, each as a scene field's value is saved |
| `frameSettingsAction` | an action's id, and `open` when the tab comes up |

- The panel opens on the scene's tab, off Wi-Fi or a scene without fields too
  (it says so), and on the frame tab only when no scene is showing.
- The frame tab's Save applies and stays: what it did shows in the status.
  Its Cancel is "Close". The scene's values typed before a tab switch stay
  until the scene tab's Save or the panel closes.
- An ESP32's tab: Wi-Fi (connected to what, can't find it, wrong password,
  connecting), signal, address, what the last Save could not do, who manages
  the frame and the version; the
  network (a select box of the networks in range by name, the 64 strongest
  when there are more, with the saved one and "Other network…" for a hidden
  one: a scan runs when the tab opens off Wi-Fi, and on "Scan for networks",
  the button right under it) and its password (never shown; empty
  keeps it for the same network, and means an open one for another); the
  rotation, on a frame no control plane manages (a backend's settings poll
  or the cloud's `set_settings` would put theirs back: there it is a status
  row; the frame's stands when it first meets either plane, below). Save joins the network in the background; a rotation restarts the
  frame, as one from a plane does. A join, a loss or a scan draws the panel
  again (`fos_scenes_settings_shown`).
- Flash: the tab and the report cost the ESP32-S3 image 12.1 KB on top of the
  select box (the scene's tab code 5.6 KB, `fos_frame_settings.c` 2.2 KB, the
  background join and scan in `fos_wifi.c` 1.3 KB, strings 1.5 KB). The host writes its JSON as
  text, not with cJSON, and the tabs are the panel's own buttons: keep it that
  lean.
- **What a control plane knows of it.** Wi-Fi set here is the device's alone,
  as the console's `wifi` and the portal's form are: neither plane can send a
  frame a network, so a deploy never touches it, and no password ever leaves
  the frame. The frame reports its rotation, network and address instead
  (`fos_cloud_add_device_report`): on every cloud hello (`hardware.rotate`,
  `hardware.wifiSsid`, `hardware.ip`), and in every backend commands pull,
  which a new address asks for at once (`embedded.reported`,
  `backend/app/utils/embedded_report.py`). Both settings pages say which
  network the frame is on.
  - **Rotation:** the first time a backend hears from a frame, the frame's
    stands (the settings poll carries it as `?rotate=`, so it is not turned
    back and restarted first); after that the row is the truth. The cloud's
    mirror follows every hello unless a `set_settings` is on its way.
  - **Address:** a backend moves `frame_host` under the bootup's rule (the
    claim must be the address the request came from, a hostname stays). A
    Wi-Fi join from the panel does not reboot, so it says no bootup. The cloud's
    `local_origin` stays fill-only: it is where a sign-in redirects.
  - **Flashing again** erases the frame's network, and the browser flasher
    sends the backend's: its plan warns when that is not the one the frame
    reports.

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
