# The code editor

*Written 2026-11-16.*

A scene's code, read and changed on the frame itself, and an AI that writes
scenes from a request typed there. It is a scene, the **Code editor** sample
(`repo/scenes/samples/Code editor`, scene id `code-editor`), one JSX app
(`codeEditor`) on one bridge call, `frameos.code`. It runs wherever a JS app
runs: a Raspberry Pi, an ESP32, the browser preview (which reads and asks
nothing of a plane: `previewOnly`).

| Piece | Where |
|---|---|
| The app (its words, its looks, where it is) | the sample's `scenes.json` (`apps.codeEditor`, an `app.tsx`) |
| What a JS app may ask: `frameos.code(op, arg)` | `frameos/src/frameos/scene_code_hooks.nim`, bridged in `js_runtime/app_runtime.nim` (`jsCode`), declared in `frontend/src/utils/appTypeDeclarations.ts` |
| The host on a Pi | `frameos/src/frameos/scene_code_linux.nim` (a worker thread) |
| The host on an ESP32 | `embedded/esp32/main/fos_code.c`, through `frameos/src/embedded/embedded_runtime.nim` |
| The host in the browser preview (reads only) | `frameos/src/frameos/scene_code_preview.nim`, through `frameos/src/wasm/wasm_main.nim` |
| What a frame asks its plane | `POST /api/frames/{id}/panel/code`: backend `app/api/panel_code.py` (also `/api/panel/code`), cloud `src/lib/panel-code.ts` |
| The AI | the voice chat's scene builder, typed instead of spoken: backend `app/utils/voice_scene_builder.py`, cloud `src/lib/ai/voice-scene-builder.ts` (`asked: "typed"`) |
| The way in from a scene | the scene settings' **Code** button (`system/sceneSettings`, `HCode`), shown while the frame holds the editor |

## Using it

