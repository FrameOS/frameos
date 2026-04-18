JS_APP_API_REFERENCE_MARKDOWN = """
# FrameOS JavaScript App API

FrameOS JavaScript apps run in QuickJS. Use `app.js` or `app.ts` plus `config.json`.

- Keep JS apps in JavaScript or TypeScript. Do not rewrite them into Nim unless you explicitly want a Nim app.
- Prefer plain language features and small helpers. Browser DOM APIs and Node-specific APIs are not available by default.
- The JS app chat assistant uses this same reference when it proposes or edits app code.

## File layout

- `config.json`: app metadata, config fields, and output schema.
- `app.js` or `app.ts`: module that exports `init`, `get`, and/or `run`.
- Extra local files can be imported and bundled into the compiled app.

## Exports

```ts
export function init(app, context) {}
export function get(app, context) {}
export function run(app, context) {}
```

- `init(app, context)` runs once before the first `get` or `run`.
- `get(app, context)` returns the app output for data apps and value-producing calls.
- `run(app, context)` is for logic or render-side work.
- You can also export `default { init, get, run }`.

## `app`

```ts
{
  nodeId: number
  nodeName: string
  category: string
  config: Record<string, any>
  state: Record<string, any>
  frame: {
    width: number
    height: number
    rotate: number
    assetsPath: string
    timeZone: string
  }
  log(...args): void
  logError(...args): void
}
```

- `app.config` comes from the node config defined by `config.json`.
- `app.state` is a snapshot of scene state. Treat it as read-only input.
- `app.log(...)` and `app.logError(...)` write to FrameOS logs.

## `context`

```ts
{
  event: string
  hasImage: boolean
  payload: any
  loopIndex: number
  loopKey: string
  nextSleep: number
  image?: FrameOSImageRef
  imageWidth?: number
  imageHeight?: number
}
```

- `context.payload` is event-specific JSON data.
- `context.image` is an opaque reference to the incoming image, not a writable pixel buffer.
- `context.nextSleep` is the current scheduled delay in seconds.

## `frameos` helpers

- `frameos.image(spec = {})`
- `frameos.svg(svg, spec = {})`
- `frameos.node(nodeId)`
- `frameos.scene(sceneId)`
- `frameos.color(color)`
- `frameos.log(...args)`
- `frameos.error(...args)`
- `frameos.setNextSleep(seconds)`
- `frameos.assets.readText(path)`
- `frameos.assets.writeText(path, content)`
- `frameos.assets.readDataUrl(path)`
- `frameos.assets.writeDataUrl(path, dataUrl)`
- `frameos.assets.list(path = ".")`
- `frameos.assets.stat(path = ".")`
- `frameos.assets.exists(path = ".")`
- `frameos.assets.mkdir(path)`
- `frameos.assets.rename(fromPath, toPath)`
- `frameos.assets.delete(path)`

### `frameos.image(spec)`

Use this to create or decode an image value.

`spec` can include:

- `width`
- `height`
- `color`
- `opacity` from `0` to `1`
- `svg`
- `dataUrl`
- `base64`

If `width` and `height` are omitted, FrameOS falls back to the incoming image size or the current render size.

### `frameos.svg(svg, spec)`

Wrap raw SVG text as an image result. Pass `width` and `height` in `spec` when you need explicit sizing.

### `frameos.node(nodeId)`, `frameos.scene(sceneId)`, `frameos.color(color)`

Use these when your app needs to return typed FrameOS values for downstream nodes or config fields.

### `frameos.setNextSleep(seconds)`

Schedules the next wake-up or render delay. This is most useful in logic apps.

### `frameos.assets.*`

Use these helpers to work with files under `app.frame.assetsPath`.

- Paths are always scoped to the configured assets root.
- Use relative paths like `images/photo.png` or `notes/today.txt`.
- Absolute paths and `..` traversal are rejected.
- `readText` and `writeText` are for plain text files.
- `readDataUrl` and `writeDataUrl` are for binary-safe reads and writes via `data:` URLs.
- `list(path)` returns direct children for a directory.
- `stat(path)` returns metadata with `path`, `name`, `isDir`, `size`, and `mtime`.
- `mkdir(path)` creates a directory.
- `rename(fromPath, toPath)` moves or renames a file or directory inside the assets root.
- `delete(path)` removes a file or directory.

## Returning values

- Return plain strings, numbers, booleans, arrays, or objects for matching output fields.
- Return `frameos.image(...)`, `frameos.svg(...)`, or an SVG / image data string for image outputs.
- Return `frameos.node(...)`, `frameos.scene(...)`, or `frameos.color(...)` for those specific field types.
- For render apps, returning an image from `run` draws that image onto the render context image.
- For logic apps, use `run` for side effects like logging or `frameos.setNextSleep(...)`.

## Example

```ts
export function get(app, context) {
  const label = `${app.config.prefix}: ${app.config.message}`
  const suffix = context.event ? ` (${context.event})` : ''
  return `${label}${suffix}`
}
```

```ts
export function run(app) {
  frameos.setNextSleep(app.config.duration)
  app.log(`Next sleep set to ${app.config.duration} seconds`)
}
```

```ts
export function get(app) {
  return frameos.image({
    width: app.config.width,
    height: app.config.height,
    color: app.config.color,
    opacity: app.config.opacity,
  })
}
```

```ts
export function run(app) {
  frameos.assets.mkdir("notes")
  frameos.assets.writeText("notes/today.txt", "hello frame")
  const note = frameos.assets.readText("notes/today.txt")
  app.log(note)
}
```
""".strip()


def get_js_app_api_reference_markdown() -> str:
    return JS_APP_API_REFERENCE_MARKDOWN
