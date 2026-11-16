# Scene icons and categories

A scene can carry a small icon of its own, `settings.icon`, that every list
which shows the scene without its picture can draw in place of a placeholder:
the frame's scene switcher, a desktop layout's windows and menus
(`app.frame.scenes`), the editor's scene lists. It is optional: a scene
without one looks as it always has everywhere.

## The format

`settings.icon` is ONE SVG path `d` string:

- drawn in a `0 0 24 24` box, as `<svg viewBox="0 0 24 24"><path d="..."
  fill="currentColor" /></svg>`;
- filled with the nonzero rule (SVG's default), never stroked, in the color of
  the text where it is shown: black on e-paper (white on a highlighted tile),
  the theme's text color on an LCD or in the SPA. It has no colors of its own;
- at most **1024 characters** once the spaces, tabs and line breaks at its
  ends are trimmed. It travels to every frame, an ESP32's scene index
  included, which the firmware parses whole;
- starting with a moveto (`M` or `m`), holding only path commands
  (`MLHVCSQTAZ`, either case), numbers (`.5`, `-1.5e2`) and the separators
  space, tab, line feed, carriage return and comma;
- path data SVG can draw: each command followed by a whole number of its
  arguments, arc flags `0` or `1`.

A solid icon from a 24 px icon set fits as it is: Material Design Icons are
one path each, `M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z` is a house. Outline icon
sets (Lucide, Feather, Heroicons outline) draw with strokes and do not.

**Anything else is no icon.** A value that is too long, holds anything else
(a whole `<svg>`, a URL, a color) or does not parse is ignored, never an
error: the runtime lists no `icon` for the scene and draws the placeholder,
the editor says what is wrong under the text box, and the cloud's scene lint
warns. The rule is written twice, `frameos/src/frameos/scene_icon.nim`
(`sceneIconPath`) and `frontend/src/utils/sceneIcon.ts` (`sceneIconPath`,
`sceneIconProblem`), and `docs/scene-icon-fixtures.json` pins the two together
(`test_scene_icon.nim`, cloud shared-spa `scene-icon.test.ts`).

## Category

`settings.category` is one of the store's category slugs, the ones its
shelves use: `photos`, `art`, `calendar`, `weather`, `ai`, `dashboards`, `fun`,
`realtime`, `utilities`, `demos`, and `desktops` / `layouts` for a layout. A
desktop layout groups its scene lists by it (`app.frame.scenes[i].category`).
The value is read trimmed and in lower case; any other value stays in the
scene, counts as none (no `category` in `app.frame.scenes`), and the cloud's
scene lint warns. The rule is `frameos/src/frameos/scene_category.nim` and
`sceneCategorySlug` in `storeCategories.ts`, pinned by
`docs/scene-category-fixtures.json`.

**One list, `docs/scene-categories.json`**: each category's `id` (the slug),
`title` (the store shelf's heading), `name` (a short label for a folder or a
group: "Photos", "Calendars", "Real time"), and the store's `description` and
classifier `hint`, in shelf order. `frameos/tools/generate_scene_categories.py`
writes every copy: the runtime's table (`scene_categories_gen.nim`), the SPA's
(the generated region of `frontend/src/utils/storeCategories.ts`, which the
editor's Category select and the store pages read) and the cloud store's (the
generated region of `cloud/apps/auth-web/src/lib/categories.ts`); the backend
suite runs its `--check`. A new category goes in the contract, never in a copy.

**Names for apps**: every runtime hands the list out as `app.frame.categories`,
`[{id, name}]` in that order, all of them (a layout shows the ones its scenes
use). An app shows a category by that name and keeps no table of its own;
`app.frame.scenes[i].category` stays the slug.

There is no category for clocks: the store files its clocks under
`utilities` ("Tools & utilities"), and so do the repo's samples.

The repo's samples and gallery scenes each name theirs (the playground's
Start menu groups by it). The store's own category (`store_scenes.category`)
is not written into a scene installed from it: on the cloud a scene goes to a
frame from its version's zip, stamped at the push (`withStoreSceneOrigin`), and
a stamp there would change every installed scene's payload and its per-scene
checksum (the workspace would mark every cloud frame's scenes as changed), and
would change again whenever the store's category does. A scene's category is
its own, set in the editor.

## On the frame

Every host reads `settings.icon` and `settings.category` with the scene and
lists them, checked, beside the scene's name and window size in
`app.frame.scenes` (`{id, name, windowSize?, icon?, category?}`, one builder:
`listingItem` in `system/sceneSwitcher/scene.nim`):

| Host | Where the icon comes from |
|---|---|
| Linux (a Pi) | the deployed or pushed scene (`interpreter.nim` `readSettings`, `scenes.nim` `getSceneIcon`) |
| ESP32 | its scene index: `fos_scene_store.c` `make_entry` keeps `icon` (1024 characters or fewer) and `category` (16 or fewer) for a scene that is not a layout, and `embedded_runtime.nim` checks both when it reads the catalog, so the scene stays on flash |
| browser / wasm (the preview, the plane rendering a board, a virtual frame) | the loaded scenes |

The scene switcher (`docs/scene-switcher.md`) draws it on the tile: above the
name on a name card (an ESP32, e-paper, the preview), and in the picture's place
on a Pi until the scene has a snapshot. Layouts get it in `app.frame.scenes`;
a desktop can draw it on a window's title bar or in its scene menu.

A server-rendered board is sent one empty scene and no settings: the plane
renders its scenes with the wasm runtime, which reads the icon itself.

## In the editor

The scene's settings (`SceneSettings.tsx`, the one scene workspace, so a
frame's scene, a saved scene and the store's scene page alike) have an Icon
area: the icon at 24 px and larger, the path as text, **Upload SVG** and
**Clear**; and a **Category** select beside it (None, then the store's
categories by their titles). Upload reads an `.svg` file and makes one path of it
(`utils/svgToSceneIcon.ts`, pure, tested in `svg-to-scene-icon.test.ts`): it
merges the filled shapes (`path`, `rect`, `circle`, `ellipse`, `polygon`),
applies transforms and maps the SVG's `viewBox` into the 24 box, turns
`fill-rule="evenodd"` shapes into nonzero ones, and refuses what cannot be one
filled path (strokes, text, images, `<use>`) with a plain message.

## The planes

Both planes keep `settings` as a scene carries it: saves, pushes (the ESP32's
patch path included), templates and store publishes and installs carry the
icon with the scene, and neither has an allow-list of settings keys.

The store does not show icons yet. Its listings (`/api/store/device/scenes`,
the browse and repository listings the SPA's tiles read) are built from
`store_scenes` columns, and the scenes themselves live in each version's zip.
Showing an icon there takes: reading `mainScene(scenes).settings.icon` when a
version is published (`validateSceneZip` in `store.ts`, which already reads
`isLayout` there), keeping it in a `store_scenes` column (a migration, and a
backfill that unzips each latest version), and adding it to the device
listing, the browse and repository listings, `TemplateType` and `SceneCard`.
