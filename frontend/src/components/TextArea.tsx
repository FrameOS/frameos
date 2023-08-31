import React from 'react'
import { clsx } from 'clsx'

interface TextAreaProps extends Omit<React.InputHTMLAttributes<HTMLTextAreaElement>, 'onChange'> {
  onChange?: (value: string) => void
  theme?: 'node' | 'full'
}

export function TextArea({ className, onChange, theme, ...props }: TextAreaProps) {
  return (
    <textarea
      className={clsx(
        (!theme || theme === 'full') &&
          'border text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2.5 bg-gray-600 border-gray-500 placeholder-gray-400 text-white',
        theme === 'node' && 'block text-white bg-zinc-800 focus:bg-zinc-700 hover:bg-zinc-700 w-full min-w-min px-0.5',
        className
      )}
      rows={theme === 'node' ? 3 : 8}
      onChange={onChange ? (e) => onChange(e.target.value) : undefined}
      {...props}
    />
  )
}
