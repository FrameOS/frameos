import React, { forwardRef } from 'react'
import { clsx } from 'clsx'

export interface TextInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  onChange?: (value: string) => void
  theme?: 'node' | 'full'
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { className, onChange, theme, type, ...props }: TextInputProps,
  ref
) {
  return (
    <input
      {...props}
      className={clsx(
        (!theme || theme === 'full') &&
          'frameos-control border text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full px-2.5 py-1.5',
        theme === 'node' &&
          'frameos-node-control block focus:ring-1 focus:ring-blue-500 w-full min-w-min px-0.5 nodrag nopan',
        className
      )}
      data-editable="true"
      size={theme === 'node' ? 15 : 20}
      type={type ?? 'text'}
      onChange={onChange ? (e) => onChange(e.target.value) : undefined}
      onMouseDown={(e) => {
        e.stopPropagation()
        props.onMouseDown?.(e)
      }}
      onClick={(e) => {
        e.stopPropagation()
        props.onClick?.(e)
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        props.onKeyDown?.(e)
      }}
      onCopy={(e) => {
        e.stopPropagation()
        props.onCopy?.(e)
      }}
      ref={ref}
      onPaste={(e) => {
        e.stopPropagation()
        props.onPaste?.(e)
      }}
    />
  )
})
