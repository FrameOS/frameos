# Built-in apps

The apps in this directory are the catalog compiled into every FrameOS
binary: `render/*` draw onto the canvas, `data/*` produce values and images,
`logic/*` branch and write state. A scene refers to them by keyword
(`render/text`, `data/clock`, …) and the interpreter dispatches into the
binary — nothing here is copied into a scene, and nothing here is edited by a
user.

Apps a scene carries itself are **JavaScript** (`app.ts` next to
`config.json` in the scene's `apps` map or on a node's `data.sources`); see
`docs/js-apps-and-code-nodes.md`. A scene that still bundles Nim sources is a
legacy *compiled* scene that needs a source build on every deploy;
`docs/nim-to-js-conversion.md` converts it. Adding a new built-in here is a
FrameOS release, not a scene change.
