import clsx from 'clsx'
import type { ReactNode } from 'react'

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
 */
export interface PowerSettingsValues {
  deepSleep: boolean
  deepSleepOnBattery: boolean
  wakeCheckSeconds: number | undefined
  batteryPin: number | undefined
  batteryDivider: number | undefined
  /** GPIO held high to switch the divider on while sampling; -1 = none (always on). */
  batteryEnablePin: number | undefined
}

export interface PowerSettingsFieldsProps {
  value: PowerSettingsValues
  onChange: (patch: Partial<PowerSettingsValues>) => void
  /** Control-plane-specific note under the fields (how the values travel). */
  footnote?: ReactNode
  /**
   * Why the enable pin cannot be edited on this plane right now (cloud: the
   * frame's firmware predates the key, 2026.8.39). The field renders disabled
   * with this as its tooltip — never hidden, so the value is still visible.
   */
  batteryEnablePinDisabledReason?: string
  className?: string
}

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
  footnote,
  batteryEnablePinDisabledReason,
  className,
}: PowerSettingsFieldsProps): JSX.Element {
  const wakeCheckValue = String(value.wakeCheckSeconds ?? 0)
  const sleeps = value.deepSleep || value.deepSleepOnBattery

  return (
    <div className={clsx('space-y-2', className)}>
      <PowerField
        label="Between renders"
        tooltip={
          <>
            Deep sleep powers the frame almost completely off between renders — best for battery frames. While asleep it
            is offline: queued actions land on the next wake. "On battery" relies on the battery sense GPIO below;
            without one the frame cannot tell and stays connected.
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
          label="Check for commands while sleeping"
          tooltip={
            <>
              Extra wake-ups between renders that connect, fetch queued actions and scene updates, and go back to sleep
              without refreshing the panel. The scheduled render still happens on time. Each check-in costs battery —
              pick the longest interval you can live with.
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
