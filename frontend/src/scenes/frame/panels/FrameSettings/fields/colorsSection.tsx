import { useState } from 'react'
import { Button } from '../../../../../components/Button'
import { Tooltip } from '../../../../../components/Tooltip'
import { H6 } from '../../../../../components/H6'
import { Select } from '../../../../../components/Select'
import { paletteDeviceOf, panelAutoFitByDefault } from '../../../../../utils/assetColors/devicePalette'
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
import { PanelPreview } from './panelPreview'

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
  // Whether the frame fits by default: the device decides by panel family
  // (color inks only), and a cloud frame's panel is in its hardware report.
  const panel = {
    device: frameForm.device ?? frame.device,
    device_config: frameForm.device_config ?? frame.device_config,
    embedded: frame.embedded,
    hardware: frame.hardware,
  }
  const fitsByDefault = panelAutoFitByDefault(panel, deviceLabelFor(paletteDeviceOf(panel)))
  const setColors = (next: FrameColors): void => setFrameFormValues({ colors: next })
  // OpenDisplay dithering (docs/dithering.md) fits the picture itself, so the
  // server's render skips the automatic fit whatever is set here.
  const dither = 'dither' in frameForm ? frameForm.dither : frame.dither
  const openDisplay = dither?.method === 'opendisplay'

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
                label: fitsByDefault ? 'Default (on for this panel)' : 'Default (off for this display)',
              },
              { value: 'on', label: 'Always on' },
              { value: 'off', label: 'Off' },
            ]}
            className="min-w-0 flex-1"
          />
        </label>
        {openDisplay ? (
          <p className="frameos-muted text-xs">
            Not used when FrameOS renders this frame&apos;s scenes on the server: OpenDisplay dithering (above) fits the
            picture to the panel&apos;s colors itself, and fitting it twice makes it far too dark.
          </p>
        ) : null}
        <p className="frameos-muted text-xs">
          {fitsByDefault
            ? 'Default is on here: this panel dithers to a fixed set of color inks. Off shows the image as it is.'
            : 'Default is off here: this display is full color, grayscale or two-color, so there is nothing to fit. Always on still applies it.'}
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
            <PanelPreview
              frame={{ ...frame, ...frameForm, id: frame.id } as Partial<FrameType> & Pick<FrameType, 'id'>}
              colors={colors}
              global={global}
              dither={dither}
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
