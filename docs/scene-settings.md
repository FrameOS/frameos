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
  one over the other. `sceneSettings {page: "frame"}` while the switcher shows
  (its gear, docs/scene-switcher.md) opens the frame page over the scene the
  switcher was opened from instead, and Back there goes to that scene;
  `sceneSwitcher {swap: true}` over a scene's settings (a taskbar's Start)
  opens the list the same way, on every host (a Pi, whose settings are
  `system/sceneSettings#<scene id>`, went back until 2026.11.14). On a desktop, where each opens in a window of its own and stays
  open beside the others ("In a window"), the other one always opens: the
  swipe up over a scene's settings opens the list, the swipe down over the
  list the settings of the scene it was opened from.

Who may say it (`origins`) is the switcher's list: the frame's event map, a
scene, a schedule, the HTTP API with the frame access key or an admin
session, the preview and the runtime. Not a driver (a key is bound through
the event map), and not the cloud, which has no verb for it.

**In a window.** On a frame that runs its scenes side by side (a Pi, an ESP32,
the browser with windows on; `docs/scene-layouts.md` "Windows") the panel is a scene
like the others: a desktop layout gives it a window of its own over the scene it
was opened from, sized there like the desktop's apps rather than the whole panel
(sceneSwitcher's `panelUnit`: the same rule for every built-in scene). There **every
scene's settings are an instance of their own**,
`system/sceneSettings#` and the scene's id (the contract's
`scenes.settingsWindow`; `event_loop.settingsWindows`), so the settings of
several scenes stay open side by side, each with its own `from`, fields and
edits. Save in one sets its scene's fields where that scene runs, in its window
(`setSceneState` aimed at it), and the settings window stays open with the
focus, its Save quiet until the next edit; Cancel goes back to its scene and
closes only it. The
frame page is one window, the plain `system/sceneSettings`: `sceneSettings
{page: "frame"}` opens it over the scene in front, or over the scene whose
settings are in front, and the gear in a scene's settings brings it forward
instead of turning that window's page (it has no gear back: the scenes'
settings have windows of their own). Left for another window, a settings window
stays open there as it was, its page and its edits kept, and its idle timeout
waits until it has the focus again; opened from its scene again, it starts
afresh, and brought forward by its id it is as it was left. Everywhere else (a
frame without a desktop, an editor's preview) the settings are the one scene
they always were. The scene switcher stays one window. In the Windows 98 sample a
scene's settings open from the gear button at the left of its window's title bar
(a window behind comes forward first; open already, they come forward), and the
frame's from Start's Control Panel and the tray; in macOS from the gear at the
right of the title bar and the menu bar's Settings, the frame's from System
Settings in the Dock and the status icons; in BeOS from the gear box on the
window's tab, the frame's from Preferences and the Deskbar's tray; in Classic Mac
from the gear box on the title bar and File's Get Info, the frame's from About
This Frame, the clock and the Frame icon; in NeXTSTEP from the gear on the title
bar and Info's Inspector, the frame's from Info Panel and the Dock's clock; in
OS/2 Warp from the gear on the title bar and the window's system menu, the
frame's from System Setup (an icon, the LaunchPad, the Desktop menu) and the
WarpCenter's clock; in Omarchy from the window's name in the bar and the menu, the
frame's from Setup in the menu, the bar's signal and battery and Super+Ctrl+W; in
Commander from F4, the frame's from F1 and the clock.

## The frame page

A gear left of Save opens the frame's own settings: **Frame settings**, where
Cancel becomes Back and the gear stays lit. On a rectangular panel the gear and
the code button beside it (docs/code-editor.md) are wider than they are tall,
for a thumb, and both are on every page of the panel: the scene's, the frame's
and a layout's (the gear lit on the last two, where it goes back to the
scene's form; the code button opens the scene's code, on a layout's page the
layout's). Back, the gear again, a key with
the role `back` and the frame's `back` (once any keyboard is away) go back to
the scene's form with its edits kept; the swipe that opened the panel closes
it from either page. `sceneSettings {page: "frame"}` (the tray of the Windows 98
layout) opens straight on the frame page, and there Back goes to the scene. The page
has a refresh button on the Wi-Fi network's line and a Layout select with a gear for
that layout's fields (`docs/scene-layouts.md` "On the frame"). Without
it the panel opens on the scene's form, off Wi-Fi or on a
scene without fields too, and on the frame page only when no scene is showing
(an ESP32 with nothing installed opens it from its status screen).

The page is built in the scene (`frameos/src/system/sceneSettings/scene.nim`)
from facts the host hands over, so every host shows the same words. Three
hooks (`frameos/src/frameos/frame_settings_hooks.nim`), set by the host's
runtime; a JS app the owner lets have them reads and uses the same three
(`frameos.frame`, `docs/terminal.md`):

| Hook | What |
|---|---|
| `frameSettingsRead` | on every render: nil when the host offers no page (the preview) or the frame's control plane turned it off (below); else `wifi` (`state`: connected, connecting, notFound, auth, hotspot, unset, off; `ssid`, `hotspot`, `rssi`, `ip`, `networks` in range, `scanning`, `password`: one is saved; absent: no Wi-Fi to set here), `rotate`, `renderScale`, `managedBy`, `version`, `actions` (what the page may offer besides Render again and Reboot: `restart` on a Pi; `linkCloud` and `adopt`, below), `cloudLink` (`code`, `uri`) and `adopt` (`address`, `seconds`) while a link is under way, `note` (what the last Save could not do), `clickSounds` (`silent`, `normal`: only on a frame that makes sounds), `awakeAfterInputSeconds` (0 to 3600: only on a frame that deep-sleeps), and on an ESP32 `clock` and `updateState` (0 idle, 1 checking, 2 current, 3 available, 4 failed, 5 installing; `fos_ota_check_t`) with `updateVersion` |
| `frameSettingsApply` | Save: what changed, `wifiSsid` with `wifiPassword`, `rotate`, `renderScale`, `clickSounds`, `awakeAfterInputSeconds`, `clock` |
| `frameSettingsAction` | `open` and `close` as the page comes and goes, `scan`, `checkUpdate`, `installUpdate`, `linkCloud`, `adopt`, `cancelLink` |

The page is for somebody at the frame. A key or a tap that came in over the
frame's HTTP API with the frame access key (origin `http:write`,
`docs/events.md` "Origins") is not that: for the run of a scene on such an
event the dispatcher holds the three hooks nil (`withholdFramePage`), which
every reader already takes for "no page here", with the code host and the
store's actions (docs/code-editor.md, docs/scene-store.md), and the scene
settings take no input from it. The key printed on a frame's QR code picks scenes; it does not
restart, update or re-join the frame through the screen.

