# The terminal

A frame's console on its own screen: a line to type the commands an ESP32's
serial console takes, and the frame's answers above it. `system/terminal`
(the contract's `scenes.terminal`), built into the runtimes that run scenes
side by side: the Raspberry Pi's runner and the browser's host
(`frameos_wasm_set_windowed`). Not on an ESP32, whose console is its serial
port (`embedded/esp32/main/fos_console.c`).

The scene is `frameos/src/system/terminal/scene.nim`, the commands
`frameos/src/system/terminal/commands.nim`.

## Opening it

`terminal` (a scene command, `docs/events-contract.json`) opens it over the
scene showing, as `sceneSettings` opens the settings: the dispatcher hands it
`state.from` and that scene's public values. The same command, `sceneSettings`
or `sceneSwitcher` while it shows go back there, and so do the frame's `back`
(once the keyboard on the screen is away), a key with the role `back` and five
minutes without a key. The Windows 98 layout has it on Start ("Terminal"), macOS in its Dock and
BeOS in its Be menu; on a
desktop of windows it stays open as a window while another has the focus, its
lines and the commands typed kept, and its idle timeout waits until it has the
focus again (`docs/scene-layouts.md` "Windows").

A keyboard types straight into its line; a tap on the line brings the keyboard
on the screen up. Enter runs the line, ArrowUp and ArrowDown walk the commands
typed before. It keeps the last 200 lines, each command after its green
prompt as it was typed, and the wheel scrolls back through them. Its letters
keep their size wherever it shows: a bigger window shows more lines, not larger
ones (built-in scenes take their size from the panel, `sizeUnit`, and the scene
settings and the scene list do the same). In a desktop's window (a layout that
keeps `openScenes`) that size is a desktop app's, as on an 800×480 frame and
twice that on a 4K screen, whatever the panel (`onDesktop`, sceneSwitcher's
`panelUnit`); full screen it is the panel's.

## The commands

The ESP32 console's names, arguments and answer lines, answered from what this
host knows:

| Command | Here |
|---|---|
| `help` | The commands this frame runs, then the ones it has not. |
| `status` | The console's lines this host has a fact for: hostname, Wi-Fi, backend, managed by, panel, rotate, scaling mode, render scale, frame page, time zone, debug, battery, `nim`, version, the scene it was opened from. |
| `set <key> <value>` | `rotate`, `render_scale`, `wifi_ssid`, `wifi_pass`, through the frame page's hooks. Every other key the ESP32 takes is the frame's control plane's to set here, and says so. |
| `wifi <ssid> [pass]` | Joins the network in the background (an ESP32 restarts). A frame with no Wi-Fi to set says so. |
| `wifi-scan` | Scans, and lists the networks when the scan is back. |
| `render` | Every panel drawn anew. |
| `event <name> [json]` | Sent from the origin `panel`, which takes `render`, `restart` and `reboot`: anything else is refused as on the console ("event refused: not one the console may send"). |
| `scenes` | The frame's scenes, `*` on the one it was opened from. |
| `scene <id>` | Shows that scene; the terminal is done, as the scene switcher is when a tile is picked. |
| `scene_state` | The public state of the scene it was opened from (only public: what the frame's API shows), live where the host keeps that scene beside it, else as the terminal opened. |
| `restart` | Restarts FrameOS (an ESP32's reboots: its runtime is the device). |
| `reboot` | Reboots the device. In the browser, both start the runtime again. |

`heapinfo`, `buttons`, `beep`, `led`, `i2c`, `touch`, `lcd`, `mic`,
`display_test`, `sd`, `usb_api`, `factory-reset` and `ota` answer that they are
an ESP32's. Anything else is `unknown command: …`.

## What it may change

Nothing here is a door for a scene: no app reaches the commands, only a person
typing into the built-in scene. What changes the frame goes where the frame
page's buttons go (`docs/scene-settings.md` "The frame page"): a setting through
`frameSettingsApply`, `restart` and `reboot` through the one dispatcher from
the origin `panel`. When the frame's control plane has turned settings on the
screen off (`frame_settings_on_screen`, and the device's own unlock), the host
reads no facts and `set`, `wifi`, `wifi-scan`, `event`, `restart` and `reboot`
answer "refused: the frame's control plane has turned settings on its screen
off". `render`, `status`, `scenes`, `scene` and `scene_state` stay: they are what
the scene switcher and the frame's API already offer.

## An ESP32

Not built there (`when not defined(frameosEmbedded)` around every use; the
contract's tables carry the `terminal` row as they carry every event). The way
to give an ESP32 one is to hand each line to `fos_console.c`'s own
`esp_console_run` and capture what it prints, so the commands are the
console's own and not a second copy; the scene itself (the JSX tree, the line,
the scrollback) is the Nim here, a few kilobytes of flash.
