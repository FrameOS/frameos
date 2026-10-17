import type { ReactElement } from 'react'
import { Switch } from '../../../frontend/src/components/Switch'
import { LAN_ACCESS_HELP } from '../../../frontend/src/scenes/frame/panels/FrameSettings/lanAccess'

// The LAN access choice at setup (SD card builder, ESP32 flasher). Chosen
// here, the frame needs no code on its panel; changing it later does.
export function LanAccessToggle({
  value,
  onChange,
  disabled,
}: {
  value: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}): ReactElement {
  return (
    <div className="grid gap-1" data-testid="lan-access-toggle">
      <span className="frameos-muted text-xs font-semibold">LAN access</span>
      <Switch
        value={value}
        // The label still toggles a disabled switch; drop the handler instead.
        {...(disabled ? {} : { onChange })}
        disabled={disabled}
        label={<span className="text-xs">{value ? 'On' : 'Off'}</span>}
        aria-label="LAN access"
      />
      <p className="frameos-muted text-xs">{LAN_ACCESS_HELP}</p>
    </div>
  )
}
