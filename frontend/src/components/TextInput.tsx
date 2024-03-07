import React from 'react'
import { clsx } from 'clsx'

export interface TextInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  onChange?: (value: string) => void
  theme?: 'node' | 'full'
}

export function TextInput({ className, onChange, theme, type, ...props }: TextInputProps) {
  return (
    <input
      className={clsx(
        (!theme || theme === 'full') &&
          'border text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full px-2.5 py-1.5 bg-gray-600 border-gray-500 placeholder-gray-400 text-white',
        theme === 'node' && 'block text-white bg-zinc-800 focus:bg-zinc-700 hover:bg-zinc-700 w-full min-w-min px-0.5',
        className
      )}
      size={theme === 'node' ? 15 : 20}
      type={type ?? 'text'}
      onChange={onChange ? (e) => onChange(e.target.value) : undefined}
      {...props}
    />
  )
}
