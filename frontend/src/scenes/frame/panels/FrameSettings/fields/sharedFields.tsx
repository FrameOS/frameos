import clsx from 'clsx'
import { Group } from 'kea-forms'
import { PlusIcon, TrashIcon } from '@heroicons/react/24/solid'
import { Button } from '../../../../../components/Button'
import { ColorInput } from '../../../../../components/ColorInput'
import { Field } from '../../../../../components/Field'
import { H6 } from '../../../../../components/H6'
import { Label } from '../../../../../components/Label'
import { NumberTextInput } from '../../../../../components/NumberTextInput'
import { Select } from '../../../../../components/Select'
import { Switch } from '../../../../../components/Switch'
import { Tag } from '../../../../../components/Tag'
import { TextInput } from '../../../../../components/TextInput'
import { Tooltip } from '../../../../../components/Tooltip'
import { spectraPalettes } from '../../../../../devices'
import {
  DEFAULT_FRAME_ERROR_BEHAVIOR,
  DEFAULT_TIMEZONE_UPDATE_HOUR,
  DEFAULT_TIMEZONE_UPDATE_URL,
} from '../../../frameLogic'
import type { Palette } from '../../../../../types'
import { useFrameSettings } from '../frameSettingsContext'

/**
 * The field blocks more than one section renders.
 *
 * Each one appears on the full self-hosted surface AND inside a cloud
 * fieldset, where it is the same form key writing the same value — the cloud
 * simply pushes it instead of deploying it. Keeping one definition is what
 * stops the two copies drifting; which surfaces reach them is decided by the
 * sections that render them, never in here.
 */

export function PaletteField(): JSX.Element {
  const { palette } = useFrameSettings()
  return (
    <Field name="palette" label="Color palette">
      {({ value, onChange }: { value: Palette; onChange: (v: Palette) => void }) => (
        <div className="space-y-2 w-full">
          <div className="flex items-center gap-2">
            <span>Set&nbsp;to</span>
            <Select
              name="palette"
              value={''}
              onChange={(v) => {
                const selectedPalette = spectraPalettes.find((p) => p.name === v)
                if (selectedPalette) {
                  onChange(selectedPalette)
                }
              }}
              options={[
                { value: '', label: '' },
                ...spectraPalettes.map((paletteOption) => ({
                  value: paletteOption.name || '',
                  label: paletteOption.name || 'Custom',
                })),
              ]}
            />
          </div>
          {palette?.colors.map((color, index) => (
            <div className="flex items-center gap-2" key={index}>
              <ColorInput
                className="!w-24"
                name={`colors.${index}`}
                value={value?.colors?.[index] ?? color}
                onChange={(_value) => {
                  const newColors = palette.colors.map((c, i) =>
                    i === index ? _value : value?.colors?.[i] ?? c ?? '#000000'
                  )
                  onChange({ colors: newColors })
                }}
              />
              <TextInput
                type="text"
                className="!w-24"
                name={`colors.${index}`}
                value={value?.colors?.[index] ?? color}
                onChange={(_value) => {
                  const newColors = palette.colors.map((c, i) =>
                    i === index ? _value : value?.colors?.[i] ?? c ?? '#000000'
                  )
                  onChange({ colors: newColors })
                }}
              />
              <span>{palette?.colorNames?.[index]}</span>
            </div>
          ))}
        </div>
      )}
    </Field>
  )
}

/**
 * GPIO buttons: a heading plus its body, because boards with a fixed button
 * map show a read-only table where the others show an editable list.
 */
