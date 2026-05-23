import React, { forwardRef, ReactNode } from 'react'
import { clsx } from 'clsx'
import { Switch as HeadlessSwitch } from '@headlessui/react'
import { Label } from './Label'

export interface SwitchProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'value'> {
  onChange?: (value: boolean) => void
  value?: boolean
  leftLabel?: ReactNode
  label?: ReactNode
  fullWidth?: boolean
  alwaysActive?: boolean
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { className, onChange, value, disabled, label, leftLabel, fullWidth, alwaysActive, ...props }: SwitchProps,
  ref
) {
  const switchTag = (
    <HeadlessSwitch
      checked={!!value}
      onChange={onChange}
      as="div"
      className={clsx('frameos-switch inline-flex items-center gap-2', className)}
      ref={ref}
    >
      {leftLabel && <Label className="frameos-switch-label cursor-pointer">{leftLabel}</Label>}
      <button
        className={clsx(
          'frameos-switch-track group inline-flex h-6 w-11 items-center rounded-full',
          value || alwaysActive ? 'frameos-switch-track-on' : 'frameos-switch-track-off',
          disabled && 'cursor-not-allowed opacity-50'
        )}
        disabled={disabled}
        {...props}
      >
        <span className="sr-only">
          {leftLabel ? (
            <>
              {leftLabel} or {label}
            </>
          ) : (
            label
          )}
        </span>
        <span
          className={clsx(
            'frameos-switch-thumb size-4 rounded-full transition',
            value ? 'translate-x-6' : 'translate-x-1'
          )}
        />
      </button>
      {label && <Label className="frameos-switch-label cursor-pointer">{label}</Label>}
    </HeadlessSwitch>
  )
  return fullWidth ? <div className="w-full">{switchTag}</div> : switchTag
})