- **The look** is a code editor's workbench, after VS Code's Dark+: an
  activity bar (the scenes, the files, the AI), the explorer, a tab bar with
  the scene's actions (Ask AI, Save; a draft's Discard and Save & show) and
  breadcrumbs over the code, and a blue status bar (purple for an AI draft).
  No title bar: a desktop's window has its own, and the activity bar is the
  way back to the scenes (a narrow screen's tab bar starts with a ‹). The
  status bar says the lines showing and the language. Text is 13 px like
  other windows (the frame's render scale makes it bigger on a big screen,
  never the app). The code is colored by kind (keywords, strings, numbers,
  calls, comments, JSON keys) in Cascadia Mono where the frame has it in its
  fonts (a Pi's assets folder), else in the frame's own face. Long lines wrap
  at spaces, each line's number beside its first row; **Wrap** in the status
  bar turns it off (VS Code's Alt+Z), and a long line then scrolls sideways. A screen under 600 px
  wide drops the activity bar and the explorer for a select of the files;
  e-paper and a grey panel are black on white, uncolored. A refusal or a note
  is a notification over the bottom right corner; a tap puts it away.
- **The scenes.** It opens on the frame's scenes (`app.frame.scenes`) in the
  explorer, a folder per category with each scene's own icon (the desktops'
  `grouped` and `ownIcon`, the same text: Other last), beside a start page
  with **New scene with AI**.
- **A scene's files.** A scene opens as files in a tree: `scene.json` (the
  scene without its apps' sources and its code nodes' code: name, settings,
  fields, nodes, edges), a folder per app with its files (`config.json`,
  `app.tsx`, …) and a `code` folder with every code node's code as
  `<node id>.js`. A file is one text with its line numbers, scrolled by a
  finger or the wheel, and each file opens where it was left.
- **Changing a file.** Tap where the text should change and type, as in any
  editor: the caret goes there, and the keyboard comes up on a screen without
  one of its own (a real one types straight in; selecting, copying and pasting
  are the fields', `docs/jsx-ui.md`). A changed file is marked; **Save** puts
  the files back together into the scene (a `.json` file that does not parse
  says where, and nothing is saved) and asks the host to save it.
- **Asking the AI.** **Ask AI** opens a box for a request. On a scene it is a
  change to that scene (with the edits not yet saved), else a new scene. The
  answer is a **draft**: its files open like a scene's, with what the AI said
  above them; **Save** installs it (a change replaces the scene, a new scene
  goes on the list and shows), **Discard** drops it, and a further request
  changes the draft.
- **Where it is** (the scene open, the file, the draft's name) is a private
  disk field, `spot`; the files' edits, what is being typed, where each file
  is scrolled to and the draft are kept with `frameos.remember`, so they
  outlast an interpreter the frame let go (scrolling writes nothing to flash).

## The file open

A file is ONE box that scrolls (`overflow-y-auto`), as tall as all its lines,
and in it only the lines around where it is scrolled to: the screen showing
and a screen above and below, a hundred lines or so whatever the file's
length, as ONE `<textarea>` beside their numbers, with spacers standing in
for the lines above and below. The field is the code editor's
`contenteditable`: colored by the `<span>`s inside it (`tokensOf`, the tokens
of each line read once and kept until an edit above them), unwrapped
(`whitespace-nowrap overflow-x-auto`), and typed into where it is tapped.
`onScroll` tells the app where the box went and the window slides
(`slide`); `scrollTop` puts a file back where it was left. All of it is the
JSX layer's, for any app (`docs/jsx-ui.md` "Fields and the keyboard",
"Scrolling and clipping"); the editor adds nothing to the runtime.

- **A window changes at one end at a time**: it grows at the end the screen
  is heading to, and shrinks at the far end once it is six screens long; one
  the screen jumped clear of (e-paper, which scrolls once the finger lifts)
  is set anew. A field whose value changes at one end keeps its caret on its
  text, so the keyboard stays where it was typing while the window slides.
- **Wrapped lines** take as many rows as the field sets them in. The rows of
  the lines in the window are measured with `frameos.measureText` (the field's
  own typesetting, its classes and width), so each number sits by its line's
  first row; the lines never near the screen are guessed from their length.
  Where a line starts is the rows above it, summed (`rowSums`). When guessed
  lines above the screen are measured and turn out taller or shorter, the
  box is scrolled by the difference (`scrollTop`), so what shows does not
  move; a drag scrolls from where the box is, so it keeps that. A line typed
  into is measured again.
- **What was typed** is the file's lines in memory (`current`), folded back
  into the file's text when the window moves, the file changes, or the scene
  is saved or sent to the AI; until then it is remembered as the window's
  text (`typing`), so an interpreter the frame let go loses nothing.
- **What it costs**: a drag is the app's `get()` once a move (the window, the
  spans kept from the last render while it did not change) and a layout of
  the window's lines. On a desktop build with optimisation (2026-11-18): get
  0.8 ms, the JSX walk 0.3 ms, the layout 1.6 ms (1.2 of it the text set in
  type when the window changed) for a 2,000-line file; the raster of the
  scrolled box is the rest, as in any scroller.
- **Opened from the scene settings** (`Code`), it opens on that scene: the
  button switches to the editor with its public field `open` set to the
  scene's id (`setCurrentScene {sceneId: "code-editor", state: {open}}`), and
  the app opens it and clears the field (`frameos.setState('open', '')`).

## `frameos.code(op, arg)`

The one native the app needs, in `js_runtime/app_runtime.nim` (`jsCode`). JSON
in and out; it throws what the host refuses (`frameos.code: <reason>`).

| op | arg | answer |
|---|---|---|
| `read` | — | the host's facts: `{busy, error, done, draft: {id, name, summary} \| null, ask, save, previewOnly?}`, or null where there is no host or the frame's settings on its screen are off. `busy` is the action running (`ask`, `save`) or `""`; `error` the last action's refusal code; `done` the last action that worked; `ask` true where an AI can be asked (a plane), `save` true where a scene can be saved |
| `source` | a scene id | that scene as the frame holds it (its JSON object, as in scenes.json), or null. Synchronous: read from what the host holds (a Pi's scenes on disk, an ESP32's scene file, the preview's loaded payload) |
| `draft` | — | the AI's last scene (an object), or null |
| `ask` | `{prompt, scene?}` | starts it and answers true: the plane's AI builds a scene (`scene` the one to change). The host renders the asking scene when it is done |
| `save` | `{scene, show?}` | starts it and answers true: the scene goes on the frame (replacing a scene of its id), shown unless `show: false` |
| `clear` | — | forgets the draft and the last error |

One action runs at a time; one asked while another runs is dropped (`busy`
says what runs), as `frameos.storeAction`'s are; an operation the host does
not know is ignored. The prelude puts the action into `ask`'s and `save`'s
arguments (`{action, …}`), so they are the request body as the plane takes it.
The host is ONE hook, `sceneCode(asker, op, arg)` (`scene_code_hooks.nim`),
which answers every operation itself, the page being off the screen included:
each hook was a proc and a bridge in the ESP32's flash. An app on a runtime
without a host gets null.

## Who may use it

Only an app whose config.json `"permissions"` has `"code"`: the owner's yes is
installing the scene, whose tags say "reads and changes this frame's scenes"
(red, as `frame` is: `utils/sceneAccess.ts`, `docs/scene-access-fixtures.json`).
Saving a scene adds `"code"` to an app whose code calls `frameos.code(`, as it
does `"frame"`. An app without it is refused with "this app's permissions do
not include code". And only while the frame offers its page: when the control
plane has turned settings on the screen off (`frame_settings_on_screen`,
unless the device unlocked them), `read` is null and everything else is
refused, because a scene's source holds what its fields were set to (an API
key in an app's config).

## The plane: `POST /api/frames/{id}/panel/code`

With the frame's own credential, as `/panel/scenes` (docs/scene-store.md
"Changes go to the plane"): the cloud's enrollment token or the backend's
`server_api_key`; a Pi posts to `/api/panel/code` on a backend. Each host
finds its plane the way its scene store's host does (the Pi's
`cloudPanel("code")` then its backend; the ESP32's `fos_store_plane`, its
backend then its cloud enrollment), so the two routes of one frame always go
to the same plane. A plane that
answers 404 with no `error` of its own is older than the route:
`plane_update_required`. A refusal is `{"ok": false, "error": <code>,
"detail"?}`; the app says it in words (`WORDS` in its `app.tsx`).

