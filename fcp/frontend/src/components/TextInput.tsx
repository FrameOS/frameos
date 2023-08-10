import React from 'react'
import { clsx } from 'clsx'

interface TextInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  onChange?: (value: string) => void
}

export function TextInput({ className, onChange, ...props }: TextInputProps) {
  return (
    <input
      className={clsx(
        'border text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2.5 bg-gray-600 border-gray-500 placeholder-gray-400 text-white',
        className
      )}
      type="text"
      onChange={onChange ? (e) => onChange(e.target.value) : undefined}
      {...props}
    />
  )
}
