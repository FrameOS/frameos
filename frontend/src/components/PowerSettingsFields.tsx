import clsx from 'clsx'
import type { ReactNode } from 'react'

import type { CpuMode, RenderMode } from '../types'

import { Label } from './Label'
import { NumberTextInput } from './NumberTextInput'
import { Select } from './Select'
import { Tooltip } from './Tooltip'

/**
 * ESP32 power management, in one place for both control planes.
 *
 * The same six knobs reach the firmware by two different routes, which is
 * exactly why this is one component rather than two forms that drift:
 *
 *  - CLOUD: pushed live over `set_settings` (deep_sleep, deep_sleep_on_battery,
 *    wake_check_seconds, battery_pin, battery_divider, battery_enable_pin —
 *    the esp32 subset of allowedFrameSettings), applied by
 *    ws_handle_set_settings.
 *  - BACKEND: stored in the frame's `device_config` and handed to the device
 *    by its settings poll (embedded_frame_settings in
 *    backend/app/api/embedded_device.py sends deepSleepOnBattery /
 *    wakeCheckSeconds / batteryPin / batteryDivider / batteryEnablePin from
 *    there), plus baked into the firmware build as compile-time defaults.
 *
 * Values are plain props, not form bindings: the cloud reads them from
 * top-level frame settings and the backend from `device_config`, so the
 * component cannot own where they live.
 *
 * The Pico thin-client firmware (embedded/pico, backend only) reads the first
 * two of the six by the BACKEND route and ignores the rest — see `profile`.
 */
export interface PowerSettingsValues {
  deepSleep: boolean
  deepSleepOnBattery: boolean
  wakeCheckSeconds: number | undefined
  /** How long a press or a tap keeps a deep-sleeping frame awake; undefined = the firmware's 5 minutes. */
  awakeAfterInputSeconds?: number | undefined
  batteryPin: number | undefined
  batteryDivider: number | undefined
  /** GPIO held high to switch the divider on while sampling; -1 = none (always on). */
  batteryEnablePin: number | undefined
  /** The chip's clock; undefined = auto (240 MHz on an LCD or touch panel, else 160). */
  cpuMode?: CpuMode | undefined
  /** Where the scenes run (docs/server-rendering.md); undefined = on the frame. */
  renderMode?: RenderMode | undefined
}

/**
 * "Render scenes": whether this frame may hand its scenes to its control
 * plane. Only for a board with a runtime of its own (an ESP32-S3); a board
 * without one is rendered by the plane whatever the setting says.
 */
export interface RenderOnServerChoice {
  /** The plane, as the select names it: "FrameOS Cloud", "the backend". */
  serverName: string
  /** Why it cannot be set here (cloud: firmware before 2026.11.7). */
  disabledReason?: string
  /** What a scene can reach from there, one sentence for the tooltip. */
  reach: string
  /** What it costs on this plane, shown under the select while it is on. */
  note?: ReactNode
}

export interface PowerSettingsFieldsProps {
  value: PowerSettingsValues
  onChange: (patch: Partial<PowerSettingsValues>) => void
  /**
   * Which firmware reads these. 'esp32' (the default) renders every control.
   * 'pico' — a Pico W / Pico 2 W thin client on the self-hosted backend, i.e.
   * a Pimoroni Inky Frame — renders "Between renders" alone: its firmware
   * implements deepSleep and deepSleepOnBattery (it senses USB power itself)
   * and nothing else, so a wake-check interval or a battery ADC pin would be
   * a field that saves and does nothing. The values it cannot use are left
   * untouched in the frame, never cleared.
   */
  profile?: 'esp32' | 'pico'
  /** Control-plane-specific note under the fields (how the values travel). */
  footnote?: ReactNode
  /**
   * Why the enable pin cannot be edited on this plane right now (cloud: the
   * frame's firmware predates the key, 2026.8.39). The field renders disabled
   * with this as its tooltip — never hidden, so the value is still visible.
   */
  batteryEnablePinDisabledReason?: string
  /** Why the processor speed cannot be set here (cloud: firmware before 2026.11.7). */
  cpuModeDisabledReason?: string
  /** The clock the frame reports running at, in MHz (cloud only). */
  reportedCpuMhz?: number | undefined
  /** Offer "Render scenes"; omitted on a board that cannot render itself. */
  renderOnServer?: RenderOnServerChoice
  className?: string
}