### `{"action": "ask", "prompt", "scene"?}`

The scene AI as the voice chat's sub-turn runs it (`build_scene_by_voice` /
`buildSceneByVoice`, asked `typed`): the editor and catalog tools alone, never
the MCP tools (a frame's token is not the owner's), the frame in context, and
the scene rendered in the frame's memory before it is handed back. `scene` is
the scene to change (as the frame has it, edits included), else a new one is
built. Answers `{"ok": true, "scene", "summary"}`. **Nothing is saved**: the
draft is the device's until it saves it. The prompt is at most 2,000
characters, the body 1 MiB; twenty asks an hour per frame (an ask is a paid
model turn); `ai_unavailable` without the plane's OpenAI key (the backend's
Settings → OpenAI; the cloud's own AI and the account's AI budget, as the
voice chat's). Photo share links are swapped for placeholders before the
model sees them, as in every scene AI (`docs/photos.md`).

### `{"action": "save", "scene", "show"?}`

The scene goes on the frame's list: one of its id is replaced (keeping its
`default` mark, button map, layout and `origin`), else it is added (never the
default). Then the list is sent as "Install & activate" sends it, showing the
scene unless `show: false`. Refused:

- a scene that is not an object with a string `id` (`invalid_scene`), an id of
  a built-in scene (`system/…`), a compiled scene (`scene_requires_compilation`)
  or a layout the layout rule refuses (`invalid_layout`, `scene_layout_problem`);
- **a save that widens what the scene may do** (`needs_owner`, with `needs`):
  the `permissions` and `settings` its apps' config.json ask for must be ones
  the saved scene of that id already asked for (a new scene: none of the red
  permissions — `shell`, `files`, `assets-write`, `frame`, `code` — and no
  settings keys). What a device asks must never widen a grant
  (docs/cloud-frames.md "Scenes the frame already had"); the owner installs
  such a scene from the workspace, where grants are made;
- nothing while the settings on the frame's screen are off (`panel_locked`);
- sixty changes a quarter of an hour per frame (`rate_limited`, shared with
  `/panel/scenes`).

### A frame with no plane

Saves itself (a Pi: `persistScenesPayload` and a reload, as the store's
install does; an ESP32: `fos_scenes_put`), under the same rules but the
grant check, which is the owner's own frame. It has no AI to ask: `ask` is
false in `read`.

## On an ESP32

`main/fos_code.c`: a scene's source is read off the scene store
(`fos_scenes_get_json`, under the store lock), on the render task, so opening a
scene costs a lookup by name (about half a second on the 32 MB boards). An ask
and a save run on the request task (`fos_js_io_run`), the draft is the
answer's own buffer in PSRAM (up to 1 MiB) with no JSON tree built (its id,
name and summary are the answer's own JSON values, found by
`fos_store_find_key`, host-tested in `test_fos_store_scan.c`), and the request
body is the app's arguments as they come. A save with no plane is
`fos_scenes_put`, the scene's own text as it came. What the app and the plane
already check (an empty request, a scene's id, a compiled scene; the app takes
the `default` mark off a scene new to the frame) is not checked again on the
device: the feature was 5.3 KB of the ESP32 image and is 4.3 KB without it and with one
hook (2026-11-17, against the branch's base).

## Not yet

- The desktops (Windows 98's Start, macOS's Dock, …) do not list the editor as
  they list the Terminal and the Scene store; it is a scene on the scene list.
- A draft cannot be previewed before it is saved (`docs/scene-previews.md`
  would be the way: a `preview` action pushing it beside the list).
- Search, undo and indenting with Tab in a file. A file's caret position
  (line and column) in the status bar: the app hears where the caret is only
  when the text changes.
- On an ESP32 an ask holds the request task while the AI works (up to three
  minutes): a scene's `fetch` and the scene store wait behind it. A task of
  its own would cost internal RAM for a TLS stack.
