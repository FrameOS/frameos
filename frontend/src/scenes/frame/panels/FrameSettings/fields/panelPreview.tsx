import { useEffect, useRef, useState } from 'react'
import { Spinner } from '../../../../../components/Spinner'
import type { FrameColors, FrameDither, FrameType } from '../../../../../types'
import { applyAssetColors, autoEndPoints } from '../../../../../utils/assetColors/adjust'
import {
  paletteDeviceOf,
  panelAutoFitByDefault,
  panelPaletteForFrame,
  panelPaletteKindForFrame,
  visiblePalette,
} from '../../../../../utils/assetColors/devicePalette'
import { ditherToPalette } from '../../../../../utils/assetColors/dither'
import { defaultAssetColorProfile, type AssetColorProfile } from '../../../../../utils/assetColors/profile'
import { normalizeFrameDither, type NormalizedFrameDither } from '../../../../../utils/ditherPresets'
import { frameAssetsApiPath } from '../../../../../utils/frameAssetsApi'
import { getBasePath } from '../../../../../utils/getBasePath'
import { ditherPreview } from '../../../../../workers/ditherPreviewClient'
import type { DitherPreviewInk } from '../../../../../workers/ditherPreviewProtocol'
import { deviceLabelFor } from '../../Assets/assetColorsLogic'

// The frame's current image as the panel will show it, under the image as
// it is. One preview for the Colors and the Dithering sections, running what
// the plane's render and packer run, in their order (docs/dithering.md,
// docs/asset-color-profiles.md):
//
//   automatic fit (Colors; skipped when the frame dithers with OpenDisplay,
//   as the plane skips it) → the frame-wide correction (Colors) → dithering
//   (Floyd–Steinberg, or OpenDisplay with the frame's settings).
//
// OpenDisplay runs in a worker (workers/ditherPreview.worker.ts). With DBS
// on, a quick pass without it shows first, then the refined picture.

/** The inks of a palette kind's visible colors, in order: OpenDisplay names each one. */
const INKS: Partial<Record<string, string[]>> = {
  spectra6: ['black', 'white', 'yellow', 'red', 'blue', 'green'],
  sevenColor: ['black', 'white', 'green', 'blue', 'red', 'yellow', 'orange'],
  fourColor: ['black', 'white', 'yellow', 'red'],
}
const NOMINAL: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  yellow: '#ffff00',
  red: '#ff0000',
  blue: '#0000ff',
  green: '#00ff00',
  orange: '#ff8000',
}

/** panel_ppi: the density the plane uses, from the panel's name (`EPD_7in3e` = 7.3"). */
export function panelPpiOf(frame: Partial<FrameType>, width: number, height: number): number {
  const hardwarePanel = (frame.hardware as { panel?: unknown } | null | undefined)?.panel
  const name = (typeof hardwarePanel === 'string' ? hardwarePanel : frame.device) ?? ''
  const short = name.split('.').pop() ?? name
  const inches = /(\d+)in(\d)/.exec(short)
  const impression = /impression_(\d+(?:\.\d+)?)/.exec(short)
  const diagonal = inches ? Number(`${inches[1]}.${inches[2]}`) : impression ? Number(impression[1]) : null
  return diagonal && width > 0 && height > 0 ? Math.hypot(width, height) / diagonal : 127
}

type Stage = 'idle' | 'rendering' | 'refining'

