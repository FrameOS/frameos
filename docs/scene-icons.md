# Scene icons

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

## On the frame

Every host reads `settings.icon` with the scene and lists it, checked, beside
the scene's name and window size in `app.frame.scenes` (`{id, name,
windowSize?, icon?}`, one builder: `listingItem` in
`system/sceneSwitcher/scene.nim`):

| Host | Where the icon comes from |
|---|---|
| Linux (a Pi) | the deployed or pushed scene (`interpreter.nim` `readSettings`, `scenes.nim` `getSceneIcon`) |
| ESP32 | its scene index: `fos_scene_store.c` `make_entry` keeps `icon` for a scene that is not a layout when it is 1024 characters or fewer, and `embedded_runtime.nim` checks it when it reads the catalog, so the scene stays on flash |
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
**Clear**. Upload reads an `.svg` file and makes one path of it
(`utils/svgToSceneIcon.ts`, pure, tested in `svg-to-scene-icon.test.ts`): it
merges the filled shapes (`path`, `rect`, `circle`, `ellipse`, `polygon`),
applies transforms and maps the SVG's `viewBox` into the 24 box, turns
`fill-rule="evenodd"` shapes into nonzero ones, and refuses what cannot be one
filled path (strokes, text, images, `<use>`) with a plain message.

## The planes

Both planes keep `settings` as a scene carries it: saves, pushes (the ESP32's
patch path included), templates and store publishes and installs carry the
icon with the scene, and neither has an allow-list of settings keys.

## In the store

FrameOS Cloud's store is the cloud's alone, so this part has no backend twin.
A store scene is a pack (a zip's `scenes.json`), and its listing stands for the
scene the pack starts on: **the listing's icon is the main scene's**, the one
marked `default`, else the first, as for `isLayout`. Another scene's icon does
not stand in when the main one has none.

- **Kept per version.** `validateSceneZip` (`store.ts` `listingIconOf`, through
  `sceneIconPath`) reads it from every zip, which every way a version is
  published goes through (the editor's Save and the AI, a zip upload, a linked
  backend's publish, a fork, the MCP's `scene_create` / `scene_update_content`
  / `scene_version_restore`), and `writeSceneVersion` records it on the
  version (`store_scene_versions.icon`) and on the row
  (`store_scenes.icon`, the latest version's, which the listings read).
  `syncLatestVersion` moves the row's with the latest version, so a yank or
  unyank shows the icon of the version now served. Migration 0082 added both
  columns empty: a version from before icons existed has none, and
  `pnpm --filter @frameos-cloud/auth-web scene:backfill-icons` reads the ones
  published between the icon's release and the migration from their zips.
- **Carried** in every listing of a scene: `repository.json` (the public index,
  each FrameOS version's, and the account's drive index) as `icon`, the
  store front's `/api/store/browse`, the account's `/api/account/scenes` and
  `/api/account/scenes/{id}` (each version's too), and so the MCP's
  `store_browse`, `store_scene_get`, `scenes_list` and `scene_get`. The
  listing for frames (`/api/store/device/scenes`) has `icon` only for a scene
  that has one: a frame parses every byte.
- **Shown** with the SPA's `SceneIcon` (`components/SceneIcon.tsx`): the store
  and library tiles (`StoreTiles.tsx`, which read a listing's `icon` through
  `templateSceneIcon`) beside the name and in the cover's place; on the
  cloud's own pages the cards (`SceneCard`), the My scenes table, and a
  scene's page (its heading, and the images box when there are none; in the
  workspace it follows the scenes it holds, so an edited icon shows before
  Save).
- **On the frame** the Scene store scene draws it in a card's placeholder
  until the cover is in, and beside the name on a scene's page
  (docs/scene-store.md).

## The repo's scenes

Every scene in the repo has an icon: the samples (layouts and desktops
included), the gallery scenes and the playground's Welcome. Each is the path of
one icon from [Material Design Icons](https://pictogrammers.com/library/mdi/)
by Pictogrammers, under the Apache License 2.0, copied as it is from `@mdi/js`.
A new sample takes one the same way: a plain shape that says what the scene
is, never a brand's logo. An icon of its own replaces the special icon a
desktop draws for the Scene store, Files and the terminal.
