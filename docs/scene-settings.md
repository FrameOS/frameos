# The scene settings

*Written 2026-10-29. What is left is in `docs/forms-todo.md`.*

Swipe down from the top of a touch screen and the frame shows the settings
of the scene showing: its public fields as a form, to change on the frame
itself and save. Cancel (or the same swipe) goes back as it was.

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
- Over the scene switcher, it is the settings of the scene the switcher was
  opened from (and the switcher over the panel is the switcher of that
  scene): both built-in scenes are about the frame's scenes, never about
  each other.

Who may say it (`origins`) is the switcher's list: the frame's event map, a
scene, a schedule, the HTTP API with the frame access key or an admin
session, the preview and the runtime. Not a driver (a key is bound through
the event map), and not the cloud, which has no verb for it.

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
| any with `options` (select) | the choices as chips; a tap picks one |
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