| Host | Where | Wi-Fi | Rotation and scale | Restart |
|---|---|---|---|---|
| ESP32 | `main/fos_frame_settings.c`, through `embedded_runtime.nim` | the station's (`fos_wifi.c`); 64 names by name, case ignored | NVS; the scale live, a rotation restarts | is a reboot: the page shows Reboot alone |
| Linux | `frameos/frame_settings_linux.nim`, installed by `frameos.nim` | the portal's code (NetworkManager or wpa_supplicant), on a thread of its own; a frame on its hotspot lets it go for the join and raises it again on a failure | `persistFrameApiUpdate`, then a reload or a restart, as a cloud push | Restart FrameOS |

What the page holds, top to bottom:

- **A card**: Wi-Fi (connected to what, can't find it, wrong password?,
  connecting, the setup hotspot), signal, address, the battery on a frame
  that has one, what the last Save could not do, who manages the frame
  ("Nobody" where a plane can be connected: below, "Connecting the
  frame"), the version.
- **The buttons**, right under the card, above the fields (which can run
  longer than the panel): **Render again**, **Check for updates** / **Install
  update** (below), **Update scenes** (below), **Restart FrameOS** (where the
  host lists it), **Reboot**, and **Link to cloud** and **Link to backend**
  where a plane can be connected (below, "Connecting the frame"). Restart,
  Reboot, Install and Update scenes ask for a second tap ("Tap again",
  red); anything else in between asks again. Render, Restart and Reboot send
  the contract's device commands from the origin `panel`
  (`docs/events-contract.json`), so every host runs the restart and reboot it
  runs for a schedule.
- **Wi-Fi network**: a select box of the networks in range, the saved one first
  when it is not among them, and "Other network…" for a hidden one (an input
  to type its name). "Scan for networks" sits right under it; a scan runs when
  the page opens off Wi-Fi (an ESP32) or on a scan older than 30 s (Linux).
- **Password**: the saved one never shown; what is typed shows with the eye
  on its line (any secret field has it), and hides again with a second tap or
  when the page is opened again. On an ESP32 an empty one keeps the saved
  password for the same network and means an open network for another; a
  Linux runtime holds no password (NetworkManager or the supplicant does), so
  there an empty one is an open network.
- **Rotation**, with a line under it: a new rotation restarts the frame, and
  on an LCD any rotation but 0° adds a
  noticeable delay to every frame of an animated scene. A turned panel cannot
  be drawn on directly, so each frame is copied to its place (30 ms at
  480x480 on an ESP32, `packImageRgb565`); on e-paper the frame is packed
  anyway.
- **Scale**: Automatic (with what that is on this panel), then the steps of
  `RENDER_SCALE_STEPS` from 0.25x that leave a layout of at least 320 px on
  the panel's shorter edge (up to 1.5x at 480 px), and a scale set elsewhere
  as it is. Below 1 everything is drawn smaller. The scale is the frame's: a
  scene with its own (`settings.renderScale`, a `renderScale` field) keeps
  it. The settings panel and the scene switcher follow it too (below).
- **Tap and click sounds**: Silent or Normal (`ClickSounds` in the scene, a
  list so another mode is one entry and its name on the host), only on a frame
  whose host hands `clickSounds` over: an ESP32 with a buzzer, a codec's
  speaker or a status LED that follows the notes (`fos_buzzer_sounds`). Silent
  mutes a press's feedback (the touch and key clicks, a double press, a
  held key, a refused press, the loading chirp: one gate, `clicks_heard` in
  `fos_buzzer.c`); the voice chat's cues and the restart notice stay. Live,
  no restart; NVS `click_sounds`, default normal; the console's `set
  click_sounds silent|normal`. A plane's `touch_beep` (e-paper touch clicks)
  still works as it did, under it.
- **Stay awake after a press or tap** (an ESP32 that deep-sleeps: `deep_sleep`
  or `deep_sleep_on_battery`): how long a press or a tap keeps it up before it
  sleeps again, the web app's Power choices (Sleep as soon as it can, 1, 5, 10,
  30 minutes; `AwakeAfterInput` in the scene) and the frame's own value when
  it is none of them. Live, no restart; NVS `awake_input`, default 300 s; the
  console's `set awake_input <seconds>`.
- **Date and time** (an ESP32): the frame's clock in its own time zone, as
  YYYY-MM-DD HH:MM. Saved to the system clock and the board's battery clock
  where it has one. A frame that reaches the internet goes back to network time
  at its next sync, which the page says. One field and no `strftime`, which
  alone brings 12 KB of libc into the image.
- **Update** (an ESP32 with a control plane): the page asks the plane whether a
  release exists when it opens on Wi-Fi, at most hourly, and on **Check for
  updates** (`fos_ota_check_start`: the same manifest and signature checks as
  an install, nothing downloaded). **Install update** asks for a second tap and
  takes the same path as the plane's own update (`fos_ota_request_for_control_plane`).
  A frame with no plane shows neither.
- **Scenes** and **Update scenes** (a frame with a control plane): how many
  store scenes on the frame have a newer version, and a button that updates
  every one the frame may take in one push. Both are the scene store's
  (`docs/scene-store.md` "What has updates"): the page reads the store host's
  facts (`sceneStoreRead`, its `updates` and `busy`) and asks it for
  `updateAll` (`sceneStoreAction`), so no host has a hook of its own for it,
  and the words stay on the page. It asks for a second tap, as Install update
  does. One only the owner may take is counted and left to the owner. A
  frame with no plane, or whose plane does not list updates, shows neither.

Save is lit only while there is something to save, on either page, and goes
quiet once it is pressed: that is how the page says it took it. On the frame
page it hands the host what was edited, and the host applies what differs
from what it has; the page stays up, and a join, a drop or a scan result draws
it again (the ESP32 while `fos_scenes_settings_shown`, a Linux frame between
`open` and `close`). A rotation restarts the frame on an ESP32 (and the
runtime on a Pi): after that Save the page's card says "Restarting to turn the
screen" (`restarting` in its state), and the ESP32 waits for that redraw to
finish before it restarts, up to 30 s, so the frame never goes blank without a
word (it looked like a crash on a reTerminal Sticky, 2026-11-22). A new scale is
drawn at once, this page included (the ESP32 hands it to the runtime every
pass; a Linux frame sets it in the live config instead of reloading, which
would rebuild every scene, this page among them).

**At the frame's scale.** The settings panel and the scene switcher are laid
out at the frame's render scale as a scene is, sized from the panel
(sceneSwitcher's `uiScale` / `uiRoom`): at 1.5 everything is half as large
again with less room, and the pointer is divided back. They stop at 0.75 and
at a layout of 320 px, whatever the scale, so the page that sets it can always
set it back.

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

### Connecting the frame

A frame that no control plane holds (no cloud link of any kind, no backend
with its key, no claim token queued) and that has a panel to show a code on
says **Managed by: Nobody** on its card, and its buttons end with **Link
to cloud** and **Link to backend**. The host decides what is offered (`actions`:
`linkCloud`, `adopt`); the words are the page's. Either button then shows the
same page:

- the plane's name, its **code** (large, in the panel's accent where it shows
  colors: sky on an LCD, red on a color e-paper), where it is entered, a line
  that says what to do, and **Cancel**;
- a **QR code** of what the person has to share, black on white as a camera
  reads it best, beside the words, and left out (the words say "open …"
  instead of "scan …") where the panel leaves no room for one that scans
  (under 96 px);
- while the cloud has not answered yet, or has and the frame is enrolling,
  "Waiting for cloud.frameos.net…" (the server it asked) and Cancel;
- for the cloud, the server under its name and a **Cloud address** field
  under the page, saved with **Save**: where Link to cloud goes from then on
  (an ESP32's `cloud_url`, a Pi's link state `provider_url`; typed without a
  scheme it is `https://`, empty is FrameOS Cloud's own, plain `http://` only
  to a local host). A link under way or stopped starts over against it; a
  link made is never moved;
