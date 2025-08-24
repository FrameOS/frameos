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
      className={clsx('inline-flex gap-1 items-center', className)}
      ref={ref}
    >
      {leftLabel && <Label className="cursor-pointer">{leftLabel}</Label>}
      <button
        className={clsx(
          'group inline-flex h-6 w-11 items-center rounded-full',
          value || alwaysActive ? 'bg-[#2a2b50]' : 'bg-gray-600',
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
        <span className={clsx('size-4 rounded-full bg-white transition', value ? 'translate-x-6' : 'translate-x-1')} />
      </button>
      {label && <Label className="cursor-pointer">{label}</Label>}
    </HeadlessSwitch>
  )
  return fullWidth ? <div className="w-full">{switchTag}</div> : switchTag
})