export function PanelPreview({
  frame,
  colors,
  global,
  dither,
}: {
  frame: Partial<FrameType> & Pick<FrameType, 'id'>
  colors: FrameColors
  global: AssetColorProfile
  dither: FrameDither | null | undefined
}): JSX.Element {
  const [source, setSource] = useState<ImageBitmap | null>(null)
  const [failed, setFailed] = useState(false)
  const [stage, setStage] = useState<Stage>('idle')
  const [startedAt, setStartedAt] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [took, setTook] = useState<number | null>(null)
  const originalRef = useRef<HTMLCanvasElement | null>(null)
  const panelRef = useRef<HTMLCanvasElement | null>(null)
  const generation = useRef(0)

  const panel = {
    device: frame.device,
    palette: frame.palette,
    device_config: frame.device_config,
    embedded: frame.embedded,
    hardware: frame.hardware,
  }
  const deviceLabel = deviceLabelFor(paletteDeviceOf(panel))
  const palette = visiblePalette(panelPaletteForFrame(panel, deviceLabel))
  const inkNames = INKS[panelPaletteKindForFrame(panel, deviceLabel)]
  const openDisplay: NormalizedFrameDither | null =
    inkNames && inkNames.length === palette.length ? normalizeFrameDither(dither) : null
  // The plane skips the automatic fit under OpenDisplay (docs/dithering.md).
  const autoFit =
    !openDisplay && (colors.autoFit === 'on' || (colors.autoFit !== 'off' && panelAutoFitByDefault(panel, deviceLabel)))
  const key = JSON.stringify([openDisplay, palette, global, autoFit])

  useEffect(() => {
    let cancelled = false
    fetch(`${getBasePath()}${frameAssetsApiPath(frame.id, 'image')}?t=-1`, { credentials: 'include' })
      .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(String(response.status)))))
      .then((blob) => createImageBitmap(blob))
      .then((bitmap) => (cancelled ? bitmap.close() : setSource(bitmap)))
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [frame.id])

  // The original, as it is.
  useEffect(() => {
    const canvas = originalRef.current
    if (!canvas || !source) {
      return
    }
    canvas.width = source.width
    canvas.height = source.height
    canvas.getContext('2d')?.drawImage(source, 0, 0)
  }, [source])

  // A ticking "Rendering… 1.2 s", so a slow pass reads as work, not a hang.
  useEffect(() => {
    if (stage === 'idle') {
      return
    }
    const timer = window.setInterval(() => setElapsed(performance.now() - startedAt), 100)
    return () => window.clearInterval(timer)
  }, [stage, startedAt])

  useEffect(() => {
    const canvas = panelRef.current
    if (!canvas || !source) {
      return
    }
    const mine = ++generation.current
    const current = (): boolean => generation.current === mine
    setStage('rendering')
    const started = performance.now()
    setStartedAt(started)
    setElapsed(0)

    // Wait for sliders to settle before starting a pass.
    const timer = window.setTimeout(async () => {
      if (!current()) {
        return
      }
      const width = source.width
      const height = source.height
      const scratch = document.createElement('canvas')
      scratch.width = width
      scratch.height = height
      const context = scratch.getContext('2d', { willReadFrequently: true })
      if (!context) {
        return
      }
      context.drawImage(source, 0, 0)
      const image = context.getImageData(0, 0, width, height)
      if (autoFit) {
        const endPoints = autoEndPoints(image.data, palette.length > 0 ? palette : null)
        if (endPoints) {
          applyAssetColors(image.data, { ...defaultAssetColorProfile(), ...endPoints })
        }
      }
      applyAssetColors(image.data, global)

      const show = (data: Uint8ClampedArray): void => {
        canvas.width = width
        canvas.height = height
        canvas
          .getContext('2d')
          ?.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0)
      }
      const paint = (indices: Uint8Array): Uint8ClampedArray => {
        const out = new Uint8ClampedArray(image.data)
        for (let i = 0; i < indices.length; i += 1) {
          const [r, g, b] = palette[indices[i]] ?? [0, 0, 0]
          out[i * 4] = r
          out[i * 4 + 1] = g
          out[i * 4 + 2] = b
        }
        return out
      }

      try {
        if (palette.length === 0) {
          show(image.data)
        } else if (!openDisplay || !inkNames) {
          const data = new Uint8ClampedArray(image.data)
          ditherToPalette(data, width, height, palette)
          show(data)
        } else {
          const inks: DitherPreviewInk[] = palette.map(([r, g, b], index) => ({
            rgb: { r, g, b },
            name: inkNames[index],
            nominal: NOMINAL[inkNames[index]],
          }))
          const options = {
            mode: openDisplay.algorithm,
            exposure: openDisplay.exposure,
            saturation: openDisplay.saturation,
            shadows: openDisplay.shadows,
            highlights: openDisplay.highlights,
            tone: openDisplay.tone,
            gamut: openDisplay.gamut,
            dbs: false as const,
          }
          const quick = await ditherPreview(width, height, image.data, inks, options)
          if (!current()) {
            return
          }
          show(paint(quick))
          if (openDisplay.dbs) {
            setStage('refining')
            const refined = await ditherPreview(width, height, image.data, inks, {
              ...options,
              dbs: {
                viewingDistanceCm: openDisplay.viewingDistanceCm,
                ppi: openDisplay.ppi ?? panelPpiOf(frame, width, height),
              },
            })
            if (!current()) {
              return
            }
            show(paint(refined))
          }
        }
      } catch {
        if (!current()) {
          return
        }
        const data = new Uint8ClampedArray(image.data)
        ditherToPalette(data, width, height, palette)
        show(data)
      }
      if (current()) {
        setTook(Math.round(performance.now() - started))
        setStage('idle')
      }
    }, 250)
    return () => window.clearTimeout(timer)
  }, [source, key])

  const busy = stage !== 'idle'
  const label = !openDisplay ? 'Floyd–Steinberg' : `OpenDisplay${openDisplay.dbs ? ' + DBS' : ''}`
  return (
    <div className="space-y-1">
      <div className="frame-tool-card overflow-hidden rounded-2xl bg-slate-900/80 p-2">
        {failed ? (
          <div className="frame-tool-muted p-4 text-center text-xs">No current image to preview on.</div>
        ) : !source ? (
          <div className="flex min-h-[8rem] items-center justify-center">
            <Spinner className="h-6 w-6" color="white" />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            <figure className="space-y-1">
              <canvas ref={originalRef} className="max-h-[32rem] w-full object-contain" />
              <figcaption className="text-center text-xs text-slate-300">Original</figcaption>
            </figure>
            <figure className="space-y-1">
              <div className="relative">
                <canvas
                  ref={panelRef}
                  className={`max-h-[32rem] w-full object-contain transition-opacity ${
                    stage === 'rendering' ? 'opacity-40' : ''
                  }`}
                />
                {busy ? (
                  <div className="absolute inset-x-2 top-2 flex items-center gap-2 rounded-lg bg-slate-950/80 px-2 py-1 text-xs text-white">
                    <Spinner className="h-3 w-3" color="white" />
                    <span>
                      {stage === 'refining' ? 'Quick preview shown; refining for viewing distance…' : 'Rendering…'}{' '}
                      {(elapsed / 1000).toFixed(1)} s
                    </span>
                  </div>
                ) : null}
              </div>
              <figcaption className="text-center text-xs text-slate-300">On the panel ({label})</figcaption>
            </figure>
          </div>
        )}
      </div>
      <p className="frameos-muted text-xs">
        The frame&apos;s current image, as it is and as the panel will show it with these Colors and Dithering settings,
        painted in the palette&apos;s colors
        {took !== null && !busy ? ` (rendered in ${(took / 1000).toFixed(1)} s)` : ''}. Zoom in to judge the dots; step
        back to judge the picture.
      </p>
    </div>
  )
}