const awakeAfterInputChoices = [
  { value: '0', label: 'Sleep as soon as it can' },
  { value: '60', label: '1 minute' },
  { value: '300', label: '5 minutes' },
  { value: '600', label: '10 minutes' },
  { value: '1800', label: '30 minutes' },
]

const cpuModeChoices: { value: CpuMode; label: string }[] = [
  { value: 'auto', label: 'Automatic (default)' },
  { value: 'battery', label: 'Battery: 160 MHz' },
  { value: 'performance', label: 'Performance: 240 MHz' },
]

const wakeCheckChoices = [
  { value: '0', label: 'Only wake to render' },
  { value: '900', label: 'Every 15 minutes' },
  { value: '1800', label: 'Every 30 minutes' },
  { value: '3600', label: 'Every hour' },
  { value: '10800', label: 'Every 3 hours' },
  { value: '21600', label: 'Every 6 hours' },
  { value: '43200', label: 'Every 12 hours' },
  { value: '86400', label: 'Once a day' },
]

export function PowerSettingsFields({
  value,
  onChange,
  profile = 'esp32',
  footnote,
  batteryEnablePinDisabledReason,
  cpuModeDisabledReason,
  reportedCpuMhz,
  renderOnServer,
  className,
}: PowerSettingsFieldsProps): JSX.Element {
  const wakeCheckValue = String(value.wakeCheckSeconds ?? 0)
  const sleeps = value.deepSleep || value.deepSleepOnBattery

  if (profile === 'pico') {
    return (
      <div className={clsx('space-y-2', className)}>
        <PowerField
          label="Between renders"
          tooltip={
            <>
              On an Inky Frame, deep sleep switches the board off completely between renders: the firmware sets the
              on-board clock&apos;s alarm for the next render and cuts its own power, drawing about 20 µA. It wakes on
              that alarm or on a press of any of the front buttons, fetches the picture, refreshes the panel and powers
              off again. While off it is offline, so changes made here land on the next wake. On USB power the board
              cannot cut its power, so it waits out the interval instead. That is also what "on battery" means
              here: the firmware checks for USB power itself, no battery sense pin involved.
            </>
          }
        >
          <Select
            value={value.deepSleep ? 'always' : value.deepSleepOnBattery ? 'battery' : 'connected'}
            onChange={(mode) => onChange({ deepSleep: mode === 'always', deepSleepOnBattery: mode === 'battery' })}
            options={[
              { value: 'connected', label: 'Stay powered (default)' },
              { value: 'battery', label: 'Power off between renders when on battery' },
              { value: 'always', label: 'Always power off between renders' },
            ]}
          />
        </PowerField>
        <p className="frameos-muted text-sm">
          {sleeps
            ? 'The board powers off between renders and wakes on the refresh interval or any front button. Plugged into USB it stays on and waits instead.'
            : 'The board stays on and connected between renders. Fine on USB power, quick to drain a battery pack.'}
        </p>
        {footnote ? <p className="frameos-muted text-sm">{footnote}</p> : null}
      </div>
    )
  }

  return (
    <div className={clsx('space-y-2', className)}>
      <PowerField
        label="Between renders"
        tooltip={
          <>
            Deep sleep powers the frame almost completely off between renders — best for battery frames. While asleep it
            is offline: queued actions land on the next wake. A press on any configured GPIO button wakes it early
            (firmware 2026.8.42+): the scene gets the button event and the panel refreshes. "On battery" relies on the
            battery sense GPIO below; without one the frame cannot tell and stays connected.
          </>
        }
      >
        <Select
          value={value.deepSleep ? 'always' : value.deepSleepOnBattery ? 'battery' : 'connected'}
          onChange={(mode) => onChange({ deepSleep: mode === 'always', deepSleepOnBattery: mode === 'battery' })}
          options={[
            { value: 'connected', label: 'Stay connected (default)' },
            { value: 'battery', label: 'Deep sleep when on battery' },
            { value: 'always', label: 'Always deep sleep' },
          ]}
        />
      </PowerField>
      {sleeps ? (
        <PowerField
          label="Stay awake after a press or tap"
          tooltip={
            <>
              How long the frame stays up after a button press or a tap on the screen, so the next one is answered at
              once instead of waking it again. Staying awake costs battery.
            </>
          }
        >
          <Select
            value={String(value.awakeAfterInputSeconds ?? 300)}
            onChange={(seconds) => onChange({ awakeAfterInputSeconds: parseInt(seconds) })}
            options={[
              ...awakeAfterInputChoices,
              ...(value.awakeAfterInputSeconds !== undefined &&
              !awakeAfterInputChoices.some((choice) => choice.value === String(value.awakeAfterInputSeconds))
                ? [{ value: String(value.awakeAfterInputSeconds), label: `${value.awakeAfterInputSeconds} seconds` }]
                : []),
            ]}
          />
        </PowerField>
      ) : null}
      {sleeps ? (
        <PowerField
          label="Check for commands while sleeping"
          tooltip={
            <>
              Extra wake-ups between renders that connect, fetch queued actions and scene updates, and go back to sleep
              without refreshing the panel. The scheduled render still happens on time, and a button press wakes the
              frame regardless. Each check-in costs battery — pick the longest interval you can live with.
            </>
          }
        >
          <Select
            value={wakeCheckValue}
            onChange={(seconds) => onChange({ wakeCheckSeconds: parseInt(seconds) })}
            options={[
              ...wakeCheckChoices,
              // A value set over the USB console or a hand-edited config is
              // still a real setting — show it rather than silently snapping
              // the frame to the nearest preset on the next save.
              ...(value.wakeCheckSeconds && !wakeCheckChoices.some((choice) => choice.value === wakeCheckValue)
                ? [{ value: wakeCheckValue, label: `Every ${wakeCheckValue} seconds` }]
                : []),
            ]}
          />
        </PowerField>
      ) : null}
      {renderOnServer ? <RenderScenesField choice={renderOnServer} value={value} onChange={onChange} /> : null}
      <PowerField
        label="Processor speed"
        tooltip={
          cpuModeDisabledReason ?? (
            <>
              Battery runs the chip at 160 MHz, performance at 240 MHz. Performance renders about a third faster, but
              the chip also waits out the screen refresh at the higher speed, about 20 seconds on a reTerminal E1002. On
              a battery e-paper frame that costs roughly 5 to 10% of battery life. Automatic is battery on e-paper and
              performance on LCD and touch screens. Saving a change reboots the frame.
            </>
          )
        }
      >
        <fieldset disabled={cpuModeDisabledReason !== undefined} className="min-w-0 space-y-1">
          <Select
            value={value.cpuMode ?? 'auto'}
            onChange={(mode) => onChange({ cpuMode: mode as CpuMode })}
            options={cpuModeChoices}
          />
          {reportedCpuMhz ? <p className="frameos-muted text-xs">Running at {reportedCpuMhz} MHz now.</p> : null}
        </fieldset>
      </PowerField>
      <PowerField
        label="Battery sense GPIO"
        tooltip={
          <>
            ADC1-capable GPIO wired to the battery through a voltage divider. Enables the battery percentage in metrics,
            the low-battery render guard and "deep sleep when on battery". Set -1 (or leave empty) when the board has no
            battery tap. Saving a change reboots the frame to re-init the ADC. The Waveshare 13.3" E6 board uses GPIO 8
            with a 3.0 divider.
          </>
        }
      >
        <NumberTextInput
          value={value.batteryPin}
          onChange={(pin) => onChange({ batteryPin: pin })}
          placeholder="-1 = no battery"
        />
      </PowerField>
      <PowerField
        label="Battery voltage divider"
        tooltip={<>Vbat = Vpin × divider. 2.0 for the classic 100k/100k tap, 3.0 on the Waveshare 13.3" E6 board.</>}
      >
        <NumberTextInput
          value={value.batteryDivider}
          onChange={(divider) => onChange({ batteryDivider: divider })}
          placeholder="2.0"
        />
      </PowerField>
      <PowerField
        label="Battery enable GPIO"
        tooltip={
          batteryEnablePinDisabledReason ?? (
            <>
              GPIO the firmware drives high to switch the battery divider on while it samples — boards that gate the
              divider to save power (the Seeed reTerminal E1004 uses GPIO 21). Set -1 (or leave empty) when the divider
              is always connected. Read at boot next to the battery pin, so saving a change reboots the frame.
            </>
          )
        }
      >
        <fieldset disabled={batteryEnablePinDisabledReason !== undefined} className="min-w-0">
          <NumberTextInput
            value={value.batteryEnablePin}
            onChange={(pin) => onChange({ batteryEnablePin: pin })}
            placeholder="-1 = always on"
          />
        </fieldset>
      </PowerField>
      {footnote ? <p className="frameos-muted text-sm">{footnote}</p> : null}
    </div>
  )
}

function RenderScenesField({
  choice,
  value,
  onChange,
}: {
  choice: RenderOnServerChoice
  value: PowerSettingsValues
  onChange: (patch: Partial<PowerSettingsValues>) => void
}): JSX.Element {
  const remote = value.renderMode === 'remote'
  return (
    <PowerField
      label="Render scenes"
      tooltip={
        choice.disabledReason ?? (
          <>
            On the server, {choice.serverName} runs this frame&apos;s scenes and sends it the finished picture. The
            frame only wakes, downloads the picture and refreshes the screen: no scene code, no image decoding and no
            data fetching on the frame, so a battery lasts longer. When nothing changed, the frame skips the download
            and the refresh. A sleeping frame&apos;s next picture is drawn just before it wakes. {choice.reach} The
            frame&apos;s keys, touch and schedule keep working: what they do goes to {choice.serverName} with the next
            download, so a press answers in a second or three. The frame changes over at its next render.
          </>
        )
      }
    >
      <fieldset disabled={choice.disabledReason !== undefined} className="min-w-0 space-y-1">
        <Select
          value={remote ? 'remote' : 'local'}
          onChange={(mode) => onChange({ renderMode: mode === 'remote' ? 'remote' : 'local' })}
          options={[
            { value: 'local', label: 'On the frame (default)' },
            { value: 'remote', label: `On ${choice.serverName}` },
          ]}
        />
        {remote ? (
          <p className="frameos-muted text-xs">
            A press or a tap reaches the scene with the frame&apos;s next download, so it answers in a second or three.
            {choice.note ? <> {choice.note}</> : null}
          </p>
        ) : null}
      </fieldset>
    </PowerField>
  )
}

// Same row shape as components/Field, without the kea-forms binding: these
// values live under different form keys on each control plane, so the
// component cannot name one.
function PowerField({
  label,
  tooltip,
  children,
}: {
  label: string
  tooltip?: JSX.Element | string
  children: JSX.Element
}): JSX.Element {
  return (
    <div className="space-y-1 @md:flex @md:gap-2">
      <Label className="@md:w-1/3">
        {label}
        {tooltip ? <Tooltip title={tooltip} /> : null}
      </Label>
      <div className="w-full">{children}</div>
    </div>
  )
}
