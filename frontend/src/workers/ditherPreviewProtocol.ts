// Messages between the settings previews and ditherPreview.worker.ts.

export interface DitherPreviewInk {
  rgb: { r: number; g: number; b: number }
  name: string
  nominal: string
}

export interface DitherPreviewOptions {
  mode: string
  exposure: number
  saturation: number
  shadows: number
  highlights: number
  tone: number
  gamut: number
  dbs: false | { viewingDistanceCm: number; ppi: number }
}

export interface DitherPreviewRequest {
  id: number
  width: number
  height: number
  /** RGBA bytes, transferred. */
  data: ArrayBuffer
  inks: DitherPreviewInk[]
  options: DitherPreviewOptions
}

export type DitherPreviewResponse = { id: number; indices: ArrayBuffer } | { id: number; error: string }
