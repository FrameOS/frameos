# Forms on the frame: fields, the keyboard, scrolling, scene settings

*Written 2026-10-29. Read cold: each section says what exists before what is
missing. When an item ships, delete it. The contract for what exists is
`docs/jsx-ui.md` ("Fields and the keyboard", "Scrolling and clipping").*

The goal: a person at a touch frame (the SenseCAP Indicator first) changes a
scene's settings on the frame itself. Swipe down from the top edge, and the
scene's fields are a form: text to type on a keyboard on the screen,
switches, choices, a list as long as it needs to be. Save, and the scene
shows them. That works now (`docs/scene-settings.md`); what is left follows.

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
- Cost on the ESP32-S3 image: +18.8 KB (2026-10-29, A/B against main at the
  same paths): the layout 5.8 KB, pixie's viewport 2.6 KB, the events 2.4 KB,
  the keyboard 2.4 KB and its strings 1.5 KB, the rest link drift (2.4 KB of
  it the interpreter's unchanged `runNode`).
- **The scene settings panel** (`docs/scene-settings.md`), built of all that:
  `sceneSettings`, bound to a swipe down from the top in every touch preset.

## Next: the frame's own settings

The scene settings (`docs/scene-settings.md`: a swipe down from the top on a
touch frame) change a scene's public fields. Its header has room for a link
to the frame's own settings once the frame can show those: Wi-Fi, the
display, the event map, its name. The same panel, built of the same fields,
saving through the frame's settings route instead of a `setCurrentScene`.

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