export function GpioButtonsSection(): JSX.Element {
  const { configuredGpioButtons, frameForm, setFrameFormValues } = useFrameSettings()
  return (
    <>
      <H6 id="frame-settings-gpio" className="flex items-center gap-2">
        GPIO buttons
        {configuredGpioButtons ? (
          <Tag color="gray">Configured</Tag>
        ) : (
          <Button
            size="small"
            color="secondary"
            onClick={() => setFrameFormValues({ gpio_buttons: [...(frameForm.gpio_buttons || []), {}] })}
            className="flex items-center gap-1"
          >
            <PlusIcon className="w-4 h-4" />
            Add button
          </Button>
        )}
      </H6>
      <div className="pl-2 @md:pl-8 space-y-2">
        {configuredGpioButtons ? (
          <div className="space-y-2">
            {configuredGpioButtons.map((button) => (
              <div key={`${button.pin}-${button.label}`} className="grid grid-cols-1 gap-2 @md:grid-cols-2">
                <div className="space-y-1 @md:flex @md:gap-2">
                  <Label className="@md:w-1/3">Pin</Label>
                  <TextInput value={String(button.pin)} readOnly className="cursor-default opacity-70" />
                </div>
                <div className="space-y-1 @md:flex @md:gap-2">
                  <Label className="@md:w-1/3">Label</Label>
                  <TextInput value={button.label} readOnly className="cursor-default opacity-70" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          frameForm.gpio_buttons?.map((_, index) => (
            <Group key={index} name={`gpio_buttons.${index}`}>
              <div>
                <Field
                  name="pin"
                  label="Pin"
                  labelRight={
                    <Button
                      color="secondary"
                      size="small"
                      className="flex items-center gap-1"
                      onClick={() =>
                        setFrameFormValues({
                          gpio_buttons: frameForm.gpio_buttons?.filter((_button, i) => i !== index),
                        })
                      }
                    >
                      <TrashIcon className="w-4 h-4" />
                      Remove
                    </Button>
                  }
                >
                  <TextInput name="pin" placeholder="5" />
                </Field>
                <Field name="label" label="Label">
                  <TextInput name="label" placeholder="A" />
                </Field>
              </div>
            </Group>
          ))
        )}
      </div>
    </>
  )
}

export function FlipField(): JSX.Element {
  return (
    <Field name="flip" label="Flip">
      {({ value, onChange }) => (
        <Select
          value={value || ''}
          onChange={(v) => onChange(v)}
          name="flip"
          options={[
            { value: '', label: '-' },
            { value: 'horizontal', label: 'horizontal' },
            { value: 'vertical', label: 'vertical' },
            { value: 'both', label: 'both' },
          ]}
        />
      )}
    </Field>
  )
}

export function MetricsIntervalField(): JSX.Element {
  return (
    <Field name="metrics_interval" label="Metrics reporting interval in seconds, 0 to disable">
      <TextInput name="metrics_interval" placeholder="60" />
    </Field>
  )
}

export function TimezoneUpdaterFields(): JSX.Element {
  const { surface, timezoneUpdateHourValue, timezoneUpdateUrlValue, setTimezoneUpdateHour, setTimezoneUpdaterValue } =
    useFrameSettings()
  const cloudProfile = surface === 'cloudLinux' || surface === 'cloudEsp32'
  return (
    <Group name="timezone_updater">
      <Field
        name="enabled"
        label="Update timezone data"
        tooltip="Download updated timezone rules on this frame so daylight saving changes stay current."
      >
        {({ value, onChange }) => {
          const enabled = value ?? true
          return (
            <div className="space-y-3">
              <div className="flex w-full items-start gap-3">
                <Switch value={enabled} onChange={onChange} />
                {enabled ? (
                  <details className="min-w-0 flex-1">
                    <summary className="frameos-link cursor-pointer list-none text-sm font-semibold">advanced</summary>
                    <div className="mt-3 w-full space-y-2">
                      <div className="space-y-1 @md:flex @md:gap-2">
                        <Label className="@md:w-1/3">
                          Timezone update hour
                          <Tooltip title="Hour of day on the frame when timezone data updates run." />
                        </Label>
                        <div className="w-full">
                          <TextInput
                            inputMode="numeric"
                            pattern="[0-9]*"
                            placeholder={String(DEFAULT_TIMEZONE_UPDATE_HOUR)}
                            value={timezoneUpdateHourValue}
                            onChange={setTimezoneUpdateHour}
                          />
                        </div>
                      </div>
                      {/* The URL stays local: a cloud push carries only
                          enabled/hour, and the device keeps whatever
                          endpoint it already uses. */}
                      {!cloudProfile ? (
                        <div className="space-y-1 @md:flex @md:gap-2">
                          <Label className="@md:w-1/3">Timezone update URL</Label>
                          <div className="w-full">
                            <TextInput
                              placeholder={DEFAULT_TIMEZONE_UPDATE_URL}
                              value={timezoneUpdateUrlValue}
                              onChange={(url) => setTimezoneUpdaterValue({ url: url || undefined })}
                            />
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </details>
                ) : null}
              </div>
            </div>
          )
        }}
      </Field>
    </Group>
  )
}

export function MaxHttpResponseBytesField(): JSX.Element {
  const { maxHttpResponsePlaceholder } = useFrameSettings()
  return (
    <Field
      name="max_http_response_bytes"
      label="Maximum HTTP response size for apps"
      tooltip={
        <>
          <p>
            The most bytes one HTTP response may carry for any app download — images, calendar feeds, APIs. Enforced on
            the device at download time: a response that announces a larger size is refused before the first byte, a
            stream that grows past it is cut off. Raise it for bigger sources.
          </p>
          <p className="mt-2">
            ESP32 frames default to 4 MiB. There the body is buffered in PSRAM chunks, and when free PSRAM would drop
            below the runtime&apos;s reserve the rest of the body spills to storage instead of failing — the SD
            card&apos;s <code>.cache</code> folder when one is mounted, otherwise the internal <code>/state</code>
            partition (capped by its free space, at most 8 MiB). A spilled image is decoded straight from the file with
            the same streaming decoder that renders SD-card assets, so a multi-MB JPEG never has to fit in memory: this
            limit, not PSRAM, is the ceiling. Spilled bodies must be baseline JPEGs (progressive JPEG and PNG cannot be
            streamed from a file yet), and text/JSON responses never spill — they need to fit in memory. With no SD card
            and no free <code>/state</code> space, spilling is off and the download fails once PSRAM is exhausted.
          </p>
          <p className="mt-2">The frame reads this value at boot, so saving a change reboots it.</p>
        </>
      }
    >
      <NumberTextInput name="max_http_response_bytes" placeholder={maxHttpResponsePlaceholder} />
    </Field>
  )
}

export function ErrorBehaviorFields(): JSX.Element {
  const { errorBehavior, errorBehaviorModes, setErrorBehavior } = useFrameSettings()
  return (
    <>
      <Field name="error_behavior.mode" label="Unrecoverable error behavior">
        <div className="grid w-full gap-2 @xl:grid-cols-3">
          {errorBehaviorModes.map((option) => {
            const selected = errorBehavior.mode === option.value
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setErrorBehavior({ mode: option.value })}
                className={clsx(
                  'frame-tool-row min-h-28 rounded-lg p-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                  selected ? 'border-blue-500 ring-2 ring-blue-500/30' : 'hover:border-slate-400'
                )}
                aria-pressed={selected}
              >
                <span className="frameos-strong block text-sm font-semibold">{option.title}</span>
                <span className="frame-tool-muted mt-1 block text-xs leading-5">{option.description}</span>
              </button>
            )
          })}
        </div>
      </Field>
      {errorBehavior.mode === 'show_error_retry' ? (
        <Field
          name="error_behavior.retry_seconds"
          label="Retry delay"
          tooltip="After a fatal error, render the error screen and retry after this many seconds."
        >
          <NumberTextInput
            value={errorBehavior.retry_seconds ?? DEFAULT_FRAME_ERROR_BEHAVIOR.retry_seconds}
            onChange={(value) => setErrorBehavior({ retry_seconds: value })}
            placeholder="60"
          />
        </Field>
      ) : null}
      {errorBehavior.mode === 'silent_retry' ? (
        <>
          <Field
            name="error_behavior.silent_retry_seconds"
            label="Silent retry delay"
            tooltip="While retrying silently, keep the current frame image and retry after this many seconds."
          >
            <NumberTextInput
              value={errorBehavior.silent_retry_seconds ?? DEFAULT_FRAME_ERROR_BEHAVIOR.silent_retry_seconds}
              onChange={(value) => setErrorBehavior({ silent_retry_seconds: value })}
              placeholder="60"
            />
          </Field>
          <Field
            name="error_behavior.silent_retry_forever"
            label="Retry silently forever"
            tooltip="When enabled, the frame never replaces the current image with a fatal error screen."
          >
            <Switch
              value={!!errorBehavior.silent_retry_forever}
              onChange={(value) => setErrorBehavior({ silent_retry_forever: value })}
              fullWidth
            />
          </Field>
          {!errorBehavior.silent_retry_forever ? (
            <>
              <Field
                name="error_behavior.silent_window_minutes"
                label="Silent window"
                tooltip="Retry silently for this many minutes before switching to the visible error screen."
              >
                <NumberTextInput
                  value={errorBehavior.silent_window_minutes ?? DEFAULT_FRAME_ERROR_BEHAVIOR.silent_window_minutes}
                  onChange={(value) => setErrorBehavior({ silent_window_minutes: value })}
                  placeholder="10"
                />
              </Field>
              <Field
                name="error_behavior.show_error_retry_seconds"
                label="Visible retry delay"
                tooltip="After the silent window expires, render the error screen and retry after this many seconds."
              >
                <NumberTextInput
                  value={
                    errorBehavior.show_error_retry_seconds ?? DEFAULT_FRAME_ERROR_BEHAVIOR.show_error_retry_seconds
                  }
                  onChange={(value) => setErrorBehavior({ show_error_retry_seconds: value })}
                  placeholder="60"
                />
              </Field>
            </>
          ) : null}
        </>
      ) : null}
    </>
  )
}

export function ControlCodeFields(): JSX.Element {
  const { frameForm } = useFrameSettings()
  return (
    <Group name="control_code">
      <Field name="enabled" label="QR Control Code">
        <Select
          name="enabled"
          options={[
            { value: 'false', label: 'Disabled' },
            { value: 'true', label: 'Enabled' },
          ]}
        />
      </Field>
      {String(frameForm.control_code?.enabled) === 'true' && (
        <>
          <Field name="position" label="Position">
            {({ value, onChange }) => (
              <Select
                name="position"
                value={value ?? 'top-right'}
                onChange={onChange}
                options={[
                  { value: 'top-left', label: 'Top Left' },
                  { value: 'top-right', label: 'Top Right' },
                  { value: 'bottom-left', label: 'Bottom Left' },
                  { value: 'bottom-right', label: 'Bottom Right' },
                  { value: 'center', label: 'Center' },
                ]}
              />
            )}
          </Field>
          <Field name="size" label="Size of each square in pixels">
            <TextInput name="size" placeholder="2" />
          </Field>
          <Field name="padding" label="Padding around code">
            <TextInput name="padding" placeholder="1" />
          </Field>
          <Field name="offsetX" label="X offset">
            <TextInput name="offsetX" placeholder="0" />
          </Field>
          <Field name="offsetY" label="Y offset">
            <TextInput name="offsetY" placeholder="0" />
          </Field>
          <Field name="qrCodeColor" label="QR code color">
            <ColorInput
              name="qrCodeColor"
              value={frameForm.control_code?.qrCodeColor ?? '#000000'}
              placeholder="#000000"
            />
          </Field>
          <Field name="backgroundColor" label="Background color">
            <ColorInput
              name="backgroundColor"
              value={frameForm.control_code?.backgroundColor ?? '#ffffff'}
              placeholder="#ffffff"
            />
          </Field>
        </>
      )}
    </Group>
  )
}

export function SaveAssetsField(): JSX.Element {
  const { appsWithSaveAssets, frameForm, setFrameFormValues, touchFrameFormField } = useFrameSettings()
  return (
    <Field
      name="save_assets"
      label={<div>Save downloaded images as assets</div>}
      tooltip="This controls the 'auto' setting for 'Save assets' in the following apps. Please note that individual apps/scenes may have overridden the default set here."
    >
      {/* Render-prop form: the checkboxes read and write frameForm.save_assets
          themselves, so kea's cloned value/onChange would only land on a div
          (and a Fragment child warns about the id it is handed). */}
      {() => (
        <div className="space-y-2 w-full">
          {Object.entries({
            _all: 'All',
            ...appsWithSaveAssets,
          }).map(([keyword, name]) => (
            <label key={keyword} className="flex gap-1">
              <input
                type="checkbox"
                name={keyword === '_all' ? 'save_assets' : undefined}
                checked={
                  typeof frameForm.save_assets === 'boolean'
                    ? frameForm.save_assets
                    : !!frameForm.save_assets?.[keyword]
                }
                value={'true'}
                onChange={(e) => {
                  const checked = !!e.target.checked
                  if (keyword === '_all') {
                    setFrameFormValues({ save_assets: checked })
                  } else {
                    const prevValues =
                      typeof frameForm.save_assets === 'object'
                        ? frameForm.save_assets
                        : frameForm.save_assets === true
                        ? Object.fromEntries(Object.entries(appsWithSaveAssets).map(([k]) => [k, true]))
                        : {}
                    setFrameFormValues({
                      save_assets: {
                        ...prevValues,
                        [keyword]: checked,
                      },
                    })
                  }
                  touchFrameFormField('save_assets')
                }}
              />
              {name}
            </label>
          ))}
        </div>
      )}
    </Field>
  )
}
