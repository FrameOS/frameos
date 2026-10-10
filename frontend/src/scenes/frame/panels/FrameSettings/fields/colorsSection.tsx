import { useEffect, useRef, useState } from 'react'
import { Button } from '../../../../../components/Button'
import { Tooltip } from '../../../../../components/Tooltip'
import { H6 } from '../../../../../components/H6'
import { Select } from '../../../../../components/Select'
import { Spinner } from '../../../../../components/Spinner'
import { Switch } from '../../../../../components/Switch'
import { frameAssetsApiPath } from '../../../../../utils/frameAssetsApi'
import { getBasePath } from '../../../../../utils/getBasePath'
import { applyAssetColors, autoEndPoints } from '../../../../../utils/assetColors/adjust'
import { panelPaletteForFrame, visiblePalette } from '../../../../../utils/assetColors/devicePalette'
import { ditherToPalette } from '../../../../../utils/assetColors/dither'
import {
  type AssetColorProfile,
  defaultAssetColorProfile,
  parseAssetColorProfile,
  serializeAssetColorProfile,
} from '../../../../../utils/assetColors/profile'
import type { FrameColorGlobal, FrameColors, FrameType } from '../../../../../types'
import { ColorAdjustmentControls } from '../../Assets/ColorAdjustmentControls'
import { deviceLabelFor } from '../../Assets/assetColorsLogic'
import { useFrameSettings } from '../frameSettingsContext'

/** frame.json's `colors.global` → the editor's profile (no palette there). */
export function globalProfileOf(colors: FrameColors | null | undefined): AssetColorProfile {
  const parsed = parseAssetColorProfile({ version: 1, colors: colors?.global ?? {} })
  return parsed ? { ...parsed, palette: null } : defaultAssetColorProfile()
}

/** The editor's profile → frame.json's `colors.global`, neutral sliders left out. */
export function globalOfProfile(profile: AssetColorProfile): FrameColorGlobal {
  const { colors } = JSON.parse(serializeAssetColorProfile({ ...profile, palette: null })) as {
    colors: FrameColorGlobal
  }
  return colors
}

function frameImageUrl(frameId: FrameType['id']): string {
  return `${getBasePath()}${frameAssetsApiPath(frameId, 'image')}?t=-1`
}

/**
 * The frame's current image with the correction (and, when on, the
 * automatic fit) applied, dithered as the panel will show it. What the
 * frame renders next is what this shows, source for source.
 */
function FrameColorsPreview({
  frame,
  colors,
  global,
}: {
  frame: Partial<FrameType> & Pick<FrameType, 'id'>
  colors: FrameColors
  global: AssetColorProfile
}): JSX.Element {
  const [source, setSource] = useState<ImageBitmap | null>(null)
  const [failed, setFailed] = useState(false)
  const [dithered, setDithered] = useState(true)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const panelPalette = panelPaletteForFrame(
    { device: frame.device, palette: frame.palette, device_config: frame.device_config, embedded: frame.embedded },
    deviceLabelFor(frame.device)
  )
  const palette = visiblePalette(panelPalette)
  const autoFit = colors.autoFit === 'on' || (colors.autoFit !== 'off' && palette.length > 0)

  useEffect(() => {
    let cancelled = false
    fetch(frameImageUrl(frame.id), { credentials: 'include' })
      .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(String(response.status)))))
      .then((blob) => createImageBitmap(blob))
      .then((bitmap) => {
        if (cancelled) {
          bitmap.close()
        } else {
          setSource(bitmap)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [frame.id])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !source) {
      return
    }
    const handle = window.requestAnimationFrame(() => {
      canvas.width = source.width
      canvas.height = source.height
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) {
        return
      }
      context.drawImage(source, 0, 0)
      const imageData = context.getImageData(0, 0, source.width, source.height)
      if (autoFit) {
        // The whole image counts as "the drawn photo" here: the frame fits
        // each image it draws, and the stored image is usually one photo.
        const endPoints = autoEndPoints(imageData.data, palette.length > 0 ? palette : null)
        if (endPoints) {
          applyAssetColors(imageData.data, { ...defaultAssetColorProfile(), ...endPoints })
        }
      }
      applyAssetColors(imageData.data, global)
      if (dithered && palette.length > 0) {
        ditherToPalette(imageData.data, source.width, source.height, palette)
      }
      context.putImageData(imageData, 0, 0)
    })
    return () => window.cancelAnimationFrame(handle)
  }, [source, global, autoFit, dithered, palette.length, frame.palette])

  return (
    <div className="space-y-2">
      <div className="frame-tool-card flex min-h-[8rem] items-center justify-center overflow-hidden rounded-2xl bg-slate-900/80 p-2">
        {failed ? (
          <span className="frame-tool-muted p-4 text-xs">No current image to preview on.</span>
        ) : source ? (
          <canvas ref={canvasRef} className="max-h-[22rem] max-w-full object-contain" />
        ) : (
          <Spinner className="h-6 w-6" color="white" />
        )}
      </div>
      {palette.length > 0 ? (
        <Switch value={dithered} onChange={setDithered} label="Preview dithered as on the panel" />
      ) : null}
    </div>
  )
}

