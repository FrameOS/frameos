import type { ReactElement } from 'react'
import { Switch } from '../../../frontend/src/components/Switch'
import { Tooltip } from '../../../frontend/src/components/Tooltip'
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
      <div className="flex items-center gap-1.5">
        <span className="frameos-muted text-xs font-semibold">LAN access</span>
        <Tooltip label="LAN access help" className="frameos-muted" titleClassName="w-72" title={LAN_ACCESS_HELP} />
      </div>
      <Switch
        value={value}
        // The label still toggles a disabled switch; drop the handler instead.
        {...(disabled ? {} : { onChange })}
        disabled={disabled}
        label={<span className="text-xs">{value ? 'On' : 'Off'}</span>}
        aria-label="LAN access"
      />
    </div>
  )
}
