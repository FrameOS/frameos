# The terminal

A frame's console on its own screen: a line to type commands into and the
frame's answers above it. It is a scene, the **Terminal** sample
(`repo/scenes/samples/Terminal app`, scene id `terminal-app`), one JSX app
(`terminal`) on top of one bridge call, `frameos.frame`. It runs wherever a JS
app runs: a Raspberry Pi, an ESP32, the browser preview.

## Using it

A tap on the line brings the keyboard on the screen up (a real keyboard types
straight into it). Enter runs the line and keeps the keyboard; ArrowUp and
ArrowDown walk the commands typed before; a swipe down on the lines (or
PageUp) scrolls back through them. It keeps the last 200 lines and 50 commands
with `frameos.remember`, so they outlast an interpreter the frame let go. Its
letters keep their size wherever it shows: a bigger window shows more lines.

On the desktops (`docs/scene-layouts.md`) it is one of the frame's own apps,
found by its id or its name like the scene store: on Windows 98's Start and
desktop, a prompt in Tiling's top bar, macOS's Dock and the mark's menu, BeOS's
Be menu and Tracker, Classic Mac's mark's menu and icons, NeXTSTEP's Services and
Dock, OS/2 Warp's Desktop menu, WarpCenter, icons and LaunchPad, and Commander's
F8 and command line.

## The commands

An ESP32 serial console's names, arguments and answer lines, answered from
what the frame page knows (`docs/scene-settings.md` "The frame page"):

| Command | What |
|---|---|
| `help` | The commands. |
| `status` | Wi-Fi, managed by, panel, rotate, render scale, the frame page, time zone, debug, battery, scenes, version, the last refusal. |
| `set <key> <value>` | `rotate`, `render_scale`, `wifi_ssid`, `wifi_pass`, through the page's Save. Every other key is the control plane's to set, and says so. |
| `wifi <ssid> [pass]` | Joins that network (an ESP32 restarts for it). |
| `wifi-scan` | Scans, and lists the networks when the scan is back. |
| `render` | Every panel drawn anew. |
| `event <name> [json]` | `render`, `restart` or `reboot`, what the origin `panel` may send; anything else is refused. |
| `scenes`, `scene <id>` | The frame's scenes (`app.frame.scenes`); `scene` shows one. |
| `restart` | Restarts FrameOS where the host can (`actions` has `restart`), else reboots. |
| `reboot` | Reboots the device. |
| `clear` | Empties the screen. |

Any other line is `unknown command`: the serial console's other commands
(`heapinfo`, `ota`, `mic`…) stay on the USB console, because handing a line
from the render task to the console's task and catching what it printed cost
about 1.5 KB of the ESP32 image.

## `frameos.frame(op, arg)`

The one native the terminal needs, in `js_runtime/app_runtime.nim` (`jsFrame`):

- `"read"`: the frame page's facts, null where there is no page.
- `"apply"`: what the page's Save sets (`wifiSsid` + `wifiPassword`, `rotate`,
  `renderScale`, `clock`).
- `"action"`: `render`, `restart` and `reboot` go through the one dispatcher
  from the origin `panel`, as the page's buttons do; anything else (`scan`,
  `checkUpdate`, `installUpdate`) is the host's `frameSettingsAction`.

The hooks are the frame page's own (`frameos/frame_settings_hooks.nim`, set by
`frame_settings_linux.nim`, `embedded_runtime.nim` and `wasm_main.nim`), so
the terminal can do exactly what the page can and nothing more, and the words
are the app's, never a host's.

## Who may use it

Only an app whose config.json `"permissions"` has `"frame"`: the owner's yes
is installing the scene, whose tags say "changes frame settings" (red, as an
update that gains it is: `utils/sceneAccess.ts`, `docs/scene-access-fixtures.json`).
Saving a scene adds `"frame"` to an app whose code calls `frameos.frame(`, as
it does the asset permissions, so a list written by hand cannot keep it
without the call, and an app without it is refused with "this app's
permissions do not include frame". And only while the frame offers its page:
when the control plane has turned settings on the screen off
(`frame_settings_on_screen`, unless the device unlocked them), `"read"` is null
and everything else is refused. No existing scene called it, so nothing was
migrated.
