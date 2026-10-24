import clsx from 'clsx'
import { Group } from 'kea-forms'
import { PencilSquareIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/solid'
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
import type { GPIOButton, Palette } from '../../../../../types'
import { buttonRoleByLabel, buttonRoles, keyboardLayouts } from '../../../../../utils/eventsContract.gen'
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
 * One button per row: pin, label and role side by side from @md up (the
 * three are short, and a row a screen wide of one number each is hard to
 * read as a list of buttons), stacked below it. The editable rows use the
 * same columns, plus Remove.
 */
const GPIO_BUTTON_ROW = 'grid grid-cols-1 gap-2 @md:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1.5fr)]'
const GPIO_BUTTON_EDIT_ROW = 'grid grid-cols-1 gap-2 @md:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1.5fr)_auto] @md:items-end'

function ReadOnlyGpioButtons({ buttons }: { buttons: GPIOButton[] }): JSX.Element {
  return (
    <div className="space-y-2">
      {buttons.map((button) => (
        <div key={`${button.pin}-${button.label}`} className={GPIO_BUTTON_ROW}>
          <div className="space-y-1">
            <Label>Pin</Label>
            <TextInput value={String(button.pin)} readOnly className="cursor-default opacity-70" />
          </div>
          <div className="space-y-1">
            <Label>Label</Label>
            <TextInput value={button.label} readOnly className="cursor-default opacity-70" />
          </div>
          <div className="space-y-1">
            <Label>Role</Label>
            <TextInput
              value={buttonRoleByLabel[button.label.trim().toUpperCase()] ?? ''}
              placeholder="none"
              readOnly
              className="cursor-default opacity-70"
            />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * GPIO buttons: a heading plus its body. Boards with a fixed button map show
 * a read-only table; a cloud frame that reported its map and was never
 * pushed one shows that map, with "Edit buttons" seeding the editable list
 * (the save then pushes it); everything else is the editable list.
 */
export function GpioButtonsSection(): JSX.Element {
  const { configuredGpioButtons, reportedGpioButtons, frameForm, setFrameFormValues, buttonBeep, voiceChat } =
    useFrameSettings()
  // The cloud form carries `gpio_buttons` only once a push set it; until
  // then the frame runs the map its board preset (or a console `set`) gave
  // it, which is the one the report shows.
  const showReported = !configuredGpioButtons && reportedGpioButtons !== null && frameForm.gpio_buttons === undefined
  const addButton = (
    <Button
      size="small"
      color="secondary"
      onClick={() => setFrameFormValues({ gpio_buttons: [...(frameForm.gpio_buttons || []), {}] })}
      className="flex items-center gap-1"
    >
      <PlusIcon className="w-4 h-4" />
      Add button
    </Button>
  )
  return (
    <>
      <H6 id="frame-settings-gpio" className="flex items-center gap-2">
        GPIO buttons
        {configuredGpioButtons ? (
          <Tag color="gray">Configured</Tag>
        ) : showReported ? (
          <>
            <Tag color="gray">On the frame</Tag>
            {reportedGpioButtons.length > 0 ? (
              <Button
                size="small"
                color="secondary"
                onClick={() =>
                  setFrameFormValues({ gpio_buttons: reportedGpioButtons.map((button) => ({ ...button })) })
                }
                className="flex items-center gap-1"
              >
                <PencilSquareIcon className="w-4 h-4" />
                Edit buttons
              </Button>
            ) : (
              addButton
            )}
          </>
        ) : (
          addButton
        )}
      </H6>
      <div className="pl-2 @md:pl-8 space-y-2">
        {configuredGpioButtons ? (
          <ReadOnlyGpioButtons buttons={configuredGpioButtons} />
        ) : showReported ? (
          reportedGpioButtons.length > 0 ? (
            <>
              <ReadOnlyGpioButtons buttons={reportedGpioButtons} />
              <p className="frameos-muted text-xs">
                The buttons the frame runs with, from its board preset. Edit buttons starts from this list; saving
                pushes the new list and restarts the frame.
              </p>
            </>
          ) : (
            <p className="frameos-muted text-xs">No buttons set on the frame.</p>
          )
        ) : (
          frameForm.gpio_buttons?.map((_, index) => (
            <Group key={index} name={`gpio_buttons.${index}`}>
              <div className={GPIO_BUTTON_EDIT_ROW}>
                <div className="space-y-1">
                  <Label>Pin</Label>
                  <Field name="pin">
                    <TextInput name="pin" placeholder="5" />
                  </Field>
                </div>
                <div className="space-y-1">
                  <Label>Label</Label>
                  <Field name="label">
                    <TextInput name="label" placeholder="A" />
                  </Field>
                </div>
                <div className="space-y-1">
                  <Label>
                    Role
                    <Tooltip
                      title={
                        <>
                          What the button means to a scene: a store scene listens for <code>button</code> with a{' '}
                          <code>role</code> filter (<code>next</code>, <code>back</code>, …) instead of the label
                          printed on this board. Leave it empty for the default the label carries (A = primary, B =
                          next, C = prev, D = back, …).
                        </>
                      }
                    />
                  </Label>
                  <Field name="role">
                    <Select
                      name="role"
                      options={[
                        {
                          value: '',
                          label: `Default for the label${roleDefaultLabel(frameForm.gpio_buttons?.[index]?.label)}`,
                        },
                        ...buttonRoles.map((role) => ({ value: role, label: role })),
                      ]}
                    />
                  </Field>
                </div>
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
              </div>
            </Group>
          ))
        )}
      </div>
      {buttonBeep || voiceChat ? (
        <>
          {/* The board's buzzer and microphone: their own box under the
              buttons they answer for, so the button rows stay a list of
              buttons. No nav entry of its own; GPIO's link lands above it. */}
          <H6 id="frame-settings-gpio-extras">Buzzer and microphone</H6>
          <div className="pl-2 @md:pl-8 space-y-2">
            <ButtonBeepField />
            <VoiceChatField />
          </div>
        </>
      ) : null}
    </>
  )
}

/**
 * The buzzer a press sounds, under the buttons it answers for (ESP32 only).
 * A GPIO like the battery pins next door: empty leaves the board's own (its
 * preset's), -1 turns the beep off. The pitch below it is in Hz; empty
 * leaves the frame's (2000 by default).
 */
function ButtonBeepField(): JSX.Element | null {
  const { buttonBeep, setButtonBeep } = useFrameSettings()
  if (!buttonBeep) {
    return null
  }
  const { pin, toneHz, reportedPin, reportedToneHz, disabledReason } = buttonBeep
  const pinPlaceholder =
    reportedPin === undefined
      ? 'Board default, -1 = off'
      : reportedPin < 0
      ? 'Off on the frame'
      : `${reportedPin} on the frame`
  const tonePlaceholder = reportedToneHz === undefined ? '2000' : `${reportedToneHz} on the frame`
  return (
    <fieldset disabled={disabledReason !== undefined} className="min-w-0 space-y-2">
      <div className="space-y-1 @md:flex @md:gap-2">
        <Label className="@md:w-1/3">
          Button beep GPIO
          <Tooltip
            title={
              disabledReason ?? (
                <>
                  The frame beeps for as long as you hold a button it registered (up to a second), and briefly when a
                  press wakes it from deep sleep, so you know the press arrived before the screen changes. A press it
                  could not take, like the 33rd during one render, gets a lower buzz instead. This is the GPIO of the
                  board's buzzer: GPIO 45 on the Seeed reTerminal E1001, E1002 and E1004, GPIO 48 on the reTerminal
                  Sticky. Set -1 to turn the beep off. Applies without a restart.
                </>
              )
            }
          />
        </Label>
        <div className="w-full">
          <NumberTextInput
            value={pin}
            onChange={(value) => setButtonBeep({ pin: value })}
            placeholder={pinPlaceholder}
          />
        </div>
      </div>
      <div className="space-y-1 @md:flex @md:gap-2">
        <Label className="@md:w-1/3">
          Button beep tone (Hz)
          <Tooltip
            title={
              disabledReason ?? (
                <>
                  The pitch of the beep, 100 to 10000 Hz. 2000 is the default, 4000 on the reTerminal Sticky, whose
                  buzzer is tuned there. The lower buzz for a press the frame could not take is a quarter of this.
                </>
              )
            }
          />
        </Label>
        <div className="w-full">
          <NumberTextInput
            value={toneHz}
            onChange={(value) => setButtonBeep({ toneHz: value })}
            placeholder={tonePlaceholder}
          />
        </div>
      </div>
    </fieldset>
  )
}

/**
 * Voice chat (docs/voice-chat.md), under the buttons it answers to: the key
 * a Button actions row binds to it (REFRESH held, on the reTerminal presets)
 * opens the board's microphone and streams what is said to this control
 * plane for the AI chat. A switch, on by default on a board with a
 * microphone (ESP32 only); off keeps the microphone shut whatever the
 * buttons are bound to. Which key, and that it is held, is the row's to say.
 */
function VoiceChatField(): JSX.Element | null {
  const { voiceChat, setVoiceChat } = useFrameSettings()
  if (!voiceChat) {
    return null
  }
  const { enabled, reported, microphone, disabledReason } = voiceChat
  const value = enabled ?? reported ?? true
  return (
    <fieldset disabled={disabledReason !== undefined} className="min-w-0 space-y-2">
      <div className="space-y-1 @md:flex @md:gap-2">
        <Label className="@md:w-1/3">
          Voice chat
          <Tooltip
            title={
              disabledReason ?? (
                <>
                  Talk to the frame: set a button action below to &quot;Voice chat&quot; (the reTerminal presets bind
                  REFRESH held). It goes on a long press because the hold is the recording: once the key has been held
                  for a second the frame plays a short sparkle and listens, and letting go ends the sentence and sends
                  it to this control plane. The AI chat transcribes it and acts on it with the frame in its context
                  (switch to a scene by name, set a field of the scene showing, redraw, show a picture); the reply
                  lands in the frame&apos;s chat and its log, and the buzzer sounds the outcome. Needs a board with a
                  microphone: the Seeed reTerminal E1001 and E1002 have one (the E1004 does not). Off keeps the
                  microphone shut whatever the buttons are bound to.
                  {microphone === false ? ' This frame reports no microphone.' : ''}
                </>
              )
            }
          />
        </Label>
        <div className="w-full">
          <Switch
            value={value}
            onChange={(next) => setVoiceChat(next)}
            label={
              value
                ? microphone === false
                  ? 'On, but this frame reports no microphone'
                  : 'On: a button action below set to Voice chat opens the microphone'
                : 'Off: the microphone stays shut'
            }
          />
        </div>
      </div>
    </fieldset>
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

function roleDefaultLabel(label: string | undefined): string {
  const role = label ? buttonRoleByLabel[label.trim().toUpperCase()] : undefined
  return role ? ` (${role})` : ''
}

/**
 * How a person's input reaches a scene (frame.json `inputSettings`): the
 * keyboard layout the runtime maps key codes through, and whether it grabs
 * keyboards away from the console. Linux frames only.
 */
export function InputSettingsSection(): JSX.Element | null {
  const { isEmbeddedMode } = useFrameSettings()
  // The evdev translator is the Linux runtime's: an ESP32 or Pico board has
  // no keyboard to map and the virtual frame's keys come from the browser
  // already mapped. The nav link goes with it (workspaceSurfaces.ts,
  // embeddedModeHiddenFrameSettingsSections).
  if (isEmbeddedMode) {
    return null
  }
  return (
    <>
      <H6 id="frame-settings-input">Input</H6>
      <div className="pl-2 @md:pl-8 space-y-2">
        <Group name="input_settings">
          <Field
            name="keyboardLayout"
            label="Keyboard layout"
            tooltip={
              <>
                A key reaches a scene as its physical <code>code</code> (<code>KeyA</code>, <code>ArrowLeft</code>) and
                as the <code>key</code> it means under this layout (<code>a</code>, <code>A</code>, <code>ä</code>),
                which is also what <code>textInput</code> carries. Dead keys and compose are not supported.
              </>
            }
          >
            <Select
              name="keyboardLayout"
              options={keyboardLayouts.map((layout) => ({ value: layout.id, label: layout.label }))}
            />
          </Field>
          <Field
            name="grabKeyboard"
            label="Grab keyboards"
            tooltip={
              <>
                While the runtime runs, a keyboard plugged into the frame is the scene&apos;s alone: the console never
                sees its keys (Ctrl+Alt+Del included). Off, the console hears every key too. The keyboard is released
                when the runtime stops, so a rescue console still works.
              </>
            }
          >
            <Switch name="grabKeyboard" fullWidth />
          </Field>
        </Group>
        <p className="frameos-muted text-xs">The frame reads these at boot, so saving a change restarts the runtime.</p>
      </div>
    </>
  )
}