/**
 * Settings → Colors: the automatic fit of drawn images into the panel's
 * range and the frame-wide correction (docs/asset-color-profiles.md). Both
 * are read on every render, so a save lands without a restart.
 */
export function ColorsSection(): JSX.Element {
  const { frame, frameForm, setFrameFormValues } = useFrameSettings()
  const colors: FrameColors = frameForm.colors ?? frame.colors ?? {}
  const global = globalProfileOf(colors)
  // The fine tuning (preview plus the slider set) is a lot of panel for a
  // setting most frames never touch, so it opens folded; the auto
  // correction switch is always in view.
  const [showFineTuning, setShowFineTuning] = useState(false)
  const tunedSliders = Object.keys(globalOfProfile(global)).length
  const panelPalette = panelPaletteForFrame(
    {
      device: frameForm.device ?? frame.device,
      palette: frameForm.palette ?? frame.palette,
      device_config: frameForm.device_config ?? frame.device_config,
      embedded: frame.embedded,
    },
    deviceLabelFor(frameForm.device ?? frame.device)
  )
  const hasPalette = visiblePalette(panelPalette).length > 0
  const setColors = (next: FrameColors): void => setFrameFormValues({ colors: next })

  return (
    <>
      <H6 id="frame-settings-colors">Colors</H6>
      <div className="pl-2 @md:pl-8 space-y-3">
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <span className="flex items-center gap-1 @md:w-1/3">
            Auto color correction
            <Tooltip
              title={
                <>
                  Before an image is dithered, the frame moves its black and white points so the image&apos;s tones fit
                  the range the panel can show. A Spectra panel&apos;s white is darker than a photo&apos;s, so without
                  this the brightest parts come out as flat white. It applies to every image the frame draws, from any
                  source, and resizes nothing. A photo with its own colors (Assets → Set colors) keeps them instead.
                </>
              }
            />
          </span>
          <Select
            value={colors.autoFit ?? 'default'}
            onChange={(value) =>
              setColors({ ...colors, autoFit: value === 'on' || value === 'off' ? value : 'default' })
            }
            options={[
              {
                value: 'default',
                label: hasPalette ? 'Default (on for this panel)' : 'Default (off for this display)',
              },
              { value: 'on', label: 'Always on' },
              { value: 'off', label: 'Off' },
            ]}
            className="min-w-0 flex-1"
          />
        </label>
        <p className="frameos-muted text-xs">
          {hasPalette
            ? 'Default is on here: this panel dithers to a fixed set of inks. Off shows the image as it is.'
            : 'Default is off here: this display shows full color, so there is nothing to fit. Always on still applies it.'}
        </p>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="flex items-center gap-1">
            Fine tuning
            <Tooltip
              title={
                <>
                  A frame-wide color correction with the same sliders as the photo editor: exposure, contrast, white and
                  black points, saturation, tints per tonal range and per hue. Applied to the whole picture on every
                  display, after the automatic correction, and previewed on the frame&apos;s current image dithered as
                  the panel will show it.
                </>
              }
            />
            <span className="frameos-muted text-xs">
              ({tunedSliders === 0 ? 'nothing set' : `${tunedSliders} slider${tunedSliders === 1 ? '' : 's'} set`})
            </span>
          </span>
          <Button size="small" color="secondary" onClick={() => setShowFineTuning(!showFineTuning)}>
            {showFineTuning ? 'Hide fine tuning' : 'Show fine tuning'}
          </Button>
        </div>
        {!showFineTuning ? null : (
          <div className="grid gap-3 @3xl:grid-cols-[minmax(0,1fr)_20rem]">
            <FrameColorsPreview
              frame={{ ...frame, ...frameForm, id: frame.id } as Partial<FrameType> & Pick<FrameType, 'id'>}
              colors={colors}
              global={global}
            />
            <div className="space-y-3">
              <ColorAdjustmentControls
                profile={global}
                onChange={(profile) => setColors({ ...colors, global: globalOfProfile(profile) })}
              />
              <Button
                size="small"
                color="secondary"
                disabled={tunedSliders === 0}
                onClick={() => setColors({ ...colors, global: {} })}
              >
                Reset sliders
              </Button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
