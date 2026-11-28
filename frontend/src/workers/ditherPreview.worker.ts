// OpenDisplay dithering for the settings previews (frontend/src/scenes/frame/
// panels/FrameSettings/fields/panelPreview.tsx), off the page's thread: DBS
// takes a second or more on a big panel, and the page must stay usable
// meanwhile. The same Rust core (the npm package's WASM build) as both
// planes' packers, so the preview is the picture the frame gets.
//
// Loaded by fixed URL ({assets}/static/workers/ditherPreview.worker.js), built
// as its own entry like Monaco's workers (frontend/build.mjs,
// cloud-frontend/build.mjs).

import { ditherImage, Palette } from '@opendisplay/epaper-dithering'
import type { DitherPreviewRequest, DitherPreviewResponse } from './ditherPreviewProtocol'

const palettes = new Map<string, ReturnType<typeof Palette.fromSrgb>>()

self.onmessage = (event: MessageEvent<DitherPreviewRequest>) => {
  const { id, width, height, data, inks, options } = event.data
  try {
    const key = JSON.stringify(inks)
    let palette = palettes.get(key)
    if (!palette) {
      palette = Palette.fromSrgb(inks, true)
      palettes.set(key, palette)
    }
    const result = ditherImage({ width, height, data: new Uint8ClampedArray(data) }, palette, options as never)
    const indices = new Uint8Array(result.indices)
    const response: DitherPreviewResponse = { id, indices: indices.buffer }
    ;(self as unknown as Worker).postMessage(response, [indices.buffer])
  } catch (error) {
    const response: DitherPreviewResponse = { id, error: String(error) }
    ;(self as unknown as Worker).postMessage(response)
  }
}
