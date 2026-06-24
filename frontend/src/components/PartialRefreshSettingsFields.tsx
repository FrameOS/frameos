import clsx from 'clsx'
import type { FrameType } from '../types'
import type { PartialRefreshDefaults } from '../devices'
import { Label } from './Label'
import { NumberTextInput } from './NumberTextInput'
import { Switch } from './Switch'
import { Tooltip } from './Tooltip'

type DeviceConfig = NonNullable<FrameType['device_config']>
type NumericDeviceConfigKey = 'partialMaxAreaPercent' | 'partialMaxRefreshesBeforeFull'
type BooleanDeviceConfigKey = 'partial'

type FieldVariant = 'settings' | 'stacked' | 'panel'

interface NumericFieldDefinition {
  key: NumericDeviceConfigKey
  defaultKey: keyof PartialRefreshDefaults
  label: string
  panelLabel: string
  placeholder: string
  hint?: string
  tooltip?: string
}

interface BooleanFieldDefinition {
  key: BooleanDeviceConfigKey
  label: string
  panelLabel: string
  hint?: string
  tooltip?: string
}

const partialEnabledField: BooleanFieldDefinition = {
  key: 'partial',
  label: 'Partial refresh',
  panelLabel: 'Partial refresh',
  tooltip: 'Enable partial updates for this panel. Full refresh remains the default.',
}

const numericFields: NumericFieldDefinition[] = [
  {
    key: 'partialMaxAreaPercent',
    defaultKey: 'maxAreaPercent',
    label: 'Partial max area (%)',
    panelLabel: 'Max area (%)',
    placeholder: 'Panel default',
    hint: 'Leave blank for the panel default.',
    tooltip: 'Maximum changed screen area to update partially. Leave blank for the panel default.',
  },
  {
    key: 'partialMaxRefreshesBeforeFull',
    defaultKey: 'maxRefreshesBeforeFull',
    label: 'Partial updates before full',
    panelLabel: 'Updates before full',
    placeholder: 'Panel default',
    hint: 'Leave blank for the panel default.',
    tooltip: 'How many partial updates may run before forcing a full refresh. Leave blank for the panel default.',
  },
]

export interface PartialRefreshSettingsFieldsProps {
  value?: FrameType['device_config'] | null
  onChange: (value: DeviceConfig) => void
  variant?: FieldVariant
  panelDefaults?: PartialRefreshDefaults
  className?: string
  numberInputClassName?: string
}

export function PartialRefreshSettingsFields({
  value,
  onChange,
  variant = 'settings',
  panelDefaults,
  className,
  numberInputClassName,
}: PartialRefreshSettingsFieldsProps): JSX.Element {
  const config = value ?? {}
  const partialEnabled = config.partial === true

  const updateConfig = <K extends keyof DeviceConfig>(key: K, nextValue: DeviceConfig[K] | undefined): void => {
    const nextConfig = { ...config }
    if (nextValue === undefined || nextValue === '') {
      delete nextConfig[key]
    } else {
      nextConfig[key] = nextValue
    }
    onChange(nextConfig)
  }

  const renderBooleanField = (field: BooleanFieldDefinition, panel = false): JSX.Element => {
    const label = panel ? field.panelLabel : field.label
    const control = (
      <Switch
        value={config[field.key] === true}
        onChange={(fieldValue) => updateConfig(field.key, fieldValue)}
        fullWidth={variant !== 'panel'}
        aria-label={field.label}
      />
    )

    if (variant === 'panel') {
      return (
        <div className="flex items-center justify-between gap-3">
          <span className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">{label}</span>
          {control}
        </div>
      )
    }

    return (
      <PartialRefreshFieldFrame
        label={label}
        hint={variant === 'stacked' ? field.hint : undefined}
        tooltip={variant === 'settings' ? field.tooltip : undefined}
        variant={variant}
      >
        {control}
      </PartialRefreshFieldFrame>
    )
  }

  const renderNumericField = (field: NumericFieldDefinition, panel = false): JSX.Element => {
    const label = panel ? field.panelLabel : field.label
    const panelDefault = panelDefaults?.[field.defaultKey]
    const placeholder =
      typeof panelDefault === 'number'
        ? `Panel default: ${field.key === 'partialMaxAreaPercent' ? `${panelDefault}%` : panelDefault}`
        : field.placeholder
    const control = (
      <NumberTextInput
        className={numberInputClassName}
        value={config[field.key]}
        onChange={(fieldValue) => updateConfig(field.key, fieldValue)}
        placeholder={placeholder}
      />
    )

    if (variant === 'panel') {
      return (
        <label className="block space-y-1">
          <span className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">{label}</span>
          {control}
        </label>
      )
    }

    return (
      <PartialRefreshFieldFrame
        label={label}
        hint={variant === 'stacked' ? field.hint : undefined}
        tooltip={variant === 'settings' ? field.tooltip : undefined}
        variant={variant}
      >
        {control}
      </PartialRefreshFieldFrame>
    )
  }

  if (variant === 'panel') {
    return (
      <div className={clsx('frame-tool-row space-y-3 rounded-xl p-3', className)}>
        {renderBooleanField(partialEnabledField, true)}
        {partialEnabled ? (
          <div className="grid gap-3 @md:grid-cols-2">
            {numericFields.map((field) => (
              <div key={field.key}>{renderNumericField(field, true)}</div>
            ))}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className={clsx(variant === 'settings' ? 'space-y-1' : 'space-y-4', className)}>
      {renderBooleanField(partialEnabledField)}
      {partialEnabled
        ? numericFields.slice(0, 2).map((field) => <div key={field.key}>{renderNumericField(field)}</div>)
        : null}
    </div>
  )
}

function PartialRefreshFieldFrame({
  label,
  hint,
  tooltip,
  variant,
  children,
}: {
  label: string
  hint?: string
  tooltip?: string
  variant: Exclude<FieldVariant, 'panel'>
  children: JSX.Element
}): JSX.Element {
  if (variant === 'stacked') {
    return (
      <label className="block space-y-2">
        <span className="frameos-form-label block text-sm font-semibold text-slate-700">{label}</span>
        {children}
        {hint ? <span className="frameos-form-hint block text-xs leading-relaxed text-slate-500">{hint}</span> : null}
      </label>
    )
  }

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
