# Forms on the frame: fields, the keyboard, scrolling, scene settings

*Written 2026-10-29. Read cold: each section says what exists before what is
missing. When an item ships, delete it. The contract for what exists is
`docs/jsx-ui.md` ("Fields and the keyboard", "Scrolling and clipping").*

The goal: a person at a touch frame (the SenseCAP Indicator first) changes a
scene's settings on the frame itself. Swipe down from the top edge, and the
scene's fields are a form: text to type on a keyboard on the screen,
switches, choices, a list as long as it needs to be. Save, and the scene
shows them.

## What exists

- **Fields in JSX UIs**: `<input>` and `<textarea>`, controlled as in React
  (`value`, `onChange` / `onInput`, `onKeyDown`, `placeholder`,
  `type="password"` / `"number"`, `focus:` and `placeholder:` classes). A tap
  gives a field the keyboard and puts the caret where it landed
  (`ui/events.nim`, `ui/layout.nim`).
- **The keyboard on the screen** when the frame has none of its own: a US
  layout (`ui/keyboard.nim`), laid out under the UI by the same layout, the
  UI above it scrolled to show the field. A typed key on a real keyboard
  (a Pi's, the computer's over the preview) puts it away for good.
- **Scrolling** (`overflow-y-auto` and friends): a finger drags a box, a
  wheel scrolls it; what is inside answers the pointer where it shows.
  **Clipping** (`overflow-hidden`) at the padding box. Both through pixie's
  nested `<svg>` viewport (FrameOS/pixie, `clip` on every element inside).
- Cost on the ESP32-S3 image: +21.3 KB (2026-10-29, A/B against main at the
  same paths): the layout 6.1 KB, pixie's viewport 3.4 KB, the events 2.9 KB,
  the keyboard 2.4 KB, the rest link drift.

## Next: the scene settings panel

A scene built into every runtime, `system/sceneSettings`, as the scene
switcher is (`docs/scene-switcher.md` is the pattern: contract, dispatcher,
hosts, presets):

1. **The event** `sceneSettings` (a scene command; contract `scenes.settings`
   = `system/sceneSettings`): from any scene the dispatcher hands the panel
   `state.from`, the scene's public fields (name, label, type, options,
   placeholder, secret) and their values *now*, read off the scene before
   the switch (an ESP32 holds one scene: the opener is gone once the panel
   shows). While it shows, the same event goes back without saving.
2. **The panel**, drawn from a tree built in Nim with the JSX layout (no
   QuickJS): a header with Cancel, the scene's name and Save; under it a list
   that scrolls, one row per field: an `<input>` (text, numbers, a password
   for a secret), a `<textarea>` (text, JSON), a switch (boolean), choices
   (select), a color as its hex. Types it cannot edit here
   (node, scene, image) are left out.
3. **Save** is `setCurrentScene {sceneId: from, state: values}`: every host
   applies a switch's state to the public fields already (ESP32 included,
   after the scene loads again), and persisted fields save themselves.
   Cancel, the swipe again and the idle timeout go back without it.
4. **The binding**: a swipe down from the top edge (`edgeSwipe {edge: top}`)
   in every touch preset (`TOUCH_EDGE_SWIPES`, `EMBEDDED_TOUCH_EDGE_SWIPES`,
   the SPA's, the HyperPixels' `device_event_map.nim`), and "Scene
   settings" as an action under Button actions on both planes (an emit the
   cloud contract allows).
5. **A link to the frame's own settings** from the panel's header, once the
   frame can show those (Wi-Fi, the display, the event map).

## After that

- **Keyboard layouts** beyond US: the layout tables Linux already has
  (`keyboard_gen.nim`, `input_settings.keyboardLayout`) are not compiled on
  an ESP32; a second layout is a page string or four in `ui/keyboard.nim`.
- **Text selection**: select, copy, paste, a word at a double tap; the
  caret dragged with a finger.
- **A scroll that repaints less**: a scroll repaints its whole viewport on an
  LCD; moving the pixels that stay and drawing the strip that came into
  sight would make a drag on the ESP32 as cheap as a tap.
- **Momentum** when a list is flung, on panels fast enough to show it.
- **The physical keyboard by device**: Linux's evdev knows when a keyboard
  is plugged in; today the first key typed is what says so.
- **Fields on frames without glass**: a focus ring walked by the buttons
  (`docs/ui-todo.md` item 1) and the keyboard's keys picked with them.
- **`<select>` and `<input type="checkbox">`** as elements, if apps keep
  building them out of boxes; the panel builds its own.
- **Uncontrolled fields** (no `value`): kept by the runtime between renders,
  as a browser keeps them.