- a cloud link that stopped stays up saying why, with **Try again** and
  Cancel: no FrameOS Cloud answered at that address (`reach`, with the HTTP
  status or "no answer"), the address is refused (`address`), the cloud
  would not take the code (`refused`), nobody entered it in time (`lapsed`),
  or the approved frame could not enroll (`enroll`). A Pi notes `reach` on a
  link it keeps retrying (a provider away, Wi-Fi not up yet) as well.

The host hands the page one fact for it, `link`: `{to: "cloud" | "backend",
code, where, qr}`, and for the cloud `server` and, once stopped, `failed`
(the word above) and `detail`. Starting either ends the other; **Cancel**
(`cancelLink`) ends either, never a link made and never a local network
access code, and so does **Back**, which goes back to the frame page.

**A code lives only while its page is up, and never long.** Leaving the
frame page any way (Back, the scene's settings, another scene, a window beside
it: the host's `close`) ends a code still waiting to be entered, and a cloud
link that stopped; a cloud link already approved and enrolling finishes. A
backend's code is good for 300 s and five tries, out of a wrong-code budget
that outlives restarts (`fos_lan_access.h`, `local_access.nim`). A cloud
link shows codes for 15 minutes from the press at most (`PANEL_LINK_SECONDS`
on a Pi, whose device flow starts a new code when one lapses; one window
held to it on an ESP32), then stops as `lapsed`. Nothing of a page's link
outlives the process: an ESP32 keeps it in RAM, and a Pi drops a link the page
asked for when it starts (`dropPanelLinkAtStart`), so a crash or a reboot
never shows a code again with nobody at the frame. (The setup portal's link,
which has no page, keeps its marker and its start budget.)

- **The cloud** (`linkCloud`; not offered to a Pi whose frame.json names a
  backend, which the cloud refuses to enroll): the device flow of
  `docs/cloud-frames.md` "B. Link code on the device", run off the render
  task (a Pi queues `state/cloud_link_code_pending.json` for the hub thread,
  `device_flow.nim`; an ESP32's cloud task, `fos_cloud.c`, which a frame that
  was never on the cloud starts at its first Link to cloud). `where` is the
  page the code is typed in without its scheme, `qr` is
  `verification_uri_complete`, the same page with the code in it
  (`/device?user_code=…`, which the cloud's device page fills in). Approved,
  the frame enrolls with the flow's token and is cloud-managed. A Pi also
  draws its code and a QR over any other scene, as it did before.
- **A backend** (`adopt`): six digits, the local network access ceremony with
  the scope `adopt` (`local_access.nim`, `fos_lan_access.c`: five tries, five
  minutes, the same wrong-code budget). `where` is the address to type
  (`ip:8787` on a Pi, the IP alone on an ESP32's port 80) and `qr` is that
  address and the code, `192.168.1.20:8787 123456`: the frame does not know
  its backend's address, so its QR code cannot open it; a phone shows the
  text, and pasted into the **Adopt frame** form's address it fills the
  address, the port and the code (`adoptPaste`, `adoptFrame.ts`). In the
  form the code stands in for the admin login: the backend reads
  `GET /api/adopt` on the frame (8787, then 80) and sends the code to
  `POST /api/adopt`:
  - a Pi answers with its admin login (minting one, `admin` and a random
    password saved to frame.json, when it has none), and the backend goes on
    as an adoption by password does: reads `GET /api/frames/1`, imports the
    scenes and writes its address and key back (`adopt_standalone_frame`,
    `backend/app/api/frame_sync.py`);
  - an ESP32 is sent `{code, backend, apiKey, frameId}` for a row the backend
    made from what `GET /api/adopt` said (platform, panel, preset, size),
    writes them to NVS and restarts, and from then on is a backend frame like
    a USB-provisioned one. It keeps its board settings and its scenes: the
    backend reads them over the board's HTTP API with the key it was just
    given (`GET /api/frames/<id>/scenes`, then each scene) as soon as it
    answers again, into the row and the deploy baseline
    (`backend/app/utils/embedded_scene_import.py`). Until they are read the
    row says so (`embedded.sceneImport`) and the board is sent no scenes: its
    scene pull answers 503 and the board keeps what it holds, and its next
    check-in reads them.

  `GET /api/adopt` says nothing but `{"adopting": false}` while no code shows;
  `POST /api/adopt` answers the ceremony's tokens (`code_required` 400,
  `invalid_code` / `too_many_attempts` 403, `code_expired` 410, `rate_limited`
  429) and `managed` 409 on a cloud-managed frame, the token alone on an
  ESP32 (the backend has the words). FrameOS Cloud adopts nothing: the
  cloud's half is the link code.

**Both codes are presence codes.** Whoever enters the cloud's code first
links the frame to their account, and whoever sends the backend's adopts it,
so reading either off the panel is the proof of being at the frame, as with
the local network access code (`docs/lan-access.md`). The page is the only
place either is drawn (a Pi's runner draws the cloud's over other scenes, and
neither runner nor firmware draws the adoption code as an overlay), and while
one is under way **no picture is kept**: a Pi does not store the render
(`setLastImage`; `GET /image` and the scene snapshots keep the one from
before), an ESP32 keeps its preview snapshot empty (`store_snapshot` in
`fos_client.c`, `fos_frame_settings_code_pending`). An app reading the facts
through `frameos.frame('read')` gets them without `link`. A frame with no
panel (a Pi whose device is only a picture) is offered neither: its picture is
all it shows, and that is exactly what is not kept.

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
- **Tap and click sounds: the plane adopts them** like the rotation: the
  `settings:frame` line carries `"clickSounds": "silent"` when it changed,
  and an ESP32 sends a `state` with `hardware.clickSounds` (and
  `hardware.sounds`, whether the board makes any sound at all) for the cloud's
  mirror. The planes set it the other way as `clickSounds` (a backend's
  settings pull) and `click_sounds` (the cloud's `set_settings`), `silent` or
  `normal`; a name the firmware does not know is normal.
- **Stay awake after a press or tap: the plane adopts it** the same way: the
  `settings:frame` line carries `"awakeAfterInputSeconds": 60`, and the
  hardware report `hardware.awakeAfterInputSeconds`. A backend keeps it in the
  row's `device_config` (`awakeAfterInputSeconds`, which its settings pull
  sends back), the cloud as `awake_after_input_seconds`; 300 is the default
  neither writes.
- **Flashing an ESP32 again** erases its network, and the browser flasher sends
  the plane's stored one (the backend's Network settings).

**Flash** on the ESP32-S3: the PR that made the page says what it cost. The
host writes its facts as text, not with cJSON, and the page's words live once,
in the scene: keep it that lean.

### A boot that does not wait for the network

A frame with a touch screen is set up on that screen: it never waits for its
network before it shows a scene, and never puts up a setup hotspot in its
place. The page above is where it joins.

- **ESP32** (`fos_wake_wifi_plan` in `main/fos_wake.c`, host-tested in
  `test_fos_wake.c`; `main.c` and `fos_client.c` carry it out): a board whose
  touch panel answered at boot (the SenseCAP Indicator, the Sunton, the round
  AMOLED, the reTerminal Sticky and E1003) starts its scenes at once and joins
  the stored network behind them. The scene renders again when the join
  lands, but only if it drew before it: a join that beats the first render
  costs e-paper no second refresh. Its first render does not wait for a cloud
  session's queued commands either (up to 20 s): what they bring renders
  after. A sleeping e-paper board's timer wake, which nobody tapped, waits for
  the join before its one render, at most 45 s after boot, and a touch, a key
  or a console event ends that wait (the log's `wifi:wait` says how it ended:
  `joined`, `input`, `timeout`). A join that does not come opens no hotspot:
  the board draws without it and sleeps again, where it used to stay up with
  its hotspot until the network came back. With no network saved and no scene
  to show, the first picture is this page, not a status screen that says to
  swipe for it.
- **Linux** (`frameos/boot_network.nim`, `test_boot_network.nim`): a
  HyperPixel's scene starts at once. The network check (`networkCheck`), the
  supplicant's join and the boot hotspot's decision run on a thread of their
  own (`startNetworkCheckBehind` in `portal.nim`), the scene renders again when
  the check answers, and while this page is offered a failed check raises no
  boot hotspot (`wifiHotspot: bootOnly`). With the page turned off, the hotspot
  is still the way to set the network at the frame, and comes up behind the
  scene.

**What still waits:** every frame without a touch screen (e-paper, an HDMI
screen, which may have no input at all, an ESP32 with no touch panel: the 45 s
join and the hotspot when it fails); an ESP32 asked to update at boot (console
`ota`, the backend's action), which joins first and then runs the updater; the
timer wake above; and a HyperPixel whose frame says `networkCheckOnTouch`
("Wait on the touch screen too" in a backend's Network settings), which waits
for the check and raises its boot hotspot like any other frame. An ESP32 has
no network check setting: `networkCheck*` are a Linux frame's.

## Saving

**Save** is `setCurrentScene {sceneId: from, state: values}`, from the
origin `scene`; in a scene's own settings window on a desktop it is
`setSceneState {state: values}` aimed at that scene instead, and the window
stays (above). Every host already applies a switch's `state` to the scene's
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
| `secret: true` | an `<input type="password">`, an eye on its line showing what is typed (`HShow`) |
| `string`, `color` (its hex), `date`, `font`, `path`, any other | an `<input>` |
| `node`, `scene`, `image` | left out: what they hold is not text |

A tap on a field brings up the keyboard on the screen under the form,
which scrolls to keep the field in sight (`docs/jsx-ui.md`). A fast panel
gets a dark form that shows presses; e-paper black on white, no press shown
(a key is a refresh there) and a scroll shown when the finger lifts.

A scene with no field to show says so: "This scene has no settings."

**A round panel** (`frameos/panel_shape.nim` `panelIsRound`: the HyperPixel
2.1" Round, the Waveshare ESP32-S3-Touch-AMOLED-1.75) keeps the form inside
its circle, `RoundInset` (12 px) in from the rim, as the switcher does: the
scene's name in the top arc, Cancel and Save centred under it with the gear
between them where the host offers the frame page, and the list as wide as the circle is where the list
ends (as far below the centre as it starts above it). With the keyboard up
it sits on the circle's lower half (`docs/jsx-ui.md`), the name makes way
for the buttons, and the list ends above the keys. `test_scene.nim` checks
every hit region and every pixel drawn, the keyboard down and up. The frame
page there is laid out the same way: "Frame settings" in the top arc, Back
and Save under it, its rows in the list as wide as the circle (which ends
above the keyboard while it is up): a round touch board joins Wi-Fi on it
like any other touch board. Either list's scroll bar is an arc along the rim
(docs/jsx-ui.md "Scrolling and clipping").

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
