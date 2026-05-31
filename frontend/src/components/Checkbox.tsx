import React, { forwardRef, ReactNode } from 'react'
import { clsx } from 'clsx'
import { Label } from './Label'

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  label?: ReactNode
  onChange?: (value: boolean) => void
  value?: boolean
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, disabled, label, onChange, value, ...props }: CheckboxProps,
  ref
) {
  return (
    <label className={clsx('inline-flex items-center gap-2 text-sm', disabled && 'cursor-not-allowed opacity-50')}>
      <input
        {...props}
        ref={ref}
        type="checkbox"
        checked={!!value}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.checked)}
        className={clsx('h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-2 focus:ring-blue-400', className)}
      />
      {label ? <Label className="cursor-pointer">{label}</Label> : null}
    </label>
  )
})
